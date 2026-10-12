// APNG animation export. encodeApng is the pure, Tauri-free part (unit-testable
// in the browser): each frame canvas is rasterized to a regular PNG via
// toBlob, the chunk stream is re-assembled into an APNG —
//
//   signature(8B) | IHDR(复用第一帧) | acTL(num_frames, num_plays=0 无限循环)
//   | fcTL(seq=0, 第一帧) | 第一帧 IDAT 原样
//   | 后续每帧: fcTL(seq 递增) + 原 IDAT 数据前插 4B 序号改名为 fdAT
//   | IEND
//
// 字节序:PNG 全大端 —— chunk 长度、sequence number、delay_num/delay_den 都用
// DataView 大端写入。CRC32 为表驱动自实现(多项式 0xEDB88320),对 chunk 类型
// +数据计算,与 PNG 规范一致。
// 已知限制 v1:所有帧按第一帧的 IHDR 尺寸编码(本项目每帧都是文档尺寸合成,
// 恒等大小);不写 sBIT/gAMA 等辅助 chunk。

import { store, invalidate } from '../store';
import { composite } from '../compositor';
import {
  applyStatesToLayers, captureLayerStates, restoreLayerStates, syncFrameFromLayers, anim,
  type LayerSnapshot,
} from '../animation';
import { writeFile } from './fs';

export interface ApngFrame {
  canvas: HTMLCanvasElement;
  delayMs: number;
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------- CRC32 (table-driven, PNG polynomial 0xEDB88320) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- PNG chunk parsing / assembly ----------

interface PngChunk { type: string; data: Uint8Array }

function setU32be(dst: Uint8Array, off: number, v: number): void {
  new DataView(dst.buffer, dst.byteOffset, dst.byteLength).setUint32(off, v);
}

function setU16be(dst: Uint8Array, off: number, v: number): void {
  new DataView(dst.buffer, dst.byteOffset, dst.byteLength).setUint16(off, v);
}

function parsePng(buf: ArrayBuffer): PngChunk[] {
  const b = new Uint8Array(buf);
  for (let i = 0; i < 8; i++) {
    if (b[i] !== PNG_SIGNATURE[i]) throw new Error('帧画布编码出的 PNG 签名不符');
  }
  const chunks: PngChunk[] = [];
  let pos = 8;
  while (pos + 12 <= b.length) {
    const len = new DataView(buf).getUint32(pos); // 大端:PNG 规范
    const type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    if (pos + 12 + len > b.length) throw new Error(`PNG chunk ${type} 长度越界`);
    chunks.push({ type, data: b.slice(pos + 8, pos + 8 + len) });
    pos += 12 + len; // 长度4 + 类型4 + 数据 + CRC4
  }
  return chunks;
}

/** 长度4 + 类型4 + 数据 + CRC4;CRC 覆盖类型+数据。 */
function chunkBytes(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  setU32be(out, 0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  setU32be(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function toPngChunks(canvas: HTMLCanvasElement): Promise<PngChunk[]> {
  return new Promise<PngChunk[]>((resolve, reject) => {
    canvas.toBlob(async blob => {
      if (!blob) { reject(new Error('canvas.toBlob 失败')); return; }
      try {
        resolve(parsePng(await blob.arrayBuffer()));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }, 'image/png');
  });
}

export async function encodeApng(frames: ApngFrame[]): Promise<ArrayBuffer> {
  if (!frames.length) throw new Error('没有可编码的帧');

  // 1) 每帧栅格化为 PNG 并解开 chunk 流
  const pngs: PngChunk[][] = [];
  for (const f of frames) pngs.push(await toPngChunks(f.canvas));

  const ihdr = pngs[0].find(c => c.type === 'IHDR');
  if (!ihdr) throw new Error('第一帧缺少 IHDR');
  const width = frames[0].canvas.width;
  const height = frames[0].canvas.height;

  // 2) 重新装配:签名 + IHDR + acTL + (fcTL + IDAT/fdAT)×N + IEND
  const parts: Uint8Array[] = [PNG_SIGNATURE, chunkBytes('IHDR', ihdr.data)];

  const actl = new Uint8Array(8);
  setU32be(actl, 0, frames.length); // num_frames
  // num_plays 保持 0 = 无限循环
  parts.push(chunkBytes('acTL', actl));

  // APNG 规范:所有 fcTL 与 fdAT 共用同一个序号,从 0 起每 chunk +1
  let seq = 0;
  for (let i = 0; i < frames.length; i++) {
    const fctl = new Uint8Array(26);
    setU32be(fctl, 0, seq++);
    setU32be(fctl, 4, width);
    setU32be(fctl, 8, height);
    // x/y_offset(12/16)保持 0:每帧都是整幅替换
    // delay_num/delay_den 是 u16@20/22;delay=0 按 1 处理:分母 1000 下分子 0 会除零
    setU16be(fctl, 20, Math.max(1, Math.round(frames[i].delayMs)));
    setU16be(fctl, 22, 1000);
    // dispose_op(24)/blend_op(25)保持 0:NONE + SOURCE,整帧直接替换
    parts.push(chunkBytes('fcTL', fctl));

    for (const c of pngs[i]) {
      if (c.type !== 'IDAT') continue;
      if (i === 0) {
        parts.push(chunkBytes('IDAT', c.data)); // 第一帧即默认图像,IDAT 原样
      } else {
        const fdat = new Uint8Array(4 + c.data.length);
        setU32be(fdat, 0, seq++); // fdAT 数据前插 4B 序号
        fdat.set(c.data, 4);
        parts.push(chunkBytes('fdAT', fdat));
      }
    }
  }
  parts.push(chunkBytes('IEND', new Uint8Array(0)));

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out.buffer;
}

/** File → 导出 APNG 动画…:逐帧应用 states → composite → encodeApng → 写盘。 */
export async function exportApngCommand(): Promise<void> {
  const doc = store.doc;
  if (!doc || !doc.frames?.length) {
    alert('时间轴没有帧:先在时间轴面板新建帧');
    return;
  }
  const { save } = await import('@tauri-apps/plugin-dialog');
  const picked = await save({ defaultPath: 'Untitled.png' });
  if (!picked) return;
  const path = picked.toLowerCase().endsWith('.png') ? picked : `${picked}.png`;
  try {
    const frames = doc.frames;
    // 视图帧先吸收图层面板里的直接编辑,再进入逐帧应用
    syncFrameFromLayers(frames[Math.min(anim.current, frames.length - 1)]);
    const snap: LayerSnapshot[] = captureLayerStates(doc);
    const out: ApngFrame[] = [];
    for (const f of frames) {
      applyStatesToLayers(doc, f.states);
      out.push({ canvas: composite(doc), delayMs: f.durationMs });
    }
    restoreLayerStates(doc, snap);
    invalidate(); // 重绘回快照状态(临时 states 不应残留在画布上)
    const buf = await encodeApng(out);
    await writeFile(path, new Uint8Array(buf));
  } catch (err) {
    alert(`无法导出 APNG:${(err as Error).message}`);
  }
}
