// 帧动画时间轴 + APNG 导出 e2e:编码器链(纯浏览器)/ 帧应用链 / 面板链。
// 运行:NODE_PATH="C:\Users\aermang\AppData\Local\npm-cache\_npx\0b9ff77863cb6e9f\node_modules" node tests/anim.mjs
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const pw = require2(process.env.PW_PATH || 'playwright');

const browser = await pw.chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 })).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

await page.goto('http://localhost:1420', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

// ---- 新建 300×200 白底文档 ----
await page.click('button.big:text-is("新建…")');
const dlg = page.locator('.dialog', { hasText: '新建文档' });
await dlg.locator('input[type=number]').nth(0).fill('300');
await dlg.locator('input[type=number]').nth(1).fill('200');
await dlg.locator('input[value=white]').check();
await dlg.locator('button:has-text("创建")').click();
await page.waitForTimeout(300);

// ---- 面板链:UI 建帧 / 复制帧 ----
await page.click('button:has-text("新建帧")');
await page.waitForTimeout(100);
const n1 = await page.evaluate(() => window.__store.doc.frames?.length ?? 0);
check('面板:首次「新建帧」→ 1 帧', n1 === 1, `frames.length=${n1}`);
await page.click('button:has-text("复制帧")');
await page.waitForTimeout(100);
const n2 = await page.evaluate(() => window.__store.doc.frames?.length ?? 0);
check('面板:「复制帧」→ 2 帧', n2 === 2, `frames.length=${n2}`);

// ---- 帧应用链:两帧(帧 2 隐藏黑层),gotoFrame/applyFrame 后像素断言 ----
const fc = await page.evaluate(async () => {
  const s = window.__store;
  const doc = s.doc;
  const A = window.__animDebug;
  const { composite } = await import('/src/core/compositor.ts');
  const { makeLayer, defaultTransform } = await import('/src/core/types.ts');

  // 白底上盖一个满幅黑层
  const black = makeLayer({ name: '黑层' });
  black.transform = defaultTransform(300, 200);
  const c = document.createElement('canvas');
  c.width = 300; c.height = 200;
  const cx = c.getContext('2d');
  cx.fillStyle = '#000';
  cx.fillRect(0, 0, 300, 200);
  black.bitmap = c;
  doc.layers.push(black);
  s.tick++;

  const bg = doc.layers[0], top = doc.layers[1];
  doc.frames = [
    { id: 'FA', durationMs: 100, states: { [bg.id]: { visible: true, opacity: 1 }, [top.id]: { visible: true, opacity: 1 } } },
    { id: 'FB', durationMs: 100, states: { [bg.id]: { visible: true, opacity: 1 }, [top.id]: { visible: false, opacity: 1 } } },
  ];

  const px = () => {
    const d = composite(doc).getContext('2d').getImageData(150, 100, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  };

  A.gotoFrame(0);
  const goto0 = px();
  A.gotoFrame(1);
  const goto1 = px();
  A.applyFrame(doc.frames[0]);
  const apply0 = px();
  A.applyFrame(doc.frames[1]);
  const apply1 = px();
  return { goto0, goto1, apply0, apply1, cur: A.anim.current, topHidden: !top.isVisible };
});
const J = v => JSON.stringify(v);
check('帧链:gotoFrame(0) → 该点黑', J(fc.goto0) === '[0,0,0,255]', J(fc.goto0));
check('帧链:gotoFrame(1) → 该点白(黑层隐藏)', J(fc.goto1) === '[255,255,255,255]', J(fc.goto1));
check('帧链:applyFrame(帧0) → 黑', J(fc.apply0) === '[0,0,0,255]', J(fc.apply0));
check('帧链:applyFrame(帧1) → 白', J(fc.apply1) === '[255,255,255,255]', J(fc.apply1));
check('帧链:current=1 且图层已隐藏', fc.cur === 1 && fc.topHidden, `cur=${fc.cur} hidden=${fc.topHidden}`);

// ---- 编码器链:两个独立 canvas → encodeApng → 字节级断言 ----
const enc = await page.evaluate(async () => {
  const { encodeApng } = await import('/src/core/io/apngExport.ts');
  const mk = color => {
    const c = document.createElement('canvas');
    c.width = 300; c.height = 200;
    const x = c.getContext('2d');
    x.fillStyle = color;
    x.fillRect(0, 0, 300, 200);
    return c;
  };
  const buf = await encodeApng([
    { canvas: mk('#ffffff'), delayMs: 100 },
    { canvas: mk('#000000'), delayMs: 50 },
  ]);
  const b = new Uint8Array(buf);
  const v = new DataView(buf);
  const sig = Array.from(b.slice(0, 8)).map(x => x.toString(16).padStart(2, '0')).join(' ');
  // 遍历 chunk 流:长度4 + 类型4 + 数据 + CRC4
  const chunks = [];
  let pos = 8;
  while (pos + 12 <= b.length) {
    const len = v.getUint32(pos);
    chunks.push({ type: String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]), dataOff: pos + 8 });
    pos += 12 + len;
  }
  const of = t => chunks.filter(c => c.type === t);
  const actl = of('acTL')[0];
  const fctls = of('fcTL');
  const fdats = of('fdAT');
  const ihdr = of('IHDR')[0];
  const r = {
    sig, size: b.length,
    walkedToEnd: pos === b.length,
    order: chunks.map(c => c.type).join(','),
    numFrames: actl ? v.getUint32(actl.dataOff) : -1,
    numPlays: actl ? v.getUint32(actl.dataOff + 4) : -1,
    fctlCount: fctls.length,
    fdATCount: fdats.length,
    ihdrWH: ihdr ? [v.getUint32(ihdr.dataOff), v.getUint32(ihdr.dataOff + 4)] : null,
    fctl0: fctls[0] ? {
      seq: v.getUint32(fctls[0].dataOff),
      w: v.getUint32(fctls[0].dataOff + 4),
      h: v.getUint32(fctls[0].dataOff + 8),
      delayNum: v.getUint16(fctls[0].dataOff + 20),
      delayDen: v.getUint16(fctls[0].dataOff + 22),
    } : null,
    fctl1: fctls[1] ? { seq: v.getUint32(fctls[1].dataOff), delayNum: v.getUint16(fctls[1].dataOff + 20) } : null,
    fdAT0Seq: fdats.length ? v.getUint32(fdats[0].dataOff) : -1,
    lastType: chunks[chunks.length - 1]?.type ?? null,
  };
  // 附加真值检查:Chrome 能把产物当图像解码(APNG 是合法 PNG)
  try {
    const url = URL.createObjectURL(new Blob([buf], { type: 'image/png' }));
    const img = new Image();
    img.src = url;
    await img.decode();
    r.browserDecodes = img.naturalWidth === 300 && img.naturalHeight === 200;
    URL.revokeObjectURL(url);
  } catch { r.browserDecodes = false; }
  return r;
});
check('编码:PNG 签名前 8 字节', enc.sig === '89 50 4e 47 0d 0a 1a 0a', enc.sig);
check('编码:chunk 流走到底部', enc.walkedToEnd, `size=${enc.size}`);
check('编码:acTL num_frames=2 且 num_plays=0(无限循环)', enc.numFrames === 2 && enc.numPlays === 0,
  `num_frames=${enc.numFrames} num_plays=${enc.numPlays}`);
check('编码:fcTL ≥1 且 fdAT ≥1', enc.fctlCount >= 1 && enc.fdATCount >= 1,
  `fcTL=${enc.fctlCount} fdAT=${enc.fdATCount}`);
check('编码:IEND 在尾部', enc.lastType === 'IEND' && enc.walkedToEnd, `last=${enc.lastType}`);
check('编码:IHDR 尺寸 300×200', J(enc.ihdrWH) === '[300,200]', J(enc.ihdrWH));
check('编码:fcTL0 seq=0 尺寸/delay 正确(100/1000)', !!enc.fctl0 && enc.fctl0.seq === 0
  && enc.fctl0.w === 300 && enc.fctl0.h === 200 && enc.fctl0.delayNum === 100 && enc.fctl0.delayDen === 1000,
  JSON.stringify(enc.fctl0));
check('编码:fcTL1 seq=1 / fdAT seq=2(共用序号)delay=50',
  enc.fctl1?.seq === 1 && enc.fdAT0Seq === 2 && enc.fctl1?.delayNum === 50,
  `fctl1=${JSON.stringify(enc.fctl1)} fdAT0Seq=${enc.fdAT0Seq}`);
check('编码:Chrome 可解码为 300×200 图像', enc.browserDecodes === true, `order=${enc.order}`);

// ---- 洋葱皮开关(不炸即可;绘制走 overlay 通道)----
await page.click('.onion-toggle input[type=checkbox]');
await page.waitForTimeout(150);
const onionOn = await page.evaluate(() => window.__animDebug.anim.onion === true);
check('面板:洋葱皮 checkbox 生效', onionOn);

const ok = results.every(Boolean);
console.log(ok ? '✅ 动画时间轴 + APNG 导出 全部 PASS' : '❌ 动画时间轴 + APNG 导出 存在 FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
