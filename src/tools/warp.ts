// Smear tool engine (liquify + smudge), ported from Compositor's Swift/Metal
// WarpStroke. The working canvas is a private copy mutated in place; every dab
// reads/writes ImageData on a willReadFrequently context so the CPU-backed
// path handles the many getImageData/putImageData round-trips.
//
// Math (from the Metal source):
//   r       = ceil(diameter / 2)
//   w(u)    = 0                            if u >= 1
//           = 1                            if u <= hardness
//           = t^2 * (3 - 2t), t = (1-u)/(1-hardness)   otherwise
//             where u = dist / (diameter / 2)
//   spacing = max(1, diameter * (smudge ? 0.005 : 0.025))
// Pointer positions are interpolated between events and one dab is applied per
// spacing step. The (2r+1)^2 falloff LUT is precomputed per params change.

import { makeCanvas, ctx2dRead, clamp } from '../core/canvasUtils';

export type WarpMode = 'liquify' | 'smudge';

export interface WarpParams {
  /** brush diameter in layer pixels, >= 2 */
  diameter: number;
  /** fraction of the radius at full weight, 0..0.98 */
  hardness: number;
  /** dab intensity, 0.01..1 */
  strength: number;
}

export class WarpStroke {
  /** Working copy of the source layer, mutated in place by the dabs. */
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  private mode: WarpMode = 'liquify';
  private params: WarpParams | null = null;
  private radius = 0;
  private side = 0;                          // 2r + 1
  private lut = new Float32Array(0);         // (2r+1)^2 falloff weights
  private carried = new Float32Array(0);     // smudge: (2r+1)^2 * 4 carried paint
  private scratch = new Float32Array(0);     // liquify: region copy, grown as needed
  private dabOut: ImageData | null = null;   // liquify write-back buffer
  private lastX = 0;                         // previous dab / anchor center, int px
  private lastY = 0;
  private pending = 0;                       // layer px left until the next dab
  private anchored = false;

  constructor(source: HTMLCanvasElement) {
    this.canvas = makeCanvas(source.width, source.height);
    // First getContext call on the fresh canvas, so willReadFrequently sticks.
    this.ctx = ctx2dRead(this.canvas);
    this.ctx.drawImage(source, 0, 0);
  }

  /** Start a stroke at (x, y). Smudge picks up its carried square here. */
  begin(x: number, y: number, p: WarpParams, mode: WarpMode): void {
    this.mode = mode;
    this.ensureParams(p);
    this.anchor(x, y);
  }

  /** Feed one pointer segment (x0,y0)->(x1,y1); dabs are interpolated inside. */
  stroke(x0: number, y0: number, x1: number, y1: number, p: WarpParams, mode: WarpMode): void {
    const modeChanged = mode !== this.mode;
    this.mode = mode;
    const rebuilt = this.ensureParams(p);
    if (modeChanged || rebuilt || !this.anchored) this.anchor(x0, y0);

    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len <= 0) return;
    const spacing = this.spacing();
    let travelled = 0;
    while (travelled + this.pending <= len) {
      travelled += this.pending;
      const f = travelled / len;
      this.dab(x0 + dx * f, y0 + dy * f);
      this.pending = spacing;
    }
    this.pending -= len - travelled;
  }

  /** End the stroke; returns the mutated canvas for the caller's history commit. */
  finish(): HTMLCanvasElement {
    this.anchored = false;
    this.scratch = new Float32Array(0); // release the big buffer; LUT stays cached
    return this.canvas;
  }

  // ---------------------------------------------------------------- internals

  private spacing(): number {
    const p = this.params as WarpParams;
    return Math.max(1, p.diameter * (this.mode === 'smudge' ? 0.005 : 0.025));
  }

  /** Re-anchor like a fresh begin (used at begin, on mode/params change). */
  private anchor(x: number, y: number): void {
    this.lastX = Math.round(x);
    this.lastY = Math.round(y);
    this.pending = this.spacing();
    if (this.mode === 'smudge') this.pickCarried(this.lastX, this.lastY);
    this.anchored = true;
  }

  /** Returns true when the (diameter, hardness) LUT had to be rebuilt. */
  private ensureParams(p: WarpParams): boolean {
    const diameter = Math.max(2, p.diameter);
    const hardness = clamp(p.hardness, 0, 0.98);
    const strength = clamp(p.strength, 0.01, 1);
    const cur = this.params;
    if (cur && cur.diameter === diameter && cur.hardness === hardness && cur.strength === strength) {
      return false;
    }
    this.params = { diameter, hardness, strength };
    this.radius = Math.ceil(diameter / 2);
    this.side = 2 * this.radius + 1;
    const half = diameter / 2;
    const span = 1 - hardness; // > 0 because hardness <= 0.98
    const lut = new Float32Array(this.side * this.side);
    for (let j = 0; j < this.side; j++) {
      const dj = j - this.radius;
      for (let i = 0; i < this.side; i++) {
        const di = i - this.radius;
        const u = Math.hypot(di, dj) / half;
        let w: number;
        if (u >= 1) w = 0;
        else if (u <= hardness) w = 1;
        else {
          const t = (1 - u) / span;
          w = t * t * (3 - 2 * t);
        }
        lut[j * this.side + i] = w;
      }
    }
    this.lut = lut;
    this.dabOut = this.ctx.createImageData(this.side, this.side);
    return true;
  }

  /** Smudge: read the (2r+1)^2 square around (cx, cy) into the carried buffer. */
  private pickCarried(cx: number, cy: number): void {
    const r = this.radius, side = this.side;
    const W = this.canvas.width, H = this.canvas.height;
    const buf = new Float32Array(side * side * 4);
    const x0 = Math.max(0, cx - r), y0 = Math.max(0, cy - r);
    const x1 = Math.min(W, cx + r + 1), y1 = Math.min(H, cy + r + 1);
    if (x1 > x0 && y1 > y0) {
      const img = this.ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
      const d = img.data;
      const lw = x1 - x0;
      for (let y = y0; y < y1; y++) {
        const srcRow = (y - y0) * lw;
        const dstRow = (y - cy + r) * side + (x0 - cx + r);
        for (let x = x0; x < x1; x++) {
          const s = (srcRow + x - x0) * 4;
          const t = (dstRow + x - cx + r) * 4;
          buf[t] = d[s]; buf[t + 1] = d[s + 1]; buf[t + 2] = d[s + 2]; buf[t + 3] = d[s + 3];
        }
      }
    }
    this.carried = buf; // out-of-canvas slots stay 0 (transparent)
  }

  private dab(x: number, y: number): void {
    const cx = Math.round(x), cy = Math.round(y);
    if (this.mode === 'smudge') {
      this.smudgeDab(cx, cy);
    } else {
      this.liquifyDab(cx, cy);
    }
    this.lastX = cx;
    this.lastY = cy;
  }

  /**
   * Smudge dab: painted = under + (carried - under) * w * strength, written
   * back per pixel; carried[k] = painted afterwards so only fresh paint rides.
   */
  private smudgeDab(cx: number, cy: number): void {
    const p = this.params as WarpParams;
    const r = this.radius, side = this.side;
    const W = this.canvas.width, H = this.canvas.height;
    const x0 = Math.max(0, cx - r), y0 = Math.max(0, cy - r);
    const x1 = Math.min(W, cx + r + 1), y1 = Math.min(H, cy + r + 1);
    if (x1 <= x0 || y1 <= y0) return;
    const img = this.ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
    const d = img.data;
    const lw = x1 - x0;
    const carried = this.carried;
    for (let y = y0; y < y1; y++) {
      const rowImg = (y - y0) * lw;
      const rowOff = y - cy + r;
      for (let x = x0; x < x1; x++) {
        const k = rowOff * side + (x - cx + r);
        const w = this.lut[k] * p.strength;
        const di = (rowImg + x - x0) * 4;
        const ci = k * 4;
        for (let ch = 0; ch < 4; ch++) {
          const under = d[di + ch];
          const painted = under + (carried[ci + ch] - under) * w;
          d[di + ch] = painted;
          carried[ci + ch] = painted;
        }
      }
    }
    this.ctx.putImageData(img, x0, y0);
  }

  /**
   * Liquify dab (forward warp): move = pointer step * strength. The dab region
   * grown by margin = ceil(max|move|) + 2 is copied to a Float32 scratch and
   * each dab pixel bilinearly resamples the scratch at (x - move.x*w, y - move.y*w).
   */
  private liquifyDab(cx: number, cy: number): void {
    const p = this.params as WarpParams;
    const mx = (cx - this.lastX) * p.strength;
    const my = (cy - this.lastY) * p.strength;
    const maxMove = Math.max(Math.abs(mx), Math.abs(my));
    if (maxMove < 1e-4) return; // identity dab
    const r = this.radius;
    const margin = Math.ceil(maxMove) + 2;
    const side = 2 * (r + margin) + 1;
    // Out-of-canvas parts of the region come back as transparent black.
    const region = this.ctx.getImageData(cx - r - margin, cy - r - margin, side, side);
    const rd = region.data;
    const need = side * side * 4;
    if (this.scratch.length < need) this.scratch = new Float32Array(need);
    const sc = this.scratch;
    sc.set(rd); // fresh per dab: the resampler reads the region just read above

    const dab = this.dabOut as ImageData;
    const od = dab.data;
    const dSide = this.side;
    for (let j = 0; j < dSide; j++) {
      const lutRow = j * dSide;
      for (let i = 0; i < dSide; i++) {
        const w = this.lut[lutRow + i];
        const o = (lutRow + i) * 4;
        const idc = ((j + margin) * side + (i + margin)) * 4;
        if (w === 0) {
          // Outside the falloff: identity copy so putImageData stays exact.
          od[o] = rd[idc]; od[o + 1] = rd[idc + 1]; od[o + 2] = rd[idc + 2]; od[o + 3] = rd[idc + 3];
          continue;
        }
        let sx = i + margin - mx * w;
        let sy = j + margin - my * w;
        if (sx < 0) sx = 0; else if (sx > side - 1) sx = side - 1;
        if (sy < 0) sy = 0; else if (sy > side - 1) sy = side - 1;
        const xi = Math.floor(sx), yi = Math.floor(sy);
        const xj = xi + 1 < side ? xi + 1 : xi;
        const yj = yi + 1 < side ? yi + 1 : yi;
        const fx = sx - xi, fy = sy - yi;
        const gx = 1 - fx, gy = 1 - fy;
        const i00 = (yi * side + xi) * 4, i10 = (yi * side + xj) * 4;
        const i01 = (yj * side + xi) * 4, i11 = (yj * side + xj) * 4;
        for (let ch = 0; ch < 4; ch++) {
          const top = sc[i00 + ch] * gx + sc[i10 + ch] * fx;
          const bot = sc[i01 + ch] * gx + sc[i11 + ch] * fx;
          od[o + ch] = top * gy + bot * fy;
        }
      }
    }
    // putImageData clips to the canvas; outside parts of the dab are dropped.
    this.ctx.putImageData(dab, cx - r, cy - r);
  }
}
