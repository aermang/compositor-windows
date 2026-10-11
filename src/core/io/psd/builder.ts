// PSD import entry point. Orchestrates the raw parser (reader.ts) and the
// feature parsers (adjustments.ts, text.ts, vector.ts), assembles premultiplied
// RGBA canvases per layer, and rebuilds the group hierarchy bottom-to-top with
// the section-divider stack semantics, exactly like the Swift implementation.

import { makeCanvas, ctx2d } from '../../canvasUtils';
import { parsePsd } from './reader';
import { blendModeFromKey } from './coder';
import { parseAdjustment, skippedAdjustmentLabel } from './adjustments';
import { parseTextLayer } from './text';
import { buildShapeDraft, parseSoCo, parseVogk, parseVectorMask, rasterizeSubpaths } from './vector';
import type { PsdDocument, PsdImportResult, PsdLayerRecord, PsdRawLayer } from './types';

export type { PsdImportResult, PsdLayerRecord, PsdTextDraft, PsdShapeDraft } from './types';

/** '8BPS' magic sniff. */
export function isPsd(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 4) return false;
  return new DataView(buf).getUint32(0) === 0x38425053; // '8BPS'
}

export function readPsd(buf: ArrayBuffer): PsdImportResult {
  const doc = parsePsd(buf);
  const notes = new Set<string>(doc.notes);
  const layers: PsdLayerRecord[] = [];
  // PSD stores layers bottom-to-top; a section divider (lsct type 3) sits below
  // its children and the folder record (type 1/2) above them, so reading in
  // file order: 3 pushes a group, 1/2 pops it, children parent onto the stack top.
  const stack: PsdLayerRecord[] = [];

  for (const raw of doc.layers) {
    const id = crypto.randomUUID();
    if (raw.sectionType === 3) {
      const group: PsdLayerRecord = {
        name: displayName(raw),
        canvas: null,
        bounds: { x: 0, y: 0, w: 0, h: 0 },
        opacity: raw.opacity / 255,
        blendMode: blendModeFromKey(raw.blendKey).mode,
        hidden: (raw.flags & 0x02) !== 0,
        isGroup: true,
        parentId: stack.length > 0 ? stack[stack.length - 1].id : null,
        id,
        mask: null,
        maskDefault: 255,
        clipping: false,
        adjustment: null,
        text: null,
        shape: null,
      };
      layers.push(group);
      stack.push(group);
      continue;
    }
    if (raw.sectionType === 1 || raw.sectionType === 2) {
      const group = stack.pop();
      if (!group) throw new Error('PSD 图层组结构不完整'); // unbalanced folder
      const name = displayName(raw);
      if (name !== '') group.name = name; // the folder record carries the real group name
      continue;
    }

    const record = buildLayerRecord(raw, doc, id, notes);
    record.parentId = stack.length > 0 ? stack[stack.length - 1].id : null;
    layers.push(record);
  }
  if (stack.length > 0) throw new Error('PSD 图层组结构不完整'); // unbalanced divider

  return {
    width: doc.width,
    height: doc.height,
    resolution: doc.resolution,
    layers, // bottom to top
    notes: [...notes],
  };
}

function displayName(raw: PsdRawLayer): string {
  return raw.luniName ?? raw.pascalName;
}

function buildLayerRecord(
  raw: PsdRawLayer,
  doc: PsdDocument,
  id: string,
  notes: Set<string>,
): PsdLayerRecord {
  const w = raw.rect.right - raw.rect.left;
  const h = raw.rect.bottom - raw.rect.top;

  let opacity = raw.opacity / 255;
  if (raw.fillOpacity < 255) {
    opacity *= raw.fillOpacity / 255;
    notes.add('图层填充不透明度已并入图层不透明度');
  }
  const { mode: blendMode, known } = blendModeFromKey(raw.blendKey);
  if (!known) notes.add(`未知的混合模式签名 "${raw.blendKey}"，已按「正常」处理`);

  let canvas = assembleCanvas(raw, w, h);
  const mask = assembleMask(raw, notes);

  // Live adjustments
  let adjustment: { kind: string; data: unknown } | null = null;
  for (const key of ['levl', 'curv', 'hue2', 'hue ']) {
    if (!raw.extra.has(key)) continue;
    try {
      adjustment = parseAdjustment(key, raw.extra.get(key)!);
    } catch {
      notes.add(`调整图层数据解析失败(${key})，已忽略`);
    }
    break;
  }
  if (!adjustment) {
    for (const key of raw.extra.keys()) {
      const label = skippedAdjustmentLabel(key);
      if (label) notes.add(`不支持的调整图层(${label})，已忽略`);
    }
  }

  // Smart objects keep their rasterized channel data.
  if (raw.extra.has('SoLd') || raw.extra.has('SoLE')) notes.add('智能对象已按其栅格内容导入');
  // Layer effects are detected and discarded.
  if (raw.extra.has('lfx2') || raw.extra.has('lrFX') || raw.extra.has('lmfx')) notes.add('图层样式(效果)未导入');

  // Text
  let text = null as ReturnType<typeof parseTextLayer>;
  const textKey = raw.extra.has('TySh') ? 'TySh' : raw.extra.has('tySh') ? 'tySh' : null;
  if (textKey) text = parseTextLayer(raw.extra.get(textKey)!, m => notes.add(m));

  // Vector
  let shape: PsdLayerRecord['shape'] = null;
  const vmskKey = raw.extra.has('vmsk') ? 'vmsk' : raw.extra.has('vsms') ? 'vsms' : null;
  if (vmskKey && !textKey) {
    const subpaths = parseVectorMask(raw.extra.get(vmskKey)!, doc.width, doc.height);
    if (subpaths.length > 0) {
      const fill = raw.extra.has('SoCo') ? parseSoCo(raw.extra.get('SoCo')!) : null;
      const vogk = raw.extra.has('vogk') ? parseVogk(raw.extra.get('vogk')!) : null;
      shape = buildShapeDraft(subpaths, vogk, fill);
      if (!shape) notes.add('复杂矢量路径已按像素导入');
      if (!canvas) {
        // No usable raster in the file — rasterize the path ourselves.
        canvas = rasterizeSubpaths(
          subpaths,
          { x: raw.rect.left, y: raw.rect.top, w, h },
          fill ? fill.css : null,
        );
      }
    }
  }

  return {
    name: displayName(raw),
    canvas,
    bounds: { x: raw.rect.left, y: raw.rect.top, w: Math.max(w, 0), h: Math.max(h, 0) },
    opacity,
    blendMode,
    hidden: (raw.flags & 0x02) !== 0,
    isGroup: false,
    parentId: null,
    id,
    mask,
    maskDefault: raw.mask ? raw.mask.defaultColor : 255,
    clipping: raw.clipping !== 0,
    adjustment,
    text,
    shape,
  };
}

/** Straight→premultiplied RGBA ((c*a+127)/255) into a canvas at record-bounds size. */
function assembleCanvas(raw: PsdRawLayer, w: number, h: number): HTMLCanvasElement | null {
  if (w <= 0 || h <= 0) return null;
  const r = raw.planes.get(0);
  const g = raw.planes.get(1);
  const b = raw.planes.get(2);
  const a = raw.planes.get(-1);
  if (!r && !g && !b && !a) return null; // no raster content
  const canvas = makeCanvas(w, h);
  const ctx = ctx2d(canvas);
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const premul = (c: number, alpha: number): number => ((c * alpha + 127) / 255) | 0;
  for (let i = 0, px = w * h; i < px; i++) {
    const av = a ? a[i] : 255; // missing alpha = opaque
    d[i * 4] = premul(r ? r[i] : 0, av); // missing RGB planes = 0
    d[i * 4 + 1] = premul(g ? g[i] : 0, av);
    d[i * 4 + 2] = premul(b ? b[i] : 0, av);
    d[i * 4 + 3] = av;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Grayscale mask canvas (white reveals) at mask-rect size. */
function assembleMask(raw: PsdRawLayer, notes: Set<string>): HTMLCanvasElement | null {
  const m = raw.mask;
  if (!m) return null;
  // Masks flagged as coming from rendering other data are dropped.
  if ((m.flags & 0x06) !== 0) {
    notes.add('来自渲染的蒙版已忽略');
    return null;
  }
  const w = m.rect.right - m.rect.left;
  const h = m.rect.bottom - m.rect.top;
  if (w <= 0 || h <= 0) return null;
  const plane = raw.planes.get(-2);
  const invert = (m.flags & 0x01) !== 0;
  if (invert) notes.add('已应用蒙版反相标志');
  const canvas = makeCanvas(w, h);
  const ctx = ctx2d(canvas);
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0, px = w * h; i < px; i++) {
    let v = plane ? plane[i] : m.defaultColor; // missing mask plane = default color
    if (invert) v = 255 - v;
    d[i * 4] = v;
    d[i * 4 + 1] = v;
    d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
