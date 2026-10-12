// PDF 导入(pdfjs-dist v6)。
// 菜单接线:commands.ts file.importPdf / openPathByKind 的 .pdf 分支(集成者维护)。
//
// v1 实现口径:每页光栅化成 2x 位图(RENDER_SCALE 抗锯齿),图层 transform.size
// 记页面 1x 尺寸、origin [0,0] —— 即位图超采样一倍,放大不糊。多页导入按自然
// 页序压栈(页 1 在最底层);单页导入只取第 1 页,层名「PDF」。
// v1 范围:非加密 PDF;页数上限 50;文本/矢量按像素导入(不可编辑);不渲染
// 批注与表单;色彩空间交给 pdfjs 默认(无 ICC 透传,doc.iccName 保持空)。
// 已知坑(Vite + WebView2):worker 用 `?url` 资产接线;pdfjs 的 GetDocRequest
// 会 transfer data.buffer(detach),每次 getDocument 都要传新拷贝。

import * as pdfjsLib from 'pdfjs-dist';
// vite-env.d.ts 已 /// <reference types="vite/client" />,自带 `*?url` 模块声明;
// worker 文件与主库同包,版本天然一致。
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Doc, Layer } from '../types';
import { makeLayer, defaultTransform } from '../types';
import { makeCanvas } from '../canvasUtils';
import { readFile } from './fs';

const MAX_PAGES = 50;
const RENDER_SCALE = 2;

// worker 状态机:unset → worker(常规)→ fake(worker 拉不起来时主线程兜底)。
// pdfjs 要到 getDocument 才真正创建 worker,所以「初始化失败」也在那里捕获:
// 加密/损坏这类解析错误与 worker 无关,直接上抛中文化;疑似 worker 环境问题
// (加载失败、模块 worker 不支持等)才降级 workerSrc='' 重试一次。
let workerMode: 'unset' | 'worker' | 'fake' = 'unset';

function isPdfError(err: unknown): boolean {
  // 异常穿越 worker 边界后 pdfjs 会按 name 重建实例,instanceof/name 双重判断
  const name = (err as { name?: string } | null)?.name;
  return name === 'PasswordException' || name === 'InvalidPDFException';
}

async function openDocument(bytes: Uint8Array) {
  // GetDocRequest 会 transfer data.buffer(原数组缓冲被 detach),每次尝试传新拷贝
  const attempt = () => pdfjsLib.getDocument({ data: bytes.slice() });
  if (workerMode === 'unset') {
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      workerMode = 'worker';
    } catch (err) {
      console.warn('PDF worker 初始化失败,降级为主线程解析(fake worker)', err);
      pdfjsLib.GlobalWorkerOptions.workerSrc = '';
      workerMode = 'fake';
    }
  }
  if (workerMode === 'worker') {
    try {
      const task = attempt();
      return { pdf: await task.promise, task };
    } catch (err) {
      if (isPdfError(err)) throw err; // 加密/损坏,与 worker 无关,不降级
      console.warn('PDF worker 加载失败,降级为主线程解析(fake worker)', err);
      pdfjsLib.GlobalWorkerOptions.workerSrc = '';
      workerMode = 'fake';
    }
  }
  const task = attempt(); // fake worker(主线程)路径或降级重试
  return { pdf: await task.promise, task };
}

/** 把 PDF 每页渲染成图层导入。返回完整 Doc(每页一个图层,层名「页 N」)。
 *  multiPage=false 时只导第 1 页(单层「PDF」)。 */
export async function importPdf(path: string, multiPage: boolean): Promise<Doc> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (err) {
    throw new Error(`无法读取 PDF 文件:${(err as Error)?.message ?? err}`);
  }

  let pdf, task;
  try {
    ({ pdf, task } = await openDocument(bytes));
  } catch (err) {
    if ((err as { name?: string } | null)?.name === 'PasswordException') {
      throw new Error('PDF 已加密,暂不支持');
    }
    const msg = (err as Error)?.message ?? String(err);
    if ((err as { name?: string } | null)?.name === 'InvalidPDFException') {
      throw new Error(`无法解析 PDF 文件(${msg})`);
    }
    throw new Error(`无法解析 PDF 文件:${msg}`);
  }

  if (pdf.numPages > MAX_PAGES) {
    await task.destroy().catch(() => {});
    throw new Error(`PDF 页数超出上限(最多 ${MAX_PAGES} 页,当前 ${pdf.numPages} 页)`);
  }

  const pageCount = multiPage ? pdf.numPages : 1;
  const layers: Layer[] = [];
  let docW = 0, docH = 0; // 取各页最大值,保证图层都落在文档画布内
  try {
    for (let i = 1; i <= pageCount; i++) {
      const page = await pdf.getPage(i);
      const v1 = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const canvas = makeCanvas(viewport.width, viewport.height);
      // v6 推荐 canvas 参数(pdfjs 自取 2d 上下文);canvasContext 仅作向后兼容
      await page.render({ canvas, viewport }).promise;
      layers.push(makeLayer({
        name: multiPage ? `页 ${i}` : 'PDF',
        bitmap: canvas,
        transform: defaultTransform(v1.width, v1.height),
      }));
      docW = Math.max(docW, v1.width);
      docH = Math.max(docH, v1.height);
    }
  } finally {
    await task.destroy().catch(() => {}); // 位图已落到各自 canvas,可安全释放
  }

  const doc: Doc = {
    id: crypto.randomUUID(),
    width: Math.round(docW),
    height: Math.round(docH),
    resolution: 72,
    layers,
    activeLayerId: layers[layers.length - 1].id,
    fileName: path.split(/[\\/]/).pop() ?? path,
  };
  return doc;
}
