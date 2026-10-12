// Compositor — 动作面板(录制/回放/批处理)浏览器端自动化测试(vite dev + Playwright)
// 仿 tests/io.mjs / tests/e2e.mjs 测试 27 的 fake __TAURI_INTERNALS__ 手法:
// read_file/write_file/list_dir/make_dir 截获到内存 Map、plugin:dialog|open 返回
// 虚拟文件夹,让批处理全链路(列目录→解码→建文档→回放动作→导出 PNG)在纯 Chrome
// 里跑通。
// 录制打点只挂在 runCommand 派发上;Menubar/快捷键/命令面板目前直接 c.run(),
// 不经过 runCommand(见交付报告),所以录制步骤用 属性面板「水平/垂直翻转」按钮
// 触发 — 它们是 @click="runCommand('layer.flipH'/'layer.flipV')" 的真实入口。
// 一律 UI + window.__store 断言,不做页面侧核心模块动态 import(规避 HMR 双实例)。
// 用法: NODE_PATH=<playwright目录>/node_modules node tests/actions.mjs
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const pw = require2(process.env.PW_PATH || 'playwright');

const BASE = 'http://localhost:1420';
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const samePx = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

// —— 以下两个辅助仿 tests/io.mjs ——
async function uiMenu(page, top, item) {
  if (await page.locator('.menu-backdrop').count()) {
    await page.mouse.click(750, 500);
    await page.waitForTimeout(120);
  }
  await page.click(`.menubar .menu:has(button:text-is("${top}")) button.menu-btn`);
  await page.click(`.dropdown .menu-item:has-text("${item}")`);
  await page.waitForTimeout(200);
  if (await page.locator('.menu-backdrop').count()) {
    await page.evaluate(() =>
      document.querySelector('.menu-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForTimeout(120);
  }
}

async function uiNewDoc(page, w, h) {
  if (await page.locator('button.big:text-is("新建…")').count()) {
    await page.click('button.big:text-is("新建…")'); // 欢迎页
  } else {
    await uiMenu(page, '文件', '新建…'); // 已有文档时走菜单
  }
  const dlg = page.locator('.dialog', { hasText: '新建文档' });
  const nums = dlg.locator('input[type=number]');
  await nums.nth(0).fill(String(w));
  await nums.nth(1).fill(String(h));
  await dlg.locator('input[value=white]').check();
  await dlg.locator('button:has-text("创建")').click();
  await page.waitForTimeout(300);
}

const actionRow = (page, name) => page.locator('.actions-panel .action-row', { hasText: name });

async function run() {
  let browser;
  try {
    browser = await pw.chromium.launch({ channel: 'chrome' });
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    // 0. 干净起点:清 localStorage['compositor.actions'] 并刷新
    await page.evaluate(() => localStorage.removeItem('compositor.actions'));
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    // 1. 录制:新建 600×400 → 画黑矩形 → 新建动作「测试动作」→ 两条 runCommand → 停止录制
    await uiNewDoc(page, 600, 400);
    await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 600; c.height = 400;
      const g = c.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, 600, 400);
      window.__store.doc.layers[0].bitmap = c; // 画黑矩形(换画布身份 → 合成缓存失效)
    });
    await page.fill('.actions-panel .new-row input', '测试动作');
    await page.click('.actions-panel button:has-text("新建动作")');
    await page.waitForTimeout(150);
    const recLine = await page.locator('.actions-panel .rec-line').innerText().catch(() => '');
    record('录制中指示:红点行「录制中:测试动作」',
      recLine.includes('录制中') && recLine.includes('测试动作'), JSON.stringify(recLine));
    // 经真实 runCommand 入口录两条命令(属性面板翻转按钮)
    await page.click('button[title="水平翻转"]');
    await page.waitForTimeout(150);
    await page.click('button[title="垂直翻转"]');
    await page.waitForTimeout(150);
    const liveTxt = await actionRow(page, '测试动作').innerText();
    await page.click('.actions-panel button:has-text("停止录制")');
    await page.waitForTimeout(200);
    const rowTxt = await actionRow(page, '测试动作').innerText();
    record('录制:列表项存在、实时与停止后步骤数=2',
      liveTxt.includes('2 步') && rowTxt.includes('2 步'),
      `live=${JSON.stringify(liveTxt)} row=${JSON.stringify(rowTxt)}`);

    // 2. 回放:新建另一文档 + 四象限灰阶(非对称,翻转效果可观察)→ 选中动作 → 回放
    await uiNewDoc(page, 600, 400);
    await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 600; c.height = 400;
      const g = c.getContext('2d');
      g.fillStyle = 'rgb(60,60,60)'; g.fillRect(0, 0, 300, 200);    // 左上
      g.fillStyle = 'rgb(200,200,200)'; g.fillRect(300, 0, 300, 200); // 右上
      g.fillStyle = 'rgb(140,140,140)'; g.fillRect(0, 200, 300, 200); // 左下
      g.fillStyle = 'rgb(30,30,30)'; g.fillRect(300, 200, 300, 200);  // 右下
      window.__store.doc.layers[0].bitmap = c;
    });
    await page.click('.actions-panel .action-row:has-text("测试动作")');
    await page.click('.actions-panel button:has-text("回放")');
    await page.waitForTimeout(400);
    const r2 = await page.evaluate(() => {
      const t = window.__store.doc.layers[0].transform;
      return { flipX: t.flipX === true, flipY: t.flipY === true };
    });
    record('回放:两条步骤按序生效(flipX/flipY 均置位)',
      r2.flipX && r2.flipY, JSON.stringify(r2));
    const rowTxt2 = await actionRow(page, '测试动作').innerText();
    record('回放未自录制:步骤数仍=2', rowTxt2.includes('2 步'), JSON.stringify(rowTxt2));

    // 3. 持久化:刷新后动作仍在(localStorage)
    await page.waitForTimeout(400); // 等 debounce 写入(150ms)完成
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await uiNewDoc(page, 100, 100); // 动作面板 v-if="store.doc",先建个文档让它显形
    const rowTxt3 = await actionRow(page, '测试动作').innerText().catch(() => '');
    const tip = String(await actionRow(page, '测试动作').getAttribute('title').catch(() => ''));
    record('持久化:刷新后动作仍在且步骤数=2',
      rowTxt3.includes('测试动作') && rowTxt3.includes('2 步'), JSON.stringify(rowTxt3));
    record('悬停提示:每步命令 label(水平/垂直翻转图层)',
      tip.includes('水平翻转图层') && tip.includes('垂直翻转图层'), JSON.stringify(tip));

    // 4. 批处理:fake internals 截获列目录/读/写,造两个左↔右双色的 8×8 PNG
    await page.evaluate(async () => {
      const mk = async (left, right) => {
        const c = document.createElement('canvas');
        c.width = 8; c.height = 8;
        const g = c.getContext('2d');
        g.fillStyle = `rgb(${left.join(',')})`; g.fillRect(0, 0, 4, 8);
        g.fillStyle = `rgb(${right.join(',')})`; g.fillRect(4, 0, 4, 8);
        const blob = await new Promise(res => c.toBlob(res, 'image/png'));
        return new Uint8Array(await blob.arrayBuffer());
      };
      window.__files = new Map();
      window.__files.set('C:/batch/a.png', await mk([255, 0, 0], [0, 0, 255]));
      window.__files.set('C:/batch/b.png', await mk([0, 128, 0], [255, 255, 255]));
      window.__alerts = [];
      window.alert = m => window.__alerts.push(String(m));
      window.__TAURI_INTERNALS__ = {
        invoke: async (cmd, args) => {
          if (cmd === 'plugin:dialog|open') return 'C:/batch';
          if (cmd === 'make_dir') return;
          const p = String(args?.path ?? '');
          if (cmd === 'list_dir') return ['a.png', 'b.png', 'note.txt'];
          if (cmd === 'write_file') { window.__files.set(p, Uint8Array.from(args.bytes)); return; }
          if (cmd === 'read_file') {
            const b = window.__files.get(p);
            if (!b) throw new Error('fake read_file: not found ' + p);
            return [...b];
          }
          throw new Error('fake invoke: ' + cmd);
        },
      };
    });
    await page.click('.actions-panel .action-row:has-text("测试动作")');
    await page.click('.actions-panel button:has-text("批处理")');
    await page.waitForFunction(() => window.__alerts && window.__alerts.length > 0, null, { timeout: 20000 });
    const r4 = await page.evaluate(async () => {
      try {
        const out = { alerts: [...window.__alerts], files: {} };
        for (const key of ['C:/batch/rendered/a.png', 'C:/batch/rendered/b.png']) {
          const bytes = window.__files.get(key);
          if (!bytes) { out.files[key] = null; continue; }
          const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
          const c = document.createElement('canvas');
          c.width = bmp.width; c.height = bmp.height;
          c.getContext('2d').drawImage(bmp, 0, 0);
          const px = (x, y) => [...c.getContext('2d').getImageData(x, y, 1, 1).data];
          out.files[key] = { w: bmp.width, h: bmp.height, left: px(1, 3), right: px(6, 3) };
        }
        return out;
      } finally { delete window.__TAURI_INTERNALS__; }
    });
    const a4 = r4.files['C:/batch/rendered/a.png'];
    const b4 = r4.files['C:/batch/rendered/b.png'];
    record('批处理:alert 汇总「完成 2/2」(note.txt 被扩展名过滤)',
      r4.alerts.some(m => m.includes('批处理完成 2/2')), JSON.stringify(r4.alerts));
    record('批处理:rendered/a.png 生成且像素=动作处理(左右互换)',
      !!a4 && a4.w === 8 && samePx(a4.left, [0, 0, 255, 255]) && samePx(a4.right, [255, 0, 0, 255]),
      JSON.stringify(a4));
    record('批处理:rendered/b.png 生成且像素=动作处理(左右互换)',
      !!b4 && b4.w === 8 && samePx(b4.left, [255, 255, 255, 255]) && samePx(b4.right, [0, 128, 0, 255]),
      JSON.stringify(b4));

    // 汇总
    console.log('\n========== 结果汇总 ==========');
    const pass = results.filter(x => x.ok).length;
    console.log(`通过 ${pass}/${results.length}`);
    if (errors.length) {
      console.log('\n⚠️ 页面报错(前10条):');
      errors.slice(0, 10).forEach(e => console.log('  ' + e.slice(0, 200)));
    } else {
      console.log('无页面 JS 报错');
    }
  } finally {
    await browser?.close();
  }
}

run().catch(e => {
  console.error('测试脚本异常:', e);
  process.exit(1);
});
