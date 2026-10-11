// Camera Raw pipeline stage 1 (geometry): perspective (vertical/horizontal),
// rotation, aspect, zoom and offsets, applied as one inverse-map bilinear warp.
// Forward map on centered coords: corner-displacement perspective → rotate →
// aspect → zoom → offset. The bilinear corner displacement is inverted by
// fixed-point iteration (it is a contraction for the documented 0.18 spreads).
// constrainCrop crops to the alpha bounds and re-centers the content in the
// same-size canvas (no rescale — a raster layer filter keeps its dimensions).

import type { CameraRawSettings } from './settings';
import { clampN } from './hsl';

export function geometryIsIdentity(g: CameraRawSettings['geometry']): boolean {
  return g.vertical === 0 && g.horizontal === 0 && g.aspect === 0 && g.scale === 0 &&
    g.offsetX === 0 && g.offsetY === 0 && g.rotate === 0;
}

export function applyGeometry(img: ImageData, g: CameraRawSettings['geometry']): ImageData {
  if (geometryIsIdentity(g)) return img;
  const w = img.width, h = img.height;
  const src = img.data;

  // Perspective corner offsets (px, centered): vertical spreads the top edge
  // horizontally, horizontal spreads the left edge vertically (strength 1.0).
  const sv = (g.vertical / 100) * w * 0.18;
  const sh = (g.horizontal / 100) * h * 0.18;
  const oTLx = -sv / 2, oTLy = -sh / 2;
  const oTRx = sv / 2, oTRy = 0;
  const oBLx = 0, oBLy = sh / 2;
  const oBRx = 0, oBRy = 0;

  const rad = (g.rotate * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const ax = 1 + g.aspect / 200;
  const ay = 1 / Math.max(0.05, 1 + g.aspect / 200);
  const zoom = Math.max(0.05, 1 + g.scale / 100);
  const offX = 0.15 * w * (g.offsetX / 100);
  const offY = 0.15 * h * (g.offsetY / 100);

  const out = new ImageData(w, h);
  const px = out.data;
  for (let y = 0; y < h; y++) {
    // inverse affine chain: un-offset → un-zoom → un-aspect → un-rotate
    let qy = (y - h / 2 - offY) / zoom * ay;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const qx = ((x - w / 2 - offX) / zoom) / ax;
      const rx = qx * cos + qy * sin;
      const ry = -qx * sin + qy * cos;
      // invert the bilinear corner displacement by fixed-point iteration
      let pxs = rx, pys = ry;
      for (let it = 0; it < 4; it++) {
        const u = clampN(pxs / w + 0.5, 0, 1);
        const v = clampN(pys / h + 0.5, 0, 1);
        const dxp = (1 - u) * (1 - v) * oTLx + u * (1 - v) * oTRx + (1 - u) * v * oBLx + u * v * oBRx;
        const dyp = (1 - u) * (1 - v) * oTLy + u * (1 - v) * oTRy + (1 - u) * v * oBLy + u * v * oBRy;
        pxs = rx - dxp;
        pys = ry - dyp;
      }
      const sx = pxs + w / 2;
      const sy = pys + h / 2;
      if (sx < -0.5 || sx > w - 0.5 || sy < -0.5 || sy > h - 0.5) {
        px[i + 3] = 0; // outside the source → transparent
        continue;
      }
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      const xa = clampN(x0, 0, w - 1), xb = clampN(x0 + 1, 0, w - 1);
      const ya = clampN(y0, 0, h - 1), yb = clampN(y0 + 1, 0, h - 1);
      const i00 = (ya * w + xa) * 4, i10 = (ya * w + xb) * 4;
      const i01 = (yb * w + xa) * 4, i11 = (yb * w + xb) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src[i00 + c] * (1 - fx) + src[i10 + c] * fx;
        const bot = src[i01 + c] * (1 - fx) + src[i11 + c] * fx;
        px[i + c] = top * (1 - fy) + bot * fy;
      }
    }
  }
  return g.constrainCrop ? constrainToAlphaBounds(out) : out;
}

/** Crop to the alpha bounding box (alpha ≥ 8) and center it in the same canvas. */
function constrainToAlphaBounds(img: ImageData): ImageData {
  const { width: w, height: h, data: px } = img;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] < 8) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return img;
  if (minX === 0 && minY === 0 && maxX === w - 1 && maxY === h - 1) return img;
  const bw = maxX - minX + 1;
  const out = new ImageData(w, h);
  const dx = ((w - bw) >> 1) - minX;
  const dy = ((h - (maxY - minY + 1)) >> 1) - minY;
  for (let y = minY; y <= maxY; y++) {
    const srcRow = (y * w + minX) * 4;
    const dstRow = ((y + dy) * w + minX + dx) * 4;
    out.data.set(px.subarray(srcRow, srcRow + bw * 4), dstRow);
  }
  return out;
}
