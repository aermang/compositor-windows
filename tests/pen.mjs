// 钢笔工具 + 路径系统 e2e:
//  阶段1(验收链):三个角点 → Enter 闭合 → 工作路径断言 → 建立选区 → 描边路径像素变暗 → 填充路径
//  阶段2:拖拽平滑点(镜像手柄)/ Alt 拖断开手柄 / 提交为路径 / undo-redo
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const pw = require2(process.env.PW_PATH || 'playwright');

const browser = await pw.chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 })).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });

let OFF = { x: 0, y: 0 }, V = { z: 1, px: 0, py: 0 };
const S = (dx, dy) => ({ x: OFF.x + V.px + dx * V.z, y: OFF.y + V.py + dy * V.z });
async function clickDoc(dx, dy) {
  const s = S(dx, dy);
  await page.mouse.click(s.x, s.y);
}
async function dragDoc(dx1, dy1, dx2, dy2, alt = false) {
  const a = S(dx1, dy1), b = S(dx2, dy2);
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  if (alt) await page.keyboard.up('Alt');
}
const readPixel = (x, y) => page.evaluate(([px, py]) => {
  const s = window.__store;
  const l = s.doc.layers.find(l => l.id === s.doc.activeLayerId);
  return Array.from(l.bitmap.getContext('2d').getImageData(px, py, 1, 1).data.slice(0, 3));
}, [x, y]);
const brightness = v => (v[0] + v[1] + v[2]) / 3;
const near = (a, b, eps = 3) => Math.abs(a - b) <= eps;

await page.goto('http://localhost:1420', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
// 新建 800×600 白底文档(与 psdRoundTrip 相同的对话框写法)
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

// ---------- 阶段 1:验收链 ----------

// 按 P 切钢笔,单击三个点(间隔 60 文档px 以上)构成三角形
await page.keyboard.press('p');
await page.waitForTimeout(100);
const tool = await page.evaluate(() => window.__store.tool);
console.log('tool after P:', tool);
const PTS = [[200, 150], [500, 150], [350, 420]];
for (const [dx, dy] of PTS) await clickDoc(dx, dy);
await page.waitForTimeout(150);

// Enter 闭合当前子路径
await page.keyboard.press('Enter');
await page.waitForTimeout(150);

// 工作路径断言:1 条闭合子路径、3 个锚点
const work = await page.evaluate(() => window.__penDebug.getWorkPath());
console.log('work path:', JSON.stringify(work));
const sub = work?.subpaths?.[0];
const workOk = !!sub && sub.closed === true && sub.anchors.length === 3
  && sub.anchors.every(a => Array.isArray(a.p) && a.p.length === 2);
console.log(workOk ? '✅ 工作路径:3 锚点已闭合' : '❌ 工作路径状态不符');

// PathsPanel → 建立选区 → bounds 非空
await page.click('.paths-panel button:has-text("建立选区")');
await page.waitForTimeout(200);
const bounds = await page.evaluate(() => window.__store.selection?.bounds ?? null);
console.log('selection bounds:', JSON.stringify(bounds));
const selOk = !!bounds && bounds.w > 100 && bounds.h > 100;
console.log(selOk ? '✅ 建立选区:bounds 非空' : '❌ 选区未建立');

// PathsPanel → 描边路径:三角形边中点应显著变暗,远离路径的中心点应保持白
await page.click('.paths-panel button:has-text("描边路径")');
await page.waitForTimeout(300);
const edgeMid = await readPixel(350, 150);
const center = await readPixel(350, 260);
console.log('edge midpoint rgb:', edgeMid, ' doc-center rgb:', center);
const strokeOk = brightness(edgeMid) < 128;
const clearOk = brightness(center) > 240;
console.log(strokeOk ? '✅ 描边路径:边中点显著变暗' : '❌ 描边路径像素未变暗');
console.log(clearOk ? '✅ 描边未溢出:远离路径处保持白色' : '❌ 描边溢出到不该有墨的地方');

// PathsPanel → 填充路径:三角形内部应变为前景色(黑)
await page.click('.paths-panel button:has-text("填充路径")');
await page.waitForTimeout(300);
const filled = await readPixel(350, 260);
const fillOk = brightness(filled) < 128;
console.log('after fill center rgb:', filled);
console.log(fillOk ? '✅ 填充路径:内部变为前景色' : '❌ 填充路径未生效');

// ---------- 阶段 2:手柄 / 提交 / 历史 ----------

// Esc 清空工作路径(无未闭合子路径时整条清除)
await page.keyboard.press('Escape');
await page.waitForTimeout(100);
const cleared = await page.evaluate(() => window.__penDebug.getWorkPath());
const escOk = cleared === null;
console.log(escOk ? '✅ Esc 清空工作路径' : '❌ Esc 未清空工作路径:' + JSON.stringify(cleared));

// 拖拽出平滑点:out=(100,80) 且 in 镜像;再单击一个角点,Enter 闭合(2 锚点)
await dragDoc(150, 480, 250, 560);
await clickDoc(650, 480);
await page.keyboard.press('Enter');
await page.waitForTimeout(150);
const w2 = await page.evaluate(() => window.__penDebug.getWorkPath());
const s2 = w2?.subpaths?.[0];
const a0 = s2?.anchors?.[0], a1 = s2?.anchors?.[1];
console.log('smooth subpath:', JSON.stringify(s2));
const smoothOk = s2?.closed === true
  && near(a0?.out?.[0], 100) && near(a0?.out?.[1], 80)
  && near(a0?.in?.[0], -100) && near(a0?.in?.[1], -80)
  && a1?.in === null && a1?.out === null;
console.log(smoothOk ? '✅ 拖拽平滑点:手柄镜像,角点无手柄' : '❌ 平滑点手柄不符');

// Alt+拖拽:断开手柄,只有 out 跟随(in 保持 null);Esc 丢弃这条 1 锚点子路径
await dragDoc(150, 100, 220, 130, true);
await page.waitForTimeout(100);
const w3 = await page.evaluate(() => window.__penDebug.getWorkPath());
const aAlt = w3?.subpaths?.[1]?.anchors?.[0];
console.log('alt anchor:', JSON.stringify(aAlt));
const altOk = aAlt && aAlt.in === null && near(aAlt.out?.[0], 70) && near(aAlt.out?.[1], 30)
  && w3.subpaths.length === 2;
console.log(altOk ? '✅ Alt 拖拽:手柄断开(仅 out)' : '❌ Alt 断开手柄不符');
await page.keyboard.press('Escape'); // 丢弃未闭合的 Alt 子路径
await page.waitForTimeout(100);

// 提交为路径:doc.paths 出现「路径 1」,工作路径清空
await page.click('.paths-panel button:has-text("提交为路径")');
await page.waitForTimeout(200);
const committed = await page.evaluate(() => ({
  paths: window.__store.doc.paths ?? [],
  work: window.__penDebug.getWorkPath(),
}));
const saved = committed.paths?.[0];
const commitOk = committed.paths?.length === 1 && saved?.name === '路径 1'
  && saved?.subpaths?.length === 1 && committed.work === null;
console.log('doc.paths:', JSON.stringify(committed.paths));
console.log(commitOk ? '✅ 提交为路径:已入列,工作路径清空' : '❌ 提交为路径不符');

// 历史:Ctrl+Z 还原空数组,Ctrl+Shift+Z 重做
await page.keyboard.press('Control+z');
await page.waitForTimeout(150);
const afterUndo = await page.evaluate(() => (window.__store.doc.paths ?? []).length);
await page.keyboard.press('Control+Shift+z');
await page.waitForTimeout(150);
const afterRedo = await page.evaluate(() => (window.__store.doc.paths ?? []).length);
const historyOk = afterUndo === 0 && afterRedo === 1;
console.log(`after undo paths=${afterUndo}, after redo paths=${afterRedo}`);
console.log(historyOk ? '✅ 路径历史:undo/redo 还原 doc.paths' : '❌ 路径历史不符');

// 提交后目标回到已存路径:建立选区仍可用(作用于选中的保存路径)
await page.click('.paths-panel button:has-text("建立选区")');
await page.waitForTimeout(200);
const bounds2 = await page.evaluate(() => window.__store.selection?.bounds ?? null);
const sel2Ok = !!bounds2;
console.log(sel2Ok ? '✅ 已存路径建立选区:bounds 非空' : '❌ 已存路径建立选区失败');

const ok = tool === 'pen' && workOk && selOk && strokeOk && clearOk && fillOk
  && escOk && smoothOk && altOk && commitOk && historyOk && sel2Ok;
console.log(ok ? '\n✅ 钢笔工具 e2e 全部 PASS' : '\n❌ 钢笔工具 e2e FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
