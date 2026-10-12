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

// Gradient tool rasterization kinds — the full Photoshop set. The value rides
// in ToolOpts.gradient (core/store.ts); 'linear' stays the default and every
// previously stored value remains a member, so persisted settings stay valid.
export type GradientType = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';

export interface LayerTransform {
  origin: [number, number];   // top-left corner in document pixels
  size: [number, number];     // drawn size in document pixels
  rotation: number;           // degrees, clockwise
  flipX: boolean;
  flipY: boolean;
  sampling: Sampling;
}

/** 逐范围样式覆盖(活字排版):[start,end) 内字符覆盖顶层同名字段;
 *  缺省字段继承 TextMeta 顶层。索引按 content 的 Unicode 码点计。 */
export interface TextStyleRange {
  start: number;
  end: number;
  fontName?: string;
  fontSize?: number;
  color?: [number, number, number];
  bold?: boolean;          // 仿粗体(权重 700)
  italic?: boolean;        // 仿斜体
  tracking?: number;
  baselineShift?: number;  // px,正上负下
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
  ranges?: TextStyleRange[]; // 活字排版逐范围样式;缺省/空 = 全部继承顶层
}

export interface ShapeMeta {
  kind: 'rectangle' | 'roundedRectangle' | 'ellipse' | 'line' | 'polygon';
  color: [number, number, number];
  cornerRadius: number;
  lineWidth: number;
  sides?: number; // polygon only (3–12)
  start: [number, number]; // lines, as fractions of the layer box
  end: [number, number];
}

/** Stored alpha channel (选区存储). Canvas is doc-sized, same encoding as
 *  selection masks: white RGB with the selection coverage in alpha (255=选中). */
export interface AlphaChannel {
  id: string;
  name: string;
  canvas: HTMLCanvasElement;
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

// ---------- smart filters (non-destructive filter stack per layer) ----------
// kind + params use the same vocabulary as the destructive Filter menu
// (commands.ts applyFilterToActive): gaussianBlur / motionBlur / addNoise /
// grain / vignette / bloom / sharpen / invert. Applied in the compositor's
// prepareLayer, before effects, so layer styles sample the filtered pixels.

export interface SmartFilter {
  id: string;
  kind: string;
  params: Record<string, number | boolean>;
  enabled: boolean;
}

// ---------- vector paths (pen tool) ----------
// Anchors carry bezier handle offsets in document pixels; `in`/`out` null
// means a corner anchor (straight segments on that side).

export interface PathAnchor {
  p: [number, number];
  in: [number, number] | null;
  out: [number, number] | null;
}

export interface PathSubpath {
  closed: boolean;
  anchors: PathAnchor[];
}

export interface DocPath {
  id: string;
  name: string;
  subpaths: PathSubpath[];
}

// ---------- frame animation ----------
// Each frame stores per-layer visibility/opacity overrides; layers missing
// from `states` keep their own current values (frames created before a layer
// existed simply don't mention it).

export interface AnimFrameState { visible: boolean; opacity: number }

export interface AnimFrame {
  id: string;
  durationMs: number;
  states: Record<string, AnimFrameState>;
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
  smartFilters: SmartFilter[] | null; // non-destructive filter stack, applied bottom-up
  smartObjectId?: string; // 智能对象:引用 doc.smartObjects[].id;bitmap 为源分辨率物化视图
  expanded: boolean;      // UI-only collapse state
  rev?: number;           // content revision: bumped on every in-place pixel edit
}

/** 智能对象的内嵌子文档(非破坏变换的像素来源)。 */
export interface SmartObjectRef {
  id: string;
  name: string;
  doc: Doc;
}

export interface Doc {
  id: string;
  width: number;
  height: number;
  resolution: number;
  layers: Layer[];        // bottom to top
  activeLayerId: string | null;
  fileName: string | null; // .comp path when opened from / saved to a package
  paths?: DocPath[];      // vector paths (pen tool); absent in older docs
  frames?: AnimFrame[];   // frame-animation timeline; absent/empty = no timeline
  alphaChannels?: AlphaChannel[]; // stored selections; absent in older docs
  smartObjects?: SmartObjectRef[]; // embedded smart-object sub-documents; absent in older docs
  bitDepth?: 8 | 16;      // 来源/导出口径位深(内部合成恒 8-bit);缺省 8
  iccProfile?: Uint8Array; // 嵌入的 ICC 配置文件原始字节(读取所得,导出回写)
  iccName?: string;       // ICC 描述名,如 'sRGB IEC61966-2.1'、'Display P3'
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
    smartFilters: partial.smartFilters ?? null,
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
