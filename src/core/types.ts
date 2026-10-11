// Document model mirroring Compositor's .comp format (see docs/project-format.md).

export const BLEND_MODES = [
  'Normal',
  'Darken', 'Multiply', 'Color Burn', 'Linear Burn',
  'Lighten', 'Screen', 'Color Dodge', 'Linear Dodge (Add)',
  'Overlay', 'Soft Light', 'Hard Light', 'Vivid Light', 'Linear Light', 'Pin Light', 'Hard Mix',
  'Difference', 'Exclusion', 'Subtract', 'Divide',
  'Hue', 'Saturation', 'Color', 'Luminosity',
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

// Modes Canvas 2D can composite natively; the rest go through the per-pixel path.
const CSS_BLEND: Partial<Record<BlendMode, GlobalCompositeOperation>> = {
  Normal: 'source-over',
  Multiply: 'multiply', Screen: 'screen', Overlay: 'overlay',
  Darken: 'darken', Lighten: 'lighten',
  'Color Dodge': 'color-dodge', 'Color Burn': 'color-burn',
  'Hard Light': 'hard-light', 'Soft Light': 'soft-light',
  Difference: 'difference', Exclusion: 'exclusion',
  Hue: 'hue', Saturation: 'saturation', Color: 'color', Luminosity: 'luminosity',
};
export function cssBlend(mode: BlendMode): GlobalCompositeOperation | null {
  return CSS_BLEND[mode] ?? null;
}

export type Sampling = 'High quality' | 'Smooth' | 'Nearest';

export interface LayerTransform {
  origin: [number, number];   // top-left corner in document pixels
  size: [number, number];     // drawn size in document pixels
  rotation: number;           // degrees, clockwise
  flipX: boolean;
  flipY: boolean;
  sampling: Sampling;
}

export interface TextMeta {
  content: string;
  fontName: string;       // CSS font family
  fontSize: number;       // pixels
  color: [number, number, number]; // 0-1
  align: 'left' | 'center' | 'right';
  tracking: number;       // letter spacing in px
  lineSpacing: number;    // line height in px
  boxSize: [number, number] | null; // paragraph bounds, or null for auto
}

export interface ShapeMeta {
  kind: 'rectangle' | 'roundedRectangle' | 'ellipse' | 'line';
  color: [number, number, number];
  cornerRadius: number;
  lineWidth: number;
  start: [number, number]; // lines, as fractions of the layer box
  end: [number, number];
}

export type AdjustmentKind =
  | 'Hue/Saturation' | 'Levels' | 'Curves' | 'Exposure' | 'Gradient Map' | 'Grain'
  | 'Invert' | 'Black & White' | 'Color Balance' | 'Gaussian Blur' | 'Motion Blur' | 'Add Noise';

export interface LevelsRange { black: number; gamma: number; white: number; outputBlack: number; outputWhite: number }
export interface LevelsSettings { channel: 'RGB' | 'Red' | 'Green' | 'Blue'; ranges: LevelsRange[] }
export interface CurvePoint { x: number; y: number }
export interface CurvesSettings { channel: 'RGB' | 'Red' | 'Green' | 'Blue'; channels: CurvePoint[][] }
export interface HueSatSettings { hue: number; saturation: number; lightness: number; colorize: boolean; colorizeHue: number; colorizeSat: number }
export interface ExposureSettings { exposure: number; offset: number; gamma: number }
export interface GradientMapSettings { shadows: [number, number, number]; highlights: [number, number, number]; reversed: boolean }
export interface GrainSettings { amount: number; size: number; roughness: number; seed: number }
export interface BlackWhiteSettings { reds: number; yellows: number; greens: number; cyans: number; blues: number; magentas: number; tint: [number, number, number] | null }
export interface ColorBalanceSettings {
  shadowCyanRed: number; shadowMagentaGreen: number; shadowYellowBlue: number;
  midCyanRed: number; midMagentaGreen: number; midYellowBlue: number;
  highlightCyanRed: number; highlightMagentaGreen: number; highlightYellowBlue: number;
  preserveLuminosity: boolean;
}

export interface AdjustmentData {
  kind: AdjustmentKind;
  hueSat: HueSatSettings;
  levels: LevelsSettings;
  curves: CurvesSettings;
  exposure: ExposureSettings;
  gradientMap: GradientMapSettings;
  grain: GrainSettings;
  blackWhite: BlackWhiteSettings;
  colorBalance: ColorBalanceSettings;
  blurRadius: number;      // Gaussian Blur, document pixels
  motionAngle: number;     // Motion Blur degrees, -90..90
  motionDistance: number;  // Motion Blur px
  noiseAmount: number;     // Add Noise
  noiseGaussian: boolean;
  noiseMonochromatic: boolean;
  noiseSeed: number;
}

export function defaultAdjustment(kind: AdjustmentKind): AdjustmentData {
  return {
    kind,
    hueSat: { hue: 0, saturation: 0, lightness: 0, colorize: false, colorizeHue: 0, colorizeSat: 25 },
    levels: {
      channel: 'RGB',
      ranges: Array.from({ length: 4 }, () => ({ black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 })),
    },
    curves: {
      channel: 'RGB',
      channels: Array.from({ length: 4 }, () => [{ x: 0, y: 0 }, { x: 255, y: 255 }]),
    },
    exposure: { exposure: 0, offset: 0, gamma: 1 },
    gradientMap: { shadows: [0, 0, 0], highlights: [1, 1, 1], reversed: false },
    grain: { amount: 25, size: 1.5, roughness: 50, seed: (Math.random() * 4294967295) >>> 0 },
    blackWhite: { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: null },
    colorBalance: {
      shadowCyanRed: 0, shadowMagentaGreen: 0, shadowYellowBlue: 0,
      midCyanRed: 0, midMagentaGreen: 0, midYellowBlue: 0,
      highlightCyanRed: 0, highlightMagentaGreen: 0, highlightYellowBlue: 0,
      preserveLuminosity: true,
    },
    blurRadius: 10,
    motionAngle: 0,
    motionDistance: 10,
    noiseAmount: 10,
    noiseGaussian: false,
    noiseMonochromatic: false,
    noiseSeed: 1,
  };
}

export interface StrokeEffect { enabled: boolean; size: number; color: [number, number, number]; opacity: number; inside: boolean }
export interface ShadowEffect { enabled: boolean; angle: number; distance: number; blur: number; color: [number, number, number]; opacity: number }
export interface OverlayEffect { enabled: boolean; color: [number, number, number]; opacity: number }
export interface GlowEffect { enabled: boolean; size: number; color: [number, number, number]; opacity: number }

export interface EffectsData {
  stroke?: StrokeEffect;
  shadow?: ShadowEffect;       // drop shadow
  colorOverlay?: OverlayEffect;
  innerShadow?: ShadowEffect;
  outerGlow?: GlowEffect;
  innerGlow?: GlowEffect;
}

export function defaultEffects(kind: keyof EffectsData): NonNullable<EffectsData[keyof EffectsData]> {
  switch (kind) {
    case 'stroke': return { enabled: true, size: 4, color: [0, 0, 0], opacity: 1, inside: false };
    case 'shadow': return { enabled: true, angle: 90, distance: 20, blur: 20, color: [0, 0, 0], opacity: 0.5 };
    case 'colorOverlay': return { enabled: true, color: [0, 0, 0], opacity: 1 };
    case 'innerShadow': return { enabled: true, angle: 90, distance: 10, blur: 10, color: [0, 0, 0], opacity: 0.5 };
    case 'outerGlow': return { enabled: true, size: 20, color: [1, 1, 1], opacity: 0.75 };
    case 'innerGlow': return { enabled: true, size: 10, color: [1, 1, 1], opacity: 0.75 };
  }
}

export interface Layer {
  id: string;
  name: string;
  isVisible: boolean;
  isGroup: boolean;
  parentId: string | null;
  opacity: number;        // 0-1
  blendMode: BlendMode;
  transform: LayerTransform;
  bitmap: HTMLCanvasElement | null;    // layer-local raster pixels
  mask: HTMLCanvasElement | null;      // layer-local grayscale mask (white reveals)
  maskEnabled: boolean;
  maskLinked: boolean;
  maskPlacement: LayerTransform | null; // set when the mask is unlinked
  maskSourceId: string | null;          // clipping mask: base layer id
  adjustment: AdjustmentData | null;
  text: TextMeta | null;
  shape: ShapeMeta | null;
  effects: EffectsData | null;
  expanded: boolean;      // UI-only collapse state
}

export interface Doc {
  id: string;
  width: number;
  height: number;
  resolution: number;
  layers: Layer[];        // bottom to top
  activeLayerId: string | null;
  fileName: string | null; // .comp path when opened from / saved to a package
}

export function defaultTransform(w: number, h: number): LayerTransform {
  return { origin: [0, 0], size: [w, h], rotation: 0, flipX: false, flipY: false, sampling: 'High quality' };
}

export function makeLayer(partial: Partial<Layer> & { name: string }): Layer {
  return {
    id: partial.id ?? crypto.randomUUID().toUpperCase(),
    name: partial.name,
    isVisible: partial.isVisible ?? true,
    isGroup: partial.isGroup ?? false,
    parentId: partial.parentId ?? null,
    opacity: partial.opacity ?? 1,
    blendMode: partial.blendMode ?? 'Normal',
    transform: partial.transform ?? defaultTransform(0, 0),
    bitmap: partial.bitmap ?? null,
    mask: partial.mask ?? null,
    maskEnabled: partial.maskEnabled ?? true,
    maskLinked: partial.maskLinked ?? true,
    maskPlacement: partial.maskPlacement ?? null,
    maskSourceId: partial.maskSourceId ?? null,
    adjustment: partial.adjustment ?? null,
    text: partial.text ?? null,
    shape: partial.shape ?? null,
    effects: partial.effects ?? null,
    expanded: partial.expanded ?? true,
  };
}

export const ADJUSTMENT_KINDS: AdjustmentKind[] = [
  'Hue/Saturation', 'Levels', 'Curves', 'Exposure', 'Gradient Map', 'Grain',
  'Invert', 'Black & White', 'Color Balance', 'Gaussian Blur', 'Motion Blur', 'Add Noise',
];

export function rgbToCss(rgb: [number, number, number], a = 1): string {
  const c = rgb.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255));
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
