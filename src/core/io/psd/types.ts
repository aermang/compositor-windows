// Shared types for the PSD importer. builder.ts is the public entry point.

export interface PsdRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface PsdChannelInfo {
  id: number;      // -2 mask, -1 alpha, 0/1/2 RGB, others skipped
  length: number;  // bytes of channel image data (incl. the compression marker)
}

export interface PsdRawMask {
  rect: PsdRect;
  defaultColor: number; // 0 or 255
  flags: number;        // bit0 inverted, bits for "came from rendering"
}

/** A layer record exactly as stored in the file, before interpretation. */
export interface PsdRawLayer {
  pascalName: string;
  luniName: string | null;        // real name from 'luni' (Unicode)
  rect: PsdRect;                  // record bounds in document pixels
  channels: PsdChannelInfo[];
  blendKey: string;               // 4-char Photoshop signature, e.g. 'norm'
  opacity: number;                // 0..255
  fillOpacity: number;            // 0..255 from 'iOPa' (255 when absent)
  clipping: number;               // 0 = base, 1 = non-base
  flags: number;                  // bit1 (0x02) = hidden
  mask: PsdRawMask | null;
  sectionType: number | null;     // 'lsct'/'lsdk': 1/2 group end, 3 divider
  extra: Map<string, Uint8Array>; // additional-info blocks by key
  planes: Map<number, Uint8Array>; // decoded planes: -2 (mask rect size), -1 alpha, 0/1/2 (layer rect size)
}

export interface PsdDocument {
  width: number;
  height: number;
  resolution: number; // dpi
  isPsb: boolean;
  layers: PsdRawLayer[];
  notes: string[];    // parser-level notes (e.g. ZIP channels), merged into the result
  iccProfile?: Uint8Array; // Image Resource ID 1039(ICC profile 原始字节,原样保留)
}

/** Live text reconstruction draft from a TySh/tySh block. */
export interface PsdTextDraft {
  text: string;
  font: string;      // CSS font family
  sizePx: number;    // FontSize scaled by the matrix' uniform factor
  colorCss: string;  // e.g. 'rgb(255,128,0)'
  rotation: number;  // degrees, clockwise
  /** PSD glyph space is Y-up, so the standard horizontal-text matrix inverts Y
   *  (negative determinant). flipY is therefore false for normal text and only
   *  true when the determinant is positive, i.e. mirrored/vertically flipped text. */
  flipY: boolean;
  trackingPx: number; // letter spacing in px (EngineData tracking / 1000 em)
}

/** Parametric shape reconstruction draft from vmsk + vogk + SoCo. */
export interface PsdShapeDraft {
  kind: 'rectangle' | 'roundedRectangle' | 'ellipse';
  radius: number;   // rounded corner radius in px
  fillCss: string;
  fillRgb: [number, number, number]; // 0..255
}

/** One imported layer, in document coordinates, bottom to top. */
export interface PsdLayerRecord {
  name: string;
  canvas: HTMLCanvasElement | null; // premultiplied RGBA at record bounds; null for groups
  bounds: { x: number; y: number; w: number; h: number };
  opacity: number;   // 0..1
  blendMode: string; // app BlendMode name
  hidden: boolean;
  isGroup: boolean;
  parentId: string | null;
  id: string;
  mask: HTMLCanvasElement | null; // grayscale (white reveals), at mask-rect size
  maskDefault: number;
  clipping: boolean;
  adjustment: { kind: string; data: unknown } | null;
  text: PsdTextDraft | null;
  shape: PsdShapeDraft | null;
}

export interface PsdImportResult {
  width: number;
  height: number;
  resolution: number;
  layers: PsdLayerRecord[]; // bottom to top
  notes: string[];
  iccProfile?: Uint8Array;  // 资源 ID 1039 原始字节(供上层回填 Doc.iccProfile)
  iccName?: string;         // profile 描述名(desc 标签),如 'sRGB IEC61966-2.1'
}
