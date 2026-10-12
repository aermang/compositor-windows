// 修复工具 e2e:污点修复(扩散填充)+ 修复画笔(Alt 设源 + 亮度转移融合)
// 前置:vite dev server 已在 http://localhost:1420(共享,勿重启)
// 用法:NODE_PATH=<playwright 所在 node_modules> node tests/heal.mjs
// 注意:多智能体并行 HMR 偶发重载 → 失败请原样重跑一次再判断。
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const pw = require2(process.env.PW_PATH || 'playwright');

const results = [];
function record(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

let page;
let OFF = { x: 0, y: 0 }, V = { z: 1, px: 0, py: 0 };
const S = (dx, dy) => ({ x: OFF.x + V.px + dx * V.z, y: OFF.y + V.py + dy * V.z });

async function sample(sx, sy) {
  return page.evaluate(([x, y]) => {
    const c = document.querySelector('.canvas-host canvas');
    const d = c.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  }, [sx - OFF.x, sy - OFF.y]);
}
const luma = p => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];

async function drag(x1, y1, x2, y2, steps = 10) {
  await page.mouse.move(x1, y1); await page.mouse.down();
  await page.mouse.move(x2, y2, { steps }); await page.mouse.up();
}

async function calcView() {
  const box = await page.locator('.canvas-host canvas').first().boundingBox();
  OFF = { x: box.x, y: box.y };
  // 读 app 的真实视图状态,坐标换算与 app 完全一致
  V = await page.evaluate(() => { const s = window.__store; return { z: s.zoom, px: s.panX, py: s.panY }; });
}

const browser = await pw.chromium.launch({ channel: 'chrome' });
page = await (await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 })).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });

await page.goto('http://localhost:1420', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

// 1. 新建 400×300 白底文档
await page.click('button.big:text-is("新建…")');
const dlg = page.locator('.dialog', { hasText: '新建文档' });
await dlg.locator('input[type=number]').nth(0).fill('400');
await dlg.locator('input[type=number]').nth(1).fill('300');
await dlg.locator('input[value=white]').check();
await dlg.locator('button:has-text("创建")').click();
await page.waitForTimeout(300);
await calcView();

// 2. B 在已知位置画一个黑污点(背景层,层级清晰)
await page.keyboard.press('b');
await drag(S(110, 140).x, S(110, 140).y, S(126, 156).x, S(126, 156).y, 4);
await page.waitForTimeout(200);
const spotC = S(118, 148);
record('B 画黑污点', luma(await sample(spotC.x, spotC.y)) < 80, JSON.stringify(await sample(spotC.x, spotC.y)));

// 3. J 切到修复工具,工具栏出现模式切换
await page.keyboard.press('j');
await page.waitForTimeout(120);
const optText = await page.locator('.tool-options').innerText();
record('J 切到修复画笔,工具栏含「污点修复/修复画笔」', optText.includes('修复画笔') && optText.includes('污点修复'));

// 4. 污点修复(默认模式):涂抹覆盖黑点 → 扩散填充变白
await page.click('.tool-options .seg button:text-is("污点修复")');
await drag(S(96, 126).x, S(96, 126).y, S(140, 170).x, S(140, 170).y, 8);
await page.waitForTimeout(300);
const afterSpot = await sample(spotC.x, spotC.y);
record('污点修复:黑点中心变白(亮度>200)', luma(afterSpot) > 200, JSON.stringify(afterSpot));
const outsideSpot = await sample(S(320, 60).x, S(320, 60).y);
record('污点修复:区域外仍为白', luma(outsideSpot) > 245, JSON.stringify(outsideSpot));

// 5. 修复画笔:再画一个黑点 → Alt 单击白区设源 → 拖过黑点移植亮度
await page.keyboard.press('b');
await drag(S(240, 190).x, S(240, 190).y, S(254, 204).x, S(254, 204).y, 4);
await page.waitForTimeout(200);
const healC = S(247, 197);
record('B 画第二个黑点', luma(await sample(healC.x, healC.y)) < 80);

await page.keyboard.press('j');
await page.waitForTimeout(100);
await page.click('.tool-options .seg button:text-is("修复画笔")');
await page.keyboard.down('Alt');
await page.mouse.click(S(320, 60).x, S(320, 60).y);
await page.keyboard.up('Alt');
await page.waitForTimeout(150);
await drag(S(224, 174).x, S(224, 174).y, S(268, 218).x, S(268, 218).y, 8);
await page.waitForTimeout(300);
const afterHeal = await sample(healC.x, healC.y);
record('修复画笔:黑点被源区亮度替换(亮度>200)', luma(afterHeal) > 200, JSON.stringify(afterHeal));
const outsideHeal = await sample(S(60, 260).x, S(60, 260).y);
record('修复画笔:区域外仍为白', luma(outsideHeal) > 245, JSON.stringify(outsideHeal));

await browser.close();
const ok = results.every(Boolean);
console.log(ok ? '✅ 修复工具 e2e 全部通过' : '❌ 修复工具 e2e 存在失败项');
process.exit(ok ? 0 : 1);
