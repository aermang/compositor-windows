// 智能滤镜 e2e:非破坏性 / 噪声确定性 / 按层缓存正确性 / 面板 UI / 性能探针。
// 运行:NODE_PATH="<npx playwright 缓存目录>" node tests/smartfilter.mjs
// 共享 dev server 上多智能体并行改文件,HMR 可能随时整页刷新或替换 store:
// 所有阶段前都经 ensureScenario 重建现场(必要时硬 reload),核心段失败重跑一次。
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const pw = require2(process.env.PW_PATH || 'playwright');

const browser = await pw.chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 })).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });

let failed = false;
function check(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failed = true;
}

async function drawRectAndEnsureActive() {
  await page.keyboard.press('u');
  const box = await page.locator('.canvas-host canvas').first().boundingBox();
  const V = await page.evaluate(() => { const s = window.__store; return { z: s.zoom, px: s.panX, py: s.panY }; });
  const S = (dx, dy) => ({ x: box.x + V.px + dx * V.z, y: box.y + V.py + dy * V.z });
  await page.mouse.move(S(80, 60).x, S(80, 60).y);
  await page.mouse.down();
  await page.mouse.move(S(260, 200).x, S(260, 200).y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  // 形状层建在背景之上,置为活动层(面板/断言都以它为对象)
  await page.evaluate(() => {
    const s = window.__store;
    s.doc.activeLayerId = s.doc.layers[s.doc.layers.length - 1].id;
    s.tick++;
  });
}

/** 新建 400×300 白底文档并画一个矩形;页面失焦/HMR 后可整体重来。 */
async function setupDoc() {
  await page.click('button.big:text-is("新建…")');
  const dlg = page.locator('.dialog', { hasText: '新建文档' });
  await dlg.locator('input[type=number]').nth(0).fill('400');
  await dlg.locator('input[type=number]').nth(1).fill('300');
  await dlg.locator('input[value=white]').check();
  await dlg.locator('button:has-text("创建")').click();
  await page.waitForTimeout(300);
  await drawRectAndEnsureActive();
}

/** 确保页面有一个「背景+矩形」文档:doc 丢失(HMR 整页刷新)则重建。 */
async function ensureScenario() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ok = await page.evaluate(() => {
        const s = window.__store;
        return !!(s?.doc && s.doc.layers.length >= 2);
      });
      if (ok) return;
      console.log('[HMR] 现场丢失,重建测试文档');
      const welcome = page.locator('button.big:text-is("新建…")');
      if (!(await welcome.isVisible().catch(() => false))) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('button.big:text-is("新建…")', { timeout: 30000 });
      }
      await setupDoc();
      const ok2 = await page.evaluate(() => !!(window.__store?.doc && window.__store.doc.layers.length >= 2));
      if (ok2) return;
    } catch (e) {
      console.log(`[retry ${attempt}] ${String(e.message).split('\n')[0]}`);
      await page.waitForTimeout(1500);
    }
  }
  throw new Error('无法建立测试现场(共享 dev server 持续 HMR)');
}

await page.goto('http://localhost:1420', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('button.big:text-is("新建…")', { timeout: 60000 });
await page.waitForTimeout(500);
await ensureScenario();

// ---- 核心断言:非破坏 / 确定性 / 禁用还原 / 缓存失效(失败自动重建重跑) ----
let r = null;
for (let attempt = 1; attempt <= 2 && !r; attempt++) {
  try {
    r = await page.evaluate(async () => {
      const s = window.__store;
      const { composite, resetPrepareLayerCache } = await import('/src/core/compositor.ts');
      const { bumpLayerRev } = await import('/src/core/store.ts');

      // FNV-1a 像素校验和
      const check = c => {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let h = 2166136261 >>> 0;
        for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619); }
        return h >>> 0;
      };

      const layer = s.doc.layers[s.doc.layers.length - 1];
      s.doc.activeLayerId = layer.id;
      s.tick++;

      const bmp0 = check(layer.bitmap);
      resetPrepareLayerCache();
      const C0 = check(composite(s.doc));

      // 高斯模糊:合成结果必须变,位图必须不动(非破坏)
      layer.smartFilters = [{ id: 't1', kind: 'gaussianBlur', params: { radius: 8 }, enabled: true }];
      s.tick++;
      const C1 = check(composite(s.doc));
      const C1b = check(composite(s.doc)); // 第二次走缓存命中路径,输出必须一致
      const bmp1 = check(layer.bitmap);

      // 噪声确定性:同一 filter.id 两次合成必须逐位一致(种子稳定性)
      layer.smartFilters = [{ id: 'n1', kind: 'addNoise', params: { amount: 30, monochromatic: true }, enabled: true }];
      s.tick++;
      const N1 = check(composite(s.doc));
      const N1b = check(composite(s.doc));

      // 叠加两条(顺序栈):结果 ≠ 单条
      layer.smartFilters = [
        { id: 't1', kind: 'gaussianBlur', params: { radius: 8 }, enabled: true },
        { id: 'n1', kind: 'addNoise', params: { amount: 30, monochromatic: true }, enabled: true },
      ];
      s.tick++;
      const CN = check(composite(s.doc));

      // 全部禁用 → 回到初始合成
      for (const f of layer.smartFilters) f.enabled = false;
      s.tick++;
      const COff = check(composite(s.doc));
      const bmp2 = check(layer.bitmap);

      // 缓存正确性:清掉滤镜后,就地改位图 + bumpLayerRev 必须立刻反映到合成
      layer.smartFilters = null;
      s.tick++;
      const K0 = check(composite(s.doc));
      layer.bitmap.getContext('2d').fillStyle = '#ff00ff';
      layer.bitmap.getContext('2d').fillRect(0, 0, 30, 30);
      bumpLayerRev(layer);
      const K1 = check(composite(s.doc));

      return { bmp0, bmp1, bmp2, C0, C1, C1b, N1, N1b, CN, COff, K0, K1 };
    });
  } catch (e) {
    console.log(`[core retry ${attempt}] ${String(e.message).split('\n')[0]}`);
    await ensureScenario();
  }
}
if (!r) throw new Error('核心断言段两次失败');

check('高斯模糊改变合成结果', r.C1 !== r.C0, `C0=${r.C0} C1=${r.C1}`);
check('缓存命中输出一致', r.C1b === r.C1);
check('噪声两次合成一致(种子稳定)', r.N1 === r.N1b, `N1=${r.N1}`);
check('叠加栈 ≠ 单条', r.CN !== r.C0 && r.CN !== r.C1 && r.CN !== r.N1);
check('全禁用回到初始合成', r.COff === r.C0, `COff=${r.COff} C0=${r.C0}`);
check('图层位图未被修改(非破坏)', r.bmp0 === r.bmp1 && r.bmp0 === r.bmp2);
check('rev bump 使缓存失效', r.K1 !== r.K0, `K0=${r.K0} K1=${r.K1}`);

// ---- 面板 UI:添加一条滤镜后 doc.smartFilters 长度 +1 ----
await ensureScenario();
await page.waitForTimeout(150);
const before = await page.evaluate(() => {
  const s = window.__store;
  return (s.doc.layers.find(l => l.id === s.doc.activeLayerId)?.smartFilters ?? []).length;
});
await page.selectOption('.smartfilter-panel select.sf-add', { label: '高斯模糊' });
await page.waitForTimeout(150);
const ui = await page.evaluate(() => {
  const s = window.__store;
  const l = s.doc.layers.find(l => l.id === s.doc.activeLayerId);
  return {
    count: (l?.smartFilters ?? []).length,
    kind: l?.smartFilters?.[0]?.kind ?? null,
    rows: document.querySelectorAll('.smartfilter-panel .sf-item').length,
  };
});
check('面板添加滤镜 → 长度 +1', ui.count === before + 1, `before=${before} after=${ui.count}`);
check('添加的种类正确', ui.kind === 'gaussianBlur');
check('面板渲染出一行滤镜', ui.rows === 1, `rows=${ui.rows}`);

// 撤销(Ctrl+Z)应把刚加的滤镜移除(历史条目生效)
await page.keyboard.press('Control+z');
await page.waitForTimeout(150);
const afterUndo = await page.evaluate(() => {
  const s = window.__store;
  const l = s.doc.layers.find(l => l.id === s.doc.activeLayerId);
  return (l?.smartFilters ?? []).length;
});
check('撤销移除刚添加的滤镜', afterUndo === before, `afterUndo=${afterUndo}`);

// ---- 性能探针:12 层 × gaussianBlur,合成 50 次缓存命中 vs 每次清缓存 ----
const bench = await page.evaluate(async () => {
  const { composite, resetPrepareLayerCache } = await import('/src/core/compositor.ts');
  const { makeCanvas } = await import('/src/core/canvasUtils.ts');
  const { makeLayer, defaultTransform } = await import('/src/core/types.ts');
  const colors = ['#e74c3c', '#27ae60', '#2980b9', '#f39c12', '#8e44ad', '#16a085'];
  const doc = { id: 'BENCH', width: 400, height: 300, resolution: 72, layers: [], activeLayerId: null, fileName: null };
  for (let i = 0; i < 12; i++) {
    const l = makeLayer({ name: 'L' + i });
    const c = makeCanvas(400, 300);
    const cx = c.getContext('2d');
    cx.fillStyle = colors[i % colors.length];
    cx.fillRect(15 + i * 12, 15 + i * 9, 220, 160);
    l.bitmap = c;
    l.transform = defaultTransform(400, 300);
    l.smartFilters = [{ id: 'b' + i, kind: 'gaussianBlur', params: { radius: 2 }, enabled: true }];
    doc.layers.push(l);
  }
  composite(doc); // 预热(uid 分配 / JIT)
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) composite(doc);
  const warmMs = performance.now() - t0;
  const t1 = performance.now();
  for (let i = 0; i < 50; i++) { resetPrepareLayerCache(); composite(doc); }
  const coldMs = performance.now() - t1;
  // 一致性:冷/热路径输出必须相同
  resetPrepareLayerCache();
  const a = composite(doc);
  const b = composite(doc);
  const da = a.getContext('2d').getImageData(0, 0, a.width, a.height).data;
  const db = b.getContext('2d').getImageData(0, 0, b.width, b.height).data;
  let same = true;
  for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) { same = false; break; }
  return { warmMs: Math.round(warmMs * 10) / 10, coldMs: Math.round(coldMs * 10) / 10, same };
});
check('缓存冷/热路径输出逐位一致', bench.same);
console.log(`⏱ 性能(12 层 × 高斯模糊,400×300,合成 50 次): 缓存命中 ${bench.warmMs}ms vs 每次清缓存 ${bench.coldMs}ms`);

console.log(failed ? '❌ 智能滤镜 FAIL' : '✅ 智能滤镜 PASS');
await browser.close();
process.exit(failed ? 1 : 0);
