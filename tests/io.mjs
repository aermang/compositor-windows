// Compositor — TIFF 导入/导出 + GIF 导出 浏览器端自动化测试(vite dev + Playwright)
// 仿 tests/e2e.mjs 测试 27 的 fake __TAURI_INTERNALS__ 手法:read_file/write_file
// 截获到内存 Map、plugin:dialog|save 返回虚拟路径,使真实保存/读取代码在纯 Chrome
// 里跑通。测试内部手工拼 TIFF 字节(头/IFD/条带)验证解码器,导出走 round-trip。
// 用法: NODE_PATH=<playwright目录>/node_modules node tests/io.mjs
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const pw = require2(process.env.PW_PATH || 'playwright');

const BASE = 'http://localhost:1420';
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const samePx = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

// —— 以下两个辅助仿 tests/e2e.mjs ——
async function uiMenu(page, top, item) {
  if (await page.locator('.menu-backdrop').count()) {
    await page.mouse.click(750, 500);
    await page.waitForTimeout(120);
  }
  await page.click(`.menubar .menu:has(button:text-is("${top}")) button.menu-btn`);
  await page.click(`.dropdown .menu-item:has-text("${item}")`);
  await page.waitForTimeout(200);
  if (await page.locator('.menu-backdrop').count()) {
    await page.evaluate(() =>
      document.querySelector('.menu-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForTimeout(120);
  }
}

async function uiNewDoc(page, w, h) {
  if (await page.locator('button.big:text-is("新建…")').count()) {
    await page.click('button.big:text-is("新建…")'); // 欢迎页
  } else {
    await uiMenu(page, '文件', '新建…'); // 已有文档时走菜单
  }
  const dlg = page.locator('.dialog', { hasText: '新建文档' });
  const nums = dlg.locator('input[type=number]');
  await nums.nth(0).fill(String(w));
  await nums.nth(1).fill(String(h));
  await dlg.locator('input[value=white]').check();
  await dlg.locator('button:has-text("创建")').click();
  await page.waitForTimeout(300);
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

    // 测试专用字节构造器,挂在 window 上供各用例复用
    await page.addInitScript(() => {
      // 最小 TIFF 组装器:只写规格所需 IFD 条目,支持 II/MM、内联/外置字段值
      window.__buildTiff = function (opt) {
        const le = opt.le !== false;
        const sizeOf = t => (t === 3 ? 2 : 4);
        const entries = [];
        const add = (tag, type, count, values) => entries.push({ tag, type, count, values });
        add(256, 4, 1, [opt.width]);
        add(257, 4, 1, [opt.height]);
        add(258, 3, opt.bitsPerSample.length, opt.bitsPerSample);
        add(259, 3, 1, [opt.compression ?? 1]);
        add(262, 3, 1, [opt.photometric]);
        add(273, 4, opt.strips.length, null); // StripOffsets(后填)
        add(277, 3, 1, [opt.spp]);
        add(278, 4, 1, [opt.rowsPerStrip ?? opt.height]);
        add(279, 4, opt.strips.length, null); // StripByteCounts(后填)
        entries.sort((a, b) => a.tag - b.tag);
        // 布局:头 8B + IFD + 外置字段值区 + 条带数据
        const ifdSize = 2 + entries.length * 12 + 4;
        let extraSize = 0;
        for (const e of entries) {
          const vs = e.count * sizeOf(e.type);
          if (vs > 4) { e.offset = extraSize; extraSize += vs + (vs & 1); }
        }
        const dataStart = 8 + ifdSize + extraSize;
        const stripOffsets = [], stripCounts = [];
        let q = dataStart;
        for (const s of opt.strips) { stripOffsets.push(q); stripCounts.push(s.length); q += s.length; }
        entries.find(e => e.tag === 273).values = stripOffsets;
        entries.find(e => e.tag === 279).values = stripCounts;
        const buf = new ArrayBuffer(q);
        const v = new DataView(buf);
        const u8 = new Uint8Array(buf);
        u8[0] = le ? 0x49 : 0x4d; u8[1] = u8[0]; // 'II' / 'MM'
        v.setUint16(2, 42, le);
        v.setUint32(4, 8, le);
        v.setUint16(8, entries.length, le);
        let p = 10;
        const extraPos = 8 + ifdSize;
        for (const e of entries) {
          v.setUint16(p, e.tag, le);
          v.setUint16(p + 2, e.type, le);
          v.setUint32(p + 4, e.count, le);
          const vs = e.count * sizeOf(e.type);
          const base = vs > 4 ? extraPos + e.offset : p + 8;
          if (vs > 4) v.setUint32(p + 8, base, le); // 值字段放外置区偏移
          for (let i = 0; i < e.count; i++) {
            if (e.type === 3) v.setUint16(base + i * 2, e.values[i], le);
            else v.setUint32(base + i * 4, e.values[i], le);
          }
          p += 12;
        }
        let d = dataStart;
        for (const s of opt.strips) { u8.set(s, d); d += s.length; }
        return new Uint8Array(buf);
      };
      // PackBits 测试编码:全同行 → 重复游程,否则字面量
      window.__packBitsRows = function (rows) {
        const out = [];
        for (const row of rows) {
          if (row.length >= 2 && row.every(b => b === row[0])) {
            out.push((1 - row.length) & 0xff, row[0]);
          } else {
            out.push(row.length - 1, ...row);
          }
        }
        return Uint8Array.from(out);
      };
      // TIFF LZW 测试编码(与解码规格镜像:MSB 打包、earlyChange=1、CLEAR/EOI)
      window.__tiffLzwEncode = function (data) {
        let width = 9, next = 258, bitBuf = 0, bitCnt = 0;
        const dict = new Map();
        const out = [];
        const put = code => {
          for (let i = width - 1; i >= 0; i--) {
            bitBuf = (bitBuf << 1) | ((code >> i) & 1);
            if (++bitCnt === 8) { out.push(bitBuf & 0xff); bitBuf = 0; bitCnt = 0; }
          }
        };
        put(256); // CLEAR
        let w = String(data[0]);
        for (let i = 1; i < data.length; i++) {
          const wc = w + ',' + data[i];
          if (dict.has(wc)) { w = wc; continue; }
          put(dict.get(w) ?? Number(w));
          dict.set(wc, next++);
          // TIFF earlyChange:解码器在 next=511/1023/2047 升位,编码器晚一档
          // 在 next=512/1024/2048 升位(已与 libtiff 生成物交叉验证)
          if (next === (1 << width) && width < 12) width++;
          w = String(data[i]);
        }
        put(dict.get(w) ?? Number(w));
        put(257); // EOI
        if (bitCnt > 0) out.push((bitBuf << (8 - bitCnt)) & 0xff);
        return Uint8Array.from(out);
      };
      // fake Tauri:read_file 回吐给定 bytes → 调真实 importTiff → 采样返回
      window.__importTiffFromBytes = async function (bytes, pts, verify) {
        const arr = Array.from(bytes);
        window.__TAURI_INTERNALS__ = {
          invoke: async (cmd, args) => {
            if (cmd === 'read_file') return arr;
            throw new Error('fake invoke: ' + cmd);
          },
        };
        try {
          const { importTiff } = await import('/src/core/io/tiff.ts');
          const doc = await importTiff('C:/tmp/in.tif');
          const bm = doc.layers[0].bitmap;
          const rd = (x, y) => {
            const d = bm.getContext('2d').getImageData(x, y, 1, 1).data;
            return [d[0], d[1], d[2], d[3]];
          };
          const samples = {};
          for (const [x, y] of pts ?? []) samples[x + ',' + y] = rd(x, y);
          return {
            w: doc.width, h: doc.height, res: doc.resolution, file: doc.fileName,
            layerName: doc.layers[0].name, layers: doc.layers.length,
            active: doc.activeLayerId === doc.layers[0].id,
            idSet: typeof doc.id === 'string' && doc.id.length > 0,
            samples,
            mismatch: verify ? verify(bm) : 0,
          };
        } finally { delete window.__TAURI_INTERNALS__; }
      };
    });

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    // 1. TIFF 解码:4×3 无压缩 RGB(II 小端),像素 (x,y)=(x*60, y*80, 200)
    {
      const r = await page.evaluate(async () => {
        const W = 4, H = 3, px = [];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.push(x * 60, y * 80, 200);
        const tiff = window.__buildTiff({
          le: true, width: W, height: H, bitsPerSample: [8, 8, 8], compression: 1,
          photometric: 2, spp: 3, rowsPerStrip: H, strips: [px],
        });
        return window.__importTiffFromBytes(tiff, [[0, 0], [3, 0], [0, 2], [3, 2]]);
      });
      record('TIFF 导入:4×3 无压缩 RGB(II 小端)',
        r.w === 4 && r.h === 3 && r.res === 72 && r.layers === 1 && r.layerName === 'TIFF'
          && r.active && r.idSet && r.file === 'in.tif'
          && samePx(r.samples['0,0'], [0, 0, 200, 255]) && samePx(r.samples['3,0'], [180, 0, 200, 255])
          && samePx(r.samples['0,2'], [0, 160, 200, 255]) && samePx(r.samples['3,2'], [180, 160, 200, 255]),
        `size=${r.w}x${r.h} res=${r.res} file=${r.file} px=${JSON.stringify(r.samples)}`);
    }

    // 2. TIFF 解码:4×3 PackBits 灰度(MM 大端,逐行 RLE)
    {
      const r = await page.evaluate(async () => {
        const rows = [[10, 20, 30, 40], [77, 77, 77, 77], [0, 255, 0, 255]];
        const tiff = window.__buildTiff({
          le: false, width: 4, height: 3, bitsPerSample: [8], compression: 32773,
          photometric: 1, spp: 1, rowsPerStrip: 1,
          strips: rows.map(row => window.__packBitsRows([row])), // 每行一条带,顺带验证条带拼装
        });
        return window.__importTiffFromBytes(tiff, [[0, 0], [2, 1], [0, 2], [1, 2]]);
      });
      record('TIFF 导入:4×3 PackBits 灰度(MM 大端,3 条带)',
        r.w === 4 && r.h === 3
          && samePx(r.samples['0,0'], [10, 10, 10, 255]) && samePx(r.samples['2,1'], [77, 77, 77, 255])
          && samePx(r.samples['0,2'], [0, 0, 0, 255]) && samePx(r.samples['1,2'], [255, 255, 255, 255]),
        `size=${r.w}x${r.h} px=${JSON.stringify(r.samples)}`);
    }

    // 3. TIFF 解码:LZW 手工字节向量(1×2 灰度;手算码流 CLEAR,65,66,EOI:
    //    100000000 001000001 001000010 100000001 → 80 10 48 50 10)
    {
      const r = await page.evaluate(async () => {
        const tiff = window.__buildTiff({
          le: true, width: 1, height: 2, bitsPerSample: [8], compression: 5,
          photometric: 1, spp: 1, rowsPerStrip: 2,
          strips: [Uint8Array.from([0x80, 0x10, 0x48, 0x50, 0x10])],
        });
        return window.__importTiffFromBytes(tiff, [[0, 0], [0, 1]]);
      });
      record('TIFF 导入:LZW 手工码流向量(1×2 灰度→65,66)',
        samePx(r.samples['0,0'], [65, 65, 65, 255]) && samePx(r.samples['0,1'], [66, 66, 66, 255]),
        `px=${JSON.stringify(r.samples)}`);
    }

    // 4. TIFF 解码:LZW 往返(32×32 灰度,码表增长跨 511 触发 9→10 位升位)
    {
      const r = await page.evaluate(async () => {
        const W = 32, H = 32, data = [];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.push((x * 7 + y * 3 + ((x * y) % 11)) % 251);
        const strip = window.__tiffLzwEncode(data);
        const tiff = window.__buildTiff({
          le: true, width: W, height: H, bitsPerSample: [8], compression: 5,
          photometric: 1, spp: 1, rowsPerStrip: H, strips: [strip],
        });
        const res = await window.__importTiffFromBytes(tiff, [], bm => {
          const d = bm.getContext('2d').getImageData(0, 0, W, H).data;
          let bad = 0;
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const v = data[y * W + x], i = (y * W + x) * 4;
            if (d[i] !== v || d[i + 1] !== v || d[i + 2] !== v || d[i + 3] !== 255) bad++;
          }
          return bad;
        });
        res.stripLen = strip.length;
        return res;
      });
      record('TIFF 导入:LZW 往返(32×32,1024 像素全比对)',
        r.w === 32 && r.h === 32 && r.mismatch === 0,
        `size=${r.w}x${r.h} 码流=${r.stripLen}B 不符像素=${r.mismatch}`);
    }

    // 5. TIFF 解码:16 位灰度取高字节(2×1,小端样本 0x1122/0xABCD → 0x11/0xAB)
    {
      const r = await page.evaluate(async () => {
        const tiff = window.__buildTiff({
          le: true, width: 2, height: 1, bitsPerSample: [16], compression: 1,
          photometric: 1, spp: 1, rowsPerStrip: 1,
          strips: [Uint8Array.from([0x22, 0x11, 0xcd, 0xab])],
        });
        return window.__importTiffFromBytes(tiff, [[0, 0], [1, 0]]);
      });
      record('TIFF 导入:16 位灰度取高字节',
        samePx(r.samples['0,0'], [17, 17, 17, 255]) && samePx(r.samples['1,0'], [171, 171, 171, 255]),
        `px=${JSON.stringify(r.samples)}`);
    }

    // 6. TIFF 导出往返:UI 新建 8×8 文档 → 图层位图换成测试图案 → 菜单「导出 TIFF…」
    //    (fake save 捕获 write_file)→ fake read_file → importTiff → 全像素比对。
    //    命令经应用自己的菜单派发(其内部 store/flattenDoc 全是应用模块图里的实例),
    //    避免并行 agent 触发 HMR 双实例分歧;importTiff 是纯函数,动态 import 安全。
    {
      await uiNewDoc(page, 8, 8);
      await page.evaluate(WH => {
        const [W, H] = WH;
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const g = c.getContext('2d');
        const img = g.createImageData(W, H);
        const expect = [];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          img.data[i] = (x * 37) % 256;
          img.data[i + 1] = (y * 29) % 256;
          img.data[i + 2] = (x + y * 13) % 256;
          img.data[i + 3] = 255;
          expect.push(img.data[i], img.data[i + 1], img.data[i + 2], 255);
        }
        g.putImageData(img, 0, 0);
        window.__rtExpect = expect;
        window.__store.doc.layers[0].bitmap = c; // 换画布身份 → 合成缓存失效
      }, [8, 8]);
      await page.evaluate(() => {
        const files = new Map();
        window.__files = files;
        window.__alerts = [];
        window.alert = m => window.__alerts.push(String(m)); // 命令失败走 alert,截获诊断
        window.__TAURI_INTERNALS__ = {
          invoke: async (cmd, args) => {
            if (cmd === 'plugin:dialog|save') return 'C:/tmp/rt.tif';
            const p = String(args?.path ?? '');
            if (cmd === 'write_file') { files.set(p, Uint8Array.from(args.bytes)); return; }
            if (cmd === 'read_file') return [...files.get(p)];
            throw new Error('fake invoke: ' + cmd);
          },
        };
      });
      await uiMenu(page, '文件', '导出 TIFF…');
      await page.waitForTimeout(250);
      const r = await page.evaluate(async () => {
        try {
          const wrote = window.__files.get('C:/tmp/rt.tif');
          if (!wrote) return { fail: 'write_file 未被调用(导出中途报错?)', alerts: window.__alerts };
          const head = [...wrote.slice(0, 4)].map(b => b.toString(16).padStart(2, '0')).join(' ');
          const { importTiff } = await import('/src/core/io/tiff.ts');
          const doc2 = await importTiff('C:/tmp/rt.tif');
          const d2 = doc2.layers[0].bitmap.getContext('2d').getImageData(0, 0, doc2.width, doc2.height).data;
          const expect = window.__rtExpect;
          let mismatch = 0;
          for (let i = 0; i < expect.length; i++) if (d2[i] !== expect[i]) mismatch++;
          return {
            head, bytes: wrote.length, w: doc2.width, h: doc2.height,
            res: doc2.resolution, layerName: doc2.layers[0].name, mismatch, alerts: window.__alerts,
          };
        } finally { delete window.__TAURI_INTERNALS__; }
      });
      record('TIFF 导出往返(导出→导入全像素一致)',
        !r.fail && r.head === '49 49 2a 00' && r.w === 8 && r.h === 8 && r.res === 72
          && r.layerName === 'TIFF' && r.mismatch === 0,
        r.fail ?? `头=${r.head} 字节=${r.bytes} 尺寸=${r.w}x${r.h} res=${r.res} 不符通道=${r.mismatch}`,
      );
      if (r.fail && r.alerts?.length) console.log('  ⚠️ alert:', r.alerts.join(' / '));
    }

    // 7. GIF 编码:两帧 16×16(100ms/200ms)结构 + 浏览器真解码
    {
      const r = await page.evaluate(async () => {
        const { encodeGif } = await import('/src/core/io/gifExport.ts');
        const mk = fill => {
          const c = document.createElement('canvas');
          c.width = 16; c.height = 16;
          const g = c.getContext('2d');
          g.fillStyle = fill;
          g.fillRect(0, 0, 16, 16);
          return c;
        };
        const buf = await encodeGif([
          { canvas: mk('#ff0000'), delayMs: 100 },
          { canvas: mk('#0000ff'), delayMs: 200 },
        ]);
        const u8 = new Uint8Array(buf);
        const head = String.fromCharCode(...u8.slice(0, 6));
        const hasNetscape = String.fromCharCode(...u8.slice(6)).includes('NETSCAPE2.0');
        // GCE 结构:21 F9 04 packed delayLo delayHi transp 00 → delay 取前两处
        const delays = [], packed = [];
        for (let i = 0; i + 7 < u8.length && delays.length < 2; i++) {
          if (u8[i] === 0x21 && u8[i + 1] === 0xf9 && u8[i + 2] === 0x04) {
            packed.push(u8[i + 3]);
            delays.push(u8[i + 4] | (u8[i + 5] << 8));
          }
        }
        // 图像描述符:2C + 左上(0,0) + 16×16 + 局部色表 flag
        let lct = 0;
        for (let i = 0; i + 9 < u8.length; i++) {
          if (u8[i] === 0x2c && u8[i + 1] === 0 && u8[i + 2] === 0 && u8[i + 3] === 0
            && u8[i + 4] === 0 && u8[i + 5] === 16 && u8[i + 7] === 16) { lct = u8[i + 9]; break; }
        }
        const gctFlag = (u8[10] & 0x80) !== 0 && (u8[10] & 7) === 7;
        const lw = u8[6] | (u8[7] << 8), lh = u8[8] | (u8[9] << 8);
        // 浏览器真解码:Blob → objectURL → Image
        const blob = new Blob([buf], { type: 'image/gif' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = () => rej(new Error('浏览器 GIF 解码失败'));
          img.src = url;
        });
        const t = document.createElement('canvas');
        t.width = 16; t.height = 16;
        t.getContext('2d').drawImage(img, 0, 0); // 动图 drawImage 取第一帧
        const firstPx = [...t.getContext('2d').getImageData(0, 0, 1, 1).data];
        URL.revokeObjectURL(url);
        return { head, trailer: u8[u8.length - 1], hasNetscape, delays, packed, lct, gctFlag, lw, lh, nw: img.naturalWidth, nh: img.naturalHeight, firstPx };
      });
      record('GIF 编码:头/循环扩展/GCE delay/尺寸/trailer',
        r.head === 'GIF89a' && r.hasNetscape && r.trailer === 0x3b
          && r.delays[0] === 10 && r.delays[1] === 20
          && r.packed.every(p => p === 0x04) && (r.lct & 0x80) !== 0 && (r.lct & 7) === 7
          && r.gctFlag && r.lw === 16 && r.lh === 16,
        `head=${r.head} NETSCAPE=${r.hasNetscape} delays=${JSON.stringify(r.delays)} `
          + `GCE=${JSON.stringify(r.packed)} LCT=0x${r.lct.toString(16)} GCT=${r.gctFlag} LSD=${r.lw}x${r.lh} 尾=${r.trailer}`);
      record('GIF 编码:浏览器真解码(naturalWidth=16,首帧红色)',
        r.nw === 16 && r.nh === 16 && samePx(r.firstPx, [255, 0, 0, 255]),
        `${r.nw}x${r.nh} 首像素=${JSON.stringify(r.firstPx)}`);
    }

    // 8. GIF 帧数上限:65 帧抛中文错误
    {
      const r = await page.evaluate(async () => {
        const { encodeGif } = await import('/src/core/io/gifExport.ts');
        const mk = () => {
          const c = document.createElement('canvas');
          c.width = 2; c.height = 2;
          return c;
        };
        try {
          await encodeGif(Array.from({ length: 65 }, () => ({ canvas: mk(), delayMs: 100 })));
          return { threw: false, msg: '' };
        } catch (e) { return { threw: true, msg: String(e?.message ?? e) }; }
      });
      record('GIF 帧数上限(65 帧抛中文错误)',
        r.threw && r.msg.includes('GIF 最多支持 64 帧'), `msg=${r.msg}`);
    }

    // 9. exportGifCommand:UI 新建 12×10 文档 → 图层位图换成纯绿 → 菜单
    //    「导出 GIF 动画…」(无时间轴 → 单帧合成)→ fake save/write_file
    //    → 浏览器真解码。命令经应用菜单派发,规避 HMR 双实例(同测试 6)。
    {
      await uiNewDoc(page, 12, 10);
      await page.evaluate(wh => {
        const c = document.createElement('canvas');
        c.width = wh[0]; c.height = wh[1];
        const g = c.getContext('2d');
        g.fillStyle = '#00ff00';
        g.fillRect(0, 0, c.width, c.height);
        window.__store.doc.layers[0].bitmap = c; // 换画布身份 → 合成缓存失效
      }, [12, 10]);
      await page.evaluate(() => {
        const files = new Map();
        window.__files = files;
        window.__alerts = [];
        window.alert = m => window.__alerts.push(String(m));
        window.__TAURI_INTERNALS__ = {
          invoke: async (cmd, args) => {
            if (cmd === 'plugin:dialog|save') return 'C:/tmp/out.gif';
            const p = String(args?.path ?? '');
            if (cmd === 'write_file') { files.set(p, Uint8Array.from(args.bytes)); return; }
            throw new Error('fake invoke: ' + cmd);
          },
        };
      });
      await uiMenu(page, '文件', '导出 GIF 动画…');
      await page.waitForTimeout(250);
      const r = await page.evaluate(async () => {
        try {
          const bytes = window.__files.get('C:/tmp/out.gif');
          if (!bytes) return { fail: 'write_file 未被调用(导出中途报错?)', alerts: window.__alerts };
          const head = String.fromCharCode(...bytes.slice(0, 6));
          const trailer = bytes[bytes.length - 1];
          const blob = new Blob([bytes], { type: 'image/gif' });
          const url = URL.createObjectURL(blob);
          const img = new Image();
          await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = () => rej(new Error('浏览器 GIF 解码失败'));
            img.src = url;
          });
          const t = document.createElement('canvas');
          t.width = img.naturalWidth; t.height = img.naturalHeight;
          t.getContext('2d').drawImage(img, 0, 0);
          const px = [...t.getContext('2d').getImageData(5, 5, 1, 1).data];
          URL.revokeObjectURL(url);
          return { head, trailer, nw: img.naturalWidth, nh: img.naturalHeight, px };
        } finally { delete window.__TAURI_INTERNALS__; }
      });
      record('exportGifCommand(无时间轴单帧→写盘→真解码)',
        !r.fail && r.head === 'GIF89a' && r.trailer === 0x3b
          && r.nw === 12 && r.nh === 10 && samePx(r.px, [0, 255, 0, 255]),
        r.fail ?? `head=${r.head} 尾=${r.trailer} ${r.nw}x${r.nh} 像素=${JSON.stringify(r.px)}`);
      if (r.fail && r.alerts?.length) console.log('  ⚠️ alert:', r.alerts.join(' / '));
    }

    // 汇总
    console.log('\n========== 结果汇总 ==========');
    const pass = results.filter(x => x.ok).length;
    console.log(`通过 ${pass}/${results.length}`);
    if (errors.length) {
      console.log('\n⚠️ 页面报错(前10条):');
      errors.slice(0, 10).forEach(e => console.log('  ' + e.slice(0, 200)));
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
