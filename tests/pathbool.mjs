// 路径布尔运算 e2e(合并/减去/相交 + 建立选区 + 历史):
//  1. 钢笔画矩形1(100,100)-(200,200)→ 提交为路径;再画重叠矩形2(150,150)-(250,250)→ 提交为路径
//  2. 合并 → 新路径出现 → 建立选区 → mask 采样 (120,120)=255 (230,230)=255 (90,90)=0
//  3. 减去(A−B) → (120,120)=255 (200,200)=0 (230,230)=0
//  4. 相交 → (180,180)=255 (120,120)=0
//  5. Ctrl+Z 三次依次撤销三个运算路径
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const pw = require2(process.env.PW_PATH || 'playwright');

const browser = await pw.chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 })).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });
page.on('dialog', d => d.accept()); // 「结果为空」alert 等不阻塞测试

let OFF = { x: 0, y: 0 }, V = { z: 1, px: 0, py: 0 };
const S = (dx, dy) => ({ x: OFF.x + V.px + dx * V.z, y: OFF.y + V.py + dy * V.z });
async function clickDoc(dx, dy) {
  const s = S(dx, dy);
  await page.mouse.click(s.x, s.y);
  await page.waitForTimeout(120);
}

const results = [];
const record = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const maskAt = (x, y) => page.evaluate(([px, py]) => {
  const m = window.__store.selection?.mask;
  return m ? m.getContext('2d').getImageData(px, py, 1, 1).data[3] : -1;
}, [x, y]);
const pathNames = () => page.evaluate(() => (window.__store.doc.paths ?? []).map(p => p.name));

await page.goto('http://localhost:1420', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

// 新建 600×400 白底文档
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

// ---------- 画两个重叠矩形并存为路径 ----------
await page.keyboard.press('p');
await page.waitForTimeout(100);

for (const [dx, dy] of [[100, 100], [200, 100], [200, 200], [100, 200]]) await clickDoc(dx, dy);
await page.keyboard.press('Enter'); // 闭合矩形 1
await page.waitForTimeout(150);
const w1 = await page.evaluate(() => window.__penDebug.getWorkPath());
const w1ok = w1?.subpaths?.length === 1 && w1.subpaths[0].closed === true && w1.subpaths[0].anchors.length === 4;
record('钢笔画矩形1(4 点击闭合)', w1ok, `anchors=${w1?.subpaths?.[0]?.anchors?.length}`);
await page.click('.paths-panel button:has-text("提交为路径")');
await page.waitForTimeout(200);

for (const [dx, dy] of [[150, 150], [250, 150], [250, 250], [150, 250]]) await clickDoc(dx, dy);
await page.keyboard.press('Enter'); // 闭合矩形 2
await page.waitForTimeout(150);
const w2 = await page.evaluate(() => window.__penDebug.getWorkPath());
const w2ok = w2?.subpaths?.length === 1 && w2.subpaths[0].closed === true && w2.subpaths[0].anchors.length === 4;
record('钢笔画矩形2(与矩形1重叠)', w2ok, `anchors=${w2?.subpaths?.[0]?.anchors?.length}`);
await page.click('.paths-panel button:has-text("提交为路径")');
await page.waitForTimeout(200);

const names0 = await pathNames();
record('两条路径已保存', names0.length === 2 && names0[0] === '路径 1' && names0[1] === '路径 2', JSON.stringify(names0));

// 面板下拉选 A=路径 1 B=路径 2
await page.selectOption('.paths-panel select.bool-a', { label: '路径 1' });
await page.selectOption('.paths-panel select.bool-b', { label: '路径 2' });
await page.waitForTimeout(100);

// ---------- 合并 ----------
await page.click('.paths-panel button:has-text("合并")');
await page.waitForTimeout(300);
const namesU = await pathNames();
record('合并生成新路径', namesU.length === 3 && namesU[2].includes('∪'), JSON.stringify(namesU));
await page.click('.paths-panel button:has-text("建立选区")');
await page.waitForTimeout(250);
const u1 = await maskAt(120, 120), u2 = await maskAt(230, 230), u3 = await maskAt(90, 90);
record('合并选区采样', u1 === 255 && u2 === 255 && u3 === 0,
  `(120,120)=${u1} (230,230)=${u2} (90,90)=${u3}`);
await page.keyboard.press('Control+d');
await page.waitForTimeout(150);

// ---------- 减去(A−B) ----------
await page.click('.paths-panel button:has-text("减去")');
await page.waitForTimeout(300);
const namesS = await pathNames();
record('减去生成新路径', namesS.length === 4 && namesS[3].includes('−'), JSON.stringify(namesS));
await page.click('.paths-panel button:has-text("建立选区")');
await page.waitForTimeout(250);
const s1 = await maskAt(120, 120), s2 = await maskAt(200, 200), s3 = await maskAt(230, 230);
record('减去选区采样(重叠区被挖掉)', s1 === 255 && s2 === 0 && s3 === 0,
  `(120,120)=${s1} (200,200)=${s2} (230,230)=${s3}`);
await page.keyboard.press('Control+d');
await page.waitForTimeout(150);

// ---------- 相交 ----------
await page.click('.paths-panel button:has-text("相交")');
await page.waitForTimeout(300);
const namesI = await pathNames();
record('相交生成新路径', namesI.length === 5 && namesI[4].includes('∩'), JSON.stringify(namesI));
await page.click('.paths-panel button:has-text("建立选区")');
await page.waitForTimeout(250);
const i1 = await maskAt(180, 180), i2 = await maskAt(120, 120);
record('相交选区采样', i1 === 255 && i2 === 0, `(180,180)=${i1} (120,120)=${i2}`);
await page.keyboard.press('Control+d');
await page.waitForTimeout(150);

// ---------- 历史:Ctrl+Z 三次依次撤销三个运算路径 ----------
const c0 = await pathNames();
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
const c1 = await pathNames();
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
const c2 = await pathNames();
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
const c3 = await pathNames();
record('Ctrl+Z 三次撤销运算路径', c0.length === 5 && c1.length === 4 && c2.length === 3 && c3.length === 2,
  `${c0.length}→${c1.length}→${c2.length}→${c3.length}`);
record('撤销后仅剩原两条路径', c3.length === 2 && c3[0] === '路径 1' && c3[1] === '路径 2', JSON.stringify(c3));

const ok = results.every(Boolean);
console.log(ok ? '\n✅ 路径布尔运算 e2e 全部 PASS' : '\n❌ 路径布尔运算 e2e FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
