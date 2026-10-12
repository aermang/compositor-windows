// 快速蒙版 + 磁性套索 e2e(vite dev + Playwright,独立于 tests/e2e.mjs)
// 链1 快速蒙版:Q 往返保真(阈值往返)/ 选区内涂抹并入选区 / 选区外涂抹扩选区
// 链2 磁性套索:沿黑矩形边缘外侧 ≤width/2 拖一圈 → bounds 尺寸偏差 < 25px
// 用法: NODE_PATH="C:\Users\aermang\AppData\Local\npm-cache\_npx\0b9ff77863cb6e9f\node_modules" node tests/quickmask.mjs
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const pw = require2(process.env.PW_PATH || 'playwright');

const BASE = 'http://localhost:1420';
const results = [];

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
function record(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
// 读选区蒙版某点的 alpha(canvas 不会被 Vue 代理,直接 getContext)
const maskAlpha = (x, y) => page.evaluate(([px, py]) => {
  const s = window.__store;
  if (!s.selection) return null;
  return s.selection.mask.getContext('2d').getImageData(px, py, 1, 1).data[3];
}, [x, y]);

await page.goto(BASE, { waitUntil: 'networkidle' });
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

// ================= 链 1:快速蒙版 =================

// --- 1a. 矩形选区进 Q 不画直接出 Q:mask 阈值往返逐位一致 ---
await page.keyboard.press('m');
const r1 = S(300, 200), r2 = S(500, 400); // 选区 doc 坐标 300,200 → 500,400
await drag(r1.x, r1.y, r2.x, r2.y);
await page.waitForTimeout(150);
const before = { center: await maskAlpha(400, 300), out: await maskAlpha(50, 50), corner: await maskAlpha(300, 200) };
await page.keyboard.press('q');
await page.waitForTimeout(120);
const qmOn = await page.evaluate(() => window.__store.quickMask);
await page.keyboard.press('q');
await page.waitForTimeout(120);
const qmOff = await page.evaluate(() => !window.__store.quickMask);
const after = { center: await maskAlpha(400, 300), out: await maskAlpha(50, 50), corner: await maskAlpha(300, 200) };
record('Q 往返保真(矩形选区阈值往返)',
  qmOn && qmOff
  && before.center === 255 && before.out === 0 && before.corner === 255
  && after.center === before.center && after.out === before.out && after.corner === before.corner,
  `before=${JSON.stringify(before)} qmOn=${qmOn} after=${JSON.stringify(after)}`);

// --- 1b. M 框选 → Q → B 画几笔(选区内+选区外)→ Q:退出选区 = 原选区 ∪ 笔画 ---
await drag(r1.x, r1.y, r2.x, r2.y); // 重新框选同一矩形(replace)
await page.waitForTimeout(150);
await page.keyboard.press('q');
await page.waitForTimeout(120);
const qmOn2 = await page.evaluate(() => window.__store.quickMask);
await page.keyboard.press('b');
// 选区内两笔(doc 400,250→460,250 与 400,350→460,350;选区 300..500 × 200..400)
await drag(S(400, 250).x, S(400, 250).y, S(460, 250).x, S(460, 250).y, 6);
await drag(S(400, 350).x, S(400, 350).y, S(460, 350).x, S(460, 350).y, 6);
// 选区外一笔(doc 60,60→110,60):快速蒙版语义下笔画并入 rubylith → 扩大选区
await drag(S(60, 60).x, S(60, 60).y, S(110, 60).x, S(110, 60).y, 5);
await page.waitForTimeout(200);
await page.keyboard.press('q');
await page.waitForTimeout(150);
const qmOff2 = await page.evaluate(() => !window.__store.quickMask);
const mask1b = {
  center: await maskAlpha(400, 300),    // 原选区中心(未被笔画覆盖)
  painted: await maskAlpha(430, 250),   // 选区内的笔画
  paintedOut: await maskAlpha(85, 60),  // 选区外的笔画
  far: await maskAlpha(50, 500),        // 远处未画
};
record('快速蒙版链(Q→画→Q,选区∪笔画)',
  qmOn2 && qmOff2 && mask1b.center === 255 && mask1b.painted === 255
  && mask1b.paintedOut === 255 && mask1b.far === 0,
  `qmOn=${qmOn2} qmOff=${qmOff2} mask=${JSON.stringify(mask1b)}`);

// ================= 链 2:磁性套索 =================

// U 画一个黑矩形(doc 300,150 → 500,320,即 200×170)
await page.keyboard.press('u');
await drag(S(300, 150).x, S(300, 150).y, S(500, 320).x, S(500, 320).y);
await page.waitForTimeout(200);

await page.keyboard.press('l');
await page.click('.tool-options button:has-text("磁性套索")');
await page.waitForTimeout(120);
const magOpts = await page.evaluate(() => {
  const o = window.__store.opts.lasso;
  return { magnetic: o.magnetic, width: o.width, contrast: o.contrast, frequency: o.frequency };
});
// 沿矩形边缘外侧 ~4px 顺时针拖一圈(width 默认 10 → ≤width/2),steps 密一点
const loop = [
  [300, 146], [500, 146],   // 上边(左→右)
  [504, 150], [504, 320],   // 右边(上→下)
  [500, 324], [300, 324],   // 下边(右→左)
  [296, 320], [296, 150],   // 左边(下→上)
];
await page.mouse.move(S(loop[0][0], loop[0][1]).x, S(loop[0][0], loop[0][1]).y);
await page.mouse.down();
for (let i = 1; i < loop.length; i++) {
  await page.mouse.move(S(loop[i][0], loop[i][1]).x, S(loop[i][0], loop[i][1]).y, { steps: 24 });
}
await page.mouse.up();
await page.waitForTimeout(200);
const mag = await page.evaluate(() => {
  const s = window.__store;
  return { bounds: s.selection ? s.selection.bounds : null };
});
const b = mag.bounds;
const RECT = { x: 300, y: 150, w: 200, h: 170 };
record('磁性套索(沿矩形边缘吸附闭合)',
  !!magOpts.magnetic && !!b
  && Math.abs(b.w - RECT.w) < 25 && Math.abs(b.h - RECT.h) < 25
  && Math.abs(b.x - RECT.x) < 25 && Math.abs(b.y - RECT.y) < 25,
  `opts=${JSON.stringify(magOpts)} bounds=${JSON.stringify(b)} 期望≈${JSON.stringify(RECT)}`);

await browser.close();
const ok = results.every(Boolean);
console.log(ok ? '✅ 快速蒙版 + 磁性套索 全部 PASS' : '❌ 存在 FAIL');
process.exit(ok ? 0 : 1);
