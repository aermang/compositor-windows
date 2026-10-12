// Creative adjustments (自然饱和度/通道混合器/照片滤镜/阴影-高光): pure pixel
// kernels applied to an ImageData buffer in place. Signatures are frozen
// (commands.ts dispatches to them). All kernels skip fully transparent pixels
// (alpha=0, RGB meaningless there) and leave alpha untouched; output clamping
// comes from Uint8ClampedArray assignment.

/** vibrance: 饱和度提升,低饱和像素增益更大(vibrance 0-100)+ 全局饱和度
 *  (saturation -100..100)。原地修改。 */
export function vibranceApply(
  data: Uint8ClampedArray, _w: number, vibrance: number, saturation: number,
): void {
  void _w;
  const vAmt = vibrance / 100;
  const sAmt = saturation / 100;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const L = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = (mx - mn) / 255;
    const amt = vAmt * (1 - sat) + sAmt;
    const scale = 1 + amt;
    data[i] = L + (r - L) * scale;
    data[i + 1] = L + (g - L) * scale;
    data[i + 2] = L + (b - L) * scale;
  }
}

/** channel mixer: 9 个输出系数(redFromRed 等 -200..200,100=不变)。输出
 *  out_R = (redFromRed*r + redFromGreen*g + redFromBlue*b)/100,clamp 0-255。
 *  缺省系数 = 恒等阵(对角线 100)。 */
export function channelMixerApply(
  data: Uint8ClampedArray, params: Record<string, number | boolean>,
): void {
  const coef = (key: string, dflt: number) => {
    const v = Number(params[key]);
    return (Number.isFinite(v) ? v : dflt) / 100;
  };
  const rr = coef('redFromRed', 100), rg = coef('redFromGreen', 0), rb = coef('redFromBlue', 0);
  const gr = coef('greenFromRed', 0), gg = coef('greenFromGreen', 100), gb = coef('greenFromBlue', 0);
  const br = coef('blueFromRed', 0), bg = coef('blueFromGreen', 0), bb = coef('blueFromBlue', 100);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    data[i] = rr * r + rg * g + rb * b;
    data[i + 1] = gr * r + gg * g + gb * b;
    data[i + 2] = br * r + bg * g + bb * b;
  }
}

/** photo filter: warmth -100(冷,蓝)…100(暖,橙),density 0-100 强度。
 *  k = density/100 * |warmth|/100;c' = c*(1-k) + filterColor*k。 */
export function photoFilterApply(
  data: Uint8ClampedArray, warmth: number, density: number,
): void {
  const k = (density / 100) * (Math.abs(warmth) / 100);
  const warm = warmth >= 0;
  const fr = warm ? 255 : 70;
  const fg = warm ? 150 : 130;
  const fb = warm ? 60 : 255;
  const inv = 1 - k;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    data[i] = data[i] * inv + fr * k;
    data[i + 1] = data[i + 1] * inv + fg * k;
    data[i + 2] = data[i + 2] * inv + fb * k;
  }
}

/** shadow/highlight: shadows 0-100 提亮暗部,highlights 0-100 压暗亮部
 *  (亮度掩码加权;三通道同加 delta,亮度域统一位移避免偏色,原地修改)。 */
export function shadowHighlightApply(
  data: Uint8ClampedArray, _w: number, _h: number, shadows: number, highlights: number,
): void {
  void _w;
  void _h;
  const sAmt = shadows / 100;
  const hAmt = highlights / 100;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const L = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const wS = Math.max(0, 1 - L / 128);
    const wH = Math.max(0, (L - 128) / 127);
    const delta = sAmt * 90 * wS * wS - hAmt * 90 * wH * wH;
    data[i] = data[i] + delta;
    data[i + 1] = data[i + 1] + delta;
    data[i + 2] = data[i + 2] + delta;
  }
}
