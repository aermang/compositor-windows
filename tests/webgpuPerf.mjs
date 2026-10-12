// WebGPU 性能基准:加载独立探针 /src/core/webgpuProbe.ts(io 类模块,无 store 副作用),
// 跑合成吞吐 / 回读成本 / 模糊对比,打印人类可读对比表并断言结果可用性。
// 运行:NODE_PATH="<npx playwright 缓存目录>" node tests/webgpuPerf.mjs
// 共享 dev server 上多智能体并行改文件会触发 HMR 抖动:整体失败时原样重跑一次。
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const pw = require2(process.env.PW_PATH || 'playwright');

const RUNS = [
  { fn: 'benchComposite', args: [1000, 1000, 4] },
  { fn: 'benchComposite', args: [1000, 1000, 16] },
  { fn: 'benchComposite', args: [1000, 1000, 64] },
  { fn: 'benchComposite', args: [4000, 4000, 4] },
  { fn: 'benchComposite', args: [4000, 4000, 16] },
  { fn: 'benchBlur', args: [1024, 1024] },
];

let failed = false;
function check(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failed = true;
}

function fmtMs(v) {
  return Number.isFinite(v) ? v.toFixed(3).padStart(9) : '        —';
}

function printTable(results) {
  console.log('\n===== WebGPU vs Canvas2D 基准(中位数,ms;倍率 = ms2d/msGpu,>1 表示 GPU 更快)=====');
  console.log(
    '场景'.padEnd(26) + 'Canvas2D'.padStart(10) + 'WebGPU(端到端)'.padStart(16) + '纯GPU渲染'.padStart(11) + '倍率'.padStart(9),
  );
  console.log('-'.repeat(76));
  for (const r of results) {
    const render = (r.note || '').match(/render=([0-9.]+)/);
    const speedup = r.msGpu > 0 ? `×${(r.ms2d / r.msGpu).toFixed(3)}` : 'n/a';
    console.log(
      r.label.padEnd(26) + fmtMs(r.ms2d) + fmtMs(r.msGpu ?? NaN).padStart(12) +
      (render ? render[1].padStart(9) : '       —') + speedup.padStart(10),
    );
    if (r.note) console.log(`${' '.repeat(26)}└ ${r.note}`);
  }
  console.log('-'.repeat(76));
}

async function runOnce(browser) {
  const pageErrors = [];
  const page = await (await browser.newContext({
    viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1,
  })).newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('http://localhost:1420', { waitUntil: 'domcontentloaded' });
  // 等 vite 服务就绪(应用可达即可;探针不依赖文档现场)
  await page.waitForSelector('body', { timeout: 30000 });
  await page.waitForTimeout(800);

  const payload = await page.evaluate(async (runs) => {
    const m = await import('/src/core/webgpuProbe.ts');
    const results = [];
    for (const r of runs) {
      try {
        results.push(await m[r.fn](...r.args));
      } catch (e) {
        // 探针承诺永不抛出;这里兜底记录(出现即视为实现缺陷)
        results.push({ label: `${r.fn} ${r.args.join('x').replace(/x(\d+)$/, ' x$1')}`, ms2d: NaN, msGpu: null, note: `探针抛出(不应发生): ${String(e && e.message || e)}` });
      }
    }
    return { info: m.gpuInfo(), results };
  }, RUNS);

  await page.close();
  return { ...payload, pageErrors };
}

const browser = await pw.chromium.launch({ channel: 'chrome' });
let out = null;
try {
  out = await runOnce(browser); // HMR 抖动 / 偶发设备失败:原样重跑一次
  if (out.results.some((r) => !Number.isFinite(r.ms2d) || r.ms2d <= 0 || r.msGpu === null && !(r.note || '').trim()) || out.pageErrors.length) {
    console.log('[retry] 首轮存在失败/页面错误,原样重跑一次');
    out = await runOnce(browser);
  }
} finally {
  await browser.close();
}

const { info, results, pageErrors } = out;

// ---- 初始化信息(Q4:初始化延迟与 WebView2 兼容性)----
console.log('===== GPU 初始化信息 =====');
if (info && info.available) {
  console.log(`✅ navigator.gpu 可用: adapter=${info.vendor}/${info.architecture} desc=${info.description || 'n/a'}`);
  console.log(`   requestAdapter=${info.adapterMs?.toFixed(1)}ms  requestDevice=${info.deviceMs?.toFixed(1)}ms  timestamp-query=${!!info.timestampQuery}  maxTexture2D=${info.maxTextureDim}`);
} else {
  console.log(`❌ navigator.gpu 不可用: ${info?.reason ?? '初始化未完成'}`);
}

printTable(results);

// ---- 断言 ----
check('结果条数 = 6', results.length === RUNS.length, `got ${results.length}`);
for (const r of results) {
  check(`${r.label}: ms2d > 0 且有限`, typeof r.ms2d === 'number' && Number.isFinite(r.ms2d) && r.ms2d > 0, `ms2d=${r.ms2d}`);
  const reasonMarked = typeof r.note === 'string'
    && ['不可用', '失败', '出错', 'n/a'].some((k) => r.note.includes(k));
  const gpuOk = r.msGpu === null ? reasonMarked : Number.isFinite(r.msGpu) && r.msGpu > 0;
  check(`${r.label}: msGpu 为 null+原因 或 > 0`, gpuOk, r.msGpu === null ? `null; note=${(r.note || '').slice(0, 90)}` : `msGpu=${r.msGpu}`);
}
check('全程无 pageerror', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

process.exit(failed ? 1 : 0);
