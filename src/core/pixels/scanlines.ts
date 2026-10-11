// CRT 扫描线滤镜,自 Swift/C 内核转译:
//  - 水平暗带:lineSpacing 周期 + thickness% 亮带占空比,smoothness 在硬条纹与
//    正弦渐变间插值,blackLevel 为暗带亮度下限;
//  - 点状遮罩 (dots%):x 向同款调制,强度按 dots 混合;
//  - wobble:逐行正弦水平偏移(相位 = 行号,幅度 wobble px);
//  - displace + split:整体水平 RGB 位移,红/蓝向相反两侧分离 split px 产生色散 fringe;
//  - threshold:先按阈值二值化源亮度再着色;density/contrast 前置预调;
//  - colorMode: blackWhite/twoColors 按色调混合 colorA→colorB,original 保留原色;
//  - 辉光:σ = spacing*3+3 的高斯在 1/4 尺度用 box×3 近似,双线性放大后
//    × glow/100×2.5 加回并截断。
// 就地修改 ImageData,alpha 通道保持原样。

import { clamp, ctx2dRead, makeCanvas } from '../canvasUtils';

export interface ScanlinesSettings {
  /** 2..32,默认 4:扫描线周期(px)。 */
  lineSpacing: number;
  /** 5..100(%),默认 70:亮带占周期比例。 */
  thickness: number;
  /** 0..100:辉光强度。 */
  glow: number;
  /** 0..100:点状遮罩强度。 */
  dots: number;
  /** 0..64(px):逐行正弦水平抖动幅度。 */
  wobble: number;
  /** -100..100(px):整体水平 RGB 位移。 */
  displace: number;
  /** 0..100(%),默认 50:硬条纹 ↔ 正弦着色混合。 */
  smoothness: number;
  /** 0..100(%):源亮度二值化阈值(0 = 关闭)。 */
  threshold: number;
  /** 0..16(px):红/蓝分离宽度。 */
  split: number;
  /** -100..100 / -100..100:密度与对比度预调。 */
  density: number;
  contrast: number;
  /** 0..100(%):暗带亮度下限。 */
  blackLevel: number;
  colorMode: 'blackWhite' | 'twoColors' | 'original';
  colorA: string;
  colorB: string;
}

type RGB = [number, number, number];

export function applyScanlines(img: ImageData, s: ScanlinesSettings): void {
  const w = img.width, h = img.height;
  if (w <= 0 || h <= 0) return;
  const d = img.data;
  const np = w * h;

  const spacing = Math.max(1, Math.round(clamp(s.lineSpacing, 2, 32)));
  const thick = clamp(s.thickness, 5, 100) / 100;
  const glow = clamp(s.glow, 0, 100);
  const dots = clamp(s.dots, 0, 100) / 100;
  const wobble = clamp(s.wobble, 0, 64);
  const displace = clamp(s.displace, -100, 100);
  const smooth = clamp(s.smoothness, 0, 100) / 100;
  const threshold = clamp(s.threshold, 0, 100);
  const split = clamp(s.split, 0, 16);
  const slope = (1 + clamp(s.density, -100, 100) / 100) * contrastFactor(clamp(s.contrast, -100, 100));
  const blackLevel = clamp(s.blackLevel, 0, 100) / 100;
  const colA = parseCssColor(s.colorA);
  const colB = parseCssColor(s.colorB);
  const keepChroma = s.colorMode === 'original';

  // 1. 预调 (density/contrast) + 阈值二值化 + 双色重映射
  const base = new Float32Array(np * 3);
  const th = threshold * 2.55;
  for (let i = 0, p = 0; i < d.length; i += 4, p += 3) {
    let r = clamp((d[i] - 128) * slope + 128, 0, 255);
    let g = clamp((d[i + 1] - 128) * slope + 128, 0, 255);
    let b = clamp((d[i + 2] - 128) * slope + 128, 0, 255);
    if (threshold > 0) {
      const v = (0.299 * r + 0.587 * g + 0.114 * b) < th ? 0 : 255;
      r = v; g = v; b = v;
    }
    if (keepChroma) {
      base[p] = r; base[p + 1] = g; base[p + 2] = b;
    } else {
      const t = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      base[p] = colA[0] + (colB[0] - colA[0]) * t;
      base[p + 1] = colA[1] + (colB[1] - colA[1]) * t;
      base[p + 2] = colA[2] + (colB[2] - colA[2]) * t;
    }
  }

  // 2. wobble + displace + split:逐行水平双线性重采样
  const shifted = new Float32Array(np * 3);
  const offR = displace + split / 2; // 红向右
  const offB = displace - split / 2; // 蓝向左(相反一侧 fringe)
  for (let y = 0; y < h; y++) {
    const row = y * w * 3;
    const wob = Math.sin(y) * wobble; // 相位 = 行号
    for (let x = 0; x < w; x++) {
      const p = row + x * 3;
      shifted[p] = sampleH(base, row, x - wob - offR, w);
      shifted[p + 1] = sampleH(base, row, x - wob - displace, w);
      shifted[p + 2] = sampleH(base, row, x - wob - offB, w);
    }
  }

  // 3. 扫描线暗带 + 点遮罩 + 黑电平底
  const shaded = new Float32Array(np * 3);
  for (let y = 0; y < h; y++) {
    const bandY = shadeAt((y % spacing) / spacing, thick, smooth, blackLevel);
    for (let x = 0; x < w; x++) {
      let shade = bandY;
      if (dots > 0) shade *= 1 - dots * (1 - shadeAt((x % spacing) / spacing, thick, smooth, blackLevel));
      const p = (y * w + x) * 3;
      shaded[p] = shifted[p] * shade;
      shaded[p + 1] = shifted[p + 1] * shade;
      shaded[p + 2] = shifted[p + 2] * shade;
    }
  }

  // 4. 辉光:1/4 尺度 box×3 ≈ 高斯 (σ = spacing*3+3),放大后按 glow/100×2.5 加回
  let glowAdd: Float32Array | null = null;
  const glowAmt = (glow / 100) * 2.5;
  if (glow > 0) {
    const qw = Math.max(1, Math.ceil(w / 4)), qh = Math.max(1, Math.ceil(h / 4));
    const q = new Float32Array(qw * qh * 3);
    for (let qy = 0; qy < qh; qy++) {
      const y0 = qy * 4, y1 = Math.min(h, y0 + 4);
      for (let qx = 0; qx < qw; qx++) {
        const x0 = qx * 4, x1 = Math.min(w, x0 + 4);
        let r = 0, g = 0, b = 0, cnt = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const p = (y * w + x) * 3;
            r += shaded[p]; g += shaded[p + 1]; b += shaded[p + 2];
            cnt++;
          }
        }
        const q3 = (qy * qw + qx) * 3;
        q[q3] = r / cnt; q[q3 + 1] = g / cnt; q[q3 + 2] = b / cnt;
      }
    }
    boxBlurRGB(q, qw, qh, boxRadiusFor((spacing * 3 + 3) / 4));
    // 双线性放大回全尺寸
    glowAdd = new Float32Array(np * 3);
    for (let y = 0; y < h; y++) {
      const gy = clamp((y + 0.5) / 4 - 0.5, 0, qh - 1);
      const gy0 = Math.floor(gy), gy1 = Math.min(qh - 1, gy0 + 1), fy = gy - gy0;
      for (let x = 0; x < w; x++) {
        const gx = clamp((x + 0.5) / 4 - 0.5, 0, qw - 1);
        const gx0 = Math.floor(gx), gx1 = Math.min(qw - 1, gx0 + 1), fx = gx - gx0;
        const p = (y * w + x) * 3;
        for (let c = 0; c < 3; c++) {
          const v00 = q[(gy0 * qw + gx0) * 3 + c], v10 = q[(gy0 * qw + gx1) * 3 + c];
          const v01 = q[(gy1 * qw + gx0) * 3 + c], v11 = q[(gy1 * qw + gx1) * 3 + c];
          glowAdd[p + c] = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
        }
      }
    }
  }

  // 5. 写回(Uint8ClampedArray 自动截断,alpha 不动)
  for (let i = 0, p = 0; i < d.length; i += 4, p += 3) {
    d[i] = shaded[p] + (glowAdd ? glowAdd[p] * glowAmt : 0);
    d[i + 1] = shaded[p + 1] + (glowAdd ? glowAdd[p + 1] * glowAmt : 0);
    d[i + 2] = shaded[p + 2] + (glowAdd ? glowAdd[p + 2] * glowAmt : 0);
  }
}

// ---------------------------------------------------------------- 辅助

/** 相位 ∈ [0,1):硬条纹与余弦渐变按 smooth 混合,再抬到 blackLevel 下限之上。 */
function shadeAt(phase: number, thick: number, smooth: number, floor: number): number {
  const stripe = phase < thick ? 1 : 0;
  const sine = 0.5 + 0.5 * Math.cos(phase * 2 * Math.PI);
  const s = stripe * (1 - smooth) + sine * smooth;
  return floor + s * (1 - floor);
}

/** 行内水平双线性采样(row = 该行在 buf 中的字节偏移)。 */
function sampleH(buf: Float32Array, row: number, x: number, w: number): number {
  const fx = clamp(x, 0, w - 1);
  const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), f = fx - x0;
  return buf[row + x0 * 3] * (1 - f) + buf[row + x1 * 3] * f;
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

/** 3 次盒式模糊近似高斯:每 pass 宽度 k 满足 3·(k²-1)/12 ≈ σ²。 */
function boxRadiusFor(sigma: number): number {
  if (sigma <= 0) return 0;
  const width = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  return Math.max(1, Math.round((width - 1) / 2));
}

/** RGB 交错缓冲的 3 遍可分离盒式模糊(滑动窗口累加)。 */
function boxBlurRGB(buf: Float32Array, w: number, h: number, radius: number): void {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return;
  for (let pass = 0; pass < 3; pass++) {
    boxBlurAxis(buf, w, h, r, true);
    boxBlurAxis(buf, w, h, r, false);
  }
}

function boxBlurAxis(buf: Float32Array, w: number, h: number, r: number, horizontal: boolean): void {
  const len = horizontal ? w : h;
  const rr = Math.min(r, Math.max(0, len - 1));
  if (rr === 0) return;
  const dst = new Float32Array(buf.length);
  const win = 2 * rr + 1;
  const stride = horizontal ? 3 : w * 3; // 沿采样轴的元素间距
  const lines = horizontal ? h : w;
  for (let li = 0; li < lines; li++) {
    const base = horizontal ? li * w * 3 : li * 3;
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -rr; k <= rr; k++) {
        acc += buf[base + clamp(k, 0, len - 1) * stride + c];
      }
      for (let x = 0; x < len; x++) {
        dst[base + x * stride + c] = acc / win;
        acc += buf[base + clamp(x + rr + 1, 0, len - 1) * stride + c]
             - buf[base + clamp(x - rr, 0, len - 1) * stride + c];
      }
    }
  }
  buf.set(dst);
}
