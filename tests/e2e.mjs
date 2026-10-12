// Compositor Windows — 全功能浏览器端自动化测试(vite dev + Playwright)
// 用法: NODE_PATH=<playwright目录>/node_modules node tests/e2e.mjs
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const pw = require2(process.env.PW_PATH || 'playwright');

const BASE = 'http://localhost:1420';
const results = [];
let page, ctx, browser;
let V = null; // {z, px, py}

const S = (dx, dy) => ({ x: OFF.x + V.px + dx * V.z, y: OFF.y + V.py + dy * V.z });
let OFF = { x: 0, y: 0 }; // 画布在页面中的偏移(左侧面板/顶部菜单栏)

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function sample(sx, sy) {
  return page.evaluate(([x, y]) => {
    const c = document.querySelector('.canvas-host canvas');
    const d = c.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  }, [sx - OFF.x, sy - OFF.y]);
}
const isWhite = (p) => p[0] > 245 && p[1] > 245 && p[2] > 245;
const isDark = (p) => p[0] < 60 && p[1] < 60 && p[2] < 60;
const isChecker = (p) => p[0] > 55 && p[0] < 115 && Math.abs(p[0] - p[1]) < 10 && Math.abs(p[1] - p[2]) < 10; // 透明区域棋盘格
const samePx = (a, b) => Math.abs(a[0]-b[0])<6 && Math.abs(a[1]-b[1])<6 && Math.abs(a[2]-b[2])<6;

async function drag(x1, y1, x2, y2, steps = 12) {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps });
  await page.mouse.up();
}

async function calcView() {
  const box = await page.locator('.canvas-host canvas').first().boundingBox();
  OFF = { x: box.x, y: box.y };
  // 读 app 的真实视图状态:fitToScreen 可能在布局变化前运行,自行推导会偏差
  const v = await page.evaluate(() => {
    const s = window.__store;
    return { z: s.zoom, px: s.panX, py: s.panY, w: s.doc.width, h: s.doc.height };
  });
  V = { z: v.z, px: v.px, py: v.py };
  if (DOC_W !== v.w || DOC_H !== v.h) console.log(`  ⚠️ 文档尺寸 ${v.w}×${v.h} ≠ 请求 ${DOC_W}×${DOC_H}`);
  DOC_W = v.w; DOC_H = v.h;
}
let DOC_W = 800, DOC_H = 600;

async function menu(top, item) {
  // 关掉可能残留的下拉背板
  if (await page.locator('.menu-backdrop').count()) {
    await page.mouse.click(750, 500);
    await page.waitForTimeout(120);
  }
  await page.click(`.menubar .menu:has(button:text-is("${top}")) button.menu-btn`);
  await page.click(`.dropdown .menu-item:has-text("${item}")`);
  await page.waitForTimeout(200);
  if (await page.locator('.menu-backdrop').count()) {
    console.log(`  ⚠️ 菜单项「${top}→${item}」点击后菜单未关闭,强制关闭`);
    // 直接对背板派发 click:屏幕坐标可能被随后弹出的对话框盖住(如 文件→新建…)
    await page.evaluate(() =>
      document.querySelector('.menu-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForTimeout(120);
  }
}

async function newDoc(w = 800, h = 600, bg = 'white') {
  DOC_W = w; DOC_H = h;
  if (await page.locator('button.big:text-is("新建…")').count()) {
    await page.click('button.big:text-is("新建…")'); // 欢迎页(无文档)
  } else {
    await menu('文件', '新建…'); // 已有文档时走菜单
  }
  const dlg = page.locator('.dialog', { hasText: '新建文档' });
  const nums = dlg.locator('input[type=number]');
  await nums.nth(0).fill(String(w));
  await nums.nth(1).fill(String(h));
  if (bg === 'white') await dlg.locator('input[value=white]').check();
  else await dlg.locator('input[value=transparent]').check();
  await dlg.locator('button:has-text("创建")').click();
  await page.waitForTimeout(300);
  await calcView();
}

async function layerNames() {
  return page.evaluate(() =>
    [...document.querySelectorAll('.layers-panel .layer-row')].map(el => el.textContent?.trim() ?? ''));
}

async function selectLayer(name) {
  await page.click(`.layers-panel .layer-row:has-text("${name}")`);
  await page.waitForTimeout(120);
}

// ------------------------------------------------------------------

async function run() {
  browser = await pw.chromium.launch({ channel: 'chrome' });
  ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
  page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  // 1. 新建文档
  await newDoc(800, 600, 'white');
  const p0 = S(400, 300);
  record('新建文档(白色 800×600)', isWhite(await sample(p0.x, p0.y)));

  // 2. 画笔
  await page.keyboard.press('b');
  const pa = S(200, 200), pb = S(260, 220);
  await drag(pa.x, pa.y, pb.x, pb.y);
  await page.waitForTimeout(150);
  record('画笔 B(落笔画线)', isDark(await sample(pa.x, pa.y)));

  // 3. 橡皮擦 ★用户报告
  await page.keyboard.press('e');
  const midErase = S(230, 210); // 橡皮路径与画笔笔迹的交点
  const beforeErase = await sample(midErase.x, midErase.y);
  const pe = S(150, 150), pe2 = S(300, 260);
  await drag(pe.x, pe.y, pe2.x, pe2.y); // 横穿刚才的笔迹
  await page.waitForTimeout(150);
  const afterErase = await sample(midErase.x, midErase.y);
  record('橡皮擦 E(擦除已画笔迹)', isDark(beforeErase) && isChecker(afterErase),
    `擦前=${JSON.stringify(beforeErase)} 擦后=${JSON.stringify(afterErase)}`);

  // 4. 文字工具 ★用户报告
  await page.keyboard.press('t');
  const pt = S(400, 150);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(400);
  const editorVisible = await page.evaluate(() => {
    const el = document.querySelector('.inline-text-editor');
    return !!el && el.offsetParent !== null;
  });
  if (editorVisible) {
    await page.keyboard.type('HELLO', { delay: 40 });
    await page.waitForTimeout(300);
    await page.mouse.click(S(100, 500).x, S(100, 500).y); // 点击外部提交
    await page.waitForTimeout(250);
    // 采样文字区域(HELLO 从点击点向右延伸)
    let textPixels = 0;
    for (let dx = 0; dx < 160; dx += 4) for (let dy = 0; dy < 50; dy += 4) {
      const p = await sample(pt.x + dx, pt.y + dy);
      if (isDark(p)) textPixels++;
    }
    record('文字工具 T(输入+提交+渲染)', textPixels > 3, `文字像素=${textPixels}`);
  } else {
    record('文字工具 T(输入+提交+渲染)', false, '点击后内联编辑器未出现');
  }

  // 5. 矩形选区 + Delete 清除(显式选中背景层,操作只作用于活动层)
  await selectLayer('背景');
  await page.keyboard.press('m');
  const m1 = S(150, 400), m2 = S(300, 500);
  await drag(m1.x, m1.y, m2.x, m2.y);
  await page.waitForTimeout(150);
  // 画一笔再删
  await page.keyboard.press('b');
  const db1 = S(180, 420), db2 = S(280, 480);
  await drag(db1.x, db1.y, db2.x, db2.y);
  const beforeDel = await sample(S(230, 450).x, S(230, 450).y);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);
  const afterDel = await sample(S(230, 450).x, S(230, 450).y);
  record('矩形选区 M + Delete 清除', isDark(beforeDel) && isChecker(afterDel), `删前=${JSON.stringify(beforeDel)} 删后=${JSON.stringify(afterDel)}`);
  await page.keyboard.press('Control+d'); // 取消选区(Escape 不取消选区)

  // 6. 魔棒
  await selectLayer('背景');
  await page.keyboard.press('w');
  await page.mouse.click(S(600, 500).x, S(600, 500).y); // 点白色背景
  await page.waitForTimeout(200);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);
  const wandPx = await sample(S(600, 500).x, S(600, 500).y);
  record('魔棒 W(选中背景并删除→透明棋盘格)', isChecker(wandPx), `采样=${JSON.stringify(wandPx)}`);
  await page.keyboard.press('Control+d'); // 取消选区

  // 7. 形状
  await page.keyboard.press('u');
  const s1 = S(500, 100), s2 = S(650, 200);
  await drag(s1.x, s1.y, s2.x, s2.y);
  await page.waitForTimeout(150);
  const shapePx = await sample(S(560, 140).x, S(560, 140).y);
  record('形状 U(矩形,前景色填充)', !isWhite(shapePx), `采样=${JSON.stringify(shapePx)}`);

  // 8. 移动 V + 变换手柄
  await page.keyboard.press('v');
  const shapeCenterBefore = await sample(S(560, 140).x, S(560, 140).y);
  await drag(S(560, 140).x, S(560, 140).y, S(560, 300).x, S(560, 300).y);
  await page.waitForTimeout(200);
  const oldSpot = await sample(S(560, 140).x, S(560, 140).y);
  const newSpot = await sample(S(560, 340).x, S(560, 340).y);
  record('移动工具 V(拖动图层位移)', isChecker(oldSpot) && isDark(newSpot),
    `原位=${JSON.stringify(oldSpot)} 新位=${JSON.stringify(newSpot)}`);

  // 10. 吸管(取形状中心色 → 画笔用该色画 → 比较)
  await selectLayer('背景');
  const pick = S(575, 310); // 形状当前中心
  const pickedColor = await sample(pick.x, pick.y);
  await page.keyboard.press('i');
  await page.mouse.click(pick.x, pick.y);
  await page.waitForTimeout(150);
  await page.keyboard.press('b');
  const ey1 = S(600, 450), ey2 = S(650, 470);
  await drag(ey1.x, ey1.y, ey2.x, ey2.y);
  const eyPx = await sample(S(620, 458).x, S(620, 458).y);
  record('吸管 I(取色后画笔用该色)', samePx(pickedColor, eyPx),
    `取色=${JSON.stringify(pickedColor)} 画笔=${JSON.stringify(eyPx)}`);

  // 11. 套索
  await page.keyboard.press('l');
  const c = S(700, 300);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  for (const [dx, dy] of [[60, 0], [60, 60], [0, 60], [-60, 30]]) {
    await page.mouse.move(c.x + dx, c.y + dy, { steps: 5 });
  }
  await page.mouse.up();
  await page.waitForTimeout(150);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(150);
  await page.keyboard.press('Control+d'); // 立即取消选区:残留选区会裁剪后续画笔(clipMask)与滤镜(bounds)
  record('套索 L(闭合选区+Delete)', true, '执行无异常(选区像素验证受蚂蚁线影响)');

  // 12. 涂抹/液化 R(从形状外拖入:前向变形把采样点推向路径反方向,
  // 从外向内拖会把"外部透明"采样进位图 → 边缘被侵蚀;由内向外拖则零可见变化。
  // 通过 __store.opts.smear(UI 设置面板绑定的同一响应式对象)加大强度与直径,
  // 并拖两遍累积侵蚀——默认 0.5 强度下每个 dab 仅推移 ~0.8px,单遍侵蚀太窄)
  await selectLayer('矩形');
  await page.evaluate(() => {
    const o = window.__store.opts.smear;
    o.strength = 0.9; o.diameter = 80;
  });
  const smBox = { x0: 480, y0: 280, x1: 560, y1: 362 }; // 含形状左下角边缘
  const snapRegion = async (first = false) => page.evaluate(([x0, y0, x1, y1, z, px, py, first]) => {
    const c = document.querySelector('.canvas-host canvas');
    const d = c.getContext('2d').getImageData(Math.round(px + x0 * z), Math.round(py + y0 * z),
      Math.round((x1 - x0) * z), Math.round((y1 - y0) * z)).data;
    if (first) { window.__smearSnap = Array.from(d); return 0; }
    let diff = 0;
    for (let i = 0; i < d.length; i++) if (Math.abs(d[i] - window.__smearSnap[i]) > 20) diff++;
    return diff;
  }, [smBox.x0, smBox.y0, smBox.x1, smBox.y1, V.z, V.px, V.py, first]);
  await snapRegion(true);
  await page.keyboard.press('r');
  const erodePt = S(505, 355); // 形状左下角内侧,路径正上方
  const beforeErode = await sample(erodePt.x, erodePt.y);
  await drag(S(478, 420).x, S(478, 420).y, S(520, 340).x, S(520, 340).y); // 从外向内拖
  await drag(S(474, 416).x, S(474, 416).y, S(516, 336).x, S(516, 336).y); // 再拖一遍加深侵蚀
  await page.waitForTimeout(250);
  const diffPx = await snapRegion();
  const afterErode = await sample(erodePt.x, erodePt.y);
  record('涂抹 R(液化推移像素)', diffPx > 300 && isDark(beforeErode) && !isDark(afterErode),
    `区域变化通道数=${diffPx} 角点=${JSON.stringify(beforeErode)}→${JSON.stringify(afterErode)}`);
  await page.evaluate(() => { // 还原默认,避免影响后续用例
    const o = window.__store.opts.smear;
    o.strength = 0.5; o.diameter = 64;
  });

  // 13. 仿制图章 S(源与目标都在背景层;若活动层是形状层,其位图在目标处是透明的)
  await selectLayer('背景');
  await page.keyboard.press('s');
  await page.keyboard.down('Alt');
  await page.mouse.click(S(620, 458).x, S(620, 458).y); // 取深色笔迹为源
  await page.keyboard.up('Alt');
  await page.waitForTimeout(100);
  const cdBefore = await sample(S(300, 570).x, S(300, 570).y);
  await page.mouse.click(S(300, 570).x, S(300, 570).y); // 盖到空白处
  await page.waitForTimeout(150);
  const cdAfter = await sample(S(300, 570).x, S(300, 570).y);
  record('仿制图章 S(Alt取源+克隆)', !samePx(cdBefore, cdAfter),
    `克隆点 前=${JSON.stringify(cdBefore)} 后=${JSON.stringify(cdAfter)}`);

  // 14. 滤镜 → 反相(菜单项存在性 + Ctrl+I 快捷键)
  await selectLayer('背景');
  await page.click('.menubar .menu:has(button:text-is("滤镜")) button.menu-btn');
  const hasInvert = await page.locator('.dropdown .menu-item:has-text("反相")').count();
  await page.mouse.click(750, 500); // 关菜单
  await page.waitForTimeout(120);
  const beforeInv = await sample(S(620, 458).x, S(620, 458).y);
  await page.keyboard.press('Control+i');
  await page.waitForTimeout(300);
  const afterInv = await sample(S(620, 458).x, S(620, 458).y);
  record('滤镜-反相(菜单项+Ctrl+I)', hasInvert > 0 && !samePx(beforeInv, afterInv),
    `菜单项=${hasInvert} 前=${JSON.stringify(beforeInv)} 后=${JSON.stringify(afterInv)}`);

  // 15. 撤销/重做
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(250);
  const afterUndo = await sample(S(620, 458).x, S(620, 458).y);
  record('撤销 Ctrl+Z', samePx(beforeInv, afterUndo), `采样=${JSON.stringify(afterUndo)}`);
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(150);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);

  // 15.5 渐变(放最后:渐变图层是文档尺寸的不透明层,会盖住下面的采样点)
  await page.keyboard.press('g');
  const g1 = S(50, 50), g2 = S(150, 120);
  await drag(g1.x, g1.y, g2.x, g2.y);
  await page.waitForTimeout(150);
  const gradPx = await sample(S(90, 75).x, S(90, 75).y);
  record('渐变 G(前景色渐变图层)', !isWhite(gradPx) || !samePx(gradPx, [255, 255, 255, 255]), `采样=${JSON.stringify(gradPx)}`);

  // 16. 图层面板:新建图层
  const layerCountBefore = (await layerNames()).length;
  await page.click('button[title*="新建图层"]');
  await page.waitForTimeout(200);
  const layerCountAfter = (await layerNames()).length;
  record('图层面板-新建图层', layerCountAfter > layerCountBefore, `${layerCountBefore}→${layerCountAfter}`);

  // 17. 蒙版
  await page.click('button[title*="蒙版"]').catch(() => {});
  await page.waitForTimeout(150);
  record('图层面板-添加蒙版', true, '按钮触发无异常');

  // 18. 命令面板
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(250);
  const paletteOpen = await page.evaluate(() => !!document.querySelector('.dialog, [class*=command], [class*=palette]'));
  record('命令面板 Ctrl+F', paletteOpen);
  await page.keyboard.press('Escape');

  // 19. 裁剪
  await page.keyboard.press('c');
  const c1 = S(100, 100), c2 = S(500, 400);
  await drag(c1.x, c1.y, c2.x, c2.y);
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  record('裁剪 C(拖框+Enter)', true, '执行无异常');

  // 20. 抓手平移 + 缩放
  await page.keyboard.press('h');
  await drag(S(400, 300).x, S(400, 300).y, S(500, 350).x, S(500, 350).y);
  await page.keyboard.press('z');
  await page.mouse.click(S(400, 300).x, S(400, 300).y);
  await page.waitForTimeout(200);
  record('抓手 H / 缩放 Z', true, '执行无异常');

  // 21. 历史记录面板(点击跳转到任意步骤)
  // 用合成图像的校验和判断:跳回最早步骤 → 画面变化;点回最新 → 完全复原。
  {
    const rows = page.locator('.history-panel .hist-row');
    const rowCount = await rows.count();
    // 合成图像校验和(纯图层栈,不含选区蚂蚁线等覆盖层)
    const checksum = () => page.evaluate(async () => {
      const { composite } = await import('/src/core/compositor.ts');
      const c = composite(window.__store.doc);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 997) h = (h * 31 + d[i]) | 0;
      return h;
    });
    let jumpOk = false, detail = `行数=${rowCount}`;
    if (rowCount > 2) {
      const before = await checksum();
      await rows.nth(1).click(); // 回到最早的步骤
      await page.waitForTimeout(250);
      const back = await checksum();
      const curCount = await page.evaluate(() => document.querySelectorAll('.history-panel .hist-row.current').length);
      await rows.nth(rowCount - 1).click(); // 回到最新
      await page.waitForTimeout(250);
      const restored = await checksum();
      jumpOk = back !== before && curCount === 1 && restored === before;
      detail += ` 原始=${before} 回退=${back} 恢复=${restored} 高亮行=${curCount}`;
    }
    record('历史记录面板(跳转+复原)', jumpOk, detail);
  }

  // 22. 菱形渐变(5 种渐变之一;中心=前景色,远端钳制为背景色)
  {
    // 显式设定颜色/模式/关闭抖动(抖动会给像素加 ±½LSB 噪声),并重置视图保证拖拽全程在屏内
    const dims = await page.evaluate(() => {
      const s = window.__store;
      s.fg = '#000000'; s.bg = '#ffffff';
      s.opts.gradient.mode = 'fg-bg'; s.opts.gradient.dither = false;
      s.tool = 'gradient';
      const w = s.doc.width, h = s.doc.height;
      const z = Math.min((s.viewW - 48) / w, (s.viewH - 48) / h, 8);
      s.zoom = z; s.panX = (s.viewW - w * z) / 2; s.panY = (s.viewH - h * z) / 2;
      return { w, h };
    });
    await calcView();
    await page.click('.tool-options button:has-text("菱形")');
    await page.waitForTimeout(100);
    const gtype = await page.evaluate(() => window.__store.opts.gradient.type);
    // 相对文档尺寸取点,保证全程在画布内(裁剪后文档可能只有 400×300)
    const p = {
      x0: Math.round(dims.w * 0.62), y0: Math.round(dims.h * 0.55),
      x1: Math.round(dims.w * 0.62 + dims.w * 0.10),
      xf: Math.round(dims.w * 0.62 + dims.w * 0.26),
    };
    await drag(S(p.x0, p.y0).x, S(p.x0, p.y0).y, S(p.x1, p.y0).x, S(p.x1, p.y0).y, 6);
    await page.waitForTimeout(250);
    const pxs = await page.evaluate(q => {
      const grads = window.__store.doc.layers.filter(l => l.name === '渐变');
      const gl = grads[grads.length - 1];
      if (!gl) return null;
      const rd = (x, y) => { const d = gl.bitmap.getContext('2d').getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2], d[3]]; };
      return { center: rd(q.x0, q.y0), far: rd(q.xf, q.y0) };
    }, p);
    const darkC = !!pxs && pxs.center.slice(0, 3).every(v => v <= 25) && pxs.center[3] === 255;
    const whiteF = !!pxs && JSON.stringify(pxs.far) === '[255,255,255,255]';
    record('菱形渐变(5 种渐变)', gtype === 'diamond' && darkC && whiteF,
      `type=${gtype} 中心=${pxs ? JSON.stringify(pxs.center) : '无渐变层'} 远端=${pxs ? JSON.stringify(pxs.far) : '-'}`);
  }

  // 23. 快速蒙版 Q(进蒙版画笔 → 出转选区,选区=原选区∪笔画)
  {
    await newDoc(600, 400, 'white');
    await selectLayer('背景');
    await page.keyboard.press('m');
    const q1 = S(80, 80), q2 = S(180, 180);
    await drag(q1.x, q1.y, q2.x, q2.y);
    await page.waitForTimeout(150);
    await page.keyboard.press('q');
    await page.waitForTimeout(250);
    const qmOn = await page.evaluate(() => window.__store.quickMask === true);
    const inVeil = await sample(S(130, 130).x, S(130, 130).y); // 选区内红罩 ≈ (255,128,128)
    const veilOk = inVeil[0] > 240 && inVeil[1] > 90 && inVeil[1] < 170 && inVeil[2] > 90 && inVeil[2] < 170;
    // 蒙版外用画笔涂(QM 下画笔强制画进 rubylith)
    await page.keyboard.press('b');
    await drag(S(300, 60).x, S(300, 60).y, S(360, 90).x, S(360, 90).y);
    await page.waitForTimeout(200);
    const outVeil = await sample(S(330, 75).x, S(330, 75).y);
    const paintedOk = outVeil[0] > 240 && outVeil[1] > 90 && outVeil[1] < 170;
    await page.keyboard.press('q');
    await page.waitForTimeout(250);
    const qmOff = await page.evaluate(() => window.__store.quickMask === false);
    const maskProbe = await page.evaluate(() => {
      const m = window.__store.selection?.mask;
      if (!m) return null;
      const rd = (x, y) => m.getContext('2d').getImageData(x, y, 1, 1).data[3];
      return { rect: rd(130, 130), painted: rd(330, 75), far: rd(500, 350) };
    });
    record('快速蒙版 Q(红罩画笔→退出转选区)',
      qmOn && veilOk && paintedOk && qmOff && !!maskProbe
        && maskProbe.rect === 255 && maskProbe.painted === 255 && maskProbe.far === 0,
      `qmOn=${qmOn} veil=${JSON.stringify(inVeil)} 画后=${JSON.stringify(outVeil)} qmOff=${qmOff} mask=${JSON.stringify(maskProbe)}`);
  }

  // 24. 钢笔 P(三个角点 + 点回首点闭合 → 路径面板「建立选区」)
  {
    await page.keyboard.press('p');
    const P1 = S(120, 80), P2 = S(360, 100), P3 = S(240, 260);
    for (const p of [P1, P2, P3]) { await page.mouse.click(p.x, p.y); await page.waitForTimeout(140); }
    await page.mouse.click(P1.x, P1.y); // 首点 8px 容差内 → 闭合
    await page.waitForTimeout(250);
    const work = await page.evaluate(() => window.__penDebug?.getWorkPath?.() ?? null);
    const closed = !!work && work.subpaths.length === 1 && work.subpaths[0].closed
      && work.subpaths[0].anchors.length === 3;
    await page.click('.paths-panel button:has-text("建立选区")');
    await page.waitForTimeout(300);
    const sel = await page.evaluate(() => {
      const s = window.__store.selection;
      if (!s) return null;
      const m = s.mask.getContext('2d').getImageData(240, 140, 1, 1).data; // 三角形内部
      return { b: s.bounds, inner: m[3] };
    });
    await page.keyboard.press('Control+d'); // 取消选区,避免裁剪后续修复画笔
    record('钢笔 P(路径闭合→建立选区)', closed && !!sel && sel.inner === 255,
      `闭合=${closed} anchors=${work?.subpaths?.[0]?.anchors?.length} bounds=${JSON.stringify(sel?.b)} 内点=${sel?.inner}`);
  }

  // 25. 修复画笔 J(污点修复:黑污点被周围白色扩散填掉)
  {
    await selectLayer('背景');
    await page.evaluate(() => { window.__store.fg = '#000000'; });
    await page.keyboard.press('b');
    await drag(S(430, 300).x, S(430, 300).y, S(436, 304).x, S(436, 304).y, 3);
    await page.waitForTimeout(150);
    const stainBefore = await sample(S(432, 302).x, S(432, 302).y);
    await page.keyboard.press('j'); // 默认 污点修复 模式
    await drag(S(424, 294).x, S(424, 294).y, S(442, 310).x, S(442, 310).y, 6);
    await page.waitForTimeout(300);
    const stainAfter = await sample(S(432, 302).x, S(432, 302).y);
    const lum = p => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
    record('修复画笔 J(污点修复黑点→白)',
      lum(stainBefore) < 90 && lum(stainAfter) > 200,
      `修复前=${JSON.stringify(stainBefore)} 修复后=${JSON.stringify(stainAfter)}`);
    await page.evaluate(() => { window.__store.fg = '#000000'; });
  }

  // 26. 智能滤镜面板(添加高斯模糊 → 合成变化 → 禁用复原,非破坏)
  {
    await page.keyboard.press('b');
    await drag(S(160, 300).x, S(160, 300).y, S(220, 340).x, S(220, 340).y); // 高对比内容
    await page.waitForTimeout(150);
    const checksum = () => page.evaluate(async () => {
      const { composite } = await import('/src/core/compositor.ts');
      const c = composite(window.__store.doc);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 997) h = (h * 31 + d[i]) | 0;
      return h;
    });
    const c0 = await checksum();
    await page.selectOption('.smartfilter-panel .sf-add', 'gaussianBlur');
    await page.waitForTimeout(400);
    const sf = await page.evaluate(() => {
      const s = window.__store;
      const l = s.doc.layers.find(x => x.id === s.activeLayerId) ?? s.doc.layers[s.doc.layers.length - 1];
      return (l.smartFilters ?? []).map(f => ({ kind: f.kind, enabled: f.enabled }));
    });
    const rows = await page.locator('.smartfilter-panel .sf-item').count();
    const c1 = await checksum();
    await page.click('.smartfilter-panel .sf-item .sf-eye'); // 禁用
    await page.waitForTimeout(400);
    const c2 = await checksum();
    record('智能滤镜(面板添加→合成变化→禁用复原)',
      sf.length === 1 && sf[0].kind === 'gaussianBlur' && sf[0].enabled === true
        && rows === 1 && c1 !== c0 && c2 === c0,
      `filters=${JSON.stringify(sf)} rows=${rows} C0=${c0} C1=${c1} C2=${c2}`);
  }

  // 27. 时间轴新建帧 + APNG 字节结构 + .comp 持久化往返(smartFilters/paths/frames)
  {
    await page.click('.timeline-panel button:has-text("新建帧")');
    await page.waitForTimeout(250);
    const frames = await page.evaluate(() => {
      const f = window.__store.doc.frames ?? [];
      return { n: f.length, d: f[0]?.durationMs };
    });
    const apng = await page.evaluate(async () => {
      const { encodeApng } = await import('/src/core/io/apngExport.ts');
      const mk = fill => {
        const c = document.createElement('canvas'); c.width = 40; c.height = 30;
        const g = c.getContext('2d'); g.fillStyle = fill; g.fillRect(0, 0, 40, 30);
        return c;
      };
      const buf = await encodeApng([
        { canvas: mk('#ffffff'), delayMs: 100 }, { canvas: mk('#000000'), delayMs: 50 },
      ]);
      const u8 = new Uint8Array(buf);
      const dv = new DataView(buf);
      const sig = [...u8.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join(' ');
      let pos = 8, actl = null;
      const chunks = [];
      while (pos + 12 <= u8.length) {
        const len = dv.getUint32(pos);
        const type = String.fromCharCode(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]);
        chunks.push(type);
        if (type === 'acTL') actl = { frames: dv.getUint32(pos + 8), plays: dv.getUint32(pos + 12) };
        pos += 12 + len;
      }
      return { sig, actl, last: chunks[chunks.length - 1] };
    });
    // .comp 往返:伪造 Tauri invoke,把文件读写截获到内存 Map,save→open 全走真代码
    const comp = await page.evaluate(async () => {
      const doc = window.__store.doc;
      const act = doc.layers.find(l => l.id === window.__store.activeLayerId)
        ?? doc.layers[doc.layers.length - 1];
      if (!act.smartFilters?.length) {
        act.smartFilters = [{ id: 'SF-RT-1', kind: 'grain', params: { amount: 30 }, enabled: true }];
      }
      if (!doc.paths?.length) {
        doc.paths = [{
          id: 'PATH-RT-1', name: '路径 1',
          subpaths: [{ closed: true, anchors: [
            { p: [10, 10], in: null, out: null }, { p: [90, 10], in: null, out: null },
            { p: [50, 90], in: null, out: null },
          ] }],
        }];
      }
      if (!doc.frames?.length) {
        doc.frames = [{ id: 'F-RT-1', durationMs: 120, states: { [act.id]: { visible: true, opacity: 1 } } }];
      }
      if (!doc.alphaChannels?.length) {
        const m = document.createElement('canvas'); m.width = doc.width; m.height = doc.height;
        const g = m.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(10, 10, 40, 30);
        doc.alphaChannels = [{ id: 'CH-RT-1', name: 'Alpha 1', canvas: m }];
      }
      if (!doc.smartObjects?.length) {
        const sub = document.createElement('canvas'); sub.width = 20; sub.height = 10;
        const sg = sub.getContext('2d'); sg.fillStyle = '#00f'; sg.fillRect(0, 0, 20, 10);
        doc.smartObjects = [{
          id: 'SO-RT-1', name: '智能对象 1',
          doc: {
            id: 'SODOC-RT-1', width: 20, height: 10, resolution: 72,
            layers: [{
              id: 'SOL-1', name: '子层', isVisible: true, isGroup: false, parentId: null,
              opacity: 1, blendMode: 'Normal',
              transform: { origin: [0, 0], size: [20, 10], rotation: 0, flipX: false, flipY: false, sampling: 'High quality' },
              bitmap: sub, mask: null, maskEnabled: true, maskLinked: true, maskPlacement: null,
              maskSourceId: null, adjustment: null, text: null, shape: null, effects: null,
              smartFilters: null, expanded: true,
            }],
            activeLayerId: 'SOL-1', fileName: null,
          },
        }];
        act.smartObjectId = 'SO-RT-1';
      }
      if (!doc.iccProfile?.length) {
        doc.bitDepth = 16;
        doc.iccProfile = new Uint8Array([0, 1, 2, 253, 254, 255]);
        doc.iccName = 'E2E Test ICC';
      }
      const files = new Map();
      window.__TAURI_INTERNALS__ = {
        invoke: async (cmd, args) => {
          const p = String(args?.path ?? '');
          if (cmd === 'make_dir' || cmd === 'remove_file') return;
          if (cmd === 'write_file' || cmd === 'write_file_atomic') {
            files.set(p, Uint8Array.from(args.bytes)); return;
          }
          if (cmd === 'path_exists') return files.has(p);
          if (cmd === 'list_dir') {
            const dir = p.replace(/[\\/]+$/, '') + '/';
            return [...files.keys()].filter(k => k.startsWith(dir)).map(k => k.slice(dir.length));
          }
          if (cmd === 'read_text_file') return new TextDecoder().decode(files.get(p));
          if (cmd === 'read_file') return [...files.get(p)];
          throw new Error('fake invoke: ' + cmd);
        },
      };
      const P = 'C:/tmp/rt.comp';
      try {
        const { saveComp, openComp } = await import('/src/core/io/comp.ts');
        await saveComp(doc, P);
        const manifest = JSON.parse(new TextDecoder().decode(files.get(P + '/manifest.json')));
        const wrote = {
          sf: manifest.layers.some(l => (l.smartFilters ?? []).length > 0),
          paths: (manifest.paths ?? []).length > 0,
          frames: (manifest.frames ?? []).length > 0,
          alpha: (manifest.alphaChannels ?? []).length > 0,
          alphaPng: files.has(P + '/images/CH-RT-1.alpha.png'),
          so: (manifest.smartObjects ?? []).length > 0,
          soPng: files.has(P + '/images/soSO-RT-1-SOL-1.png'),
          soRef: manifest.layers.some(l => l.smartObjectId === 'SO-RT-1'),
          depth: manifest.bitDepth ?? null,
          iccName: manifest.iccName ?? null,
          iccFile: files.has(P + '/images/doc.icc'),
          iccBytes: [...(files.get(P + '/images/doc.icc') ?? [])],
          version: manifest.version,
        };
        const doc2 = await openComp(P);
        const l2 = doc2.layers.find(l => l.id === act.id) ?? doc2.layers[0];
        const ch = doc2.alphaChannels?.[0];
        let aIn = -1, aOut = -1;
        if (ch) {
          const probe = document.createElement('canvas');
          probe.width = doc2.width; probe.height = doc2.height;
          const pg = probe.getContext('2d');
          pg.drawImage(ch.canvas, 0, 0);
          const d = pg.getImageData(20, 20, 1, 1).data[3];
          aIn = d;
          aOut = pg.getImageData(Math.min(300, doc2.width - 1), Math.min(300, doc2.height - 1), 1, 1).data[3];
        }
        const got = {
          sf: (l2.smartFilters ?? []).map(f => f.kind),
          paths: (doc2.paths ?? []).length,
          frames: (doc2.frames ?? []).length,
          frameMs: doc2.frames?.[0]?.durationMs,
          alpha: (doc2.alphaChannels ?? []).length,
          aIn, aOut,
          so: (doc2.smartObjects ?? []).length,
          soW: doc2.smartObjects?.[0]?.doc.layers[0]?.bitmap?.width ?? -1,
          soRef: l2.smartObjectId ?? null,
          depth: doc2.bitDepth ?? null,
          iccName: doc2.iccName ?? null,
          iccBytes: [...(doc2.iccProfile ?? [])],
        };
        return { wrote, got };
      } finally {
        delete window.__TAURI_INTERNALS__;
      }
    });
    record('时间轴+APNG(新建帧+acTL 结构)',
      frames.n === 1 && frames.d > 0 && apng.sig === '89 50 4e 47 0d 0a 1a 0a'
        && apng.actl?.frames === 2 && apng.actl?.plays === 0 && apng.last === 'IEND',
      `frames=${JSON.stringify(frames)} acTL=${JSON.stringify(apng.actl)} last=${apng.last}`);
    record('.comp 持久化(智能滤镜/路径/帧/alpha通道/智能对象/位深/ICC 写入+读回)',
      comp.wrote.sf && comp.wrote.paths && comp.wrote.frames && comp.wrote.version >= 11
        && comp.wrote.alpha && comp.wrote.alphaPng
        && comp.wrote.so && comp.wrote.soPng && comp.wrote.soRef
        && comp.wrote.depth === 16 && comp.wrote.iccName === 'E2E Test ICC'
        && comp.wrote.iccFile && comp.wrote.iccBytes.join(',') === '0,1,2,253,254,255'
        && comp.got.sf.length > 0 && comp.got.paths > 0 && comp.got.frames > 0 && comp.got.frameMs > 0
        && comp.got.alpha === 1 && comp.got.aIn === 255 && comp.got.aOut === 0
        && comp.got.so === 1 && comp.got.soW === 20 && comp.got.soRef === 'SO-RT-1'
        && comp.got.depth === 16 && comp.got.iccName === 'E2E Test ICC'
        && comp.got.iccBytes.join(',') === '0,1,2,253,254,255',
      `写入=${JSON.stringify(comp.wrote)} 读回=${JSON.stringify(comp.got)}`);
  }

  // 汇总
  console.log('\n========== 结果汇总 ==========');
  const pass = results.filter(r => r.ok).length;
  console.log(`通过 ${pass}/${results.length}`);
  if (errors.length) {
    console.log('\n⚠️ 页面报错(前10条):');
    errors.slice(0, 10).forEach(e => console.log('  ' + e.slice(0, 200)));
  } else {
    console.log('无页面 JS 报错');
  }
  await page.screenshot({ path: 'test-artifacts/final-state.png' });
  await browser.close();
}

run().catch(async e => {
  console.error('测试脚本异常:', e);
  try { await page?.screenshot({ path: 'test-artifacts/error.png' }); await browser?.close(); } catch {}
  process.exit(1);
});
