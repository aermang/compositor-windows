// Compositor — PDF 导入 浏览器端自动化测试(vite dev + Playwright)
// 仿 tests/io.mjs 手法:fake __TAURI_INTERNALS__ 的 read_file 返回内存字节,
// 动态 import 真实 importPdf(纯函数,动态 import 安全,不经应用菜单派发)。
// PDF 字节在页面里手工拼装(最小单文件结构,认真计算 xref 偏移):内容流画
// 红矩形 + 黑色 Helvetica 文字;加密用例挂 /Encrypt(R2/40bit,随机 O/U,空口令
// 必然校验失败)让 pdfjs 抛 PasswordException。
// 用法: NODE_PATH=<playwright目录>/node_modules node tests/pdf.mjs
// 注意:pdfjs-dist 首次被 dev server 预构建要 10-30s,预热阶段有重试兜底。
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const pw = require2(process.env.PW_PATH || 'playwright');

const BASE = 'http://localhost:1420';
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/** 单断言超时保护(pdfjs 在 worker 里跑 + 首次预构建较慢) */
function withTimeout(p, ms, label) {
  let timer;
  const t = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`超时(${ms}ms): ${label}`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

async function run() {
  let browser;
  try {
    browser = await pw.chromium.launch({ channel: 'chrome' });
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

    // 页面内测试辅助:最小 PDF 组装器 + fake Tauri 导入采样
    await page.addInitScript(() => {
      // 手工拼最小 PDF:1=Catalog 2=Pages 3=Font(Helvetica),其后每页两个对象
      // (Page + 内容流);xref 偏移认真计算(每条目恰 20 字节)。opt.encrypt 时
      // 挂标准安全处理器字典(空口令、随机 O/U → pdfjs 抛 PasswordException)。
      window.__buildPdf = function (opt) {
        const [mw, mh] = opt.mediaBox ?? [200, 150];
        const objects = new Map();
        let next = 4;
        const pageRefs = [];
        for (const stream of opt.pages) {
          const pageNum = next++;
          const contentNum = next++;
          pageRefs.push(pageNum);
          objects.set(pageNum,
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${mw} ${mh}] `
            + `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`);
          objects.set(contentNum, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
        }
        objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
        objects.set(2, `<< /Type /Pages /Kids [${pageRefs.map(n => `${n} 0 R`).join(' ')}] /Count ${opt.pages.length} >>`);
        objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
        let encryptNum = 0;
        if (opt.encrypt) {
          encryptNum = next++;
          const o = 'A'.repeat(32), u = 'B'.repeat(32);
          objects.set(encryptNum,
            `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -1 /O (${o}) /U (${u}) >>`);
        }
        let out = '%PDF-1.4\n';
        const total = next - 1;
        const offsets = [];
        for (let n = 1; n <= total; n++) {
          offsets[n] = out.length;
          out += `${n} 0 obj\n${objects.get(n)}\nendobj\n`;
        }
        const xrefPos = out.length;
        out += `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
        for (let n = 1; n <= total; n++) {
          out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
        }
        const trailer = [`/Size ${total + 1}`, '/Root 1 0 R'];
        if (encryptNum) {
          const id = '0123456789abcdef0123456789abcdef';
          trailer.push(`/Encrypt ${encryptNum} 0 R`, `/ID [<${id}> <${id}>]`);
        }
        out += `trailer\n<< ${trailer.join(' ')} >>\nstartxref\n${xrefPos}\n%%EOF`;
        return Uint8Array.from(out, ch => ch.charCodeAt(0) & 0xff);
      };
      // fake Tauri:read_file 回吐给定字节 → 调真实 importPdf → 按色系统计像素
      window.__importPdfFromBytes = async function (bytes, multiPage, opt = {}) {
        const arr = Array.from(bytes);
        const path = opt.path ?? 'C:/tmp/in.pdf';
        window.__TAURI_INTERNALS__ = {
          invoke: async (cmd, args) => {
            if (cmd === 'read_file') {
              if (String(args?.path ?? '').endsWith('__missing__.pdf')) {
                throw new Error('No such file or directory (os error 2)');
              }
              return arr;
            }
            throw new Error('fake invoke: ' + cmd);
          },
        };
        try {
          const { importPdf } = await import('/src/core/io/pdfImport.ts');
          const doc = await importPdf(path, multiPage);
          return {
            w: doc.width, h: doc.height, res: doc.resolution, file: doc.fileName,
            iccName: doc.iccName, n: doc.layers.length,
            activeIsLast: doc.activeLayerId === doc.layers[doc.layers.length - 1]?.id,
            idSet: typeof doc.id === 'string' && doc.id.length > 0,
            layers: doc.layers.map(l => {
              const bm = l.bitmap;
              const d = bm.getContext('2d').getImageData(0, 0, bm.width, bm.height).data;
              let red = 0, black = 0, blue = 0, white = 0;
              for (let i = 0; i < d.length; i += 4) {
                const r = d[i], g = d[i + 1], b = d[i + 2];
                if (r > 180 && g < 100 && b < 100) red++;
                else if (r < 70 && g < 70 && b < 70) black++;
                else if (r < 100 && g < 100 && b > 180) blue++;
                else if (r > 240 && g > 240 && b > 240) white++;
              }
              return {
                name: l.name, bw: bm.width, bh: bm.height,
                size: l.transform.size, origin: l.transform.origin,
                red, black, blue, white,
              };
            }),
          };
        } finally { delete window.__TAURI_INTERNALS__; }
      };
      // 错误用例:捕获异常返回 { threw, msg }
      window.__pdfTry = async function (bytes, multiPage, opt) {
        try {
          const r = await window.__importPdfFromBytes(bytes, multiPage, opt);
          return { threw: false, r };
        } catch (e) { return { threw: true, msg: String(e?.message ?? e) }; }
      };
    });

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    // 预热:首次 import 会触发 Vite 对 pdfjs-dist 的依赖预构建(10-30s),期间
    // dev server 可能 full-reload 页面,evaluate 会抛 fetch 失败 —— 重试兜底。
    let warmed = false;
    for (let i = 0; i < 10 && !warmed; i++) {
      try {
        await withTimeout(
          page.evaluate(() => import('/src/core/io/pdfImport.ts').then(m => typeof m.importPdf === 'function')),
          120000, `模块预热(第 ${i + 1} 次)`);
        warmed = true;
      } catch (e) {
        console.log(`  ⏳ 预热重试 ${i + 1}/10:${String(e?.message ?? e).slice(0, 120)}`);
        await page.waitForTimeout(2500);
      }
    }
    record('pdfImport 模块预热(Vite 预构建 pdfjs-dist)', warmed, warmed ? '' : '10 次重试后仍失败');

    // 1. 单页导入:红矩形 + 黑文字,2x 位图 / 1x 图层尺寸
    {
      const res = await withTimeout(page.evaluate(async () => {
        const pdf = window.__buildPdf({
          pages: ['1 0 0 rg\n50 30 100 80 re\nf\n0 0 0 rg\nBT /F1 24 Tf 20 120 Td (Hello) Tj ET'],
          mediaBox: [200, 150],
        });
        return window.__importPdfFromBytes(pdf, false);
      }), 60000, '单页 PDF 导入');
      const L = res.layers[0];
      record('PDF 单页导入:尺寸/resolution/文件名/iccName',
        res.w === 200 && res.h === 150 && res.res === 72 && res.file === 'in.pdf'
          && res.iccName === undefined && res.idSet && res.n === 1
          && L.size.join(',') === '200,150' && L.origin.join(',') === '0,0'
          && L.bw === 400 && L.bh === 300,
        `doc=${res.w}x${res.h} res=${res.res} file=${res.file} 层=${res.n} `
          + `transform=${L?.size} 位图=${L?.bw}x${L?.bh}`);
      record('PDF 单页导入:层名「PDF」+ 红矩形/黑文字/白底像素',
        L.name === 'PDF' && L.red > 5000 && L.black > 50 && L.white > 5000,
        `name=${L.name} 红=${L.red} 黑=${L.black} 白=${L.white}`);
      record('PDF 单页导入:activeLayerId 指向该层', res.activeIsLast, '');
    }

    // 2. 多页导入:两页 PDF → 2 图层「页 1」「页 2」,第二页有蓝色矩形
    {
      const res = await withTimeout(page.evaluate(async () => {
        const pdf = window.__buildPdf({
          pages: [
            '1 0 0 rg\n50 30 100 80 re\nf',
            '0 0 1 rg\n30 20 140 110 re\nf',
          ],
          mediaBox: [200, 150],
        });
        return window.__importPdfFromBytes(pdf, true);
      }), 60000, '多页 PDF 导入');
      const ok = res.n === 2
        && res.layers[0].name === '页 1' && res.layers[1].name === '页 2'
        && res.layers[0].red > 5000 && res.layers[0].blue === 0
        && res.layers[1].blue > 5000 && res.layers[1].red === 0;
      record('PDF 多页导入:两图层「页 1」「页 2」各页内容独立',
        ok,
        `层数=${res.n} 名=[${res.layers.map(l => l.name)}] `
          + `页1红=${res.layers[0]?.red} 页1蓝=${res.layers[0]?.blue} `
          + `页2蓝=${res.layers[1]?.blue} 页2红=${res.layers[1]?.red}`);
    }

    // 3. 多页 PDF + multiPage=false → 只导第 1 页,层名「PDF」
    {
      const res = await withTimeout(page.evaluate(async () => {
        const pdf = window.__buildPdf({
          pages: ['1 0 0 rg\n50 30 100 80 re\nf', '0 0 1 rg\n30 20 140 110 re\nf'],
          mediaBox: [200, 150],
        });
        return window.__importPdfFromBytes(pdf, false);
      }), 60000, '多页 PDF 单页导入');
      record('PDF multiPage=false:只导第 1 页且层名「PDF」',
        res.n === 1 && res.layers[0].name === 'PDF'
          && res.layers[0].red > 5000 && res.layers[0].blue === 0,
        `层数=${res.n} 名=${res.layers[0]?.name} 红=${res.layers[0]?.red} 蓝=${res.layers[0]?.blue}`);
    }

    // 4. 加密 PDF → 中文报错「PDF 已加密,暂不支持」
    {
      const r = await withTimeout(page.evaluate(async () => {
        const pdf = window.__buildPdf({
          pages: ['1 0 0 rg\n50 30 100 80 re\nf'],
          mediaBox: [200, 150],
          encrypt: true,
        });
        return window.__pdfTry(pdf, false);
      }), 60000, '加密 PDF 导入');
      record('加密 PDF → 中文报错',
        r.threw && r.msg.includes('PDF 已加密,暂不支持'), `msg=${r.msg}`);
    }

    // 5. 损坏文件 → 中文报错「无法解析 PDF 文件」
    {
      const r = await withTimeout(page.evaluate(async () => {
        const junk = Uint8Array.from('this is not a pdf at all, just junk bytes.', c => c.charCodeAt(0));
        return window.__pdfTry(junk, false);
      }), 60000, '损坏文件导入');
      record('损坏文件 → 中文报错',
        r.threw && r.msg.includes('无法解析 PDF 文件'), `msg=${r.msg}`);
    }

    // 6. 不存在的路径 → 中文报错「无法读取 PDF 文件」
    {
      const r = await withTimeout(page.evaluate(async () => {
        const pdf = window.__buildPdf({ pages: ['0 0 0 rg 10 10 10 10 re f'] });
        return window.__pdfTry(pdf, false, { path: 'C:/tmp/__missing__.pdf' });
      }), 60000, '坏路径导入');
      record('不存在的路径 → 中文报错',
        r.threw && r.msg.includes('无法读取 PDF 文件'), `msg=${r.msg}`);
    }

    // 7. 页数上限:51 页 → 中文报错
    {
      const r = await withTimeout(page.evaluate(async () => {
        const pages = Array.from({ length: 51 }, (_, i) => `${(i % 2)} 0 0 rg 10 10 20 20 re f`);
        const pdf = window.__buildPdf({ pages, mediaBox: [60, 60] });
        return window.__pdfTry(pdf, true);
      }), 60000, '51 页 PDF 导入');
      record('页数上限(51 页 → 中文报错)',
        r.threw && r.msg.includes('页数超出上限'), `msg=${r.msg}`);
    }

    // 汇总
    console.log('\n========== 结果汇总 ==========');
    const pass = results.filter(x => x.ok).length;
    console.log(`通过 ${pass}/${results.length}`);
    if (errors.length) {
      const relevant = errors.filter(e =>
        !e.includes('favicon') && !e.includes('WebSocket')); // dev server 噪声
      if (relevant.length) {
        console.log('\n⚠️ 页面报错(前10条):');
        relevant.slice(0, 10).forEach(e => console.log('  ' + e.slice(0, 200)));
      } else {
        console.log('无页面 JS 报错(仅 dev server 噪声)');
      }
    } else {
      console.log('无页面 JS 报错');
    }
  } finally {
    await browser?.close();
  }
}

run().catch(e => {
  console.error('测试脚本异常:', e);
  process.exit(1);
});
