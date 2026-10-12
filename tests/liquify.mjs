// 液化工作区 e2e:膨胀扩散 / 冻结保护 / 全部恢复 + 提交可撤销 / 取消不提交
// 前置:vite dev server 已在 http://localhost:1420(共享,勿重启)
// 用法:NODE_PATH=<playwright 所在 node_modules> node tests/liquify.mjs
// 注意:多智能体并行 HMR 偶发重载 → 失败请原样重跑一次再判断。
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const pw = require2(process.env.PW_PATH || 'playwright');

const results = [];
function record(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const browser = await pw.chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 })).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });

await page.goto('http://localhost:1420', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

// ---------- helpers ----------

async function menu(top, item) {
  await page.waitForSelector('.menubar', { timeout: 20000 });
  if (await page.locator('.menu-backdrop').count()) {
    await page.evaluate(() =>
      document.querySelector('.menu-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  }
  await page.click(`.menubar .menu:has(button:text-is("${top}")) button.menu-btn`);
  await page.click(`.dropdown .menu-item:has-text("${item}")`);
  if (await page.locator('.menu-backdrop').count()) {
    await page.evaluate(() =>
      document.querySelector('.menu-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  }
}

async function newDoc() {
  await page.click('button.big:text-is("新建…")');
  const dlg = page.locator('.dialog', { hasText: '新建文档' });
  await dlg.locator('input[type=number]').nth(0).fill('400');
  await dlg.locator('input[type=number]').nth(1).fill('300');
  await dlg.locator('input[value=white]').check();
  await dlg.locator('button:has-text("创建")').click();
  await page.waitForTimeout(300);
}

/** 活动层居中画 20×20 纯红点 (190,140)-(210,160),中心 (200,150)。 */
async function drawRedDot() {
  await page.evaluate(() => {
    const s = window.__store;
    const l = s.doc.layers.find(x => x.id === s.doc.activeLayerId);
    const x = l.bitmap.getContext('2d');
    x.fillStyle = '#ff0000';
    x.fillRect(190, 140, 20, 20);
    l.rev = (l.rev ?? 0) + 1;
    s.tick++; s.uiTick++;
  });
  await page.waitForTimeout(150);
}

const isRed = d => d[0] > 180 && d[1] < 100 && d[2] < 100;

async function previewRedCount() {
  return page.evaluate(() => {
    const c = document.querySelector('.lx-preview');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 180 && d[i + 1] < 100 && d[i + 2] < 100) n++;
    return n;
  });
}

async function layerRedCount() {
  return page.evaluate(() => {
    const s = window.__store;
    const l = s.doc.layers.find(x => x.id === s.doc.activeLayerId);
    const c = document.createElement('canvas');
    c.width = l.bitmap.width; c.height = l.bitmap.height;
    const x = c.getContext('2d');
    x.drawImage(l.bitmap, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 180 && d[i + 1] < 100 && d[i + 2] < 100) n++;
    return n;
  });
}

async function openLiquify() {
  await menu('滤镜', '液化…');
  await page.waitForSelector('.lx-preview', { timeout: 5000 });
  await page.waitForTimeout(200);
}

async function setSliders(size, pr) {
  const rs = page.locator('.lx-params input[type=range]');
  await rs.nth(0).fill(String(size));
  await rs.nth(1).fill(String(pr));
}

async function pickTool(label) {
  await page.click(`.lx-tools button:text-is("${label}")`);
}

/** 工作区坐标 → 页面坐标(用 __lxDebug.canvasRect + 预览画布分辨率换算) */
async function workToScreen(wx, wy) {
  return page.evaluate(([x, y]) => {
    const r = window.__lxDebug.canvasRect();
    const c = document.querySelector('.lx-preview');
    return { x: r.left + x * (r.width / c.width), y: r.top + y * (r.height / c.height) };
  }, [wx, wy]);
}

async function dragW(x1, y1, x2, y2, steps = 8) {
  const a = await workToScreen(x1, y1);
  const b = await workToScreen(x2, y2);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
  await page.waitForTimeout(60);
}

async function applyNow() {
  await page.evaluate(() => window.__lxDebug.applyNow());
}

async function samplePreview(pts) {
  return page.evaluate(pts2 => {
    const c = document.querySelector('.lx-preview');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return pts2.map(([x, y]) => {
      const o = (y * c.width + x) * 4;
      return [d[o], d[o + 1], d[o + 2], d[o + 3]];
    });
  }, pts);
}

const FROZEN_PTS = [[240, 150], [240, 160], [240, 170], [260, 120]];

// ---------- 1. 新建 → 红点 → 打开液化 ----------

await newDoc();
await drawRedDot();
await openLiquify();
record('滤镜→液化… 打开全屏模态', await page.locator('.liquify-overlay').count() > 0
  && await page.locator('.lx-preview').count() > 0);
record('工具列 9 个工具', (await page.locator('.lx-tools button').count()) === 9,
  `count=${await page.locator('.lx-tools button').count()}`);
const initial = await previewRedCount();
record('初始预览红点 = 400 像素', initial === 400, `initial=${initial}`);
const dw = await page.evaluate(() => window.__lxDebug.docToWork(200, 150));
record('docToWork 恒等(默认变换)', Math.abs(dw.x - 200) < 0.01 && Math.abs(dw.y - 150) < 0.01, JSON.stringify(dw));

// ---------- 2. 膨胀 + 大笔刷:红点扩散 ----------

await setSliders(150, 100);
await pickTool('膨胀');
await dragW(200, 150, 225, 170, 8);
await applyNow();
const bloated = await previewRedCount();
record('膨胀:红点面积变大', bloated > initial + 50, `initial=${initial} bloated=${bloated}`);

// ---------- 3. 冻结:取消重来,右半冻结后膨胀红点 ----------

await page.click('.lx-foot button:text-is("取消")');
await page.waitForSelector('.liquify-overlay', { state: 'detached', timeout: 5000 });
await openLiquify();
await setSliders(100, 100);
await pickTool('冻结蒙版');
await dragW(240, 20, 240, 280, 12);
await dragW(240, 280, 240, 20, 12); // 二次涂抹让冻结饱和到 1
await applyNow();
const fz = await page.evaluate(() => {
  const f = window.__lxDebug.getField();
  let nz = 0, full = 0;
  for (let i = 0; i < f.freeze.length; i++) {
    if (f.freeze[i] > 0) nz++;
    if (f.freeze[i] >= 1) full++;
  }
  return { nz, full };
});
record('冻结场写入(freeze 非零且含饱和区)', fz.nz > 1000 && fz.full > 200, JSON.stringify(fz));
const frozenBefore = await samplePreview(FROZEN_PTS);
await setSliders(150, 100);
await pickTool('膨胀');
await dragW(200, 150, 225, 170, 8);
await applyNow();
const frozenAfter = await samplePreview(FROZEN_PTS);
const same = frozenBefore.every((p, i) => p.every((v, j) => v === frozenAfter[i][j]));
record('冻结区像素逐字节不变', same,
  `${JSON.stringify(frozenBefore)} → ${JSON.stringify(frozenAfter)}`);
const stillBloated = await previewRedCount();
record('冻结不阻碍红点(靠左)膨胀', stillBloated > initial + 20, `bloated=${stillBloated}`);

// ---------- 4. 全部恢复 → 预览回原;确定提交可撤销 ----------

await pickTool('全部恢复');
await applyNow();
const restored = await previewRedCount();
record('全部恢复:预览回原', restored === initial, `restored=${restored} initial=${initial}`);
const fzLeft = await page.evaluate(() => {
  const f = window.__lxDebug.getField();
  let nz = 0;
  for (let i = 0; i < f.freeze.length; i++) if (f.freeze[i] > 0) nz++;
  return nz;
});
record('全部恢复:冻结一并清零', fzLeft === 0, `nonzero=${fzLeft}`);

await dragW(200, 150, 225, 170, 8);
await applyNow();
const beforeCommit = await previewRedCount();
record('重新膨胀(有内容可提交)', beforeCommit > initial, `=${beforeCommit}`);
await page.click('.lx-foot button:text-is("确定")');
await page.waitForSelector('.liquify-overlay', { state: 'detached', timeout: 5000 });
record('确定后模态关闭', (await page.locator('.liquify-overlay').count()) === 0);
const afterCommit = await layerRedCount();
record('确定:图层位图像素 = 预览(红点扩散保留)', afterCommit === beforeCommit,
  `layer=${afterCommit} preview=${beforeCommit}`);
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
const afterUndo = await layerRedCount();
record('Ctrl+Z 撤销液化(回原)', afterUndo === initial, `=${afterUndo}`);

// ---------- 5. 取消路径:变形后 Esc,图层不变 ----------

await openLiquify();
await setSliders(150, 100);
await pickTool('膨胀');
await dragW(200, 150, 235, 175, 10);
await applyNow();
const escPreview = await previewRedCount();
record('取消路径:预览确已变形', escPreview > initial, `=${escPreview}`);
await page.keyboard.press('Escape');
await page.waitForSelector('.liquify-overlay', { state: 'detached', timeout: 5000 });
record('Esc 关闭模态', (await page.locator('.liquify-overlay').count()) === 0);
const escLayer = await layerRedCount();
record('取消不提交:图层位图未变', escLayer === initial, `=${escLayer}`);

await browser.close();
const ok = results.every(Boolean);
console.log(ok ? '✅ 液化工作区 e2e 全部通过' : '❌ 液化工作区 e2e 存在失败项');
process.exit(ok ? 0 : 1);
