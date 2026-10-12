// 通道面板 + Alpha 选区存储 e2e(vite dev + Playwright,独立于 tests/e2e.mjs)
// 链路:矩形选区 → 选择→存储选区 → Alpha 1 行出现 / 通道 canvas alpha 采样正确
//      → 载入为选区(与原 mask 采样一致)→ 删除 → Ctrl+Z 恢复 → Ctrl+Shift+Z 再删
// 用法: NODE_PATH="C:\Users\aermang\AppData\Local\npm-cache\_npx\0b9ff77863cb6e9f\node_modules" node tests/channels.mjs
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
// 读 store 里第 n 个通道 canvas 某点的 alpha(canvas 已 markRaw,直接 getContext)
const chAlpha = (n, x, y) => page.evaluate(([i, px, py]) => {
  const ch = window.__store.doc?.alphaChannels?.[i];
  if (!ch) return null;
  return ch.canvas.getContext('2d').getImageData(px, py, 1, 1).data[3];
}, [n, x, y]);
// 读当前选区 mask 某点的 alpha
const maskAlpha = (x, y) => page.evaluate(([px, py]) => {
  const s = window.__store;
  if (!s.selection) return null;
  return s.selection.mask.getContext('2d').getImageData(px, py, 1, 1).data[3];
}, [x, y]);

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

// 选区:doc 坐标 (150,100) → (350,260)
const RECT = { x: 150, y: 100, w: 200, h: 160 };
const IN = { x: 250, y: 180 };    // 选区内
const OUT = { x: 40, y: 40 };     // 选区外

// --- 1. 框选并存储为通道 ---
await page.keyboard.press('m');
await drag(S(RECT.x, RECT.y).x, S(RECT.x, RECT.y).y, S(RECT.x + RECT.w, RECT.y + RECT.h).x, S(RECT.x + RECT.w, RECT.y + RECT.h).y);
await page.waitForTimeout(150);
await menu('选择', '存储选区');
await page.waitForTimeout(200);
const row1 = await page.locator('.channels-panel .ch-row:has-text("Alpha 1")').count();
const stored = { in: await chAlpha(0, IN.x, IN.y), out: await chAlpha(0, OUT.x, OUT.y) };
record('存储选区为通道 → Alpha 1 行出现,通道 alpha 采样正确',
  row1 === 1 && stored.in === 255 && stored.out === 0,
  `rows=${row1} alpha=${JSON.stringify(stored)}`);

// --- 2. 取消选择后,载入通道为选区:mask 与原选区一致 ---
await page.keyboard.press('Control+d'); // 取消选择
await page.waitForTimeout(150);
const deselected = await page.evaluate(() => {
  const s = window.__store;
  return !s.selection || !s.selection.bounds;
});
await page.locator('.channels-panel .ch-alpha-row:has-text("Alpha 1") button:has-text("载入为选区")').click();
await page.waitForTimeout(200);
const b = await page.evaluate(() => window.__store.selection?.bounds ?? null);
const reloaded = { in: await maskAlpha(IN.x, IN.y), out: await maskAlpha(OUT.x, OUT.y) };
record('载入为选区(mask 采样与原选区一致 + bounds 恢复)',
  deselected && reloaded.in === 255 && reloaded.out === 0
  && b && Math.abs(b.x - RECT.x) < 3 && Math.abs(b.y - RECT.y) < 3
  && Math.abs(b.w - RECT.w) < 3 && Math.abs(b.h - RECT.h) < 3,
  `deselected=${deselected} bounds=${JSON.stringify(b)} mask=${JSON.stringify(reloaded)}`);

// --- 3. 删除通道 → 行消失;Ctrl+Z 恢复;Ctrl+Shift+Z 再删 ---
await page.locator('.channels-panel .ch-alpha-row:has-text("Alpha 1") button:has-text("删除")').click();
await page.waitForTimeout(200);
const rowAfterDelete = await page.locator('.channels-panel .ch-row:has-text("Alpha 1")').count();
const chanAfterDelete = await page.evaluate(() => window.__store.doc.alphaChannels?.length ?? 0);
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
const rowAfterUndo = await page.locator('.channels-panel .ch-row:has-text("Alpha 1")').count();
const chanAfterUndo = await page.evaluate(() => window.__store.doc.alphaChannels?.length ?? 0);
const alphaAfterUndo = await chAlpha(0, IN.x, IN.y);
await page.keyboard.press('Control+Shift+z');
await page.waitForTimeout(200);
const rowAfterRedo = await page.locator('.channels-panel .ch-row:has-text("Alpha 1")').count();
record('删除 → Ctrl+Z 恢复(历史生效)→ Ctrl+Shift+Z 再删',
  rowAfterDelete === 0 && chanAfterDelete === 0
  && rowAfterUndo === 1 && chanAfterUndo === 1 && alphaAfterUndo === 255
  && rowAfterRedo === 0,
  `del=${rowAfterDelete}/${chanAfterDelete} undo=${rowAfterUndo}/${chanAfterUndo}(a=${alphaAfterUndo}) redo=${rowAfterRedo}`);

// --- 4. 页面无 JS 报错 ---
record('无页面 JS 报错', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));

await browser.close();
const ok = results.every(Boolean);
console.log(ok ? '✅ 通道面板 + Alpha 选区存储 全部 PASS' : '❌ 存在 FAIL');
process.exit(ok ? 0 : 1);
