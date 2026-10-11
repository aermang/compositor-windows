// Color Range selection (ported from the Swift ColorRangeSampler): multi-sample
// include/exclude keying with a per-channel fuzziness cube on alpha-unpremultiplied
// RGB. Transparent pixels never match a sample; `invert` flips membership.

/** True when the unpremultiplied pixel lies within the fuzziness cube around c. */
function matchesCube(
  r: number, g: number, b: number, a: number,
  c: [number, number, number], fuzz: number,
): boolean {
  if (a === 0) return false; // fully transparent never matches
  return (
    Math.abs(r - c[0]) <= fuzz &&
    Math.abs(g - c[1]) <= fuzz &&
    Math.abs(b - c[2]) <= fuzz
  );
}

/**
 * Build a 0/255 mask (w×h) of pixels matching any include sample while matching
 * no exclude sample. Data is treated as premultiplied RGBA; RGB is unpremultiplied
 * as rgb = (px*255 + a/2)/a (clamped to 0..255) when a > 0. With `invert`, the
 * membership test is flipped (so transparent pixels, which never "match", become
 * selected when inverting).
 */
export function colorRangeMask(
  img: ImageData,
  include: [number, number, number][],
  exclude: [number, number, number][],
  fuzziness: number,
  invert: boolean,
): Uint8Array {
  const w = img.width, h = img.height;
  const d = img.data;
  const mask = new Uint8Array(w * h);
  const fuzz = Math.max(0, fuzziness);

  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    const a = d[i + 3];
    let r = 0, g = 0, b = 0;
    if (a > 0) {
      r = Math.min(255, (d[i] * 255 + a / 2) / a);
      g = Math.min(255, (d[i + 1] * 255 + a / 2) / a);
      b = Math.min(255, (d[i + 2] * 255 + a / 2) / a);
    }

    let anyInclude = false;
    for (let s = 0; s < include.length; s++) {
      if (matchesCube(r, g, b, a, include[s], fuzz)) { anyInclude = true; break; }
    }
    if (!anyInclude) { if (invert) mask[p] = 255; continue; }

    let anyExclude = false;
    for (let s = 0; s < exclude.length; s++) {
      if (matchesCube(r, g, b, a, exclude[s], fuzz)) { anyExclude = true; break; }
    }

    const inMask = !anyExclude;
    if (invert ? !inMask : inMask) mask[p] = 255;
  }
  return mask;
}

/**
 * 3×3 average sample at (x, y) as unpremultiplied [r, g, b] (0..255 ints).
 * Sample coordinates are clamped at the edges, so border pixels are repeated.
 * Fully-transparent neighbors (unpremultipliable) are skipped; if the whole
 * neighborhood is transparent, returns [0, 0, 0].
 */
export function sampleAt(img: ImageData, x: number, y: number): [number, number, number] {
  const w = img.width, h = img.height;
  const d = img.data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const cy = Math.min(h - 1, Math.max(0, y + dy));
    for (let dx = -1; dx <= 1; dx++) {
      const cx = Math.min(w - 1, Math.max(0, x + dx));
      const i = (cy * w + cx) * 4;
      const a = d[i + 3];
      if (a === 0) continue;
      r += Math.min(255, (d[i] * 255 + a / 2) / a);
      g += Math.min(255, (d[i + 1] * 255 + a / 2) / a);
      b += Math.min(255, (d[i + 2] * 255 + a / 2) / a);
      n++;
    }
  }
  if (!n) return [0, 0, 0];
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}
