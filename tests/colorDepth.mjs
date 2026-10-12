// Compositor — 16-bit 与 ICC 色彩 IO 浏览器端自动化测试(vite dev + Playwright)
// 仿 tests/io.mjs 的 fake __TAURI_INTERNALS__ 手法:read_file/write_file 截获到
// 内存 Map、plugin:dialog|save 返回虚拟路径。ICC profile 一律测试侧手工拼字节
// (最小 desc/mluc profile),PNG 的 iCCP 也用测试侧独立 CRC 注入,避免与被测
// 实现循环验证;TIFF 导出走应用自己的菜单命令(规避 HMR 双实例,同 io.mjs 测 6)。
// 用法: NODE_PATH=<playwright目录>/node_modules node tests/colorDepth.mjs
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const pw = require2(process.env.PW_PATH || 'playwright');

const BASE = 'http://localhost:1420';
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const sameArr = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
const hex = arr => arr.slice(0, 8).map(v => v.toString(16).padStart(2, '0')).join(' ');

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
    await page.click('button.big:text-is("新建…")');
  } else {
    await uiMenu(page, '文件', '新建…');
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

    // 测试专用字节构造器(独立于被测实现),挂在 window 上供各用例复用
    await page.addInitScript(() => {
      // —— 独立 CRC32(多项式 0xEDB88320),只用于测试侧拼 iCCP chunk ——
      window.__crc32 = function (bytes) {
        let c;
        const make = () => {
          const t = new Uint32Array(256);
          for (let n = 0; n < 256; n++) {
            let x = n;
            for (let k = 0; k < 8; k++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1;
            t[n] = x >>> 0;
          }
          return t;
        };
        if (!window.__crcTable) window.__crcTable = make();
        c = 0xffffffff;
        for (let i = 0; i < bytes.length; i++) c = window.__crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
      };
      // —— 测试侧 iCCP 注入:插在 IHDR 之后(与被测实现相互独立验证;iCCP 载荷
      //    须为 zlib,压缩直接用平台 CompressionStream,不算被测实现) ——
      window.__insertIccpChunk = async function (pngU8, name, profile) {
        const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        for (let i = 0; i < 8; i++) if (pngU8[i] !== sig[i]) throw new Error('测试侧:PNG 签名不符');
        const compressed = new Uint8Array(await new Response(
          new Blob([profile]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
        const nameBytes = [];
        for (let i = 0; i < name.length; i++) nameBytes.push(name.charCodeAt(i) & 0xff);
        const payload = new Uint8Array(nameBytes.length + 2 + compressed.length);
        payload.set(Uint8Array.from(nameBytes), 0);
        payload[nameBytes.length] = 0;
        payload[nameBytes.length + 1] = 0;
        payload.set(compressed, nameBytes.length + 2);
        const chunk = new Uint8Array(12 + payload.length);
        new DataView(chunk.buffer).setUint32(0, payload.length);
        chunk[4] = 0x69; chunk[5] = 0x43; chunk[6] = 0x43; chunk[7] = 0x50; // 'iCCP'
        chunk.set(payload, 8);
        new DataView(chunk.buffer).setUint32(8 + payload.length, window.__crc32(chunk.subarray(4, 8 + payload.length)));
        // IHDR 总长 = 12 + 数据长度(数据固定 13B,但按长度字段解析更稳)
        const ihdrLen = new DataView(pngU8.buffer, pngU8.byteOffset).getUint32(8);
        const afterIhdr = 8 + 12 + ihdrLen;
        const out = new Uint8Array(pngU8.length + chunk.length);
        out.set(pngU8.subarray(0, afterIhdr), 0);
        out.set(chunk, afterIhdr);
        out.set(pngU8.subarray(afterIhdr), afterIhdr + chunk.length);
        return out;
      };
      // —— 最小合法 ICC profile:v2 'desc' 标签携带描述名 ——
      window.__makeIccWithDesc = function (name) {
        const be = s => Uint8Array.from([...s].map(c => c.charCodeAt(0) & 0xff));
        const descSize = 4 + 4 + 4 + name.length + 1 + 4 + 4 + 2 + 1 + 67;
        const tagOffset = 132 + 12;
        const total = tagOffset + descSize;
        const buf = new ArrayBuffer(total);
        const u8 = new Uint8Array(buf);
        const v = new DataView(buf);
        v.setUint32(0, total);
        v.setUint32(8, 0x02100000);          // 版本 2.1
        u8.set(be('mntr'), 12);
        u8.set(be('RGB '), 16);
        u8.set(be('XYZ '), 20);
        u8.set(be('acsp'), 36);
        v.setUint32(68, 0x0000f6d6); v.setUint32(72, 0x00010000); v.setUint32(76, 0x0000d32d); // D50
        v.setUint32(128, 1);                 // 1 个标签
        u8.set(be('desc'), 132);
        v.setUint32(136, tagOffset);
        v.setUint32(140, descSize);
        const d = tagOffset;
        u8.set(be('desc'), d);
        v.setUint32(d + 8, name.length + 1);
        u8.set(be(name), d + 12);
        v.setUint32(d + 12 + name.length + 1, 0); // unicode lang
        v.setUint32(d + 12 + name.length + 5, 0); // unicode count
        v.setUint16(d + 12 + name.length + 9, 0); // scriptcode code
        u8[d + 12 + name.length + 11] = 0;        // scriptcode count
        return u8;
      };
      // —— 最小合法 ICC profile:v4 'mluc' 标签携带 UTF-16BE 描述名 ——
      window.__makeIccWithMluc = function (name) {
        const be = s => Uint8Array.from([...s].map(c => c.charCodeAt(0) & 0xff));
        const nameUnits = [...name].map(c => c.charCodeAt(0));
        const strLen = nameUnits.length * 2;
        const descSize = 4 + 4 + 4 + 4 + 12 + strLen;
        const tagOffset = 132 + 12;
        const total = tagOffset + descSize;
        const buf = new ArrayBuffer(total);
        const u8 = new Uint8Array(buf);
        const v = new DataView(buf);
        v.setUint32(0, total);
        v.setUint32(8, 0x04300000);          // 版本 4.3
        u8.set(be('mntr'), 12);
        u8.set(be('RGB '), 16);
        u8.set(be('XYZ '), 20);
        u8.set(be('acsp'), 36);
        v.setUint32(128, 1);
        u8.set(be('desc'), 132);
        v.setUint32(136, tagOffset);
        v.setUint32(140, descSize);
        const d = tagOffset;
        u8.set(be('mluc'), d);
        v.setUint32(d + 8, 1);               // 记录数
        v.setUint32(d + 12, 12);             // 记录大小
        u8.set(be('zh'), d + 16);
        u8.set(be('CN'), d + 18);
        v.setUint32(d + 20, strLen);         // 字符串字节数
        v.setUint32(d + 24, 16 + 12);        // 字符串偏移(mluc 起点计:头16 + 记录12)
        nameUnits.forEach((unit, i) => v.setUint16(d + 28 + i * 2, unit));
        return u8;
      };
      // —— 测试侧 TIFF 解析:tag → 值(type 7 回吐字节数组) ——
      window.__parseTiffTags = function (bytes) {
        const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const le = bytes[0] === 0x49;
        const ifd = v.getUint32(4, le);
        const n = v.getUint16(ifd, le);
        const tags = {};
        let p = ifd + 2;
        const sizeOf = t => (t === 3 ? 2 : (t === 1 || t === 7) ? 1 : 4);
        for (let i = 0; i < n; i++, p += 12) {
          const tag = v.getUint16(p, le);
          const type = v.getUint16(p + 2, le);
          const count = v.getUint32(p + 4, le);
          const vs = count * sizeOf(type);
          const base = vs > 4 ? v.getUint32(p + 8, le) : p + 8;
          if (type === 7) tags[tag] = [...bytes.slice(base, base + count)];
          else {
            const vals = [];
            for (let j = 0; j < count; j++) {
              vals.push(type === 3 ? v.getUint16(base + j * 2, le) : v.getUint32(base + j * 4, le));
            }
            tags[tag] = vals;
          }
        }
        return tags;
      };
      // —— 最小 TIFF 组装器(仿 tests/io.mjs,支持 16bit 样本与 type 7) ——
      window.__buildTiff = function (opt) {
        const le = opt.le !== false;
        const sizeOf = t => (t === 3 ? 2 : (t === 1 || t === 7) ? 1 : 4);
        const entries = [];
        const add = (tag, type, count, values) => entries.push({ tag, type, count, values });
        add(256, 4, 1, [opt.width]);
        add(257, 4, 1, [opt.height]);
        add(258, 3, opt.bitsPerSample.length, opt.bitsPerSample);
        add(259, 3, 1, [opt.compression ?? 1]);
        add(262, 3, 1, [opt.photometric]);
        add(273, 4, opt.strips.length, null);
        add(277, 3, 1, [opt.spp]);
        add(278, 4, 1, [opt.rowsPerStrip ?? opt.height]);
        add(279, 4, opt.strips.length, null);
        if (opt.icc) add(34675, 7, opt.icc.length, null);
        entries.sort((a, b) => a.tag - b.tag);
        const ifdSize = 2 + entries.length * 12 + 4;
        let extraSize = 0;
        for (const e of entries) {
          const vs = e.type === 7 ? e.count : e.count * sizeOf(e.type);
          if (vs > 4) { e.offset = extraSize; extraSize += vs + (vs & 1); }
        }
        const dataStart = 8 + ifdSize + extraSize;
        const stripOffsets = [], stripCounts = [];
        let q = dataStart;
        for (const s of opt.strips) { stripOffsets.push(q); stripCounts.push(s.length); q += s.length; }
        entries.find(e => e.tag === 273).values = stripOffsets;
        entries.find(e => e.tag === 279).values = stripCounts;
        if (opt.icc) entries.find(e => e.tag === 34675).values = [dataStart + opt.strips.reduce((a, s) => a + s.length, 0)];
        const buf = new ArrayBuffer(q + (opt.icc ? opt.icc.length : 0));
        const v = new DataView(buf);
        const u8 = new Uint8Array(buf);
        u8[0] = le ? 0x49 : 0x4d; u8[1] = u8[0];
        v.setUint16(2, 42, le);
        v.setUint32(4, 8, le);
        v.setUint16(8, entries.length, le);
        let p = 10;
        const extraPos = 8 + ifdSize;
        for (const e of entries) {
          v.setUint16(p, e.tag, le);
          v.setUint16(p + 2, e.type, le);
          v.setUint32(p + 4, e.count, le);
          const vs = e.type === 7 ? e.count : e.count * sizeOf(e.type);
          const base = vs > 4 ? extraPos + e.offset : p + 8;
          if (vs > 4) v.setUint32(p + 8, base, le);
          if (e.type === 7) u8.set(opt.icc, base);
          else for (let i = 0; i < e.count; i++) {
            if (e.type === 3) v.setUint16(base + i * 2, e.values[i], le);
            else v.setUint32(base + i * 4, e.values[i], le);
          }
          p += 12;
        }
        let d = dataStart;
        for (const s of opt.strips) { u8.set(s, d); d += s.length; }
        return new Uint8Array(buf);
      };
      // —— fake Tauri:read_file 回吐字节 → openImageWithMeta / importTiff ——
      window.__withFakeRead = async function (bytes, fn) {
        const arr = Array.from(bytes);
        window.__TAURI_INTERNALS__ = {
          invoke: async cmd => {
            if (cmd === 'read_file') return arr;
            throw new Error('fake invoke: ' + cmd);
          },
        };
        try { return await fn(); } finally { delete window.__TAURI_INTERNALS__; }
      };
    });

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    // 1. PNG iCCP 提取:测试侧独立 CRC 拼带 iCCP 的 PNG → openImageWithMeta
    //    拿到 profile 字节 + 描述名;plain PNG / WebP 不带 ICC。
    {
      const r = await page.evaluate(async () => {
        const c = document.createElement('canvas');
        c.width = 6; c.height = 4;
        const g = c.getContext('2d');
        g.fillStyle = '#c04080';
        g.fillRect(0, 0, 6, 4);
        const png = new Uint8Array(await (await new Promise(res => c.toBlob(res, 'image/png'))).arrayBuffer());
        const prof = window.__makeIccWithDesc('TestRGB v1');
        const withIcc = await window.__insertIccpChunk(png, 'Test Profile', prof);
        const meta = await window.__withFakeRead(withIcc, async () => {
          const { openImageWithMeta, openImageFile } = await import('/src/core/io/raster.ts');
          const m = await openImageWithMeta('C:/tmp/in.png');
          const legacy = await openImageFile('C:/tmp/in.png'); // 薄包装仍可用
          return {
            w: m.canvas.width, h: m.canvas.height,
            icc: m.icc ? [...m.icc] : null, iccName: m.iccName ?? null,
            legacyW: legacy.width,
            px: [...m.canvas.getContext('2d').getImageData(3, 2, 1, 1).data],
          };
        });
        const plain = await window.__withFakeRead(png, async () => {
          const { openImageWithMeta } = await import('/src/core/io/raster.ts');
          return await openImageWithMeta('C:/tmp/in.png');
        });
        // WebP:浏览器编码一张,openImageWithMeta 应返回无 ICC
        const webpBlob = await new Promise(res => c.toBlob(res, 'image/webp'));
        const webp = webpBlob ? await window.__withFakeRead(new Uint8Array(await webpBlob.arrayBuffer()), async () => {
          const { openImageWithMeta } = await import('/src/core/io/raster.ts');
          return await openImageWithMeta('C:/tmp/in.webp');
        }) : null;
        const { extractIccFromPng } = await import('/src/core/io/icc.ts');
        const ext = await extractIccFromPng(withIcc);
        return {
          meta, plainIcc: plain.icc ?? null, webpIcc: webp ? (webp.icc ?? null) : 'skip',
          extName: ext?.name ?? null, extProf: ext ? [...ext.profile] : null, prof: [...prof],
        };
      });
      record('PNG iCCP 提取:openImageWithMeta 拿到 profile + 描述名;plain/WebP 无 ICC',
        r.meta.w === 6 && r.meta.h === 4 && r.meta.legacyW === 6
          && sameArr(r.meta.icc, r.prof) && r.meta.iccName === 'TestRGB v1'
          && sameArr(r.meta.px, [192, 64, 128, 255])
          && r.plainIcc === null && (r.webpIcc === 'skip' || r.webpIcc === null)
          && r.extName === 'Test Profile' && sameArr(r.extProf, r.prof),
        `meta=${r.meta.w}x${r.meta.h} iccName=${r.meta.iccName} icc=${r.meta.icc ? r.meta.icc.length + 'B' : 'null'} `
          + `plainIcc=${r.plainIcc} webpIcc=${r.webpIcc} extName=${r.extName}`);
    }

    // 2. injectIccPng 往返:注入 → 提取字节一致;iCCP 位于 IHDR 之后且唯一;
    //    浏览器 Blob 解码不受影响;重复注入替换旧块。
    {
      const r = await page.evaluate(async () => {
        const { injectIccPng, extractIccFromPng } = await import('/src/core/io/icc.ts');
        const c = document.createElement('canvas');
        c.width = 10; c.height = 7;
        const g = c.getContext('2d');
        g.fillStyle = '#123456';
        g.fillRect(0, 0, 10, 7);
        const png = new Uint8Array(await (await new Promise(res => c.toBlob(res, 'image/png'))).arrayBuffer());
        const prof = window.__makeIccWithDesc('Injected sRGB');
        const prof2 = window.__makeIccWithDesc('Second Profile');
        const inj = await injectIccPng(png, prof);
        const ext = await extractIccFromPng(inj);
        // chunk 顺序:iCCP 应在 IHDR(下标 0)之后,且只出现一次
        const types = [];
        let pos = 8;
        const v = new DataView(inj.buffer);
        while (pos + 12 <= inj.length) {
          const len = v.getUint32(pos);
          types.push(String.fromCharCode(inj[pos + 4], inj[pos + 5], inj[pos + 6], inj[pos + 7]));
          pos += 12 + len;
        }
        // 浏览器真解码
        const blob = new Blob([inj], { type: 'image/png' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('解码失败')); img.src = url; });
        const nw = img.naturalWidth;
        const t = document.createElement('canvas');
        t.width = img.naturalWidth; t.height = img.naturalHeight;
        t.getContext('2d').drawImage(img, 0, 0);
        const px = [...t.getContext('2d').getImageData(2, 5, 1, 1).data];
        URL.revokeObjectURL(url);
        // 重复注入:替换而非堆叠
        const inj2 = await injectIccPng(inj, prof2);
        const ext2 = await extractIccFromPng(inj2);
        const countIccp = inj2Types => inj2Types;
        return {
          ext: ext ? [...ext.profile] : null, prof: [...prof], name: ext?.name ?? null,
          types, nw, px,
          ext2: ext2 ? [...ext2.profile] : null, prof2: [...prof2],
          inj2IccpCount: countIccp(1) && (() => {
            let n = 0, p2 = 8;
            const v2 = new DataView(inj2.buffer);
            while (p2 + 12 <= inj2.length) {
              const len = v2.getUint32(p2);
              if (inj2[p2 + 4] === 0x69 && inj2[p2 + 5] === 0x43 && inj2[p2 + 6] === 0x43 && inj2[p2 + 7] === 0x50) n++;
              p2 += 12 + len;
            }
            return n;
          })(),
        };
      });
      const iccpCount = r.types.filter(t => t === 'iCCP').length;
      const ihdrIdx = r.types.indexOf('IHDR');
      const iccpIdx = r.types.indexOf('iCCP');
      record('injectIccPng 往返:字节一致 + IHDR 之后 + 唯一 + 浏览器解码不受影响 + 重注入替换',
        sameArr(r.ext, r.prof) && ihdrIdx === 0 && iccpIdx === 1 && iccpCount === 1
          && r.nw === 10 && sameArr(r.px, [18, 52, 86, 255])
          && sameArr(r.ext2, r.prof2) && r.inj2IccpCount === 1 && r.name !== '',
        `icc=${r.ext?.length}B name=${r.name} chunks=${r.types.slice(0, 4).join(',')}… nw=${r.nw} re-inject=${r.inj2IccpCount}`);
    }

    // 3. injectIccJpeg 往返:小 profile 单段 + 7 万字节 profile 分多段;
    //    提取字节一致;Image 加载成功。
    {
      const r = await page.evaluate(async () => {
        const { injectIccJpeg, extractIccFromJpeg } = await import('/src/core/io/icc.ts');
        const c = document.createElement('canvas');
        c.width = 8; c.height = 9;
        const g = c.getContext('2d');
        g.fillStyle = '#00aa44';
        g.fillRect(0, 0, 8, 9);
        const jpeg = new Uint8Array(await (await new Promise(res => c.toBlob(res, 'image/jpeg', 0.92))).arrayBuffer());
        if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('canvas 未产出 JPEG');
        const small = window.__makeIccWithDesc('Small JPEG ICC');
        const injSmall = await injectIccJpeg(jpeg, small);
        const extSmall = await extractIccFromJpeg(injSmall);
        // 大 profile:65519+300 → 两段
        const base = window.__makeIccWithDesc('Large JPEG ICC');
        const big = new Uint8Array(65819);
        big.set(base, 0);
        for (let i = base.length; i < big.length; i++) big[i] = i & 0xff;
        const injBig = await injectIccJpeg(jpeg, big);
        const extBig = await extractIccFromJpeg(injBig);
        // 段结构:APP2 数量、段长上限
        const segLens = [];
        let pos = 2;
        while (pos + 4 <= injBig.length) {
          if (injBig[pos] !== 0xff) break;
          const m = injBig[pos + 1];
          if (m === 0xda || m === 0xd9) break;
          const len = (injBig[pos + 2] << 8) | injBig[pos + 3];
          if (m === 0xe2) segLens.push(len);
          pos += 2 + len;
        }
        // Image 加载成功(小段注入版)
        const blob = new Blob([injSmall], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('解码失败')); img.src = url; });
        URL.revokeObjectURL(url);
        return {
          small: extSmall ? [...extSmall.profile] : null, smallProf: [...small],
          big: extBig ? [...extBig.profile] : null, bigLen: big.length,
          segLens, nw: img.naturalWidth, nh: img.naturalHeight,
        };
      });
      record('injectIccJpeg 往返:单段字节一致 + 多段结构(2 段、段长≤65535)+ Image 加载成功',
        sameArr(r.small, r.smallProf) && !!r.big && r.big.length === r.bigLen
          && r.segLens.length === 2 && r.segLens.every(l => l <= 65535)
          && r.nw === 8 && r.nh === 9,
        `small=${r.small?.length}B big=${r.big?.length}/${r.bigLen}B segLens=${JSON.stringify(r.segLens)} ${r.nw}x${r.nh}`);
    }

    // 3b. 大 profile 字节级严格比对(65819B = 65519 + 300)
    {
      const r = await page.evaluate(async () => {
        const { injectIccJpeg, extractIccFromJpeg } = await import('/src/core/io/icc.ts');
        const c = document.createElement('canvas');
        c.width = 4; c.height = 4;
        const jpeg = new Uint8Array(await (await new Promise(res => c.toBlob(res, 'image/jpeg'))).arrayBuffer());
        const base = window.__makeIccWithDesc('Large JPEG ICC');
        const big = new Uint8Array(65819);
        big.set(base, 0);
        for (let i = base.length; i < big.length; i++) big[i] = i & 0xff;
        const expect = [...big];
        const inj = await injectIccJpeg(jpeg, big);
        const ext = await extractIccFromJpeg(inj);
        return { got: ext ? [...ext.profile] : null, expect };
      });
      record('injectIccJpeg 多段逐字节一致(65819B)',
        sameArr(r.got, r.expect),
        `got=${r.got?.length}B expect=${r.expect.length}B`);
    }

    // 4. exportCanvas 可选 ICC:带 { icc } 导出 PNG 含 iCCP 且字节一致;
    //    不传参数导出与旧行为一致(无 iCCP)。
    {
      const r = await page.evaluate(async () => {
        const files = new Map();
        window.__TAURI_INTERNALS__ = {
          invoke: async (cmd, args) => {
            const p = String(args?.path ?? '');
            if (cmd === 'write_file') { files.set(p, Uint8Array.from(args.bytes)); return; }
            throw new Error('fake invoke: ' + cmd);
          },
        };
        try {
          const { exportCanvas } = await import('/src/core/io/raster.ts');
          const { extractIccFromPng } = await import('/src/core/io/icc.ts');
          const c = document.createElement('canvas');
          c.width = 5; c.height = 3;
          const g = c.getContext('2d');
          g.fillStyle = '#f08020';
          g.fillRect(0, 0, 5, 3);
          const prof = window.__makeIccWithDesc('Export Channel ICC');
          await exportCanvas(c, 'C:/tmp/icc.png', 'png', 0.92, { icc: prof });
          await exportCanvas(c, 'C:/tmp/plain.png', 'png'); // 不传 → 零行为变化
          const iccBytes = files.get('C:/tmp/icc.png');
          const plainBytes = files.get('C:/tmp/plain.png');
          const ext = await extractIccFromPng(iccBytes);
          const plainExt = await extractIccFromPng(plainBytes);
          const countIccp = bytes => {
            let n = 0, pos = 8;
            const v = new DataView(bytes.buffer);
            while (pos + 12 <= bytes.length) {
              const len = v.getUint32(pos);
              if (bytes[pos + 4] === 0x69 && bytes[pos + 5] === 0x43 && bytes[pos + 6] === 0x43 && bytes[pos + 7] === 0x50) n++;
              pos += 12 + len;
            }
            return n;
          };
          return {
            icc: ext ? [...ext.profile] : null, prof: [...prof],
            plain: plainExt ? 'has' : 'none',
            iccpCount: countIccp(iccBytes), plainSize: plainBytes.length, iccSize: iccBytes.length,
          };
        } finally { delete window.__TAURI_INTERNALS__; }
      });
      record('exportCanvas 可选 ICC 回写:PNG 含 iCCP 字节一致;缺省无 iCCP(零行为)',
        sameArr(r.icc, r.prof) && r.iccpCount === 1 && r.plain === 'none',
        `icc=${r.icc ? r.icc.length + 'B' : 'null'} iccp=${r.iccpCount} plainIcc=${r.plain} plain=${r.plainSize}B iccFile=${r.iccSize}B`);
    }

    // 5. TIFF 16bit 导入:4×3 16bit 灰度,采样取高字节,doc.bitDepth=16
    {
      const r = await page.evaluate(async () => {
        const samples = [0x1234, 0xabcd, 0x00ff, 0x8001, 0x7fff, 0xffff, 0x0001, 0x0203, 0x4050, 0x6070, 0x090a, 0x0b0c];
        const strip = new Uint8Array(samples.length * 2);
        const sv = new DataView(strip.buffer);
        samples.forEach((s, i) => sv.setUint16(i * 2, s, true)); // II 小端
        const tiff = window.__buildTiff({
          le: true, width: 4, height: 3, bitsPerSample: [16], compression: 1,
          photometric: 1, spp: 1, rowsPerStrip: 3, strips: [strip],
        });
        return await window.__withFakeRead(tiff, async () => {
          const { importTiff } = await import('/src/core/io/tiff.ts');
          const doc = await importTiff('C:/tmp/in16.tif');
          const bm = doc.layers[0].bitmap;
          const rd = (x, y) => [...bm.getContext('2d').getImageData(x, y, 1, 1).data];
          return {
            w: doc.width, h: doc.height, bitDepth: doc.bitDepth ?? null,
            px: { '0,0': rd(0, 0), '1,0': rd(1, 0), '2,0': rd(2, 0), '3,0': rd(3, 0), '3,2': rd(3, 2) },
          };
        });
      });
      const hi = s => (s >> 8) & 0xff;
      record('TIFF 导入:4×3 16bit 灰度取高字节 + bitDepth=16',
        r.w === 4 && r.h === 3 && r.bitDepth === 16
          && sameArr(r.px['0,0'], [hi(0x1234), hi(0x1234), hi(0x1234), 255])
          && sameArr(r.px['1,0'], [hi(0xabcd), hi(0xabcd), hi(0xabcd), 255])
          && sameArr(r.px['2,0'], [hi(0x00ff), hi(0x00ff), hi(0x00ff), 255])
          && sameArr(r.px['3,0'], [hi(0x8001), hi(0x8001), hi(0x8001), 255])
          && sameArr(r.px['3,2'], [hi(0x0b0c), hi(0x0b0c), hi(0x0b0c), 255]),
        `size=${r.w}x${r.h} bitDepth=${r.bitDepth} px=${JSON.stringify(r.px)}`);
    }

    // 6. TIFF 16bit 导出 + ICC 回写:UI 新建 8×8 → doc.bitDepth=16 + iccProfile
    //    → 菜单导出(fake save 捕获 write_file)→ 解析 tag 258/34675 + profile
    //    字节一致 → importTiff 读回像素一致、icc 一致、bitDepth=16。
    {
      const prof = await page.evaluate(() => [...window.__makeIccWithDesc('Export16 sRGB')]);
      await uiNewDoc(page, 8, 8);
      await page.evaluate(({ profBytes, wh }) => {
        const [W, H] = wh;
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
        window.__store.doc.bitDepth = 16;
        window.__store.doc.iccProfile = Uint8Array.from(profBytes);
        window.__store.doc.iccName = 'Export16 sRGB';
      }, { profBytes: prof, wh: [8, 8] });
      await page.evaluate(() => {
        const files = new Map();
        window.__files = files;
        window.__alerts = [];
        window.alert = m => window.__alerts.push(String(m));
        window.__TAURI_INTERNALS__ = {
          invoke: async (cmd, args) => {
            if (cmd === 'plugin:dialog|save') return 'C:/tmp/rt16.tif';
            const p = String(args?.path ?? '');
            if (cmd === 'write_file') { files.set(p, Uint8Array.from(args.bytes)); return; }
            if (cmd === 'read_file') return [...files.get(p)];
            throw new Error('fake invoke: ' + cmd);
          },
        };
      });
      await uiMenu(page, '文件', '导出 TIFF…');
      await page.waitForTimeout(300);
      const r = await page.evaluate(async profBytes => {
        try {
          const wrote = window.__files.get('C:/tmp/rt16.tif');
          if (!wrote) return { fail: 'write_file 未被调用(导出中途报错?)', alerts: window.__alerts };
          const tags = window.__parseTiffTags(wrote);
          const { importTiff } = await import('/src/core/io/tiff.ts');
          const doc = await importTiff('C:/tmp/rt16.tif');
          const d2 = doc.layers[0].bitmap.getContext('2d').getImageData(0, 0, doc.width, doc.height).data;
          const expect = window.__rtExpect;
          let mismatch = 0;
          for (let i = 0; i < expect.length; i++) if (d2[i] !== expect[i]) mismatch++;
          return {
            bps: tags[258], strip: tags[279], icc: tags[34675] ?? null,
            iccOk: tags[34675] ? sameIcc(tags[34675], profBytes) : false,
            px: mismatch, bitDepth: doc.bitDepth ?? null,
            iccBack: doc.iccProfile ? sameIcc([...doc.iccProfile], profBytes) : false,
            alerts: window.__alerts,
          };
          function sameIcc(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }
        } finally { delete window.__TAURI_INTERNALS__; }
      }, prof);
      record('TIFF 16bit 导出:BitsPerSample[16×4] + tag34675 字节一致 + 读回像素/bitDepth/ICC',
        !r.fail && sameArr(r.bps, [16, 16, 16, 16]) && r.iccOk
          && r.px === 0 && r.bitDepth === 16 && r.iccBack,
        r.fail ?? `bps=${JSON.stringify(r.bps)} icc=${Array.isArray(r.icc) ? r.icc.length + 'B' : 'null'} `
          + `不符通道=${r.px} bitDepth=${r.bitDepth} iccBack=${r.iccBack}`,
      );
      if (r.fail && r.alerts?.length) console.log('  ⚠️ alert:', r.alerts.join(' / '));
    }

    // 7. iccDescription / identifySpace:v2 desc、v4 mluc、损坏回退。
    {
      const r = await page.evaluate(async () => {
        const { iccDescription, identifySpace } = await import('/src/core/io/icc.ts');
        const garbage = new Uint8Array(300).fill(9);
        const mluc = window.__makeIccWithMluc('宽色域 P3');
        return {
          srgb: iccDescription(window.__makeIccWithDesc('sRGB IEC61966-2.1')),
          srgbSpace: identifySpace(window.__makeIccWithDesc('sRGB IEC61966-2.1')),
          p3: iccDescription(window.__makeIccWithDesc('Display P3')),
          p3Space: identifySpace(window.__makeIccWithDesc('Display P3')),
          adobe: iccDescription(window.__makeIccWithDesc('Adobe RGB (1998)')),
          adobeSpace: identifySpace(window.__makeIccWithDesc('Adobe RGB (1998)')),
          mlucName: iccDescription(mluc),
          mlucSpace: identifySpace(mluc),
          garbage: iccDescription(garbage),
          garbageSpace: identifySpace(garbage),
        };
      });
      record('iccDescription/identifySpace:desc/mluc 解析 + 回退',
        r.srgb === 'sRGB IEC61966-2.1' && r.srgbSpace === 'srgb'
          && r.p3 === 'Display P3' && r.p3Space === 'display-p3'
          && r.adobe === 'Adobe RGB (1998)' && r.adobeSpace === 'other'
          && r.mlucName === '宽色域 P3' && r.mlucSpace === 'display-p3'
          && r.garbage === 'ICC Profile' && r.garbageSpace === 'other',
        `srgb=${r.srgb} p3=${r.p3} adobe=${r.adobe} mluc=${r.mlucName} garbage=${r.garbage} `
          + `spaces=${r.srgbSpace}/${r.p3Space}/${r.adobeSpace}/${r.mlucSpace}/${r.garbageSpace}`);
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
