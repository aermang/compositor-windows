// 调整命令 e2e:自动色调/自动对比度/自动颜色(图像菜单)+ 自然饱和度/通道混合器/
// 照片滤镜/阴影-高光(滤镜对话框)。逐条 Ctrl+Z 验证可撤销。
// 运行:NODE_PATH="C:\Users\aermang\AppData\Local\npm-cache\_npx\0b9ff77863cb6e9f\node_modules" node tests/adjust.mjs
// 共享 dev server 上多智能体并行改文件会触发 HMR 整页刷新(文档丢失):
// 每个用例前 ensureDoc 重建现场,用例失败自动重建重跑(最多 3 次)。
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const pw = require2(process.env.PW_PATH || 'playwright');

const BASE = 'http://localhost:1420';
const browser = await pw.chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 })).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });

let failed = false;
function check(name, cond, detail = '') {
  console.log(`${cond ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failed = true;
  return !!cond;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

async function menu(top, item) {
  await page.waitForSelector('.menubar', { timeout: 20000 });
  // 关掉可能残留的下拉背板
  if (await page.locator('.menu-backdrop').count()) {
    await page.mouse.click(750, 500);
    await page.waitForTimeout(120);
  }
  await page.click(`.menubar .menu:has(button:text-is("${top}")) button.menu-btn`);
  await page.click(`.dropdown .menu-item:has-text("${item}")`);
  await page.waitForTimeout(250);
  if (await page.locator('.menu-backdrop').count()) {
    console.log(`  ⚠️ 菜单项「${top}→${item}」点击后菜单未关闭,强制关闭`);
    await page.evaluate(() =>
      document.querySelector('.menu-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForTimeout(120);
  }
}

async function newDoc(w, h) {
  if (await page.locator('button.big:text-is("新建…")').count()) {
    await page.click('button.big:text-is("新建…")');
  } else {
    await menu('文件', '新建…');
  }
  const dlg = page.locator('.dialog', { hasText: '新建文档' });
  await dlg.locator('input[type=number]').nth(0).fill(String(w));
  await dlg.locator('input[type=number]').nth(1).fill(String(h));
  await dlg.locator('input[value=white]').check();
  await dlg.locator('button:has-text("创建")').click();
  await page.waitForTimeout(300);
}

/** HMR 可能把页面整刷掉:确认 600×400 文档还在,丢了就重建。 */
async function ensureDoc() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ok = await page.evaluate(() => {
        const d = window.__store?.doc;
        return !!(d && d.width === 600 && d.height === 400
          && d.layers.length >= 1 && d.layers.some(l => l.bitmap));
      });
      if (ok) return;
      console.log('[HMR] 测试文档丢失,重建 600×400');
      const welcome = page.locator('button.big:text-is("新建…")');
      if (!(await welcome.isVisible().catch(() => false))) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('button.big:text-is("新建…")', { timeout: 30000 });
      }
      await newDoc(600, 400);
    } catch (e) {
      console.log(`[ensureDoc retry ${attempt}] ${String(e.message).split('\n')[0]}`);
      await page.waitForTimeout(1500);
    }
  }
  throw new Error('无法建立 600×400 测试文档(共享 dev server 持续 HMR)');
}

/** 把活动层位图整体填成测试数据(直接写 ImageData + 手动 bump rev,不进历史)。
 *  注意:页面侧不要动态 import /src 模块 —— HMR ?t= 分歧会重新执行 store.ts 的
 *  模块副作用,把 window.__store 覆盖成全新的空 store(见 memory: 模块分歧陷阱)。 */
async function fillLayer(spec) {
  await page.evaluate(spec => {
    const s = window.__store;
    if (!s?.doc) throw new Error('doc 丢失(HMR)');
    const l = s.doc.layers.find(v => v.id === s.doc.activeLayerId) ?? s.doc.layers[s.doc.layers.length - 1];
    const cx = l.bitmap.getContext('2d');
    const img = cx.getImageData(0, 0, l.bitmap.width, l.bitmap.height);
    const d = img.data, w = img.width, h = img.height;
    if (spec.kind === 'solid') {
      for (let i = 0; i < d.length; i += 4) {
        d[i] = spec.color[0]; d[i + 1] = spec.color[1]; d[i + 2] = spec.color[2]; d[i + 3] = 255;
      }
    } else if (spec.kind === 'gradient') {
      for (let x = 0; x < w; x++) {
        const v = Math.round(spec.lo + (x / (w - 1)) * (spec.hi - spec.lo));
        for (let y = 0; y < h; y++) {
          const i = (y * w + x) * 4;
          d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
        }
      }
    } else if (spec.kind === 'split') {
      for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4;
        const c = x < spec.xMid ? spec.left : spec.right;
        d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
      }
    }
    if (spec.patch) {
      const [r, g, b] = spec.patch.color;
      for (let x = spec.patch.x0; x < spec.patch.x1; x++) for (let y = spec.patch.y0; y < spec.patch.y1; y++) {
        const i = (y * w + x) * 4;
        d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
      }
    }
    cx.putImageData(img, 0, 0);
    l.rev = (l.rev ?? 0) + 1; // 等价 bumpLayerRev(避免页面侧动态 import 模块分歧)
    s.tick++;
  }, spec);
}

/** 直接采样活动层位图像素(不经合成,避免缩放/缓存干扰)。 */
const px = (x, y) => page.evaluate(([x, y]) => {
  const s = window.__store;
  if (!s?.doc) throw new Error('doc 丢失(HMR)');
  const l = s.doc.layers.find(v => v.id === s.doc.activeLayerId) ?? s.doc.layers[s.doc.layers.length - 1];
  const d = l.bitmap.getContext('2d').getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}, [x, y]);
const spread = p => Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);

/** 打开滤镜对话框,按顺序给滑杆设值(null=保持默认),点确定应用。 */
async function runFilterDialog(menuItem, values) {
  await menu('滤镜', menuItem);
  const dlg = page.locator('.dialog', { has: page.locator('input[type=range]') });
  await dlg.waitFor({ state: 'visible', timeout: 5000 });
  const ranges = dlg.locator('input[type=range]');
  const n = await ranges.count();
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null || v === undefined) continue;
    // Vue v-model.number 监听 input 事件:set value + 派发 input/change
    await ranges.nth(i).evaluate((el, val) => {
      el.value = String(val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, v);
  }
  await page.waitForTimeout(100);
  await dlg.locator('button:has-text("确定")').click();
  await page.waitForTimeout(300);
}

async function undo() {
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
}

/** 用例失败(HMR 抖动/页面被并行刷新)时重建现场重跑,最多 3 次。 */
async function caseRetry(label, fn) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let ok = true;
    const fail = () => { ok = false; };
    try {
      await fn(fail);
    } catch (e) {
      ok = false;
      console.log(`  [异常] ${String(e.message).split('\n')[0]}`);
    }
    if (ok) return;
    if (attempt < 3) {
      console.log(`[retry ${attempt}] 用例「${label}」失败,重建现场重跑(HMR 抖动?)`);
      await page.waitForTimeout(1200);
    }
  }
  console.log(`❌ 用例「${label}」3 次尝试均失败`);
  failed = true;
}

// ------------------------------------------------------------------

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('button.big:text-is("新建…")', { timeout: 60000 });
await page.waitForTimeout(500);
await newDoc(600, 400);

// 1. 自动色调:40..200 灰阶渐变 → 暗端 <15、亮端 >240
await caseRetry('自动色调', async fail => {
  await ensureDoc();
  await fillLayer({ kind: 'gradient', lo: 40, hi: 200 });
  await menu('图像', '自动色调');
  const t0 = await px(0, 200), t1 = await px(599, 200);
  let ok = check('自动色调(暗端提黑/亮端提白)', t0[0] < 15 && t1[0] > 240 && near(t0[2], t0[0], 2) && near(t1[2], t1[0], 2),
    `暗端=${JSON.stringify(t0)} 亮端=${JSON.stringify(t1)}`);
  await undo();
  const tU0 = await px(0, 200), tU1 = await px(599, 200);
  ok = check('自动色调可撤销', near(tU0[0], 40, 3) && near(tU1[0], 200, 3),
    `撤销后暗端=${JSON.stringify(tU0)} 亮端=${JSON.stringify(tU1)}`) && ok;
  if (!ok) fail();
});

// 2. 自动对比度:渐变+彩色块 → 暗端/亮端拉伸且色块 r:g:b 比例保持
await caseRetry('自动对比度', async fail => {
  await ensureDoc();
  await fillLayer({ kind: 'gradient', lo: 40, hi: 200, patch: { x0: 250, y0: 190, x1: 300, y1: 210, color: [120, 90, 60] } });
  await menu('图像', '自动对比度');
  const cDark = await px(0, 200), cBright = await px(599, 200), cPatch = await px(275, 200);
  const ratioRG = cPatch[0] / cPatch[1], ratioGB = cPatch[1] / cPatch[2];
  let ok = check('自动对比度(亮度域拉伸)', cDark[0] < 20 && cBright[0] > 235,
    `暗端=${JSON.stringify(cDark)} 亮端=${JSON.stringify(cBright)}`);
  ok = check('自动对比度保色相(r:g:b≈4:3:2)', near(ratioRG, 4 / 3, 0.1) && near(ratioGB, 3 / 2, 0.1),
    `色块=${JSON.stringify(cPatch)} r/g=${ratioRG.toFixed(3)} g/b=${ratioGB.toFixed(3)}`) && ok;
  await undo();
  const cPatchU = await px(275, 200);
  ok = check('自动对比度可撤销', JSON.stringify(cPatchU) === '[120,90,60,255]',
    `撤销后色块=${JSON.stringify(cPatchU)}`) && ok;
  if (!ok) fail();
});

// 3. 自动颜色:蓝偏色灰图 (100,100,160) → gray-world 中和为灰
await caseRetry('自动颜色', async fail => {
  await ensureDoc();
  await fillLayer({ kind: 'solid', color: [100, 100, 160] });
  await menu('图像', '自动颜色');
  const ccPx = await px(300, 200);
  let ok = check('自动颜色(gray-world 去偏色)', near(ccPx[0], ccPx[1], 3) && near(ccPx[1], ccPx[2], 3) && near(ccPx[0], 120, 8),
    `结果=${JSON.stringify(ccPx)}`);
  await undo();
  const ccU = await px(300, 200);
  ok = check('自动颜色可撤销', JSON.stringify(ccU) === '[100,100,160,255]', `撤销后=${JSON.stringify(ccU)}`) && ok;
  if (!ok) fail();
});

// 4. 自然饱和度 vibrance=80:低饱和块 spread 增大,全饱和块几乎不动
await caseRetry('自然饱和度', async fail => {
  await ensureDoc();
  await fillLayer({ kind: 'split', xMid: 300, left: [128, 124, 120], right: [255, 0, 0] });
  const vGrayBefore = spread(await px(150, 200)), vRedBefore = spread(await px(450, 200));
  await runFilterDialog('自然饱和度…', [80, 0]);
  const vGray = await px(150, 200), vRed = await px(450, 200);
  const dGray = spread(vGray) - vGrayBefore, dRed = spread(vRed) - vRedBefore;
  let ok = check('自然饱和度(低饱和增益大/高饱和增益小)', dGray >= 4 && dRed <= 1 && dGray > dRed,
    `灰块 spread ${vGrayBefore}→${spread(vGray)} (+${dGray}) 红块 ${vRedBefore}→${spread(vRed)} (+${dRed}) 灰块=${JSON.stringify(vGray)} 红块=${JSON.stringify(vRed)}`);
  await undo();
  const vGrayU = await px(150, 200);
  ok = check('自然饱和度可撤销', spread(vGrayU) === 8, `撤销后灰块=${JSON.stringify(vGrayU)}`) && ok;
  if (!ok) fail();
});

// 5. 通道混合器:纯绿图,红行「红-绿」=100 → 红通道≈255,输出≈(255,255,0)
await caseRetry('通道混合器', async fail => {
  await ensureDoc();
  await fillLayer({ kind: 'solid', color: [0, 255, 0] });
  await runFilterDialog('通道混合器…', [null, 100]); // 9 个滑杆:nth(1)=红-绿
  const mPx = await px(300, 200);
  let ok = check('通道混合器(红←绿 100%)', mPx[0] >= 250 && mPx[1] >= 250 && mPx[2] <= 10,
    `结果=${JSON.stringify(mPx)}`);
  await undo();
  const mU = await px(300, 200);
  ok = check('通道混合器可撤销', JSON.stringify(mU) === '[0,255,0,255]', `撤销后=${JSON.stringify(mU)}`) && ok;
  if (!ok) fail();
});

// 6. 照片滤镜 warmth=100 density=100:浅灰 (240,240,240) → 暖色,R 升 B 降
await caseRetry('照片滤镜', async fail => {
  await ensureDoc();
  await fillLayer({ kind: 'solid', color: [240, 240, 240] });
  await runFilterDialog('照片滤镜…', [100, 100]);
  const fPx = await px(300, 200);
  let ok = check('照片滤镜(暖色,R升B降)', fPx[0] > 245 && fPx[2] < 100 && near(fPx[1], 150, 12),
    `结果=${JSON.stringify(fPx)}`);
  await undo();
  const fU = await px(300, 200);
  ok = check('照片滤镜可撤销', JSON.stringify(fU) === '[240,240,240,255]', `撤销后=${JSON.stringify(fU)}`) && ok;
  if (!ok) fail();
});

// 7. 阴影/高光:50 灰+阴影100 → 变亮;230 灰+高光100 → 变暗
await caseRetry('阴影/高光', async fail => {
  await ensureDoc();
  await fillLayer({ kind: 'solid', color: [50, 50, 50] });
  await runFilterDialog('阴影/高光…', [100, 0]);
  const shPx = await px(300, 200);
  let ok = check('阴影/高光(阴影提亮暗部)', shPx[0] >= 65 && near(shPx[2], shPx[0], 2),
    `50 灰 → ${JSON.stringify(shPx)}`);
  await undo();
  await fillLayer({ kind: 'solid', color: [230, 230, 230] });
  await runFilterDialog('阴影/高光…', [0, 100]);
  const hiPx = await px(300, 200);
  ok = check('阴影/高光(高光压暗亮部)', hiPx[0] <= 205 && near(hiPx[2], hiPx[0], 2),
    `230 灰 → ${JSON.stringify(hiPx)}`) && ok;
  await undo();
  const hiU = await px(300, 200);
  ok = check('阴影/高光可撤销', near(hiU[0], 230, 3), `撤销后=${JSON.stringify(hiU)}`) && ok;
  if (!ok) fail();
});

console.log(failed ? '\n❌ 调整命令 FAIL' : '\n✅ 调整命令 PASS');
try { await page.screenshot({ path: 'test-artifacts/adjust-final.png' }); } catch {}
await browser.close();
process.exit(failed ? 1 : 0);
