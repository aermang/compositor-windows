// WebGPU 性能探针 —— 独立评估原型,不被任何生产代码 import(仅供 tests/webgpuPerf.mjs
// 与 docs/webgpu-eval.md 取数)。设计原则:永不抛出 —— 适配器/设备/管线/任何一步失败
// 都降级为 msGpu = null + note 原因;调用方只需断言「有数字或明确的 null+原因」。
//
// 计时口径(报告直接引用):
// - Canvas2D(ms2d):performance.now 包住整段绘制循环,预热 5 次 + 测量 20 次取中位数。
//   不显式 flush(无此 API),含 Skia 命令缓冲自然背压,不含显式回读 —— 即「rAF 循环里
//   每帧调 composite()」的真实口径。
// - WebGPU(msGpu):每帧 = 编码渲染 pass + submit + drawImage(GPU canvas → 2D canvas,
//   「结果回到 Canvas2D 世界」的传输)+ await queue.onSubmittedWorkDone() 全排空后停表。
//   对 WebGPU 是保守(偏不利)口径:2D 侧不排空,这里强制排空。
// - 纯 GPU 渲染时间(note.render=):device 有 timestamp-query 时取 pass 时间戳差(多
//   pass 求和);否则用「编码+submit+排空」(不含回传)的 CPU 墙钟,note 标 via。
// - 回读成本(note.readback=/putImage=):copyTextureToBuffer + mapAsync(CPU 真读回)与
//   putImageData(写回 2D canvas)单独计时 —— 这是迁移的最大隐藏成本,必须实测。
// - 层不透明度(LAYER_ALPHA=0.5)烧进层内容像素,两侧管线等价输入、等价混合路径。

export interface BenchResult {
  label: string;
  ms2d: number;
  msGpu: number | null;
  note?: string;
}

export interface GpuInitInfo {
  available: boolean;
  /** 不可用/降级原因(人类可读) */
  reason?: string;
  /** requestAdapter 墙钟耗时 ms(首次) */
  adapterMs?: number;
  /** requestDevice 墙钟耗时 ms(首次) */
  deviceMs?: number;
  vendor?: string;
  architecture?: string;
  description?: string;
  /** timestamp-query 特性是否启用 */
  timestampQuery?: boolean;
  /** maxTextureDimension2D */
  maxTextureDim?: number;
}

const WARMUP = 5;
const MEASURE = 20;
/** 模拟图层不透明度:烧进层内容(两侧等价) */
const LAYER_ALPHA = 0.5;
/** benchBlur 的 CSS 口径半径:ctx.filter = blur(Rpx) */
const BLUR_RADIUS_PX = 8;
/** 盒式模糊迭代:每方向 3 次单盒 ≈ Skia 对 CSS blur 的三迭盒式实现,σ 口径一致 */
const BOX_ITERS = 3;

// 本 TS 版本的 lib.dom 只带 WebGPU 类型、不带全局 usage 常量声明(GPUBufferUsage 等),
// 经 globalThis 取运行时值(值集为 WebGPU spec 固定值,Chrome 实现一致)。
interface WebGpuGlobals {
  GPUBufferUsage: Record<'MAP_READ' | 'COPY_SRC' | 'COPY_DST' | 'UNIFORM' | 'QUERY_RESOLVE', number>;
  GPUTextureUsage: Record<'COPY_SRC' | 'TEXTURE_BINDING' | 'COPY_DST' | 'RENDER_ATTACHMENT', number>;
  GPUMapMode: Record<'READ', number>;
}
const U = globalThis as unknown as WebGpuGlobals;

// ---------------------------------------------------------------------------
// 设备初始化(进程级缓存一次;丢失后重置,下一次 bench 重连并给出原因)
// ---------------------------------------------------------------------------

let initPromise: Promise<GpuInitInfo> | null = null;
let lastInit: GpuInitInfo | null = null;
let device: GPUDevice | null = null;
let uncapturedError = '';
let compositePipeline: GPURenderPipeline | null = null;
let blurPipeline: GPURenderPipeline | null = null;
let sampler: GPUSampler | null = null;

function fmt(v: unknown): string {
  return typeof v === 'string' && v ? v : 'n/a';
}

async function doInit(): Promise<GpuInitInfo> {
  const nav = navigator as Navigator & { gpu?: GPU };
  if (!nav.gpu || typeof nav.gpu.requestAdapter !== 'function') {
    return { available: false, reason: 'navigator.gpu 不可用(WebView2 默认无 WebGPU,见 docs/webgpu-eval.md)' };
  }
  let adapter: GPUAdapter | null = null;
  let adapterMs = NaN;
  let deviceMs = NaN;
  try {
    const t0 = performance.now();
    adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
    adapterMs = performance.now() - t0;
    if (!adapter) return { available: false, reason: 'requestAdapter() 返回 null' };
  } catch (e) {
    return { available: false, reason: `requestAdapter 抛错: ${String((e as Error)?.message ?? e)}` };
  }
  const wantTs = adapter.features.has('timestamp-query');
  try {
    const t1 = performance.now();
    device = await adapter.requestDevice({
      requiredFeatures: wantTs ? ['timestamp-query'] : [],
      label: 'webgpuProbe',
    });
    deviceMs = performance.now() - t1;
  } catch (e) {
    device = null;
    return { available: false, reason: `requestDevice 抛错: ${String((e as Error)?.message ?? e)}`, adapterMs };
  }
  device.onuncapturederror = (ev: GPUUncapturedErrorEvent) => {
    // 只保留第一条(根因);后续多为「Invalid CommandBuffer」连锁噪音
    if (!uncapturedError) uncapturedError = ev.error?.message ?? 'uncaptured GPU error';
  };
  device.lost.then((info) => {
    if (device) {
      device = null;
      compositePipeline = null;
      blurPipeline = null;
      sampler = null;
      initPromise = null;
      uncapturedError = `device lost: ${info.reason ?? 'unknown'}`;
    }
  });
  return {
    available: true,
    adapterMs,
    deviceMs,
    vendor: fmt(adapter.info?.vendor),
    architecture: fmt(adapter.info?.architecture),
    description: fmt(adapter.info?.description),
    timestampQuery: wantTs,
    maxTextureDim: device.limits.maxTextureDimension2D,
  };
}

/** 确保 GPU 设备就绪(幂等;失败结果也缓存) */
async function ensureDevice(): Promise<GpuInitInfo> {
  if (!initPromise) {
    initPromise = doInit();
    void initPromise.then((r) => { lastInit = r; }).catch(() => { /* never rejects */ });
  }
  return initPromise;
}

// 模块加载即开始初始化(探针场景无妨;应用内若接入应改为首次用时请求)
void ensureDevice();

/** navigator.gpu 是否可用(含适配器/设备请求;幂等,永不抛出) */
export async function gpuAvailable(): Promise<boolean> {
  try {
    return (await ensureDevice()).available;
  } catch {
    return false;
  }
}

/** 最近一次初始化详情(延迟/适配器信息/特性);尚未完成返回 null */
export function gpuInfo(): GpuInitInfo | null {
  return lastInit;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? NaN : n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function f(x: number): string {
  return Number.isFinite(x) ? x.toFixed(3) : 'n/a';
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成一层半透明测试内容(等效 opacity=0.5 的图层,烧进像素) */
function makeLayerCanvas(w: number, h: number, seed: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: false });
  if (!ctx) throw new Error('2D context unavailable');
  const rnd = mulberry32(seed);
  ctx.globalAlpha = LAYER_ALPHA;
  const bands = 6 + Math.floor(rnd() * 6);
  for (let i = 0; i < bands; i++) {
    ctx.fillStyle = `hsl(${Math.floor(rnd() * 360)} 80% 55%)`;
    const bw = w * (0.12 + rnd() * 0.5);
    const bh = h * (0.12 + rnd() * 0.5);
    ctx.fillRect(rnd() * (w - bw), rnd() * (h - bh), bw, bh);
  }
  ctx.beginPath();
  ctx.arc(w * (0.3 + rnd() * 0.4), h * (0.3 + rnd() * 0.4), Math.min(w, h) * 0.25, 0, Math.PI * 2);
  ctx.fillStyle = `hsl(${Math.floor(rnd() * 360)} 90% 60%)`;
  ctx.fill();
  return c;
}

function destroyAll(xs: { destroy?: () => void }[]): void {
  for (const x of xs) { try { x.destroy?.(); } catch { /* noop */ } }
}

/** 防 mapAsync 永久挂起(如 submit 被毒化后 readBuf 永不就绪) */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout(${ms}ms)`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// ---------------------------------------------------------------------------
// WGSL:全屏三角形;fsLayer=逐层 source-over;fsBlur=单方向盒式(uniform 驱动)
// ---------------------------------------------------------------------------

const SHADER = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};
@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VSOut {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let q = p[vi];
  var o : VSOut;
  o.pos = vec4<f32>(q, 0.0, 1.0);
  o.uv = vec2<f32>((q.x + 1.0) * 0.5, (1.0 - q.y) * 0.5);
  return o;
}

@group(0) @binding(0) var texS : sampler;
@group(0) @binding(1) var tex : texture_2d<f32>;

// 逐层 source-over(输入输出均 premultiplied,等价 Canvas2D source-over)
@fragment
fn fsLayer(in : VSOut) -> @location(0) vec4<f32> {
  return textureSample(tex, texS, in.uv);
}

struct BlurParams {
  radius : f32, dx : f32, dy : f32, pad0 : f32,
  texelX : f32, texelY : f32, pad1 : f32, pad2 : f32,
};
@group(0) @binding(2) var<uniform> bp : BlurParams;

// 单方向盒式均值(1D);半径/方向由 uniform 驱动,循环界为 uniform 值(均匀控制流)
@fragment
fn fsBlur(in : VSOut) -> @location(0) vec4<f32> {
  let stepv = vec2<f32>(bp.dx * bp.texelX, bp.dy * bp.texelY);
  var acc = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  let r = i32(bp.radius);
  for (var i = -r; i <= r; i = i + 1) {
    acc = acc + textureSample(tex, texS, in.uv + stepv * f32(i));
  }
  let n = f32(2 * r + 1);
  return acc / vec4<f32>(n, n, n, n);
}
`;

const BLEND_OVER_PREMULTIPLIED: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

function getPipeline(kind: 'composite' | 'blur'): GPURenderPipeline {
  if (kind === 'composite' && compositePipeline) return compositePipeline;
  if (kind === 'blur' && blurPipeline) return blurPipeline;
  if (!device || !navigator.gpu) throw new Error('no device');
  const module = device.createShaderModule({ code: SHADER, label: 'webgpuProbe' });
  const common = {
    layout: 'auto' as const,
    vertex: { module, entryPoint: 'vs' },
    primitive: { topology: 'triangle-list' as const },
  };
  if (kind === 'composite') {
    compositePipeline = device.createRenderPipeline({
      ...common,
      fragment: {
        module, entryPoint: 'fsLayer',
        targets: [{ format: navigator.gpu.getPreferredCanvasFormat(), blend: BLEND_OVER_PREMULTIPLIED }],
      },
    });
    return compositePipeline;
  }
  blurPipeline = device.createRenderPipeline({
    ...common,
    fragment: {
      module, entryPoint: 'fsBlur',
      targets: [{ format: navigator.gpu.getPreferredCanvasFormat(), blend: BLEND_OVER_PREMULTIPLIED }],
    },
  });
  return blurPipeline;
}

function getSampler(): GPUSampler {
  if (!sampler) {
    sampler = device!.createSampler({
      magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    });
  }
  return sampler;
}

// ---- timestamp-query 封装(不可用/失败时 rig 为 null 或永久禁用)----
class TimestampRig {
  private qs: GPUQuerySet;
  private resolveBuf: GPUBuffer;
  private readBuf: GPUBuffer;
  private n: number;
  private period: number;
  private broken = false;
  constructor(dev: GPUDevice, passes: number) {
    this.n = passes * 2;
    // lib.dom 类型只列 maxTimestampPeriod(limit);实际换算系数是 device.limits.timestampPeriod
    this.period = (dev.limits as GPUSupportedLimits & { timestampPeriod?: number }).timestampPeriod || 1;
    this.qs = dev.createQuerySet({ type: 'timestamp', count: this.n });
    this.resolveBuf = dev.createBuffer({ size: 8 * this.n, usage: U.GPUBufferUsage.QUERY_RESOLVE | U.GPUBufferUsage.COPY_SRC });
    this.readBuf = dev.createBuffer({ size: 8 * this.n, usage: U.GPUBufferUsage.COPY_DST | U.GPUBufferUsage.MAP_READ });
  }
  writes(passIndex: number): GPURenderPassTimestampWrites {
    return { querySet: this.qs, beginningOfPassWriteIndex: passIndex * 2, endOfPassWriteIndex: passIndex * 2 + 1 };
  }
  /** 提交 resolve+copy 并读回;所有 pass 时长求和(ms)。排在停表之后调用 */
  async read(): Promise<number> {
    if (this.broken) return NaN;
    try {
      const dev = device;
      if (!dev) return NaN;
      const enc = dev.createCommandEncoder();
      enc.resolveQuerySet(this.qs, 0, this.n, this.resolveBuf, 0);
      enc.copyBufferToBuffer(this.resolveBuf, 0, this.readBuf, 0, 8 * this.n);
      dev.queue.submit([enc.finish()]);
      await withTimeout(this.readBuf.mapAsync(U.GPUMapMode.READ), 2000);
      const arr = new BigUint64Array(this.readBuf.getMappedRange());
      let sumNs = 0;
      for (let i = 0; i < this.n; i += 2) sumNs += Number(arr[i + 1] - arr[i]);
      this.readBuf.unmap();
      return (sumNs * this.period) / 1e6;
    } catch {
      this.broken = true;
      return NaN;
    }
  }
  destroy(): void {
    try { this.qs.destroy(); this.resolveBuf.destroy(); this.readBuf.destroy(); } catch { /* noop */ }
  }
}

interface FramePass {
  view: GPUTextureView;
  clear: boolean;
  bgs: GPUBindGroup[];
}
interface FrameCtx {
  kind: 'composite' | 'blur';
  passes: FramePass[];
  gpuCanvas: OffscreenCanvas;
  dst2d: CanvasRenderingContext2D;
  ts: TimestampRig | null;
  /** false = 纯渲染基线:不把 GPU canvas 回传到 2D(用于 render= 的 wall 口径) */
  transfer: boolean;
}
/** 每帧公共骨架:[编码+提交 (+回传2D) (+排空)] 停表;时间戳读回排在停表之后 */
async function runFrame(fc: FrameCtx): Promise<[number, number]> {
  if (!device) throw new Error('no device');
  const t0 = performance.now();
  const enc = device.createCommandEncoder();
  const pipe = getPipeline(fc.kind);
  for (let i = 0; i < fc.passes.length; i++) {
    const p = fc.passes[i];
    const desc: GPURenderPassDescriptor = {
      colorAttachments: [{
        view: p.view, loadOp: p.clear ? 'clear' : 'load', storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    };
    if (fc.ts) desc.timestampWrites = fc.ts.writes(i);
    const pass = enc.beginRenderPass(desc);
    pass.setPipeline(pipe);
    for (const bg of p.bgs) { pass.setBindGroup(0, bg); pass.draw(3); }
    pass.end();
  }
  device.queue.submit([enc.finish()]);
  if (fc.transfer) fc.dst2d.drawImage(fc.gpuCanvas as unknown as CanvasImageSource, 0, 0);
  await device.queue.onSubmittedWorkDone();
  const t1 = performance.now();
  let tsMs = NaN;
  if (fc.ts) tsMs = await fc.ts.read();
  return [t1 - t0, tsMs];
}

/** 配一块 GPU 画布 + 2D 回传目标;失败返回 null(原因入 note) */
function makeTargets(w: number, h: number): { gpuCanvas: OffscreenCanvas; gctx: GPUCanvasContext; r2d: CanvasRenderingContext2D } | string {
  if (!device) return 'no device';
  const gpuCanvas = new OffscreenCanvas(w, h);
  const gctx = gpuCanvas.getContext('webgpu') as unknown as GPUCanvasContext | null;
  if (!gctx) return 'OffscreenCanvas webgpu context 获取失败';
  try {
    gctx.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'premultiplied' });
  } catch (e) {
    return `canvas configure 失败: ${String((e as Error)?.message ?? e)}`;
  }
  const ret2d = document.createElement('canvas');
  ret2d.width = w; ret2d.height = h;
  const r2d = ret2d.getContext('2d', { willReadFrequently: false });
  if (!r2d) return '2D 回传目标创建失败';
  return { gpuCanvas, gctx, r2d };
}

/** 上传 2D 源 → rgba8unorm 纹理(premultiplied);失败抛出(调用方 catch 降级) */
function uploadTexture(src: HTMLCanvasElement, w: number, h: number): GPUTexture {
  if (!device) throw new Error('no device');
  const t = device.createTexture({
    size: [w, h], format: 'rgba8unorm',
    usage: U.GPUTextureUsage.TEXTURE_BINDING | U.GPUTextureUsage.COPY_DST | U.GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({ source: src }, { texture: t, premultipliedAlpha: true }, [w, h]);
  return t;
}

// ---------------------------------------------------------------------------
// 基准 1:合成吞吐(N 层 full-canvas source-over)
// ---------------------------------------------------------------------------

export async function benchComposite(w: number, h: number, layers: number): Promise<BenchResult> {
  const label = `composite ${w}x${h} x${layers}`;
  let ms2d = NaN;
  const noteParts: string[] = [];
  // GPU 侧资源集中登记,任何出口都统一销毁(4000²×N 纹理必须还内存)
  const disposables: { destroy?: () => void }[] = [];
  try {
    // ---- Canvas2D 侧(无论 GPU 是否可用都要给出数据)----
    const distinct = Math.min(layers, 4); // 去重源上限控内存;每层 drawImage 次数不变
    const srcs: HTMLCanvasElement[] = [];
    for (let i = 0; i < distinct; i++) srcs.push(makeLayerCanvas(w, h, 1000 + i * 7));
    const dst = document.createElement('canvas');
    dst.width = w; dst.height = h;
    const c2d = dst.getContext('2d', { willReadFrequently: false });
    if (!c2d) throw new Error('2D context unavailable');
    // 分离 canvas 的绘制会被 Chrome 无限延迟(display-list 记录,连 drawImage 到
    // 另一 canvas 都不会真正栅格化),必须每帧 getImageData(1×1) 强制 flush ——
    // 这是 Canvas2D 微基准的标准口径:含栅格化、不含整幅回读。
    const loop2d = () => {
      c2d.clearRect(0, 0, w, h);
      for (let i = 0; i < layers; i++) c2d.drawImage(srcs[i % distinct], 0, 0);
      c2d.getImageData(0, 0, 1, 1);
    };
    for (let i = 0; i < WARMUP; i++) { c2d.clearRect(0, 0, w, h); loop2d(); }
    const t2d: number[] = [];
    for (let i = 0; i < MEASURE; i++) {
      const t0 = performance.now();
      c2d.clearRect(0, 0, w, h);
      loop2d();
      t2d.push(performance.now() - t0);
    }
    ms2d = median(t2d);

    // ---- WebGPU 侧 ----
    const init = await ensureDevice();
    if (!init.available || !device || !navigator.gpu) {
      return { label, ms2d, msGpu: null, note: `GPU 不可用: ${init.reason ?? 'unknown'}` };
    }
    const dev: GPUDevice = device; // 闭包内使用(模块级 let 的收窄不进闭包)
    uncapturedError = ''; // 归因到本 bench:不继承上一 bench 的陈旧错误
    noteParts.push(`adapter=${init.vendor}/${init.architecture}`);

    const texs: GPUTexture[] = [];
    try {
      const t0 = performance.now();
      for (const s of srcs) {
        const t = uploadTexture(s, w, h);
        texs.push(t);
        disposables.push(t);
      }
      await device.queue.onSubmittedWorkDone();
      noteParts.push(`upload=${f(performance.now() - t0)}ms/${texs.length}tex(一次性)`);
    } catch (e) {
      destroyAll(disposables);
      return { label, ms2d, msGpu: null, note: `GPU 上传失败: ${String((e as Error)?.message ?? e)}` };
    }

    const targets = makeTargets(w, h);
    if (typeof targets === 'string') { destroyAll(disposables); return { label, ms2d, msGpu: null, note: targets }; }
    const { gpuCanvas, gctx, r2d } = targets;

    const pipe = getPipeline('composite');
    const samp = getSampler();
    const bgs = texs.map((t) => dev.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: samp }, { binding: 1, resource: t.createView() }],
    }));

    let rig: TimestampRig | null = null;
    if (init.timestampQuery) { try { rig = new TimestampRig(dev, 1); disposables.push(rig); } catch { rig = null; } }
    noteParts.push(rig ? 'renderVia=ts' : 'renderVia=wall');

    const mkPasses = (): FramePass[] => [{
      view: gctx.getCurrentTexture().createView(),
      clear: true,
      bgs, // N 层 = 同一 pass 内 N 次 setBindGroup+draw
    }];

    // 预热:端到端路径(含回传)跑 WARMUP 次
    try {
      for (let i = 0; i < WARMUP; i++) await runFrame({ kind: 'composite', passes: mkPasses(), gpuCanvas, dst2d: r2d, ts: null, transfer: true });
    } catch (e) {
      destroyAll(disposables);
      return { label, ms2d, msGpu: null, note: `GPU 渲染失败: ${String((e as Error)?.message ?? e)}` };
    }
    // 纯渲染基线(不含回传;wall 口径备用):再跑 WARMUP 次
    const renderOnly: number[] = [];
    try {
      for (let i = 0; i < WARMUP; i++) {
        const [wallMs] = await runFrame({ kind: 'composite', passes: mkPasses(), gpuCanvas, dst2d: r2d, ts: null, transfer: false });
        renderOnly.push(wallMs);
      }
    } catch { renderOnly.length = 0; }

    // 正式测量:端到端 ×MEASURE
    const frames: number[] = [];
    const tsFrames: number[] = [];
    try {
      for (let i = 0; i < MEASURE; i++) {
        const [wallMs, tsMs] = await runFrame({ kind: 'composite', passes: mkPasses(), gpuCanvas, dst2d: r2d, ts: rig, transfer: true });
        frames.push(wallMs);
        if (rig && Number.isFinite(tsMs)) tsFrames.push(tsMs);
        if (uncapturedError) break; // 设备已报错,后续帧数据不可信
      }
    } catch (e) {
      destroyAll(disposables);
      return { label, ms2d, msGpu: null, note: `GPU 测量失败: ${String((e as Error)?.message ?? e)}` };
    }

    // 合理性抽查:中心像素 alpha ≈ 1-(1-0.5)^N
    try {
      const px = r2d.getImageData(Math.floor(w / 2), Math.floor(h / 2), 1, 1).data;
      const expect = 1 - Math.pow(1 - LAYER_ALPHA, layers);
      const ok = Math.abs(px[3] / 255 - expect) < 0.15;
      noteParts.push(`sanity=${ok ? 'ok' : `fail(a=${px[3]},expect≈${Math.round(expect * 255)})`}`);
    } catch { noteParts.push('sanity=unreadable'); }

    // 回读成本(独立口径):渲染一帧到自有 COPY_SRC 纹理 → copyTextureToBuffer +
    // mapAsync ×3 取中位;putImageData 一次。注意:canvas swapchain 纹理在当前
    // Chrome/WebView2 上无 COPY_SRC(实测报 usage 校验错),必须经自有纹理中转。
    try {
      const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
      const rb = dev.createBuffer({ size: bytesPerRow * h, usage: U.GPUBufferUsage.COPY_DST | U.GPUBufferUsage.MAP_READ });
      const rbTex = dev.createTexture({
        size: [w, h], format: navigator.gpu.getPreferredCanvasFormat(),
        usage: U.GPUTextureUsage.RENDER_ATTACHMENT | U.GPUTextureUsage.COPY_SRC,
      });
      const rbView = rbTex.createView();
      const rbPipe = getPipeline('composite');
      const rbTimes: number[] = [];
      for (let i = 0; i < 3; i++) {
        const enc = dev.createCommandEncoder();
        const pass = enc.beginRenderPass({
          colorAttachments: [{ view: rbView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
        });
        pass.setPipeline(rbPipe);
        for (const bg of bgs) { pass.setBindGroup(0, bg); pass.draw(3); }
        pass.end();
        enc.copyTextureToBuffer(
          { texture: rbTex },
          { buffer: rb, bytesPerRow, rowsPerImage: h },
          [w, h, 1],
        );
        dev.queue.submit([enc.finish()]);
        const t0 = performance.now();
        await withTimeout(rb.mapAsync(U.GPUMapMode.READ), 5000);
        rb.unmap();
        rbTimes.push(performance.now() - t0);
      }
      rb.destroy();
      rbTex.destroy();
      noteParts.push(`readback=${f(median(rbTimes))}ms(渲染+copy+mapAsync,自有纹理)`);
      const id = r2d.createImageData(w, h);
      const t1 = performance.now();
      r2d.putImageData(id, 0, 0);
      noteParts.push(`putImage=${f(performance.now() - t1)}ms`);
    } catch (e) {
      noteParts.push(`readback=n/a(${String((e as Error)?.message ?? e).slice(0, 60)})`);
    }

    const useTs = !!rig && tsFrames.length > 0;
    noteParts.push(`render=${f(useTs ? median(tsFrames) : median(renderOnly))}ms${useTs ? '' : '(via=wall,不含回传)'}`);
    if (uncapturedError) noteParts.push(`gpuErr=${uncapturedError.slice(0, 200)}`);

    destroyAll(disposables);
    return { label, ms2d, msGpu: median(frames), note: noteParts.join('; ') };
  } catch (e) {
    destroyAll(disposables);
    return { label, ms2d, msGpu: null, note: `GPU 不可用: ${String((e as Error)?.message ?? e)}` };
  }
}

// ---------------------------------------------------------------------------
// 基准 2:卷积类滤镜代表 —— 高斯模糊
// Canvas2D: ctx.filter='blur(8px)'(Skia 内部三迭盒式)vs WebGPU:两趟盒式
// (H/V 两方向 × BOX_ITERS=3 迭代,半径 r/2,σ≈CSS blur,视觉可比,口径见文档)
// ---------------------------------------------------------------------------

export async function benchBlur(w: number, h: number): Promise<BenchResult> {
  const label = `blur ${w}x${h} r=${BLUR_RADIUS_PX}`;
  const noteParts: string[] = [`algo=box x${BOX_ITERS}(H+V 两趟,σ≈CSS blur)`];
  let ms2d = NaN;
  const disposables: { destroy?: () => void }[] = [];
  try {
    // ---- Canvas2D 侧 ----
    const src = makeLayerCanvas(w, h, 42);
    const srcO = document.createElement('canvas');
    srcO.width = w; srcO.height = h;
    const so = srcO.getContext('2d');
    if (!so) throw new Error('2D context unavailable');
    so.drawImage(src, 0, 0);
    so.drawImage(src, 0, 0); // 叠两次 → 近不透明,贴近真实「图层内容模糊」

    const dst = document.createElement('canvas');
    dst.width = w; dst.height = h;
    const c2d = dst.getContext('2d', { willReadFrequently: false });
    if (!c2d) throw new Error('2D context unavailable');
    const loop2d = () => {
      c2d.clearRect(0, 0, w, h);
      c2d.filter = `blur(${BLUR_RADIUS_PX}px)`;
      c2d.drawImage(srcO, 0, 0);
      c2d.filter = 'none';
      c2d.getImageData(0, 0, 1, 1); // 强制栅格化(同 composite 口径)
    };
    for (let i = 0; i < WARMUP; i++) loop2d();
    const t2d: number[] = [];
    for (let i = 0; i < MEASURE; i++) {
      const t0 = performance.now();
      loop2d();
      t2d.push(performance.now() - t0);
    }
    ms2d = median(t2d);

    // ---- WebGPU 侧 ----
    const init = await ensureDevice();
    if (!init.available || !device || !navigator.gpu) {
      return { label, ms2d, msGpu: null, note: `GPU 不可用: ${init.reason ?? 'unknown'}; ${noteParts.join('; ')}` };
    }
    const dev: GPUDevice = device; // 闭包内使用(模块级 let 的收窄不进闭包)
    uncapturedError = ''; // 归因到本 bench

    let srcTex: GPUTexture | null = null;
    try {
      const t0 = performance.now();
      srcTex = uploadTexture(srcO, w, h);
      disposables.push(srcTex);
      await device.queue.onSubmittedWorkDone();
      noteParts.push(`upload=${f(performance.now() - t0)}ms`);
    } catch (e) {
      destroyAll(disposables);
      return { label, ms2d, msGpu: null, note: `GPU 上传失败: ${String((e as Error)?.message ?? e)}` };
    }

    const targets = makeTargets(w, h);
    if (typeof targets === 'string') { destroyAll(disposables); return { label, ms2d, msGpu: null, note: targets }; }
    const { gpuCanvas, gctx, r2d } = targets;

    const texUsages = U.GPUTextureUsage.TEXTURE_BINDING | U.GPUTextureUsage.COPY_DST | U.GPUTextureUsage.RENDER_ATTACHMENT;
    const srcView = srcTex!.createView();
    // ping-pong 中间纹理(格式=canvas 格式,可直接做渲染目标)
    const ppViews: GPUTextureView[] = [];
    for (let i = 0; i < 2; i++) {
      const t = dev.createTexture({ size: [w, h], format: navigator.gpu.getPreferredCanvasFormat(), usage: texUsages });
      disposables.push(t);
      ppViews.push(t.createView());
    }
    const pipe = getPipeline('blur');
    const samp = getSampler();
    const layout = pipe.getBindGroupLayout(0);
    const mkU = (dx: number, dy: number): GPUBuffer => {
      const b = dev.createBuffer({ size: 32, usage: U.GPUBufferUsage.UNIFORM | U.GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(b, 0, new Float32Array([BLUR_RADIUS_PX / 2, dx, dy, 0, 1 / w, 1 / h, 0, 0]));
      disposables.push(b);
      return b;
    };
    const uH = mkU(1, 0);
    const uV = mkU(0, 1);
    const bgOf = (view: GPUTextureView, u: GPUBuffer) => dev.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: samp },
        { binding: 1, resource: view },
        { binding: 2, resource: { buffer: u } },
      ],
    });
    // pass 序列(BOX_ITERS=3 → 6 pass):偶数=H(src|B→A),奇数=V(A→B|最终→canvas)
    const nPass = BOX_ITERS * 2;
    const inputViews: GPUTextureView[] = [];
    const uniforms: GPUBuffer[] = [];
    for (let i = 0; i < nPass; i++) {
      const even = i % 2 === 0;
      inputViews.push(even ? (i === 0 ? srcView : ppViews[1]) : ppViews[0]);
      uniforms.push(even ? uH : uV);
    }
    const bgs = inputViews.map((v, i) => bgOf(v, uniforms[i]));
    const passTarget = (i: number, canvasView: GPUTextureView): GPUTextureView =>
      i % 2 === 0 ? ppViews[0] : (i === nPass - 1 ? canvasView : ppViews[1]);
    const mkPasses = (): FramePass[] => {
      const canvasView = gctx.getCurrentTexture().createView();
      return bgs.map((bg, i) => ({ view: passTarget(i, canvasView), clear: true, bgs: [bg] }));
    };

    let rig: TimestampRig | null = null;
    if (init.timestampQuery) { try { rig = new TimestampRig(dev, nPass); disposables.push(rig); } catch { rig = null; } }

    // 预热(端到端)
    try {
      for (let i = 0; i < WARMUP; i++) await runFrame({ kind: 'blur', passes: mkPasses(), gpuCanvas, dst2d: r2d, ts: null, transfer: true });
    } catch (e) {
      destroyAll(disposables);
      return { label, ms2d, msGpu: null, note: `GPU 渲染失败: ${String((e as Error)?.message ?? e)}` };
    }
    // 纯渲染基线(不含回传)
    const renderOnly: number[] = [];
    try {
      for (let i = 0; i < WARMUP; i++) {
        const [wallMs] = await runFrame({ kind: 'blur', passes: mkPasses(), gpuCanvas, dst2d: r2d, ts: null, transfer: false });
        renderOnly.push(wallMs);
      }
    } catch { renderOnly.length = 0; }

    const frames: number[] = [];
    const tsFrames: number[] = [];
    try {
      for (let i = 0; i < MEASURE; i++) {
        const [wallMs, tsMs] = await runFrame({ kind: 'blur', passes: mkPasses(), gpuCanvas, dst2d: r2d, ts: rig, transfer: true });
        frames.push(wallMs);
        if (rig && Number.isFinite(tsMs)) tsFrames.push(tsMs);
        if (uncapturedError) break; // 设备已报错,后续帧数据不可信
      }
    } catch (e) {
      destroyAll(disposables);
      return { label, ms2d, msGpu: null, note: `GPU 测量失败: ${String((e as Error)?.message ?? e)}` };
    }

    try {
      const px = r2d.getImageData(Math.floor(w / 2), Math.floor(h / 2), 1, 1).data;
      noteParts.push(`sanity=${px[3] > 0 ? 'ok' : `fail(a=${px[3]})`}`);
    } catch { noteParts.push('sanity=unreadable'); }

    const useTs = !!rig && tsFrames.length > 0;
    noteParts.push(`render=${f(useTs ? median(tsFrames) : median(renderOnly))}ms${useTs ? `(ts,${nPass} pass)` : `(via=wall,${nPass} pass,不含回传)`}`);
    if (uncapturedError) noteParts.push(`gpuErr=${uncapturedError.slice(0, 200)}`);

    destroyAll(disposables);
    return { label, ms2d, msGpu: median(frames), note: noteParts.join('; ') };
  } catch (e) {
    destroyAll(disposables);
    return { label, ms2d, msGpu: null, note: `GPU 不可用: ${String((e as Error)?.message ?? e)}; ${noteParts.join('; ')}` };
  }
}
