// 操控变形(Puppet Warp)e2e:图钉放置 / 拖动变形 / 拖回复原 / 提交可撤销 / 取消不提交
// 前置:vite dev server 已在 http://localhost:1420(共享,勿重启)
// 用法:NODE_PATH=<playwright 所在 node_modules> node tests/puppet.mjs
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
page.on('pageerror', e => { results.push(false); console.log('PAGEERROR:', e.message); });
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

/** 活动层画 20×20 纯红点(中心 200,150)与 20×20 纯蓝点(中心 330,150)。 */
async function drawRedBlueDots() {
  await page.evaluate(() => {
    const s = window.__store;
    const l = s.doc.layers.find(x => x.id === s.doc.activeLayerId);
    const x = l.bitmap.getContext('2d');
    x.fillStyle = '#ff0000';
    x.fillRect(190, 140, 20, 20);
    x.fillStyle = '#0000ff';
    x.fillRect(320, 140, 20, 20);
    l.rev = (l.rev ?? 0) + 1;
    s.tick++; s.uiTick++;
  });
  await page.waitForTimeout(150);
}

/** 预览画布(或指定选择器)矩形区域内纯红/纯蓝像素计数。 */
async function regionCount(x1, y1, x2, y2, ch, sel = '.pp-preview') {
  return page.evaluate(([a, b, c, d, ch, sel]) => {
    const el = document.querySelector(sel);
    const ctx = el.getContext('2d');
    const img = ctx.getImageData(a, b, c - a, d - b).data;
    let n = 0;
    for (let i = 0; i < img.length; i += 4) {
      const r = img[i], g = img[i + 1], bl = img[i + 2];
      const hit = ch === 'red' ? (r > 180 && g < 100 && bl < 100) : (bl > 180 && r < 100 && g < 100);
      if (hit) n++;
    }
    return n;
  }, [x1, y1, x2, y2, ch, sel]);
}

const totalRed = () => regionCount(0, 0, 400, 300, 'red');
const totalBlue = () => regionCount(0, 0, 400, 300, 'blue');
// 红点初始区(含边距)/ 拖后预期区 / 蓝点区
const redOrig = () => regionCount(180, 130, 220, 170, 'red');
const redNew = () => regionCount(230, 105, 305, 195, 'red');
const blueZone = ch => regionCount(305, 125, 355, 175, ch);

async function layerRegionCount(x1, y1, x2, y2, ch) {
  return page.evaluate(([a, b, c, d, ch]) => {
    const s = window.__store;
    const l = s.doc.layers.find(x => x.id === s.doc.activeLayerId);
    const cv = document.createElement('canvas');
    cv.width = l.bitmap.width; cv.height = l.bitmap.height;
    const x = cv.getContext('2d');
    x.drawImage(l.bitmap, 0, 0);
    const img = x.getImageData(a, b, c - a, d - b).data;
    let n = 0;
    for (let i = 0; i < img.length; i += 4) {
      const r = img[i], g = img[i + 1], bl = img[i + 2];
      const hit = ch === 'red' ? (r > 180 && g < 100 && bl < 100) : (bl > 180 && r < 100 && g < 100);
      if (hit) n++;
    }
    return n;
  }, [x1, y1, x2, y2, ch]);
}

const layerTotal = ch => layerRegionCount(0, 0, 400, 300, ch);
const layerRedOrig = () => layerRegionCount(190, 140, 210, 160, 'red');

async function openPuppet() {
  await menu('编辑', '操控变形…');
  await page.waitForSelector('.pp-preview', { timeout: 5000 });
  await page.waitForTimeout(200);
}

/** addPin + 返回吸附后的图钉坐标 */
async function addPinAt(x, y) {
  return page.evaluate(([x, y]) => {
    const idx = window.__ppDebug.addPin(x, y);
    const pins = window.__ppDebug.getPins();
    return { idx, pin: pins[idx] };
  }, [x, y]);
}

async function dragPin(i, x, y) {
  await page.evaluate(([i, x, y]) => {
    window.__ppDebug.dragPin(i, x, y);
    window.__ppDebug.renderNow();
  }, [i, x, y]);
}

// ---------- 1. 新建 → 红蓝点 → 打开操控变形 ----------

await newDoc();
await drawRedBlueDots();
await openPuppet();
record('编辑→操控变形… 打开全屏模态', await page.locator('.puppet-overlay').count() > 0
  && await page.locator('.pp-preview').count() > 0);
const meshInfo = await page.evaluate(() => {
  const m = window.__ppDebug.getMesh();
  return { gx: m.gx, gy: m.gy, n: m.ox.length };
});
record('网格已建(gx/gy ≥ 1)', meshInfo.gx >= 1 && meshInfo.gy >= 1
  && meshInfo.n === (meshInfo.gx + 1) * (meshInfo.gy + 1), JSON.stringify(meshInfo));
const ir = await totalRed();
const ib = await totalBlue();
record('初始预览 = 原图(红 400 / 蓝 400)', ir === 400 && ib === 400, `red=${ir} blue=${ib}`);
const dis0 = await page.locator('.pp-foot button.primary').isDisabled();
record('无图钉时确定按钮禁用', dis0);

// ---------- 2. 两图钉 → 拖红图钉右移 60px → 周围跟随、蓝点不动 ----------

const p0 = await addPinAt(200, 150);
const p1 = await addPinAt(330, 150);
record('图钉吸附到格点(getPins 可读)', p0.idx === 0 && p1.idx === 1
  && Number.isFinite(p0.pin.x) && Number.isFinite(p1.pin.y),
  JSON.stringify({ p0: p0.pin, p1: p1.pin }));
const en1 = await page.locator('.pp-foot button.primary').isEnabled();
record('加图钉后确定按钮启用', en1);

await dragPin(0, p0.pin.x + 60, p0.pin.y);
const dr = await totalRed();
const dNew = await redNew();
const dOrig = await redOrig();
const dbR = await blueZone('red');
const dbB = await blueZone('blue');
record('拖动:红点移动到新位置', dNew >= 300, `newRegion=${dNew}`);
record('拖动:红点离开原位', dOrig <= 40, `origRegion=${dOrig}`);
record('拖动:蓝点区域无红像素', dbR === 0, `=${dbR}`);
record('拖动:蓝点基本不动(蓝像素仍在)', dbB >= 300, `=${dbB}`);
record('拖动:红像素守恒(内容跟随非复制)', dr >= 320 && dr <= 460, `total=${dr}`);

// ---------- 3. 拖回原位 → 预览逐字节复原 ----------

await dragPin(0, p0.pin.x, p0.pin.y);
const br = await totalRed();
const bb = await totalBlue();
record('拖回原位:预览≈初始(红 400 / 蓝 400)', br === 400 && bb === 400, `red=${br} blue=${bb}`);

// ---------- 4. 确定 → 图层位图 = 预览;Ctrl+Z 回原 ----------

await page.evaluate(() => window.__ppDebug.commitPreview());
await page.waitForSelector('.puppet-overlay', { state: 'detached', timeout: 5000 });
record('确定后模态关闭', (await page.locator('.puppet-overlay').count()) === 0);
const cr = await layerTotal('red');
const cb = await layerTotal('blue');
const cro = await layerRedOrig();
record('确定:图层位图 = 预览(红蓝点完整保留)', cr === 400 && cb === 400 && cro === 400,
  `red=${cr} blue=${cb} redOrig=${cro}`);
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
const ur = await layerTotal('red');
const ub = await layerTotal('blue');
record('Ctrl+Z 撤销操控变形(位图不变,回原)', ur === 400 && ub === 400, `red=${ur} blue=${ub}`);

// ---------- 5. 再开 → 拖动 → Esc → 位图未变 ----------

await openPuppet();
await addPinAt(200, 150);
await addPinAt(330, 150);
const q0 = await page.evaluate(() => window.__ppDebug.getPins()[0]);
await dragPin(0, q0.x + 60, q0.y);
const er = await redOrig();
const ert = await totalRed();
record('取消路径:预览确已变形(红点离开原位)', er <= 40 && ert >= 320, `orig=${er} total=${ert}`);
await page.keyboard.press('Escape');
await page.waitForSelector('.puppet-overlay', { state: 'detached', timeout: 5000 });
record('Esc 关闭模态', (await page.locator('.puppet-overlay').count()) === 0);
const fr = await layerTotal('red');
const fb = await layerTotal('blue');
const fro = await layerRedOrig();
record('取消不提交:图层位图未变', fr === 400 && fb === 400 && fro === 400,
  `red=${fr} blue=${fb} redOrig=${fro}`);

await browser.close();
const ok = results.every(Boolean);
console.log(ok ? '✅ 操控变形 e2e 全部通过' : '❌ 操控变形 e2e 存在失败项');
process.exit(ok ? 0 : 1);
