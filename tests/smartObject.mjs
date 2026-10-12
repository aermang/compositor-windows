// 智能对象 e2e(转换 / 非破坏缩放 / 栅格化 / 撤销重做)
// 链路:B 画黑块 → 指纹 F0 → 图层→转换为智能对象(指纹不变+smartObjectId+源分辨率位图+菜单可用)
//      → transform.size ×2(合成变,位图仍源尺寸)→ 改回(指纹复原)
//      → 栅格化(smartObjectId 清+ref 移除+指纹不变)→ Ctrl+Z 恢复 → Ctrl+Shift+Z 再清
//      → 再次转换 → Ctrl+Z 撤销转换(指纹不变+smartObjectId 清空)
// 前置:vite dev server 已在 http://localhost:1420(共享,勿自起)
// 用法:NODE_PATH="C:\Users\aermang\AppData\Local\npm-cache\_npx\0b9ff77863cb6e9f\node_modules" node tests/smartObject.mjs
// 注意:多智能体并行 HMR 偶发重载 → 失败请原样重跑一次再判断。
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const pw = require2(process.env.PW_PATH || 'playwright');

const BASE = 'http://localhost:1420';
const results = [];

const browser = await pw.chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 })).newPage();
const pageErrors = [];
page.on('pageerror', e => { pageErrors.push(e.message); console.log('PAGEERROR:', e.message); });
page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });

let OFF = { x: 0, y: 0 }, V = { z: 1, px: 0, py: 0 };
const S = (dx, dy) => ({ x: OFF.x + V.px + dx * V.z, y: OFF.y + V.py + dy * V.z });
async function drag(x1, y1, x2, y2, steps = 10) {
  await page.mouse.move(x1, y1); await page.mouse.down();
  await page.mouse.move(x2, y2, { steps }); await page.mouse.up();
}
function record(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
async function menu(top, item) {
  if (await page.locator('.menu-backdrop').count()) {
    await page.evaluate(() =>
      document.querySelector('.menu-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForTimeout(120);
  }
  await page.click(`.menubar .menu:has(button:text-is("${top}")) button.menu-btn`);
  await page.click(`.dropdown .menu-item:has-text("${item}")`);
  await page.waitForTimeout(250);
  if (await page.locator('.menu-backdrop').count()) {
    await page.evaluate(() =>
      document.querySelector('.menu-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForTimeout(120);
  }
}
// 打开菜单只读某项是否禁用(不点击,靠 backdrop 事件关掉)
async function menuDisabled(top, item) {
  if (await page.locator('.menu-backdrop').count()) {
    await page.evaluate(() =>
      document.querySelector('.menu-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForTimeout(120);
  }
  await page.click(`.menubar .menu:has(button:text-is("${top}")) button.menu-btn`);
  await page.waitForTimeout(120);
  const disabled = await page.locator(`.dropdown .menu-item:has-text("${item}")`).first()
    .evaluate(el => el.classList.contains('disabled'));
  await page.evaluate(() =>
    document.querySelector('.menu-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForTimeout(120);
  return disabled;
}
// 合成指纹:主画布文档矩形内缩 4px 的 FNV-1a(不 import 核心模块 — HMR 模块
// 分歧陷阱,一律走 UI)。不取全幅:画布四周文档阴影区的 Chrome 模糊渲染会随
// 重绘路径 ±1 抖动(与文档内容无关),内缩后指纹只反映合成内容本身。
const fingerprint = () => page.evaluate(([x, y, w, h]) => {
  const c = document.querySelector('.canvas-host canvas');
  const d = c.getContext('2d').getImageData(x, y, w, h).data;
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < d.length; i++) { hash ^= d[i]; hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}, [Math.round(V.px) + 4, Math.round(V.py) + 4,
    Math.round(600 * V.z) - 8, Math.round(400 * V.z) - 8]);
// 屏幕上某文档坐标的像素(减掉 host 偏移即画布 backing store 坐标)
const sample = (sx, sy) => page.evaluate(([x, y]) => {
  const c = document.querySelector('.canvas-host canvas');
  const d = c.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}, [sx - OFF.x, sy - OFF.y]);
const luma = p => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
// 活动层 + 智能对象表状态(走 window.__store)
const state = () => page.evaluate(() => {
  const s = window.__store;
  const l = s.doc?.layers.find(x => x.id === s.doc?.activeLayerId) ?? null;
  return {
    smartObjectId: l?.smartObjectId ?? null,
    soCount: s.doc?.smartObjects?.length ?? 0,
    bw: l?.bitmap?.width ?? 0,
    bh: l?.bitmap?.height ?? 0,
    tw: l?.transform?.size[0] ?? 0,
    th: l?.transform?.size[1] ?? 0,
  };
});
async function setScale(k) {
  await page.evaluate(k => {
    const s = window.__store;
    const l = s.doc.layers.find(x => x.id === s.doc.activeLayerId);
    l.transform.size = [l.bitmap.width * k, l.bitmap.height * k];
    s.tick++;
  }, k);
  await page.waitForTimeout(250);
}

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.click('button.big:text-is("新建…")');
const dlg = page.locator('.dialog', { hasText: '新建文档' });
await dlg.locator('input[type=number]').nth(0).fill('600');
await dlg.locator('input[type=number]').nth(1).fill('400');
await dlg.locator('input[value=white]').check();
await dlg.locator('button:has-text("创建")').click();
await page.waitForTimeout(300);
{
  const box = await page.locator('.canvas-host canvas').first().boundingBox();
  OFF = { x: box.x, y: box.y };
  V = await page.evaluate(() => { const s = window.__store; return { z: s.zoom, px: s.panX, py: s.panY }; });
}

// --- 前置:B 在背景层画一个黑块 (150,150)-(190,190) ---
await page.keyboard.press('b');
await drag(S(150, 150).x, S(150, 150).y, S(190, 190).x, S(190, 190).y, 6);
await page.waitForTimeout(250);
const blobC = S(170, 170);
const st0 = await state();
const f0 = await fingerprint();
record('前置:B 画黑块(中心变暗)且背景层为普通栅格层',
  luma(await sample(blobC.x, blobC.y)) < 80 && !st0.smartObjectId && st0.soCount === 0
  && st0.bw === 600 && st0.bh === 400,
  `px=${JSON.stringify(await sample(blobC.x, blobC.y))} state=${JSON.stringify(st0)}`);

// --- 1. 转换前「栅格化智能对象」应禁用 ---
const disBefore = await menuDisabled('图层', '栅格化智能对象');
record('转换前菜单「栅格化智能对象」禁用', disBefore === true, `disabled=${disBefore}`);

// --- 2. 转换为智能对象:合成指纹不变 / smartObjectId / 源分辨率位图 / 菜单可用 ---
await menu('图层', '转换为智能对象');
const f1 = await fingerprint();
const st1 = await state();
record('转换后合成指纹不变', f1 === f0, `f0=${f0} f1=${f1}`);
record('转换后 smartObjectId 已设 + doc.smartObjects 有一条 ref',
  !!st1.smartObjectId && st1.soCount === 1, JSON.stringify(st1));
record('layer.bitmap 尺寸 === 原 bitmap 尺寸(源分辨率物化)',
  st1.bw === st0.bw && st1.bh === st0.bh, `before=${st0.bw}x${st0.bh} after=${st1.bw}x${st1.bh}`);
const disAfter = await menuDisabled('图层', '栅格化智能对象');
record('转换后菜单「栅格化智能对象」变为可用', disAfter === false, `disabled=${disAfter}`);

// --- 3. 非破坏缩放:transform.size ×2 → 合成变但位图仍源尺寸;改回 → 指纹复原 ---
await setScale(2);
const f2 = await fingerprint();
const st2 = await state();
record('放大 2 倍:合成改变 且 layer.bitmap 仍为源尺寸(非破坏)',
  f2 !== f1 && st2.bw === st0.bw && st2.bh === st0.bh && st2.tw === st0.bw * 2,
  `f1=${f1} f2=${f2} state=${JSON.stringify(st2)}`);
await setScale(1);
const f3 = await fingerprint();
record('改回原尺寸:合成指纹恢复原值', f3 === f1, `f3=${f3} f1=${f1}`);

// --- 4. 栅格化:smartObjectId 清空 + ref 移除 + 指纹不变;Ctrl+Z 恢复;Ctrl+Shift+Z 再清 ---
await menu('图层', '栅格化智能对象');
const f4 = await fingerprint();
const st4 = await state();
record('栅格化:smartObjectId 清空 + ref 移除 + 指纹不变',
  !st4.smartObjectId && st4.soCount === 0 && f4 === f1, JSON.stringify(st4));
await page.keyboard.press('Control+z');
await page.waitForTimeout(250);
const st5 = await state();
record('栅格化 Ctrl+Z:smartObjectId 恢复 + ref 回来',
  !!st5.smartObjectId && st5.soCount === 1, JSON.stringify(st5));
await page.keyboard.press('Control+Shift+z');
await page.waitForTimeout(250);
const st6 = await state();
record('栅格化 Ctrl+Shift+Z:再次清空',
  !st6.smartObjectId && st6.soCount === 0, JSON.stringify(st6));

// --- 5. 撤销转换:再转换一次 → Ctrl+Z → 指纹不变且 smartObjectId 为空 ---
await menu('图层', '转换为智能对象');
const st7 = await state();
record('再次转换为智能对象', !!st7.smartObjectId && st7.soCount === 1, JSON.stringify(st7));
await page.keyboard.press('Control+z');
await page.waitForTimeout(250);
const f5 = await fingerprint();
const st8 = await state();
record('撤销转换:指纹不变且 smartObjectId 清空 / ref 移除',
  !st8.smartObjectId && st8.soCount === 0 && f5 === f1, `f5=${f5} state=${JSON.stringify(st8)}`);

// --- 6. 无页面 JS 报错 ---
record('无页面 JS 报错', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));

await browser.close();
const ok = results.every(Boolean);
console.log(ok ? '✅ 智能对象 e2e 全部 PASS' : '❌ 智能对象 e2e 存在 FAIL');
process.exit(ok ? 0 : 1);
