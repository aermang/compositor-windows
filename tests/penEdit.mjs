// 钢笔事后编辑 + 多边形形状 e2e(骨架抄 tests/pen.mjs):
//  1) 画开放 3 锚路径 → 第 4 点点回起点闭合
//  2) 拖动中间锚点(屏幕偏移 40px → doc 移动 40/zoom)
//  3) Alt+点击锚点删除(余 ≤2 拒绝;4 锚子路径 4→3)
//  4) 单击线段中点 → 插入新锚点且拖动生效
//  5) 双击角点 → 平滑(handles 非空);再双击 → 回角点(null)
//  6) 编辑后的工作路径「建立选区」→ mask 采样正确 → Ctrl+D 取消
//  7) 形状工具 + 多边形 + 6 边 → 拖画 → 位图中心/0.8R 不透明、1.2R 透明
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const pw = require2(process.env.PW_PATH || 'playwright');

const browser = await pw.chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 })).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

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
const work = () => page.evaluate(() => window.__penDebug.getWorkPath());
const near = (a, b, eps = 2.5) => Math.abs(a - b) <= eps;

await page.goto('http://localhost:1420', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
// 新建 600×400 白底文档(与 pen.mjs 相同的对话框写法)
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

// ---------- 1) 画路径:3 个角点 + 第 4 点回起点闭合 ----------
await page.keyboard.press('p');
await page.waitForTimeout(120);
const tool = await page.evaluate(() => window.__store.tool);
record('P 切钢笔', tool === 'pen', `tool=${tool}`);

const PTS = [[150, 80], [450, 80], [450, 300]];
for (const [dx, dy] of PTS) await clickDoc(dx, dy);
await page.waitForTimeout(120);
let w = await work();
let sub0 = w?.subpaths?.[0];
record('开放路径 3 锚点', !!sub0 && sub0.anchors.length === 3 && sub0.closed === false,
  JSON.stringify(sub0?.anchors?.map(a => a.p)));

await clickDoc(150, 80); // 第 4 点落在起点锚点上 → 闭合(编辑命中不抢闭合手势)
await page.waitForTimeout(120);
w = await work();
sub0 = w?.subpaths?.[0];
record('第 4 点回起点闭合(3 锚闭合路径)', !!sub0 && sub0.closed === true && sub0.anchors.length === 3,
  JSON.stringify({ closed: sub0?.closed, n: sub0?.anchors?.length }));

// ---------- 2) 拖动中间锚点 ----------
const midBefore = sub0.anchors[1].p; // (450, 80)
{
  const s = S(midBefore[0], midBefore[1]);
  await page.mouse.move(s.x, s.y);
  await page.mouse.down();
  await page.mouse.move(s.x + 40, s.y, { steps: 6 }); // 屏幕偏移 40px
  await page.mouse.up();
  await page.waitForTimeout(120);
}
w = await work();
const midAfter = w.subpaths[0].anchors[1].p;
const expect = 40 / V.z;
const dragOk = near(midAfter[0] - midBefore[0], expect, 2.5) && near(midAfter[1] - midBefore[1], 0, 2.5);
record('拖动锚点:doc 位移 ≈ 40/zoom', dragOk,
  `before=${JSON.stringify(midBefore)} after=${JSON.stringify(midAfter)} expectΔ=${expect.toFixed(2)}`);

// ---------- 3) Alt+点击删除锚点 ----------
// 3 锚闭合路径再删只剩 2 → 必须被拒绝
{
  const s = S(450, 300); // sub0 anchors[2]
  await page.keyboard.down('Alt');
  await page.mouse.click(s.x, s.y);
  await page.keyboard.up('Alt');
  await page.waitForTimeout(120);
}
w = await work();
const refusedOk = w.subpaths[0].anchors.length === 3;
record('Alt+点击:余 ≤2 拒绝删除(仍 3 锚)', refusedOk, `n=${w.subpaths[0].anchors.length}`);

// 另画一条 4 锚开放子路径,再删其中 1 锚 → 4→3
// (位置避开三角形斜边 (450,300)→(150,80),否则线段命中会抢先插锚点)
const SUB1 = [[80, 260], [200, 260], [200, 340], [80, 340]];
for (const [dx, dy] of SUB1) await clickDoc(dx, dy);
await page.waitForTimeout(120);
w = await work();
const nSub = w.subpaths.length;
record('第 2 条子路径 4 锚', nSub === 2 && w.subpaths[1].anchors.length === 4 && w.subpaths[1].closed === false,
  `subs=${nSub}, sub1=${JSON.stringify(w.subpaths[1]?.anchors?.map(a => a.p))}`);

{
  const s = S(200, 260); // sub1 anchors[1]
  await page.keyboard.down('Alt');
  await page.mouse.click(s.x, s.y);
  await page.keyboard.up('Alt');
  await page.waitForTimeout(120);
}
w = await work();
const delOk = w.subpaths.length === 2 && w.subpaths[1].anchors.length === 3
  && JSON.stringify(w.subpaths[1].anchors.map(a => [Math.round(a.p[0]), Math.round(a.p[1])]))
    === JSON.stringify([[80, 260], [200, 340], [80, 340]]);
record('Alt+点击删除:4→3', delOk, `sub1=${JSON.stringify(w.subpaths[1]?.anchors?.map(a => a.p))}`);

// ---------- 4) 线段中点单击 → 插入锚点并拖动 ----------
{
  const s = S(320, 80); // sub0 顶边 [0]=(150,80) → [1]=(490,80) 的中点
  await page.mouse.move(s.x, s.y);
  await page.mouse.down();
  await page.mouse.move(s.x + 30, s.y, { steps: 5 }); // 插入后立即拖动
  await page.mouse.up();
  await page.waitForTimeout(120);
}
w = await work();
sub0 = w.subpaths[0];
const ins = sub0.anchors.length === 4;
const insP = sub0.anchors[1].p;
const insPosOk = ins && near(insP[0] - 320, 30 / V.z, 2.5) && near(insP[1], 80, 2.5);
const insHandlesOk = ins && Array.isArray(sub0.anchors[1].in) && Array.isArray(sub0.anchors[1].out);
record('线段插入锚点:数量 3→4', ins, `n=${sub0.anchors.length}`);
record('插入的锚点随拖动移动且带手柄', insPosOk && insHandlesOk,
  `p=${JSON.stringify(insP)} expect≈[${(320 + 30 / V.z).toFixed(1)},80] in=${JSON.stringify(sub0.anchors[1]?.in)}`);

// ---------- 5) 双击角点 ⇄ 平滑切换 ----------
{
  const s = S(200, 340); // sub1 anchors[1] = (200,340)
  await page.mouse.dblclick(s.x, s.y);
  await page.waitForTimeout(150);
}
w = await work();
const sm = w.subpaths[1].anchors[1];
const smoothOk = sm.in !== null && sm.out !== null
  && near(Math.abs(sm.out[0]), 0, 0.5) && sm.out[1] > 0 && near(sm.in[0], -sm.out[0], 0.001) && near(sm.in[1], -sm.out[1], 0.001);
record('双击角点 → 平滑(镜像手柄,沿邻点方向)', smoothOk,
  `in=${JSON.stringify(sm.in)} out=${JSON.stringify(sm.out)}`);

{
  // 等 600ms 让 Chromium 的连击计数复位,确保第二次 dblclick 事件照常触发
  await page.waitForTimeout(600);
  const s = S(200, 340);
  await page.mouse.dblclick(s.x, s.y);
  await page.waitForTimeout(150);
}
w = await work();
const backOk = w.subpaths[1].anchors[1].in === null && w.subpaths[1].anchors[1].out === null;
record('再双击 → 回角点(handles 置 null)', backOk,
  `in=${JSON.stringify(w.subpaths[1].anchors[1].in)} out=${JSON.stringify(w.subpaths[1].anchors[1].out)}`);

// ---------- 6) 编辑后的路径仍可建立选区 ----------
await page.click('.paths-panel button:has-text("建立选区")');
await page.waitForTimeout(250);
const sel = await page.evaluate(() => {
  const s = window.__store.selection;
  if (!s) return null;
  const sample = (x, y) => s.mask.getContext('2d').getImageData(x, y, 1, 1).data[3];
  return {
    bounds: s.bounds,
    inside: sample(340, 190), // 三角形内部(sub0)
    outside: sample(560, 390), // 所有子路径外
  };
});
const selOk = !!sel?.bounds && sel.bounds.w > 100 && sel.inside > 200 && sel.outside < 50;
record('编辑后的路径建立选区:bounds + mask 采样', selOk,
  JSON.stringify(sel));

await page.keyboard.press('Control+d');
await page.waitForTimeout(150);
const selGone = await page.evaluate(() => window.__store.selection === null);
record('Ctrl+D 取消选区', selGone);

// ---------- 7) 多边形形状 ----------
await page.keyboard.press('u');
await page.waitForTimeout(120);
const tool2 = await page.evaluate(() => window.__store.tool);
await page.selectOption('.tool-options select.select', 'polygon');
await page.waitForTimeout(80);
// range 滑杆不能用 fill,直接走原生 setter + input 事件(v-model.number 监听 input)
await page.evaluate(() => {
  const r = document.querySelector('.tool-options input[type=range]');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(r, '6');
  r.dispatchEvent(new Event('input', { bubbles: true }));
  r.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(80);
const shapeOpts = await page.evaluate(() => ({ kind: window.__store.opts.shape.kind, sides: window.__store.opts.shape.sides }));
record('形状工具 + 多边形 + 6 辺', tool2 === 'shape' && shapeOpts.kind === 'polygon' && shapeOpts.sides === 6,
  `tool=${tool2} opts=${JSON.stringify(shapeOpts)}`);

await dragDoc(250, 150, 550, 350); // w=300 h=200 → R=min/2=100
await page.waitForTimeout(300);
const poly = await page.evaluate(() => {
  const s = window.__store;
  const l = [...s.doc.layers].reverse().find(l => l.name === '多边形');
  if (!l || !l.bitmap) return null;
  const c = l.bitmap.getContext('2d');
  const W = l.bitmap.width, H = l.bitmap.height;
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2;
  const a = (x, y) => c.getImageData(Math.round(x), Math.round(y), 1, 1).data[3];
  // 顶点方向 -30°(六边形 6 顶点之一),沿该方向取 0.8R(内部)与 1.2R(外接圆外)
  const cos = Math.cos(-Math.PI / 6), sin = Math.sin(-Math.PI / 6);
  return {
    meta: { kind: l.shape?.kind, sides: l.shape?.sides },
    W, H, R,
    center: a(cx, cy),
    v08: a(cx + 0.8 * R * cos, cy + 0.8 * R * sin),
    v12: a(cx + 1.2 * R * cos, cy + 1.2 * R * sin),
  };
});
const polyOk = !!poly && poly.meta.kind === 'polygon' && poly.meta.sides === 6
  && poly.center > 200 && poly.v08 > 200 && poly.v12 < 10;
record('多边形位图:中心/0.8R 不透明,1.2R 透明', polyOk, JSON.stringify(poly));

// ---------- 汇总 ----------
const ok = tool === 'pen' && results.every(r => r.ok);
for (const r of results) if (!r.ok) console.log(`failed: ${r.name}`);
console.log(ok ? '\n✅ 钢笔事后编辑 + 多边形 e2e 全部 PASS' : '\n❌ 钢笔事后编辑 + 多边形 e2e FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
