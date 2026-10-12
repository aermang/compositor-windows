// 活字排版 e2e(逐范围字符样式 + 字符/段落面板;vite dev + Playwright)
// 链路:文字工具建层 → __typeDebug.applyRange 逐范围样式(红/仿粗/基线偏移)
//      → 位图指纹变化 + 像素采样 → ranges 缺省与基线一致(两层对比)
//      → 段落框换行 → Ctrl+Z/Ctrl+Shift+Z 可逆 → 全程无 pageerror
// 用法: NODE_PATH="C:\Users\aermang\AppData\Local\npm-cache\_npx\0b9ff77863cb6e9f\node_modules" node tests/typography.mjs
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
function record(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
async function typeTextAt(dx, dy, text, commitAt) {
  await page.keyboard.press('t');
  const pt = S(dx, dy);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(400);
  const editor = await page.evaluate(() => !!document.querySelector('.inline-text-editor'));
  if (!editor) return false;
  await page.keyboard.type(text, { delay: 30 });
  await page.waitForTimeout(300);
  const cm = S(commitAt[0], commitAt[1]);
  await page.mouse.click(cm.x, cm.y);
  return true;
}
const blur = () => page.evaluate(() => document.activeElement?.blur?.());
const fp = async () => (await page.evaluate(() => window.__typeDebug?.bitmapFingerprint?.() ?? null))?.fp ?? null;
const fpFull = () => page.evaluate(() => window.__typeDebug?.bitmapFingerprint?.() ?? null);
const meta = () => page.evaluate(() => window.__typeDebug?.meta?.() ?? null);
const applyRange = opts => page.evaluate(o => window.__typeDebug.applyRange(o), opts);

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
await page.waitForFunction(() => !!window.__typeDebug, null, { timeout: 10000 });

// --- 1. 文字工具:画布点一下输入「Hello World」确认 → 活动层 .text 存在 ---
{
  const ok = await typeTextAt(60, 80, 'Hello World', [60, 320]);
  await page.waitForTimeout(250);
  const m = await meta();
  record('文字工具 T:输入 Hello World 提交 → 活动层 .text 存在',
    ok && !!m && m.content === 'Hello World',
    `editor=${ok} content=${m ? JSON.stringify(m.content) : 'null'}`);
}
const fp0 = await fp();

// --- 2. 字符面板顶层控件(字距)即时应用 + 确定性回零;applyRange [0,5) 红色 → 采样 ---
{
  const enabled = await page.locator('.char-panel fieldset:not([disabled])').count();
  await page.fill('.char-panel .cp-tracking', '4');
  await page.keyboard.press('Enter'); // 面板控件挂 @change,fill 只发 input,需 Enter/失焦提交
  await page.waitForTimeout(250);
  const fpT4 = await fp();
  await page.fill('.char-panel .cp-tracking', '0');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const fpT0 = await fp();
  record('字符面板:字距即时 upsert(指纹变)且回 0 后指纹=初始(渲染确定)',
    enabled === 1 && !!fp0 && fpT4 !== fp0 && fpT0 === fp0,
    `fp0=${fp0} fpT4=${fpT4} fpT0=${fpT0}`);

  await applyRange({ start: 0, end: 5, color: [1, 0, 0] });
  await page.waitForTimeout(250);
  const fp1 = await fp();
  const sample = await page.evaluate(() => {
    const s = window.__store;
    const l = s.doc.layers.find(x => x.id === s.doc.activeLayerId);
    const c = l.bitmap, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let red = 0, black = 0, maxRedX = -1, minBlackX = 1e9;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (d[i + 3] < 128) continue;
      if (d[i] > 180 && d[i + 1] < 90 && d[i + 2] < 90) { red++; if (x > maxRedX) maxRedX = x; }
      else if (d[i] < 70 && d[i + 1] < 70 && d[i + 2] < 70) { black++; if (x < minBlackX) minBlackX = x; }
    }
    return { red, black, maxRedX, minBlackX };
  });
  record('applyRange [0,5) 红色 → 指纹变化;Hello 区红像素、World 区仍原色(黑)',
    fp1 !== fp0 && sample.red > 20 && sample.black > 20 && sample.maxRedX < sample.minBlackX,
    `fp0=${fp0} fp1=${fp1} sample=${JSON.stringify(sample)}`);
}

// --- 3. applyRange [6,11) bold → 指纹再变;ranges 缺省与基线一致(两层对比) ---
{
  await applyRange({ start: 6, end: 11, bold: true });
  await page.waitForTimeout(250);
  const fp2 = await fp();

  // 新建一个同 meta、无 ranges 的图层 B(走真实 UI 管道);其指纹应与 A 初始指纹一致
  await typeTextAt(250, 280, 'Hello World', [60, 350]);
  await page.waitForTimeout(250);
  const fpB = await fp();
  const mB = await meta();

  // 模块级对比:动态 import 活字渲染器(无状态模块,与 app 同实例),
  // A 的 meta 去掉 ranges / 置空数组 渲染结果应与 B 的实际位图逐字节一致
  const cmp = await page.evaluate(async () => {
    const { renderTextBitmap } = await import('/src/core/textRender.ts');
    const s = window.__store;
    const a = s.doc.layers.find(x => x.text && x.text.ranges && x.text.ranges.length);
    const b = s.doc.layers[s.doc.layers.length - 1];
    const h = c => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let x = 0x811c9dc5;
      for (let i = 0; i < d.length; i++) { x ^= d[i]; x = Math.imul(x, 0x01000193); }
      return (x >>> 0).toString(16);
    };
    const w = s.doc.width, ht = s.doc.height;
    const ma = JSON.parse(JSON.stringify(a.text));
    const withEmpty = h(renderTextBitmap(w, ht, { ...ma, ranges: [] }));
    delete ma.ranges;
    const noRanges = h(renderTextBitmap(w, ht, ma));
    return {
      noRanges, withEmpty,
      layerB: h(renderTextBitmap(w, ht, JSON.parse(JSON.stringify(b.text)))),
      bActual: h(b.bitmap),
      bHasRanges: !!(b.text.ranges && b.text.ranges.length),
    };
  });
  record('applyRange [6,11) bold → 指纹再变;ranges 缺省/空 与无 ranges 图层指纹一致',
    fp2 !== fp0 && fpB === fp0 && !cmp.bHasRanges
    && cmp.noRanges === cmp.layerB && cmp.withEmpty === cmp.layerB && cmp.bActual === cmp.layerB,
    `fp2=${fp2} fpB=${fpB} mB=${JSON.stringify(mB && { content: mB.content, ranges: mB.ranges })} cmp=${JSON.stringify(cmp)}`);
}

// --- 4. baselineShift 负值 → 指纹变化(此时活动层为 B) ---
{
  const before = await fp();
  await applyRange({ start: 0, end: 5, baselineShift: -8 });
  await page.waitForTimeout(250);
  const after = await fp();
  const m = await meta();
  record('applyRange [0,5) baselineShift=-8 → 指纹变化且 range 合并写入',
    after !== before && m.ranges?.length === 1 && m.ranges[0].baselineShift === -8,
    `before=${before} after=${after} ranges=${JSON.stringify(m.ranges)}`);
}

// --- 5. 段落框 200×60 → 多行换行,文本不超 200px 宽 ---
{
  await page.fill('.para-panel .pp-w', '200');
  await page.fill('.para-panel .pp-h', '60');
  await page.check('.para-panel .pp-box');
  await page.waitForTimeout(300);
  const m = await meta();
  const full = await fpFull();
  const wrap = await page.evaluate(() => {
    const s = window.__store;
    const l = s.doc.layers.find(x => x.id === s.doc.activeLayerId);
    const c = l.bitmap, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const rows = [];
    let maxX = -1;
    for (let y = 0; y < c.height; y++) {
      let has = false;
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i + 3] > 128) { has = true; if (x > maxX) maxX = x; }
      }
      rows.push(has);
    }
    let bands = 0, prev = false;
    for (const h of rows) { if (h && !prev) bands++; prev = h; }
    return { bands, maxX, w: c.width, h: c.height };
  });
  record('段落面板:段落框 200×60 → boxSize 生效、多行换行(≥2 行)、文本不超 200px 宽',
    JSON.stringify(m.boxSize) === '[200,60]' && wrap.w === 200
    && wrap.bands >= 2 && wrap.maxX <= 205,
    `boxSize=${JSON.stringify(m.boxSize)} fp=${JSON.stringify(full)} wrap=${JSON.stringify(wrap)}`);
}

// --- 6b. 字符面板「起始/结束 + 应用」按钮:UI 路径写入 range(全缺省值 → 渲染不变) ---
{
  const mBefore = await meta();
  const fpBefore = await fp();
  await page.fill('.char-panel .cp-start', '1');
  await page.fill('.char-panel .cp-end', '3');
  await page.click('.char-panel .cp-apply');
  await page.waitForTimeout(250);
  const mAfter = await meta();
  const fpNow = await fp();
  record('字符面板:起始 1 / 结束 3 + 应用 → ranges 增加一条,缺省值渲染不变',
    mAfter.ranges?.length === (mBefore.ranges?.length ?? 0) + 1
    && mAfter.ranges?.some(r => r.start === 1 && r.end === 3)
    && fpNow === fpBefore,
    `before=${mBefore.ranges?.length} after=${mAfter.ranges?.length} fpBefore=${fpBefore} fp=${fpNow}`);
}

// --- 6. Ctrl+Z 可逆 / Ctrl+Shift+Z 重做(每次应用一个历史条目) ---
{
  const fpPre = await fp();
  const mPre = await meta();
  await applyRange({ start: 0, end: 11, tracking: 6 });
  await page.waitForTimeout(250);
  const fpPost = await fp();
  const mPost = await meta();
  await blur();
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(250);
  const fpUndo = await fp();
  const mUndo = await meta();
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(250);
  const fpRedo = await fp();
  const mRedo = await meta();
  record('应用字符样式 → 指纹变;Ctrl+Z 恢复(指纹与 ranges 复原);Ctrl+Shift+Z 重做',
    fpPost !== fpPre && fpUndo === fpPre && fpRedo === fpPost
    && mPost.ranges?.length === (mPre.ranges?.length ?? 0) + 1
    && mUndo.ranges?.length === mPre.ranges?.length
    && mRedo.ranges?.length === mPost.ranges?.length,
    `pre=${fpPre} post=${fpPost} undo=${fpUndo} redo=${fpRedo} `
    + `ranges pre/post/undo/redo=${mPre.ranges?.length}/${mPost.ranges?.length}/${mUndo.ranges?.length}/${mRedo.ranges?.length}`);
}

// --- 7. 全程无 pageerror ---
record('全程无页面 JS 报错', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));

await browser.close();
const ok = results.every(Boolean);
console.log(ok ? '✅ 活字排版(逐范围字符样式 + 字符/段落面板)全部 PASS' : '❌ 存在 FAIL');
process.exit(ok ? 0 : 1);
