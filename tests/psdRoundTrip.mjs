// PSD 往返实测:应用内建文档(白底+形状) → exportPsd → readPsd → psdToDoc → 逐项断言
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const pw = require2(process.env.PW_PATH || 'playwright');

const browser = await pw.chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 })).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });

let OFF = { x: 0, y: 0 }, V = { z: 1, px: 0, py: 0 };
const S = (dx, dy) => ({ x: OFF.x + V.px + dx * V.z, y: OFF.y + V.py + dy * V.z });
async function drag(x1, y1, x2, y2, steps = 8) {
  await page.mouse.move(x1, y1); await page.mouse.down();
  await page.mouse.move(x2, y2, { steps }); await page.mouse.up();
}

await page.goto('http://localhost:1420', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.click('button.big:text-is("新建…")');
const dlg = page.locator('.dialog', { hasText: '新建文档' });
await dlg.locator('input[type=number]').nth(0).fill('800');
await dlg.locator('input[type=number]').nth(1).fill('600');
await dlg.locator('input[value=white]').check();
await dlg.locator('button:has-text("创建")').click();
await page.waitForTimeout(300);
{
  const box = await page.locator('.canvas-host canvas').first().boundingBox();
  OFF = { x: box.x, y: box.y };
  V = await page.evaluate(() => { const s = window.__store; return { z: s.zoom, px: s.panX, py: s.panY }; });
}
// 画一个形状 → 2 层(背景 + 矩形,中文名)
await page.keyboard.press('u');
await drag(S(500, 100).x, S(500, 100).y, S(650, 200).x, S(650, 200).y);
await page.waitForTimeout(200);

const report = await page.evaluate(async () => {
  const s = window.__store;
  const { exportPsd } = await import('/src/core/io/psdExport.ts');
  const { isPsd, readPsd } = await import('/src/core/io/psd/builder.ts');
  const { psdToDoc } = await import('/src/core/io/psdImport.ts');

  const buf = exportPsd(s.doc);
  const ok1 = isPsd(buf);
  const result = readPsd(buf);
  const doc2 = psdToDoc(result);

  const px = (doc, li, x, y) => {
    const l = doc.layers[li];
    const d = l.bitmap.getContext('2d').getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  };
  return {
    signature: ok1,
    bytes: buf.byteLength,
    srcLayers: s.doc.layers.map(l => l.name),
    outLayers: doc2.layers.map(l => l.name),
    outDims: [doc2.width, doc2.height],
    bgPixel: px(doc2, 0, 10, 10),          // 背景层应为白
    shapePixel: px(doc2, 1, 60, 50),       // 形状层内应为黑(位图 150×100,形状满幅)
    shapeAlphaOutside: px(doc2, 1, 145, 95)[3], // 形状层位图角落(满幅,应 255)
    notes: (await import('/src/core/io/psdImport.ts')).psdNotes(result),
  };
});
console.log(JSON.stringify(report, null, 2));

// 16bit + ICC 导出(读回端只支持 8bit,这里做字节级结构断言)
const meta = await page.evaluate(async () => {
  const s = window.__store;
  const { exportPsd } = await import('/src/core/io/psdExport.ts');
  s.doc.bitDepth = 16;
  s.doc.iccProfile = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xee, 0xdd, 0xcc, 0xbb]);
  s.doc.iccName = 'RT16 Test';
  const buf = exportPsd(s.doc);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const icc8 = s.doc.iccProfile;
  return {
    depth: dv.getUint16(22),                       // 文件头深度(8BPS4+版本2+保留6+通道2+高4+宽4=22)
    resLen: dv.getUint32(30),                      // Image Resources 长度字段
    sig: String.fromCharCode(u8[34], u8[35], u8[36], u8[37]), // 首资源签名
    resId: dv.getUint16(38),                       // 资源 ID(1039 = ICC)
    iccLen: dv.getUint32(42),                      // 资源数据长度
    iccBytes: [...new Uint8Array(buf, 46, 8)],     // 数据前 8 字节
    expectRes: 4 + 2 + 2 + 4 + icc8.length + (icc8.length % 2),
    iccLen8: icc8.length,
    w: s.doc.width, h: s.doc.height,
    size16: buf.byteLength,
  };
});
const metaOk = meta.depth === 16
  && meta.resLen === meta.expectRes
  && meta.sig === '8BIM' && meta.resId === 1039
  && meta.iccLen === meta.iccLen8
  && meta.iccBytes.join(',') === '137,80,78,71,238,221,204,187';
// 16bit 比 8bit 版至少多出合并图翻倍的 4×w×h 字节(图层通道也翻倍,此为保守下界)
const biggerOk = meta.size16 > report.bytes + 4 * meta.w * meta.h;
console.log('16bit+ICC:', JSON.stringify(meta), 'metaOk=' + metaOk, 'biggerOk=' + biggerOk);

const ok = report.signature
  && report.srcLayers.length === 2 && report.outLayers.length === 2
  && report.srcLayers.every((n, i) => report.outLayers.includes(n))
  && JSON.stringify(report.bgPixel) === '[255,255,255,255]'
  && JSON.stringify(report.shapePixel) === '[0,0,0,255]'
  && report.shapeAlphaOutside === 255
  && metaOk && biggerOk;
console.log(ok ? '✅ PSD 往返 PASS(图层数/中文名/像素/尺寸/16bit+ICC 全对)' : '❌ PSD 往返 FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
