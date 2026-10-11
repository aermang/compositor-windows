// Global app state: the open document, viewport, active tool, selection, history.
// Canvases are markRaw'd so Vue never proxies them; structural layer changes swap
// the array and bump `tick` so views re-render.

import { reactive, markRaw, computed } from 'vue';
import { History, snapCanvas } from './history';
import { makeCanvas, ctx2d, cloneCanvas } from './canvasUtils';
import { composite, renderTextBitmap, prepareLayer } from './compositor';
import {
  makeLayer, defaultTransform, defaultAdjustment, defaultEffects,
} from './types';
import type { AdjustmentKind, Doc, Layer, TextMeta } from './types';
import type { SelectionState } from './selection';
import { emptySelection } from './selection';
import { ADJUSTMENT_ZH } from './labels';

export type ToolId =
  | 'move' | 'marquee' | 'lasso' | 'wand' | 'crop' | 'brush' | 'eraser' | 'clone'
  | 'smear' | 'gradient' | 'shape' | 'type' | 'eyedropper' | 'hand' | 'zoom';

export interface ToolOpts {
  brush: { size: number; hardness: number; opacity: number; smoothing: number };
  marquee: { shape: 'rectangle' | 'ellipse' };
  lasso: { polygonal: boolean };
  wand: { tolerance: number; contiguous: boolean; sampleRadius: number };
  crop: { ratio: string };
  clone: { aligned: boolean; size: number; hardness: number; opacity: number };
  smear: { mode: 'liquify' | 'smudge' | 'blur'; diameter: number; hardness: number; strength: number };
  shape: { kind: 'rectangle' | 'roundedRectangle' | 'ellipse' | 'line'; cornerRadius: number; lineWidth: number };
  gradient: { type: 'linear' | 'radial'; mode: 'fg-bg' | 'fg-transparent'; dither: boolean };
  type: { fontFamily: string; fontSize: number; bold: boolean; italic: boolean; align: 'left' | 'center' | 'right' };
}

interface AppState {
  doc: Doc | null;
  zoom: number;
  panX: number;   // screen-space translation
  panY: number;
  viewW: number;
  viewH: number;
  tool: ToolId;
  opts: ToolOpts;
  fg: string;
  bg: string;
  selection: SelectionState | null;
  paintingTarget: 'image' | 'mask';
  showGrid: boolean;
  showPixelGrid: boolean;
  canvasOnly: boolean;
  dirty: boolean;
  dialog: string | null;
  dialogPayload: unknown;
  clipLayer: Layer | null;   // internal copy/paste clipboard
  preview: { kind: string; [k: string]: unknown } | null; // live tool preview (marquee, lasso, crop…)
  strokePreview: { layerId: string; canvas: HTMLCanvasElement } | null; // live brush overlay
  cloneMarker: { x: number; y: number } | null;
  editingTextId: string | null;
  tick: number;              // composite invalidation
  uiTick: number;            // structural invalidation
}

export const store = reactive<AppState>({
  doc: null,
  zoom: 1,
  panX: 0,
  panY: 0,
  viewW: 800,
  viewH: 600,
  tool: 'move',
  opts: {
    brush: { size: 30, hardness: 0.8, opacity: 1, smoothing: 0 },
    marquee: { shape: 'rectangle' },
    lasso: { polygonal: false },
    wand: { tolerance: 32, contiguous: true, sampleRadius: 1 },
    crop: { ratio: 'free' },
    clone: { aligned: true, size: 40, hardness: 0.6, opacity: 1 },
    smear: { mode: 'liquify', diameter: 64, hardness: 0.5, strength: 0.5 },
    shape: { kind: 'rectangle', cornerRadius: 12, lineWidth: 4 },
    gradient: { type: 'linear', mode: 'fg-bg', dither: true },
    type: { fontFamily: 'Segoe UI', fontSize: 48, bold: false, italic: false, align: 'left' },
  },
  fg: '#000000',
  bg: '#ffffff',
  selection: null,
  paintingTarget: 'image',
  showGrid: false,
  showPixelGrid: true,
  canvasOnly: false,
  dirty: false,
  dialog: null,
  dialogPayload: null,
  clipLayer: null,
  preview: null,
  strokePreview: null,
  cloneMarker: null,
  editingTextId: null,
  tick: 0,
  uiTick: 0,
});

export const history = new History();

export function invalidate() { store.tick++; }
export function uiRefresh() { store.uiTick++; }

export const activeLayer = computed<Layer | null>(
  () => store.doc?.layers.find(l => l.id === store.doc?.activeLayerId) ?? null,
);

// ---------- layer wrapping ----------

export function rawCanvas(c: HTMLCanvasElement): HTMLCanvasElement {
  return markRaw(c) as HTMLCanvasElement;
}

export function wrapLayer(l: Layer): Layer {
  const wrapped = reactive({ ...l }) as Layer;
  if (wrapped.bitmap) wrapped.bitmap = rawCanvas(wrapped.bitmap);
  if (wrapped.mask) wrapped.mask = rawCanvas(wrapped.mask);
  return wrapped;
}

export function unwrapLayer(l: Layer): Layer {
  return { ...l } as Layer;
}

// ---------- document ----------

export function setDoc(doc: Doc) {
  store.doc = reactive({ ...doc, layers: doc.layers.map(wrapLayer) });
  store.selection = emptySelection(doc);
  history.clear();
  store.dirty = false;
  fitToScreen();
  invalidate();
  uiRefresh();
}

export function newDoc(width: number, height: number, background: 'white' | 'transparent', name: string) {
  const doc: Doc = {
    id: crypto.randomUUID().toUpperCase(),
    width, height, resolution: 72,
    layers: [], activeLayerId: null, fileName: null,
  };
  const bgLayer = makeLayer({ name: background === 'white' ? '背景' : '图层 1' });
  bgLayer.transform = defaultTransform(width, height);
  const c = rawCanvas(makeCanvas(width, height));
  if (background === 'white') {
    const cx = ctx2d(c);
    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, width, height);
  }
  bgLayer.bitmap = c;
  doc.layers.push(bgLayer);
  doc.activeLayerId = bgLayer.id;
  setDoc(doc);
  store.dirty = false;
  if (name) doc.fileName = name;
  uiRefresh();
}

/** Structural change: replace the layers array. */
export function replaceLayers(layers: Layer[], activeId?: string | null) {
  if (!store.doc) return;
  store.doc.layers = layers.map(wrapLayer);
  if (activeId) store.doc.activeLayerId = activeId;
  store.dirty = true;
  invalidate();
  uiRefresh();
}

function snapshotStructure(): { layers: Layer[]; activeId: string | null } {
  return {
    layers: store.doc!.layers.map(unwrapLayer),
    activeId: store.doc!.activeLayerId,
  };
}

export function pushStructural(label: string, apply: () => void) {
  const before = snapshotStructure();
  apply();
  const after = snapshotStructure();
  history.push({
    label,
    undo: () => replaceLayers(before.layers, before.activeId),
    redo: () => replaceLayers(after.layers, after.activeId),
  });
  store.dirty = true;
  uiRefresh();
}

// ---------- layers ----------

export function addRasterLayer(name?: string, bitmap?: HTMLCanvasElement): Layer | null {
  if (!store.doc) return null;
  const doc = store.doc;
  const layer = makeLayer({ name: name ?? `图层 ${doc.layers.length + 1}` });
  layer.bitmap = rawCanvas(bitmap ?? makeCanvas(doc.width, doc.height));
  layer.transform = defaultTransform(layer.bitmap.width, layer.bitmap.height);
  insertLayerAboveActive(layer);
  return layer;
}

export function insertLayerAboveActive(layer: Layer) {
  if (!store.doc) return;
  const doc = store.doc;
  const idx = doc.layers.findIndex(l => l.id === doc.activeLayerId);
  const insertAt = idx < 0 ? doc.layers.length : idx + 1;
  pushStructural('Add Layer', () => {
    const layers = [...doc.layers];
    layers.splice(insertAt, 0, unwrapLayer(layer));
    doc.layers = layers.map(wrapLayer);
    doc.activeLayerId = layer.id;
  });
}

export function addGroupLayer(): Layer | null {
  if (!store.doc) return null;
  const doc = store.doc;
  const group = makeLayer({ name: `组 ${doc.layers.filter(l => l.isGroup).length + 1}`, isGroup: true });
  group.transform = defaultTransform(doc.width, doc.height);
  insertLayerAboveActive(group);
  return group;
}

export function addAdjustmentLayer(kind: AdjustmentKind): Layer | null {
  if (!store.doc) return null;
  const doc = store.doc;
  const layer = makeLayer({ name: ADJUSTMENT_ZH[kind] });
  layer.adjustment = defaultAdjustment(kind);
  layer.transform = defaultTransform(doc.width, doc.height);
  insertLayerAboveActive(layer);
  return layer;
}

export function deleteLayer(layer: Layer) {
  if (!store.doc) return;
  const doc = store.doc;
  pushStructural('Delete Layer', () => {
    const layers = doc.layers.filter(l => l.id !== layer.id);
    // detach children of a deleted group
    for (const l of layers) if (l.parentId === layer.id) l.parentId = null;
    // release clipping masks pointing here
    for (const l of layers) if (l.maskSourceId === layer.id) l.maskSourceId = null;
    doc.layers = layers.map(wrapLayer);
    if (doc.activeLayerId === layer.id) {
      doc.activeLayerId = doc.layers.length ? doc.layers[doc.layers.length - 1].id : null;
    }
  });
}

export function duplicateLayer(layer: Layer): Layer | null {
  if (!store.doc) return null;
  const copy = makeLayer({
    ...unwrapLayer(layer),
    name: `${layer.name} 副本`,
    id: crypto.randomUUID().toUpperCase(),
  });
  if (copy.bitmap) copy.bitmap = rawCanvas(cloneCanvas(copy.bitmap));
  if (copy.mask) copy.mask = rawCanvas(cloneCanvas(copy.mask));
  insertLayerAboveActive(copy);
  return copy;
}

export function mergeDown(layer: Layer) {
  if (!store.doc) return;
  const doc = store.doc;
  const idx = doc.layers.findIndex(l => l.id === layer.id);
  if (idx <= 0) return;
  const below = doc.layers[idx - 1];
  if (below.isGroup || below.adjustment || layer.isGroup || layer.adjustment) return;
  pushStructural('Merge Down', () => {
    const merged = rasterizePair(below, layer);
    const layers = doc.layers.filter(l => l.id !== layer.id && l.id !== below.id);
    const mergedLayer = makeLayer({
      ...unwrapLayer(below), name: below.name,
      bitmap: rawCanvas(merged),
      mask: null, maskSourceId: null, text: null, shape: null, effects: null, adjustment: null,
    });
    mergedLayer.transform = defaultTransform(merged.width, merged.height);
    const at = idx - 1;
    layers.splice(at, 0, mergedLayer);
    doc.layers = layers.map(wrapLayer);
    doc.activeLayerId = mergedLayer.id;
  });
}

/** Flatten two stacked layers into one doc-sized raster. */
function rasterizePair(below: Layer, above: Layer): HTMLCanvasElement {
  const doc = store.doc!;
  const flat = makeCanvas(doc.width, doc.height);
  const fx = ctx2d(flat);
  const prepared = new Map<string, HTMLCanvasElement>();
  const b = prepareLayer(doc, below, prepared);
  if (b) fx.drawImage(b, 0, 0);
  const a = prepareLayer(doc, above, prepared);
  if (a) {
    fx.globalAlpha = above.opacity;
    fx.drawImage(a, 0, 0);
    fx.globalAlpha = 1;
  }
  return flat;
}

export function flattenDoc(): HTMLCanvasElement {
  if (!store.doc) return makeCanvas(1, 1);
  return composite(store.doc);
}

// ---------- raster edits with history ----------

export function rasterEdit(layer: Layer, label: string, edit: (bitmap: HTMLCanvasElement) => void) {
  const before = snapCanvas(layer.bitmap);
  if (layer.bitmap) edit(layer.bitmap);
  const after = snapCanvas(layer.bitmap);
  history.push({
    label,
    undo: () => { if (layer.bitmap && before) layer.bitmap = rawCanvas(cloneCanvas(before)); invalidate(); uiRefresh(); },
    redo: () => { if (layer.bitmap && after) layer.bitmap = rawCanvas(cloneCanvas(after)); invalidate(); uiRefresh(); },
  });
  store.dirty = true;
  invalidate();
  uiRefresh();
}

// ---------- masks ----------

export function addMask(layer: Layer, revealAll: boolean) {
  if (!store.doc || !layer.bitmap) return;
  const m = rawCanvas(makeCanvas(layer.bitmap.width, layer.bitmap.height));
  const mx = ctx2d(m);
  if (revealAll) {
    mx.fillStyle = '#fff';
    mx.fillRect(0, 0, m.width, m.height);
  }
  layer.mask = m;
  layer.maskEnabled = true;
  layer.maskLinked = true;
  store.dirty = true;
  invalidate();
  uiRefresh();
}

// ---------- text ----------

export function upsertTextBitmap(layer: Layer, text: TextMeta) {
  layer.text = text;
  const bmp = renderTextBitmap(
    text.boxSize ? Math.ceil(text.boxSize[0]) : store.doc!.width,
    text.boxSize ? Math.ceil(text.boxSize[1] * 4) || store.doc!.height : store.doc!.height,
    text,
  );
  layer.bitmap = rawCanvas(bmp);
  layer.transform.size = [bmp.width, bmp.height];
  store.dirty = true;
  invalidate();
  uiRefresh();
}

// ---------- undo/redo ----------

export function undo() {
  if (history.undo()) { store.dirty = true; invalidate(); uiRefresh(); }
}
export function redo() {
  if (history.redo()) { store.dirty = true; invalidate(); uiRefresh(); }
}

// ---------- viewport ----------

export function setZoom(z: number, anchor?: { x: number; y: number }) {
  const newZoom = Math.min(32, Math.max(0.005, z));
  if (anchor) {
    // keep the document point under the anchor stationary
    const docX = (anchor.x - store.panX) / store.zoom;
    const docY = (anchor.y - store.panY) / store.zoom;
    store.panX = anchor.x - docX * newZoom;
    store.panY = anchor.y - docY * newZoom;
  }
  store.zoom = newZoom;
}

export function fitToScreen() {
  if (!store.doc) return;
  const margin = 48;
  const z = Math.min(
    (store.viewW - margin) / store.doc.width,
    (store.viewH - margin) / store.doc.height,
  );
  store.zoom = Math.min(8, Math.max(0.005, z));
  centerCanvas();
}

export function centerCanvas() {
  if (!store.doc) return;
  store.panX = (store.viewW - store.doc.width * store.zoom) / 2;
  store.panY = (store.viewH - store.doc.height * store.zoom) / 2;
}

export function screenToDoc(x: number, y: number): { x: number; y: number } {
  return { x: (x - store.panX) / store.zoom, y: (y - store.panY) / store.zoom };
}

// ---------- appearance helpers ----------

export function pushAppearance(layer: Layer, label: string, props: Partial<Pick<Layer, 'opacity' | 'blendMode' | 'isVisible'>>) {
  const before = { opacity: layer.opacity, blendMode: layer.blendMode, isVisible: layer.isVisible };
  history.push({
    label,
    undo: () => { Object.assign(layer, before); invalidate(); uiRefresh(); },
    redo: () => { Object.assign(layer, props); invalidate(); uiRefresh(); },
  });
  store.dirty = true;
}

export function findLayer(id: string | null): Layer | null {
  return store.doc?.layers.find(l => l.id === id) ?? null;
}

export { defaultEffects };
