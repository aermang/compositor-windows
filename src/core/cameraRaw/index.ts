// Camera Raw Filter pixel engine — main entry point.
//
// applyCameraRaw runs the ported pipeline in the original's exact stage order:
//   1. geometry (inverse-map warp, possibly returning a new ImageData)
//   2. calibration shadow tint
//   3. tone/color formula pass (exposure/WB LUTs + contrast/masks/endpoints/sat)
//   4. parametric curve → point curves → refine saturation
//   5. HSL mixer (8 families + target points)
//   6. color grading (4 wheels)
//   7. effects (texture → clarity → dehaze → glow → vignette → grain)
//   8. optics (CA → distortion → defringe → lens vignette)
//   9. detail (luminance NR → color NR → sharpen)
//
// Process-version scaling policy: the version multiplier (0.55…1.0) is applied
// to signed ±100 *strength* sliders only (light/color/curve/mixer shifts/
// grading luminance+balance/effects texture/clarity/dehaze/glow range+spread+
// warmth/vignette amount+roundness/optics distortion+lens vignette amount/
// noise-luminance contrast/calibration shadow tint). Structural parameters —
// exposure stops, geometry, splits, ranges, midpoints, feathers, radii, sizes,
// 0..100 amounts — are left untouched.
//
// ImageData is straight RGBA; alpha=0 pixels are skipped by tonal stages.
// Stages mutate `img` in place; geometry returns a fresh buffer when active.
// `scale` is the preview scale (1 = full resolution) used to shrink radii and
// pixel shifts so previews match the full-resolution render.

import { applyGeometry, geometryIsIdentity } from './geometry';
import { applyEffects, applyDetail } from './effects';
import { applyOptics } from './optics';
import {
  applyCalibrationShadowTint, applyCurvesStage, applyGrading, applyMixer, applyToneColor,
} from './pipeline';
import {
  autoWhiteBalance, cameraRawIsIdentity, normalizeCameraRawSettings, processVersionScale,
} from './settings';
import type { CameraRawSettings } from './settings';

export function applyCameraRaw(img: ImageData, s: CameraRawSettings, seed: number, scale = 1): ImageData {
  const n = normalizeCameraRawSettings(s);
  if (cameraRawIsIdentity(n)) return img;
  const verScale = processVersionScale(n.calibration.processVersion);

  // 1. geometry
  let cur = geometryIsIdentity(n.geometry) ? img : applyGeometry(img, n.geometry);

  // resolve auto white balance from the (post-geometry) pixels
  if (n.color.whiteBalance === 'auto') {
    const wb = autoWhiteBalance(cur);
    n.color.temperature = wb.temperature;
    n.color.tint = wb.tint;
  }

  // 2. calibration shadow tint
  applyCalibrationShadowTint(cur, n, verScale);
  // 3. tone/color formula pass
  applyToneColor(cur, n, verScale);
  // 4. parametric + point curves + refine saturation
  applyCurvesStage(cur, n, verScale);
  // 5. HSL mixer
  applyMixer(cur, n, verScale);
  // 6. color grading
  applyGrading(cur, n, verScale);
  // 7. effects
  applyEffects(cur, n, verScale, scale, seed);
  // 8. optics
  applyOptics(cur, n, verScale, scale);
  // 9. detail
  applyDetail(cur, n, verScale, scale);
  return cur;
}

export * from './settings';
export * from './hsl';
export { applyGeometry, geometryIsIdentity } from './geometry';
export { applyEffects, applyDetail } from './effects';
export { applyOptics } from './optics';
export {
  applyCalibrationShadowTint, applyCurvesStage, applyGrading, applyMixer, applyToneColor,
} from './pipeline';
