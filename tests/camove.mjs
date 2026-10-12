// 感知移动(Content-Aware Move)工具 e2e
// 前置:vite dev server 已在 http://localhost:1420(共享,勿重启)
// 用法:NODE_PATH=<playwright 所在 node_modules> node tests/camove.mjs
// 注意:多智能体并行 HMR 偶发重载 → 失败请原样重跑一次再判断。
//
// 用例:
//   1. 白底 600×400,左侧 (60,60) 画 60×60 红方块 → 套索圈住 → 拖到 (300,200):
//      新位置≈红(移动到位)、原位置≈白(空洞被 contentFill 填充)、Ctrl+Z 可逆。
//   2. 右侧画蓝/绿/黄纹理块 → 套索 → 部分重叠拖动(offset -30,+30):
//      重叠区内采样为纹理色(移动混合正确)、不炸、Ctrl+Z 可逆。
//   3. 选中工具时 ToolOptions 显示「感知移动」。
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
const isRed = p => p[0] > 150 && p[1] < 90 && p[2] < 90;
const isBlue = p => p[2] > 140 && p[0] < 100 && p[1] < 120;
const isGreen = p => p[1] > 120 && p[0] < 100 && p[2] < 110;
const isWhite = p => luma(p) > 245;

async function drag(x1, y1, x2, y2, steps = 10) {
  await page.mouse.move(x1, y1); await page.mouse.down();
  await page.mouse.move(x2, y2, { steps }); await page.mouse.up();
}

// 沿折线闭合套索(感知移动第 1 段)
async function lassoLoop(pts, stepsPerEdge = 6) {
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (let i = 1; i < pts.length; i++) await page.mouse.move(pts[i].x, pts[i].y, { steps: stepsPerEdge });
  await page.mouse.move(pts[0].x, pts[0].y, { steps: stepsPerEdge });
  await page.mouse.up();
}

async function brushStroke(x1, y1, x2, y2) {
  await drag(S(x1, y1).x, S(x1, y1).y, S(x2, y2).x, S(x2, y2).y, 6);
  await page.waitForTimeout(150);
}

async function calcView() {
  const box = await page.locator('.canvas-host canvas').first().boundingBox();
  OFF = { x: box.x, y: box.y };
  // 读 app 的真实视图状态,坐标换算与 app 完全一致
  V = await page.evaluate(() => { const s = window.__store; return { z: s.zoom, px: s.panX, py: s.panY }; });
}

const browser = await pw.chromium.launch({ channel: 'chrome' });
const pageErrors = [];
const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
page = await context.newPage();
page.on('pageerror', e => { pageErrors.push(e.message); console.log('PAGEERROR:', e.message); });
page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });

await page.goto('http://localhost:1420', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

// 1. 新建 600×400 白底文档
await page.click('button.big:text-is("新建…")');
const dlg = page.locator('.dialog', { hasText: '新建文档' });
await dlg.locator('input[type=number]').nth(0).fill('600');
await dlg.locator('input[type=number]').nth(1).fill('400');
await dlg.locator('input[value=white]').check();
await dlg.locator('button:has-text("创建")').click();
await page.waitForTimeout(300);
await calcView();

// 2. 活动层:左侧 (60,60) 画 60×60 红方块(B 笔刷 size48 硬度1,短笔画胶囊
//    覆盖 (58,58)-(122,122);套索要严格大于色块,留白边当空洞填充源)
await page.keyboard.press('b');
await page.evaluate(() => {
  window.__store.fg = '#cc2222';
  window.__store.opts.brush.size = 48;
  window.__store.opts.brush.hardness = 1;
  window.__store.opts.brush.opacity = 1;
  window.__store.opts.brush.smoothing = 0;
});
await page.waitForTimeout(100);
await brushStroke(82, 82, 98, 98);
const sqC = S(90, 90), sqA = S(70, 70), sqB = S(110, 110);
record('B 画红方块:中心 (90,90) 为红', isRed(await sample(sqC.x, sqC.y)), JSON.stringify(await sample(sqC.x, sqC.y)));
record('B 画红方块:(70,70)/(110,110) 为红', isRed(await sample(sqA.x, sqA.y)) && isRed(await sample(sqB.x, sqB.y)),
  `${JSON.stringify(await sample(sqA.x, sqA.y))} ${JSON.stringify(await sample(sqB.x, sqB.y))}`);

// 3. 工具栏按钮切「感知移动」,面板提示出现
await page.click('.tool-btn[title^="感知移动"]');
await page.waitForTimeout(120);
const camoveOn = await page.evaluate(() => window.__store.tool);
record('工具栏切到感知移动', camoveOn === 'camove', `tool=${camoveOn}`);
const optText = await page.locator('.tool-options').innerText();
record('面板提示显示「感知移动」', optText.includes('感知移动'), optText.slice(0, 60));

// 4. 用例 1:套索圈住红方块(第 1 段)→ 区内按下拖到 (300,200) 松开(第 2 段)
await lassoLoop([S(50, 50), S(130, 50), S(130, 130), S(50, 130)]);
await page.waitForTimeout(150);
const destC = S(300, 200), dest2 = S(280, 180);
await drag(sqC.x, sqC.y, destC.x, destC.y, 12);
await page.waitForTimeout(400);

const movedPx = await sample(destC.x, destC.y);
record('感知移动:新位置 (300,200) ≈ 红(移动到位)', isRed(movedPx), JSON.stringify(movedPx));
const movedPx2 = await sample(dest2.x, dest2.y);
record('感知移动:新位置 (280,180) ≈ 红', isRed(movedPx2), JSON.stringify(movedPx2));
const holePx = await sample(sqC.x, sqC.y);
record('感知移动:原位置 (90,90) ≈ 白(空洞被填充)', isWhite(holePx), JSON.stringify(holePx));

await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
const undoHole = await sample(sqC.x, sqC.y);
const undoDest = await sample(destC.x, destC.y);
record('感知移动:Ctrl+Z 后原位置恢复红', isRed(undoHole), JSON.stringify(undoHole));
record('感知移动:Ctrl+Z 后新位置回白', isWhite(undoDest), JSON.stringify(undoDest));

// 5. 用例 2:右侧画蓝/绿/黄纹理块 → 套索 → 部分重叠拖动
await page.keyboard.press('b');
await page.waitForTimeout(80);
await page.evaluate(() => { window.__store.fg = '#2244cc'; window.__store.opts.brush.size = 40; });
await brushStroke(435, 110, 445, 120);
await page.evaluate(() => { window.__store.fg = '#22aa44'; window.__store.opts.brush.size = 36; });
await brushStroke(455, 145, 465, 155);
await page.evaluate(() => { window.__store.fg = '#ddcc22'; window.__store.opts.brush.size = 30; });
await brushStroke(435, 150, 445, 160);
const texBlue = S(445, 120), texGreen = S(465, 155);
const blue0 = await sample(texBlue.x, texBlue.y), green0 = await sample(texGreen.x, texGreen.y);
record('纹理块:蓝/绿就位', isBlue(blue0) && isGreen(green0), `${JSON.stringify(blue0)} ${JSON.stringify(green0)}`);

await page.click('.tool-btn[title^="感知移动"]');
await page.waitForTimeout(120);
// 第 1 段:套索圈住纹理块
await lassoLoop([S(410, 88), S(492, 88), S(492, 178), S(410, 178)]);
await page.waitForTimeout(150);
// 第 2 段:区内按下 (450,130),拖 (-30,+30) 到 (420,160) → 部分重叠
const pressC = S(450, 130), relC = S(420, 160);
await drag(pressC.x, pressC.y, relC.x, relC.y, 12);
await page.waitForTimeout(400);

const mvBlue = await sample(S(415, 150).x, S(415, 150).y);   // 蓝块新位 (445,120)+(-30,30)
record('部分重叠:蓝块移动到 (415,150) ≈ 蓝', isBlue(mvBlue), JSON.stringify(mvBlue));
const mvGreen = await sample(S(435, 185).x, S(435, 185).y);  // 绿块新位 (465,155)+(-30,30)
record('部分重叠:绿块移动到 (435,185) ≈ 绿', isGreen(mvGreen), JSON.stringify(mvGreen));

await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
const backBlue = await sample(texBlue.x, texBlue.y);
const backGreen = await sample(texGreen.x, texGreen.y);
const backMvBlue = await sample(S(415, 150).x, S(415, 150).y);
record('部分重叠:Ctrl+Z 后蓝/绿回原位', isBlue(backBlue) && isGreen(backGreen),
  `${JSON.stringify(backBlue)} ${JSON.stringify(backGreen)}`);
record('部分重叠:Ctrl+Z 后 (415,150) 回白', isWhite(backMvBlue), JSON.stringify(backMvBlue));

// 6. 全程无页面异常
record('全程无 pageerror', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));

await browser.close();
const ok = results.every(Boolean);
console.log(ok ? '✅ 感知移动 e2e 全部通过' : '❌ 感知移动 e2e 存在失败项');
process.exit(ok ? 0 : 1);
