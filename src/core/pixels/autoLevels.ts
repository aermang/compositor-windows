// 自动色阶端点计算,自 Swift/C 内核转译:
// 每通道 256-bin 直方图,端点取 0.1% 双侧截断 (累计像素数首次超过 total*0.001 的 bin)。
//  - contrast:三通道共用同一区间,black = min(各通道低点)、white = max(各通道高点),写入 rgb 槽;
//  - color:按通道各自取端点 (rgb 槽填亮度直方图的端点);
//  - colorNeutral:在 color 基础上按通道求 gamma = log(mean)/log(0.5),夹在 0.1..9.99,
//    其中 mean 为端点重映射 (black..white → 0..1) 后的平均亮度。

export type AutoLevelsMode = 'contrast' | 'color' | 'colorNeutral';

export interface LevelEndpoints {
  black: number;
  white: number;
}

export interface AutoLevelsResult {
  /** contrast 模式为三通道共享区间,其余模式为亮度直方图区间。 */
  rgb: LevelEndpoints;
  /** R/G/B 三通道各自的端点。 */
  channels: LevelEndpoints[];
  /** colorNeutral 模式给出各通道 gamma,其余模式为 [1, 1, 1]。 */
  gammas: number[];
}

/** 双侧截断比例:0.1% 。 */
const CLIP_RATIO = 0.001;

export function autoLevelsEndpoints(img: ImageData, mode: AutoLevelsMode): AutoLevelsResult {
  const total = img.width * img.height;
  if (total <= 0) throw new Error('图像为空,无法计算自动色阶端点');

  const d = img.data;
  const bins: Uint32Array[] = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const lumaBins = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    bins[0][r]++;
    bins[1][g]++;
    bins[2][b]++;
    lumaBins[Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b))]++;
  }

  const clip = total * CLIP_RATIO;
  const channels: LevelEndpoints[] = [
    percentileEndpoints(bins[0], clip),
    percentileEndpoints(bins[1], clip),
    percentileEndpoints(bins[2], clip),
  ];

  const rgb: LevelEndpoints = mode === 'contrast'
    ? {
        black: Math.min(channels[0].black, channels[1].black, channels[2].black),
        white: Math.max(channels[0].white, channels[1].white, channels[2].white),
      }
    : percentileEndpoints(lumaBins, clip);

  const gammas: number[] = mode === 'colorNeutral'
    ? [
        channelGamma(bins[0], total, channels[0].black, channels[0].white),
        channelGamma(bins[1], total, channels[1].black, channels[1].white),
        channelGamma(bins[2], total, channels[2].black, channels[2].white),
      ]
    : [1, 1, 1];

  return { rgb, channels, gammas };
}

/** 低端点 = 累计计数首次超过 clip 的 bin;高端点自顶向下对称求解。 */
function percentileEndpoints(bins: Uint32Array, clip: number): LevelEndpoints {
  let cum = 0;
  let black = 0;
  for (let i = 0; i < 256; i++) {
    cum += bins[i];
    if (cum > clip) { black = i; break; }
  }
  cum = 0;
  let white = 255;
  for (let i = 255; i >= 0; i--) {
    cum += bins[i];
    if (cum > clip) { white = i; break; }
  }
  if (white <= black) white = Math.min(255, black + 1); // 平坦直方图防退化
  return { black, white };
}

/** 端点重映射后的通道均值 → gamma = log(mean)/log(0.5),夹在 0.1..9.99。 */
function channelGamma(bins: Uint32Array, total: number, black: number, white: number): number {
  const lo = black / 255;
  const span = Math.max(1 / 255, (white - black) / 255);
  let mean = 0;
  for (let i = 0; i < 256; i++) {
    const c = bins[i];
    if (c === 0) continue;
    const v = Math.min(1, Math.max(0, (i / 255 - lo) / span));
    mean += (v * c) / total;
  }
  if (mean <= 0) return 9.99; // 全黑:最大提亮
  if (mean >= 1) return 0.1; // 全白:最大压暗
  const gamma = Math.log(mean) / Math.log(0.5);
  return Math.min(9.99, Math.max(0.1, gamma));
}
