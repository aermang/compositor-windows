// 减淡/加深/海绵 + 修补工具 e2e
// 前置:vite dev server 已在 http://localhost:1420(共享,勿重启)
// 用法:NODE_PATH=<playwright 所在 node_modules> node tests/dodge.mjs
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
const spread = p => Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);

async function drag(x1, y1, x2, y2, steps = 10) {
  await page.mouse.move(x1, y1); await page.mouse.down();
  await page.mouse.move(x2, y2, { steps }); await page.mouse.up();
}

// 沿折线闭合套索(patch 第 1 段)
async function lassoLoop(pts, stepsPerEdge = 6) {
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (let i = 1; i < pts.length; i++) await page.mouse.move(pts[i].x, pts[i].y, { steps: stepsPerEdge });
  await page.mouse.move(pts[0].x, pts[0].y, { steps: stepsPerEdge });
  await page.mouse.up();
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

// 1. 新建 600×400 白底文档
await page.click('button.big:text-is("新建…")');
const dlg = page.locator('.dialog', { hasText: '新建文档' });
await dlg.locator('input[type=number]').nth(0).fill('600');
await dlg.locator('input[type=number]').nth(1).fill('400');
await dlg.locator('input[value=white]').check();
await dlg.locator('button:has-text("创建")').click();
await page.waitForTimeout(300);
await calcView();

// 2. B 在 (150,150)-(190,190) 画一个黑污点(减淡目标),中心 (170,170)
await page.keyboard.press('b');
await drag(S(150, 150).x, S(150, 150).y, S(190, 190).x, S(190, 190).y, 6);
await page.waitForTimeout(200);
const dodgeC = S(170, 170);
record('B 画黑污点', luma(await sample(dodgeC.x, dodgeC.y)) < 80, JSON.stringify(await sample(dodgeC.x, dodgeC.y)));

// 3. O 切减淡工具,工具栏出现「减淡/加深/海绵」
await page.keyboard.press('o');
await page.waitForTimeout(120);
const optText = await page.locator('.tool-options').innerText();
record('O 切到减淡,工具栏含「减淡/加深/海绵」', optText.includes('减淡') && optText.includes('加深') && optText.includes('海绵'));

// 曝光度拉高到 90%(v-model 绑定的同一响应式对象,与 e2e.mjs 设 smear 参数同法)
await page.evaluate(() => { window.__store.opts.dodge.exposure = 90; });
await page.waitForTimeout(100);

// 4. dodge:黑污点中心拖一笔 → 变亮
await drag(S(150, 150).x, S(150, 150).y, S(190, 190).x, S(190, 190).y, 10);
await page.waitForTimeout(300);
const afterDodge = await sample(dodgeC.x, dodgeC.y);
record('减淡:黑色中心提亮(亮度>150)', luma(afterDodge) > 150, JSON.stringify(afterDodge));
await page.keyboard.press('Control+z');
await page.waitForTimeout(250);
const afterDodgeUndo = await sample(dodgeC.x, dodgeC.y);
record('减淡:Ctrl+Z 撤销回黑(亮度<80)', luma(afterDodgeUndo) < 80, JSON.stringify(afterDodgeUndo));

// 5. burn:切「加深」,白底上拖一笔 → 变暗
await page.click('.tool-options .seg button:text-is("加深")');
const burnC = S(400, 80);
const beforeBurn = await sample(burnC.x, burnC.y);
await drag(S(380, 60).x, S(380, 60).y, S(420, 100).x, S(420, 100).y, 10);
await page.waitForTimeout(300);
const afterBurn = await sample(burnC.x, burnC.y);
record('加深:白底拖过变暗(亮度<150)', luma(afterBurn) < 150, `before=${JSON.stringify(beforeBurn)} after=${JSON.stringify(afterBurn)}`);
await page.keyboard.press('Control+z');
await page.waitForTimeout(250);
const afterBurnUndo = await sample(burnC.x, burnC.y);
record('加深:Ctrl+Z 撤销回白(亮度>245)', luma(afterBurnUndo) > 245, JSON.stringify(afterBurnUndo));

// 6. sponge saturate:低饱和色块 (#c0c0b4) 上拖 → (max-min) 变大
await page.evaluate(() => { window.__store.fg = '#c0c0b4'; });
await page.keyboard.press('b');
const spongeC = S(300, 320);
await drag(S(280, 300).x, S(280, 300).y, S(320, 340).x, S(320, 340).y, 8);
await page.waitForTimeout(200);
const spBefore = spread(await sample(spongeC.x, spongeC.y));
await page.keyboard.press('o');
await page.waitForTimeout(100);
await page.click('.tool-options .seg button:text-is("海绵")');
await page.evaluate(() => { window.__store.opts.dodge.spongeFlow = 100; });
await page.waitForTimeout(100);
await drag(S(280, 300).x, S(280, 300).y, S(320, 340).x, S(320, 340).y, 10);
await page.waitForTimeout(300);
const spAfterPx = await sample(spongeC.x, spongeC.y);
record('海绵(加饱和):色度差变大', spread(spAfterPx) > spBefore + 15, `before=${spBefore} after=${spread(spAfterPx)} ${JSON.stringify(spAfterPx)}`);
await page.keyboard.press('Control+z');
await page.waitForTimeout(250);
const spUndo = spread(await sample(spongeC.x, spongeC.y));
record('海绵:Ctrl+Z 撤销回原色度差', Math.abs(spUndo - spBefore) <= 3, `before=${spBefore} undo=${spUndo}`);

// 7. patch:左侧干净区套索 → 拖到右侧污渍处 → 目标区获得采样区内容
await page.evaluate(() => { window.__store.fg = '#000000'; });
await page.keyboard.press('b');
const stainC = S(420, 200);
await drag(S(400, 180).x, S(400, 180).y, S(440, 220).x, S(440, 220).y, 8);
await page.waitForTimeout(200);
record('B 画修补用黑污渍', luma(await sample(stainC.x, stainC.y)) < 80, JSON.stringify(await sample(stainC.x, stainC.y)));

// 工具栏按钮切修补(无快捷键)
await page.click('.tool-btn[title^="修补"]');
await page.waitForTimeout(120);
const patchToolOn = await page.evaluate(() => window.__store.tool);
record('工具栏切到修补', patchToolOn === 'patch', `tool=${patchToolOn}`);

// 第 1 段:在左侧干净区套索一个方块 region(顶点绕一圈)
// (region 是 patch.ts 的模块级状态,测试侧不可读;region 是否生效由第 2 段的
//  提交结果断言间接验证——若套索失败,按下会开新套索而非进入拖拽采样)
const targetC = S(160, 200);
await lassoLoop([S(140, 180), S(180, 180), S(180, 220), S(140, 220)]);
await page.waitForTimeout(150);
const patchHint = await page.locator('.tool-options').innerText();
record('修补工具选项面板显示', patchHint.includes('修补'));

// 第 2 段:region 内按下,拖到污渍中心松开 → 目标区应变为采样区(污渍)颜色
await drag(targetC.x, targetC.y, stainC.x, stainC.y, 12);
await page.waitForTimeout(300);
const patched = await sample(targetC.x, targetC.y);
const stainPx = await sample(stainC.x, stainC.y);
record('修补:目标区≈采样区颜色(均为污渍色)', luma(patched) < 100 && Math.abs(luma(patched) - luma(stainPx)) < 60,
  `patched=${JSON.stringify(patched)} stain=${JSON.stringify(stainPx)}`);
await page.keyboard.press('Control+z');
await page.waitForTimeout(250);
const patchedUndo = await sample(targetC.x, targetC.y);
record('修补:Ctrl+Z 撤销回白(亮度>245)', luma(patchedUndo) > 245, JSON.stringify(patchedUndo));

await browser.close();
const ok = results.every(Boolean);
console.log(ok ? '✅ 减淡/加深/海绵 + 修补 e2e 全部通过' : '❌ 减淡/加深/海绵 + 修补 e2e 存在失败项');
process.exit(ok ? 0 : 1);
