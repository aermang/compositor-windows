// 抖动 / 网屏 / ASCII 像素滤镜,自 Swift/C 内核转译:
//  - Atkinson(1/8 误差扩散至 6 邻域)与 Floyd–Steinberg(7/16、3/16、5/16、1/16,
//    误差按 diffusion/100 缩放),量化到 levels 级;
//  - Bayer 2/4/8 有序抖动阈值矩阵,及 Mac 经典 4×4 聚集点 (clustered dot) 图案;
//  - 旋转网格半色调:圆点 / 线条 / 菱形,mark 尺寸 ∝ 单元格暗度,二值输出,
//    lightOnDark 翻转极性;
//  - ASCII 字符画:等宽粗体字形经离屏 canvas 预栅格化,按墨量升序排序,
//    cell = textSize px(跳过 pixelSize 降采样)。
// 流程:可选 pixelSize 盒式高质量降采样 → density/contrast 预调 → 按风格抖动 →
// 最近邻放大写回。colorMode: blackWhite/twoColors 用 colorA→colorB 按色调混合,
// original 仅量化亮度并保留原像素色度。就地修改 ImageData,alpha 通道保持原样。

import { clamp, ctx2dRead, makeCanvas } from '../canvasUtils';

export interface DitherSettings {
  style:
    | 'atkinson' | 'floydSteinberg'
    | 'bayer2' | 'bayer4' | 'bayer8'
    | 'halftoneDots' | 'halftoneLines' | 'halftoneDiamonds'
    | 'macPatterns' | 'ascii';
  /** 2..8,量化色阶数。 */
  levels: number;
  /** 0..100,Floyd–Steinberg 误差缩放比例。 */
  diffusion: number;
  /** 4..64,半色调单元格边长(小图分辨率下)。 */
  cellSize: number;
  /** -90..90,半色调网格旋转角(度)。 */
  angle: number;
  /** 1..32,前置盒式降采样因子(ASCII 忽略)。 */
  pixelSize: number;
  /** 6..64,ASCII 单元格边长。 */
  textSize: number;
  /** -100..100,密度(绕 128 的斜率调整)。 */
  density: number;
  /** -100..100,对比度。 */
  contrast: number;
  /** mark 风格的二值极性翻转。 */
  lightOnDark: boolean;
  colorMode: 'blackWhite' | 'twoColors' | 'original';
  colorA: string;
  colorB: string;
}

type RGB = [number, number, number];

export function applyDither(img: ImageData, s: DitherSettings): void {
  const w = img.width, h = img.height;
  if (w <= 0 || h <= 0) return;
  const d = img.data;

  const style = s.style;
  const levels = Math.round(clamp(s.levels, 2, 8));
  const diffusion = clamp(s.diffusion, 0, 100) / 100;
  const cellSize = Math.max(1, Math.round(clamp(s.cellSize, 4, 64)));
  const rad = (clamp(s.angle, -90, 90) * Math.PI) / 180;
  const density = clamp(s.density, -100, 100) / 100;
  const contrastF = contrastFactor(clamp(s.contrast, -100, 100));
  const colA = parseCssColor(s.colorA);
  const colB = parseCssColor(s.colorB);
  const keepChroma = s.colorMode === 'original';
  const isAscii = style === 'ascii';

  // 1. 可选降采样(ASCII 按原分辨率处理,cell 自带 gridSize)
  const ps = isAscii ? 1 : Math.round(clamp(s.pixelSize, 1, 32));
  let sw = w, sh = h;
  let src: Uint8ClampedArray = d;
  if (ps > 1) {
    sw = Math.ceil(w / ps);
    sh = Math.ceil(h / ps);
    src = boxDownsample(d, w, h, ps, sw, sh);
  }
  const n = sw * sh;

  // 2. 亮度 + density/contrast 预调 + lightOnDark 极性
  const tone = new Float32Array(n); // 0 = 暗端(着墨/A 色),255 = 亮端(B 色)
  const chroma = keepChroma ? new Float32Array(n * 3) : null;
  const slope = (1 + density) * contrastF;
  for (let i = 0; i < n; i++) {
    const r = src[i * 4], g = src[i * 4 + 1], b = src[i * 4 + 2];
    const lumaRaw = src[i * 4 + 3] === 0 ? 255 : 0.299 * r + 0.587 * g + 0.114 * b;
    const luma = clamp((lumaRaw - 128) * slope + 128, 0, 255);
    tone[i] = s.lightOnDark ? 255 - luma : luma;
    if (chroma) {
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      chroma[i * 3] = r - l;
      chroma[i * 3 + 1] = g - l;
      chroma[i * 3 + 2] = b - l;
    }
  }

  // 3. 按风格生成结果层
  if (isAscii) {
    renderAscii(img, tone, chroma, colA, colB, Math.max(4, Math.round(clamp(s.textSize, 6, 64))));
    return;
  }

  const out = new Uint8ClampedArray(n * 3);
  if (style === 'atkinson' || style === 'floydSteinberg') {
    const q = errorDiffuse(tone, sw, sh, levels, diffusion, style === 'atkinson');
    for (let i = 0; i < n; i++) mixTone(out, i * 3, q[i] / 255, colA, colB, chroma, i);
  } else if (style === 'bayer2' || style === 'bayer4' || style === 'bayer8' || style === 'macPatterns') {
    const mat = style === 'macPatterns'
      ? MAC_PATTERN
      : bayerMatrix(style === 'bayer2' ? 2 : style === 'bayer4' ? 4 : 8);
    const q = orderedDither(tone, sw, sh, mat, Math.round(Math.sqrt(mat.length)), levels);
    for (let i = 0; i < n; i++) mixTone(out, i * 3, q[i] / 255, colA, colB, chroma, i);
  } else {
    const kind: 'dots' | 'lines' | 'diamonds' =
      style === 'halftoneLines' ? 'lines' : style === 'halftoneDiamonds' ? 'diamonds' : 'dots';
    const ink = halftoneInk(tone, sw, sh, cellSize, rad, kind);
    for (let i = 0; i < n; i++) mixTone(out, i * 3, ink[i] ? 0 : 1, colA, colB, chroma, i);
  }

  // 4. 最近邻放大写回(alpha 保持原图)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / w));
      const si = (sy * sw + sx) * 3, di = (y * w + x) * 4;
      d[di] = out[si];
      d[di + 1] = out[si + 1];
      d[di + 2] = out[si + 2];
    }
  }
}

// ---------------------------------------------------------------- 色彩/色调辅助

/** t=0 → colorA(墨),t=1 → colorB(纸);original 模式叠加原像素色度。 */
function mixTone(
  out: Uint8ClampedArray, o: number, t: number,
  a: RGB, b: RGB, chroma: Float32Array | null, ci: number,
): void {
  for (let c = 0; c < 3; c++) {
    let v = a[c] + (b[c] - a[c]) * t;
    if (chroma) v += chroma[ci * 3 + c];
    out[o + c] = v;
  }
}

/** -100..100 → 经典 259 法则对比度斜率。 */
function contrastFactor(contrast100: number): number {
  const c = contrast100 * 2.55; // -255..255
  return (259 * (c + 255)) / (255 * (259 - c));
}

/** 解析 CSS 颜色:#hex 短路,其余交给 canvas 归一化;失败抛中文错误。 */
function parseCssColor(spec: string): RGB {
  const t = spec.trim();
  const m = /^#([0-9a-fA-F]{3,8})$/.exec(t);
  if (m) {
    const hx = m[1];
    const full = hx.length === 3 || hx.length === 4
      ? hx.split('').map(ch => ch + ch).join('')
      : hx;
    if (full.length === 6 || full.length === 8) {
      const r = parseInt(full.slice(0, 2), 16);
      const g = parseInt(full.slice(2, 4), 16);
      const b = parseInt(full.slice(4, 6), 16);
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) return [r, g, b];
    }
  }
  const c = makeCanvas(1, 1);
  const ctx = ctx2dRead(c);
  ctx.fillStyle = 'rgba(4,7,9,0.789)'; // 哨兵色:正常输入归一化后不会与之相同
  const sentinel = ctx.fillStyle;
  ctx.fillStyle = t;
  if (ctx.fillStyle === sentinel && t !== sentinel) {
    throw new Error(`无法识别的颜色值: ${spec}`);
  }
  ctx.fillRect(0, 0, 1, 1);
  const px = ctx.getImageData(0, 0, 1, 1).data;
  return [px[0], px[1], px[2]];
}

// ---------------------------------------------------------------- 降采样

/** 高质量盒式平均降采样(边界块按实际像素数归一)。 */
function boxDownsample(
  src: Uint8ClampedArray, w: number, h: number, ps: number, sw: number, sh: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(sw * sh * 4);
  for (let sy = 0; sy < sh; sy++) {
    const y0 = sy * ps, y1 = Math.min(h, y0 + ps);
    for (let sx = 0; sx < sw; sx++) {
      const x0 = sx * ps, x1 = Math.min(w, x0 + ps);
      let r = 0, g = 0, b = 0, a = 0, cnt = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3];
          cnt++;
        }
      }
      const o = (sy * sw + sx) * 4;
      out[o] = r / cnt; out[o + 1] = g / cnt; out[o + 2] = b / cnt; out[o + 3] = a / cnt;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 误差扩散

/** 误差扩散:atkinson 传 6 邻域 ×1/8;FS 四邻域权重 ×diffusion(仅 FS 缩放)。 */
function errorDiffuse(
  tone: Float32Array, w: number, h: number, levels: number, diffusion: number, atkinson: boolean,
): Float32Array {
  const buf = Float32Array.from(tone);
  const out = new Float32Array(tone.length);
  const step = 255 / (levels - 1);
  const errScale = atkinson ? 1 : diffusion;
  const taps: Array<readonly [number, number, number]> = atkinson
    ? [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]]
    : [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = clamp(buf[i], 0, 255);
      const q = clamp(Math.round(v / step) * step, 0, 255);
      out[i] = q;
      const err = (v - q) * errScale;
      for (const [dx, dy, wt] of taps) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny >= h) continue;
        buf[ny * w + nx] += err * wt;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 有序抖动

/** 递归构造 Bayer 阈值矩阵(扁平数组,长度 = size*size,值域 0..size²-1)。 */
function bayerMatrix(size: 2 | 4 | 8): number[] {
  let m = [0];
  while (m.length < size) {
    const s = m.length;
    const r = new Array<number>(s * 2 * s * 2);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const v = m[y * s + x] * 4;
        r[(2 * y) * (2 * s) + 2 * x] = v;
        r[(2 * y) * (2 * s) + 2 * x + 1] = v + 2;
        r[(2 * y + 1) * (2 * s) + 2 * x] = v + 3;
        r[(2 * y + 1) * (2 * s) + 2 * x + 1] = v + 1;
      }
    }
    m = r;
  }
  return m;
}

/** Mac 经典 4×4 聚集点图案(自中心向外生长,近似 classic Mac 50% 网屏)。 */
const MAC_PATTERN: number[] = [
  12, 5, 6, 13,
  4, 0, 1, 7,
  11, 3, 2, 14,
  15, 8, 9, 10,
];

/** 有序抖动:阈值 u∈(0,1) 在一个量化步长内扰动后取整。 */
function orderedDither(
  tone: Float32Array, w: number, h: number, mat: number[], m: number, levels: number,
): Float32Array {
  const step = 255 / (levels - 1);
  const out = new Float32Array(tone.length);
  for (let y = 0; y < h; y++) {
    const my = (y % m) * m;
    for (let x = 0; x < w; x++) {
      const u = (mat[my + (x % m)] + 0.5) / (m * m);
      const v = tone[y * w + x] + (u - 0.5) * step;
      out[y * w + x] = clamp(Math.round(v / step) * step, 0, 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 半色调

/** 旋转网格半色调:第一遍按旋转单元格累加平均墨量,第二遍逐像素判定 mark 覆盖。 */
function halftoneInk(
  tone: Float32Array, w: number, h: number, cell: number, rad: number,
  kind: 'dots' | 'lines' | 'diamonds',
): Uint8Array {
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cellKey = (iu: number, iv: number): number =>
    (iu + (1 << 20)) * (1 << 21) + (iv + (1 << 20));

  const cells = new Map<number, { sum: number; cnt: number }>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const iu = Math.floor((x * cos + y * sin) / cell);
      const iv = Math.floor((-x * sin + y * cos) / cell);
      const k = cellKey(iu, iv);
      let e = cells.get(k);
      if (!e) { e = { sum: 0, cnt: 0 }; cells.set(k, e); }
      e.sum += 1 - tone[y * w + x] / 255;
      e.cnt++;
    }
  }

  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = (x * cos + y * sin) / cell;
      const v = (-x * sin + y * cos) / cell;
      const e = cells.get(cellKey(Math.floor(u), Math.floor(v)));
      const cov = e ? e.sum / e.cnt : 0; // 单元格墨量覆盖率 0..1
      const fu = u - Math.floor(u), fv = v - Math.floor(v);
      let ink: boolean;
      if (kind === 'dots') {
        // 圆点面积 = πr² = cov → r = sqrt(cov/π)(单元格单位)
        ink = Math.hypot(fu - 0.5, fv - 0.5) <= Math.sqrt(cov / Math.PI);
      } else if (kind === 'lines') {
        // 沿 u 向线条,带厚 = cov 个单元格
        ink = Math.min(fv, 1 - fv) <= cov / 2;
      } else {
        // 菱形面积 = 2k² = cov → k = sqrt(cov/2)
        ink = Math.abs(fu - 0.5) + Math.abs(fv - 0.5) <= Math.sqrt(cov / 2);
      }
      out[i] = ink ? 1 : 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------- ASCII

const ASCII_RAMP = ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';

interface AsciiGlyph {
  cov: number; // 0..1 墨量覆盖
  ink: Uint8Array; // cell×cell 二值位图
}

/** 等宽粗体字形离屏栅格化,按墨量升序。 */
function buildAsciiGlyphs(cell: number): AsciiGlyph[] {
  const cv = makeCanvas(cell, cell);
  const g = ctx2dRead(cv);
  g.fillStyle = '#000';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold ${Math.max(1, Math.round(cell * 0.9))}px monospace`;
  const glyphs: AsciiGlyph[] = [];
  for (const ch of ASCII_RAMP) {
    g.clearRect(0, 0, cell, cell);
    g.fillText(ch, cell / 2, cell / 2);
    const px = g.getImageData(0, 0, cell, cell).data;
    const ink = new Uint8Array(cell * cell);
    let cov = 0;
    for (let i = 0; i < ink.length; i++) {
      const a = px[i * 4 + 3]; // 透明底上黑字:alpha 即墨量
      ink[i] = a >= 128 ? 1 : 0;
      cov += a / 255;
    }
    glyphs.push({ cov: cov / (cell * cell), ink });
  }
  glyphs.sort((a, b) => a.cov - b.cov);
  return glyphs;
}

/** 升序覆盖序列中二分查找与 target 最接近的字形。 */
function pickGlyph(glyphs: AsciiGlyph[], target: number): AsciiGlyph {
  let lo = 0, hi = glyphs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (glyphs[mid].cov < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(glyphs[lo - 1].cov - target) < Math.abs(glyphs[lo].cov - target)) lo--;
  return glyphs[lo];
}

/** 全分辨率逐 cell 渲染 ASCII:cell 平均墨量选字形,二值上色(原色度可选叠加)。 */
function renderAscii(
  img: ImageData, tone: Float32Array, chroma: Float32Array | null, colA: RGB, colB: RGB, cell: number,
): void {
  const w = img.width, h = img.height, d = img.data;
  const glyphs = buildAsciiGlyphs(cell);
  for (let cy = 0; cy * cell < h; cy++) {
    const y0 = cy * cell, y1 = Math.min(h, y0 + cell);
    for (let cx = 0; cx * cell < w; cx++) {
      const x0 = cx * cell, x1 = Math.min(w, x0 + cell);
      let inkSum = 0, cnt = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          inkSum += 1 - tone[y * w + x] / 255;
          cnt++;
        }
      }
      const glyph = pickGlyph(glyphs, cnt > 0 ? inkSum / cnt : 0);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const t = glyph.ink[(y - y0) * cell + (x - x0)] ? 0 : 1;
          const di = (y * w + x) * 4, ti = y * w + x;
          d[di] = colA[0] + (colB[0] - colA[0]) * t + (chroma ? chroma[ti * 3] : 0);
          d[di + 1] = colA[1] + (colB[1] - colA[1]) * t + (chroma ? chroma[ti * 3 + 1] : 0);
          d[di + 2] = colA[2] + (colB[2] - colA[2]) * t + (chroma ? chroma[ti * 3 + 2] : 0);
        }
      }
    }
  }
}
