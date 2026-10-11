<script setup lang="ts">
// The canvas: checkerboard, the flattened composite scaled by zoom/pan, and an
// overlay canvas (pointer-events: none) carrying the interaction polish —
// brush cursor, eyedropper sample ring, free-transform handles. Pointer events
// route to the active tool with document-space coordinates; wheel zooms
// (anchored) with Ctrl/Alt, pans otherwise. The visible doc-px rect is
// published to core/viewport for rulers/navigator, which can also drive the
// view back through core/navBus. Files dropped on the canvas open/develop/import.

import { onMounted, onUnmounted, ref, watch, computed } from 'vue';
import {
  store, setZoom, fitToScreen, screenToDoc, activeLayer, invalidate, history,
  addRasterLayer, newDoc, rawCanvas, setDoc, rasterEdit,
} from '../core/store';
import { composite } from '../core/compositor';
import {
  transformQuad, pointInQuad, makeCanvas, ctx2d, ctx2dRead, docToLayer, clamp,
} from '../core/canvasUtils';
import { toolFor } from '../tools';
import { lassoKey } from '../tools/select';
import { cropKey } from '../tools/crop';
import { WarpStroke, type WarpParams } from '../tools/warp';
import { BlurBrushSource, blurSigma } from '../tools/blurBrush';
import { isRawPath, developRaw, rawMetadata } from '../core/io/raw';
import { setViewport } from '../core/viewport';
import { navListeners } from '../core/navBus';
import { uiFlags } from '../core/uiFlags';
import { guides, gridSettings, drawGuidesAndGrid } from '../core/guides';
import { floating, commitFloatingSelection, cancelFloatingSelection } from '../core/floating';
import InlineTextEditor from './InlineTextEditor.vue';
import Rulers from './Rulers.vue';
import NavigatorMini from './NavigatorMini.vue';
import type { ToolEvent } from '../tools';
import type { Doc, Layer, LayerTransform } from '../core/types';

const host = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const overlay = ref<HTMLCanvasElement | null>(null);
let composited: HTMLCanvasElement | null = null;
let raf = 0;
let antsPhase = 0;
let antsTimer: number | undefined;
let spaceHeld = false;
let panSession: { x: number; y: number; panX: number; panY: number } | null = null;
let strokeActive = false;
let hoverPt: { x: number; y: number } | null = null;

// dashed-ring window after a [ / ] brush size change
let brushSizeChangedAt = 0;
let brushRingTimer: number | undefined;

// eyedropper HUD state while dragging
let eyedropperDrag: { downColor: string; curColor: string; alt: boolean } | null = null;

// file drop
const dropHover = ref(false);
let unlistenDrop: (() => void) | null = null;

// transform-handle hover cursor
const handleCursor = ref<string | null>(null);

// active inline text editing id (type tool sets store.editingTextId; double-
// click sets uiFlags.editingTextLayerId; both mount InlineTextEditor)
const editingId = computed(() => store.editingTextId ?? uiFlags.editingTextLayerId);

function viewCtx(): CanvasRenderingContext2D | null {
  return canvas.value ? canvas.value.getContext('2d') : null;
}

// ---------- viewport publish (rulers/navigator consume this) ----------

function publishViewport() {
  const doc = store.doc;
  const z = store.zoom;
  setViewport({
    left: doc ? -store.panX / z : 0,
    top: doc ? -store.panY / z : 0,
    width: store.viewW / z,
    height: store.viewH / z,
    scale: z,
    canvasW: doc?.width ?? 0,
    canvasH: doc?.height ?? 0,
  });
}

function resize() {
  if (!host.value || !canvas.value) return;
  const r = host.value.getBoundingClientRect();
  store.viewW = Math.max(1, Math.round(r.width));
  store.viewH = Math.max(1, Math.round(r.height));
  canvas.value.width = store.viewW;
  canvas.value.height = store.viewH;
  if (overlay.value) {
    overlay.value.width = store.viewW;
    overlay.value.height = store.viewH;
  }
  draw();
}

function recomposite() {
  if (!store.doc) { composited = null; return; }
  composited = composite(store.doc, { strokePreview: store.strokePreview });
}

function draw() {
  const ctx = viewCtx();
  if (!ctx) return;
  publishViewport();
  redrawOverlay();
  const w = store.viewW, h = store.viewH;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, w, h);
  if (!store.doc || !composited) return;

  const doc = store.doc;
  const z = store.zoom;

  // checkerboard anchored to the document's top-left, 10 screen px squares scaled by zoom
  const sq = Math.max(4, 10 * Math.max(1, z));
  const ox = store.panX % (sq * 2), oy = store.panY % (sq * 2);
  ctx.save();
  ctx.beginPath();
  ctx.rect(store.panX, store.panY, doc.width * z, doc.height * z);
  ctx.clip();
  for (let y = -sq * 2 + oy; y < doc.height * z + oy + sq * 2; y += sq) {
    for (let x = -sq * 2 + ox; x < doc.width * z + ox + sq * 2; x += sq) {
      const alt = (Math.floor((x - ox) / sq) + Math.floor((y - oy) / sq)) % 2 === 0;
      ctx.fillStyle = alt ? '#595959' : '#4d4d4d';
      ctx.fillRect(x, y, sq, sq);
    }
  }
  ctx.restore();

  // document shadow + edge
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 12;
  ctx.fillStyle = '#000';
  ctx.fillRect(store.panX, store.panY, doc.width * z, doc.height * z);
  ctx.restore();

  // the composite; crisp (nearest) at zoom ≥ 2, as the macOS app does
  ctx.imageSmoothingEnabled = z < 2;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(composited, store.panX, store.panY, doc.width * z, doc.height * z);
  ctx.imageSmoothingEnabled = true;

  // 1px document edge
  ctx.strokeStyle = 'rgba(255,255,255,0.13)';
  ctx.lineWidth = 1;
  ctx.strokeRect(store.panX + 0.5, store.panY + 0.5, doc.width * z - 1, doc.height * z - 1);

  if (z >= 8 && store.showPixelGrid) drawPixelGrid(ctx, z);
  // grid + guides now render in the overlay pass (drawGuidesAndGrid), above the composite

  drawSelectionAnts(ctx, z);
  drawToolOverlays(ctx, z);
  drawTransformBox(ctx, z);
}

function drawPixelGrid(ctx: CanvasRenderingContext2D, z: number) {
  const doc = store.doc!;
  ctx.save();
  ctx.beginPath();
  ctx.rect(store.panX, store.panY, doc.width * z, doc.height * z);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  const startCol = Math.max(0, Math.floor(-store.panX / z));
  const endCol = Math.min(doc.width, Math.ceil((store.viewW - store.panX) / z));
  ctx.beginPath();
  for (let x = startCol; x <= endCol; x++) {
    const sx = Math.round(store.panX + x * z) + 0.5;
    ctx.moveTo(sx, store.panY);
    ctx.lineTo(sx, store.panY + doc.height * z);
  }
  const startRow = Math.max(0, Math.floor(-store.panY / z));
  const endRow = Math.min(doc.height, Math.ceil((store.viewH - store.panY) / z));
  for (let y = startRow; y <= endRow; y++) {
    const sy = Math.round(store.panY + y * z) + 0.5;
    ctx.moveTo(store.panX, sy);
    ctx.lineTo(store.panX + doc.width * z, sy);
  }
  ctx.stroke();
  ctx.restore();
}

function drawSelectionAnts(ctx: CanvasRenderingContext2D, z: number) {
  const sel = store.selection;
  if (!sel?.polygons?.length) return;
  ctx.save();
  ctx.translate(store.panX, store.panY);
  ctx.scale(z, z);
  ctx.lineWidth = 1 / z;
  ctx.strokeStyle = '#000';
  ctx.setLineDash([4 / z, 4 / z]);
  ctx.lineDashOffset = -antsPhase / z;
  drawPolys(ctx, sel.polygons);
  ctx.strokeStyle = '#fff';
  ctx.lineDashOffset = (-antsPhase + 4) / z;
  drawPolys(ctx, sel.polygons);
  ctx.restore();
}

function drawPolys(ctx: CanvasRenderingContext2D, polys: number[][]) {
  for (const poly of polys) {
    ctx.beginPath();
    ctx.moveTo(poly[0], poly[1]);
    for (let i = 2; i < poly.length; i += 2) ctx.lineTo(poly[i], poly[i + 1]);
    ctx.closePath();
    ctx.stroke();
  }
}

function drawToolOverlays(ctx: CanvasRenderingContext2D, z: number) {
  const p = store.preview;
  if (!p) return;
  const X = (dx: number) => store.panX + dx * z;
  const Y = (dy: number) => store.panY + dy * z;
  ctx.save();
  ctx.lineWidth = 1;
  if (p.kind === 'marquee' || p.kind === 'shape') {
    const from = p.from as { x: number; y: number }, to = p.to as { x: number; y: number };
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#fff';
    const x = Math.min(from.x, to.x), y = Math.min(from.y, to.y);
    const w = Math.abs(to.x - from.x), h = Math.abs(to.y - from.y);
    ctx.beginPath();
    if ((p.shape === 'ellipse') || (p.kind === 'shape' && p.shape === 'ellipse')) {
      ctx.ellipse(X(x + w / 2), Y(y + h / 2), w * z / 2, h * z / 2, 0, 0, Math.PI * 2);
    } else {
      ctx.rect(X(x), Y(y), w * z, h * z);
    }
    ctx.stroke();
  } else if (p.kind === 'lasso') {
    const pts = p.points as { x: number; y: number }[];
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(X(pts[0].x), Y(pts[0].y));
    for (const pt of pts.slice(1)) ctx.lineTo(X(pt.x), Y(pt.y));
    ctx.stroke();
  } else if (p.kind === 'gradient') {
    const from = p.from as { x: number; y: number }, to = p.to as { x: number; y: number };
    ctx.strokeStyle = '#fff';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(X(from.x), Y(from.y));
    ctx.lineTo(X(to.x), Y(to.y));
    ctx.stroke();
  } else if (p.kind === 'crop') {
    const r = p.rect as { x: number; y: number; w: number; h: number };
    // darken outside
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, store.viewW, store.viewH);
    ctx.rect(X(r.x), Y(r.y), r.w * z, r.h * z);
    ctx.fill('evenodd');
    // thirds guides
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.setLineDash([]);
    for (let i = 1; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(X(r.x + r.w * i / 3), Y(r.y));
      ctx.lineTo(X(r.x + r.w * i / 3), Y(r.y + r.h));
      ctx.moveTo(X(r.x), Y(r.y + r.h * i / 3));
      ctx.lineTo(X(r.x + r.w), Y(r.y + r.h * i / 3));
      ctx.stroke();
    }
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(X(r.x), Y(r.y), r.w * z, r.h * z);
  }
  ctx.restore();
}

function drawTransformBox(ctx: CanvasRenderingContext2D, z: number) {
  if (handlesActive()) return; // interactive handles live on the overlay canvas
  if (store.tool !== 'move' || !store.doc) return;
  const layer = activeLayer.value;
  if (!layer || layer.adjustment) return;
  const quad = transformQuad(layer.transform);
  ctx.save();
  ctx.strokeStyle = 'rgba(80,160,255,0.9)';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  quad.forEach((pt, i) => (i ? ctx.lineTo(store.panX + pt.x * z, store.panY + pt.y * z)
    : ctx.moveTo(store.panX + pt.x * z, store.panY + pt.y * z)));
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = '#fff';
  for (const pt of quad) {
    ctx.fillRect(store.panX + pt.x * z - 3, store.panY + pt.y * z - 3, 6, 6);
  }
  ctx.restore();
}

// ---------- overlay canvas: brush cursor / eyedropper ring / transform handles ----------

function redrawOverlay() {
  const ctx = overlay.value?.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, store.viewW, store.viewH);
  drawGuidesAndGrid(ctx, store.viewW, store.viewH, store.showGrid);
  drawBrushCursor(ctx);
  drawEyedropperRing(ctx);
  drawTransformHandles(ctx);
}

function paintToolActive(): boolean {
  return store.tool === 'brush' || store.tool === 'eraser' || store.tool === 'clone'
    || store.tool === 'smear';
}

function drawBrushCursor(ctx: CanvasRenderingContext2D) {
  if (!paintToolActive() || !hoverPt) return;
  const size = (store.tool === 'clone' ? store.opts.clone.size
    : store.tool === 'smear' ? store.opts.smear.diameter
      : store.opts.brush.size) * store.zoom;
  const r = Math.max(2, size / 2);
  ctx.save();
  // double stroke: white 2.5 then black 1
  ctx.beginPath();
  ctx.arc(hoverPt.x, hoverPt.y, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // dashed inner ring while the size is being nudged with [ / ]
  if (performance.now() - brushSizeChangedAt < 650) {
    ctx.beginPath();
    ctx.setLineDash([4, 3]);
    ctx.arc(hoverPt.x, hoverPt.y, Math.max(1.5, r - 4), 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
  // clone source crosshair: 7px arms, white 3 + black 1
  if (store.tool === 'clone' && store.cloneMarker) {
    const mx = store.panX + store.cloneMarker.x * store.zoom;
    const my = store.panY + store.cloneMarker.y * store.zoom;
    ctx.save();
    for (const [color, width] of [['rgba(255,255,255,0.95)', 3], ['rgba(0,0,0,0.85)', 1]] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(mx - 7, my); ctx.lineTo(mx + 7, my);
      ctx.moveTo(mx, my - 7); ctx.lineTo(mx, my + 7);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawEyedropperRing(ctx: CanvasRenderingContext2D) {
  if (store.tool !== 'eyedropper' || !eyedropperDrag || !hoverPt) return;
  const { x, y } = hoverPt;
  const R = 46; // 24px rim centered on this radius
  ctx.save();
  ctx.lineWidth = 24;
  ctx.beginPath();
  ctx.arc(x, y, R, Math.PI, Math.PI * 2); // top half: newly sampled
  ctx.strokeStyle = eyedropperDrag.curColor;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI); // bottom half: sampled at pointerdown
  ctx.strokeStyle = eyedropperDrag.downColor;
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.beginPath();
  ctx.arc(x, y, R + 12, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, R - 12, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - R - 12, y);
  ctx.lineTo(x + R + 12, y);
  ctx.stroke();
  ctx.restore();
}

function sampleDocColor(pt: { x: number; y: number }): string | null {
  const comp = composited;
  if (!comp) return null;
  const x = Math.round(pt.x), y = Math.round(pt.y);
  if (x < 0 || y < 0 || x >= comp.width || y >= comp.height) return null;
  const d = ctx2dRead(comp).getImageData(x, y, 1, 1).data;
  return '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
}

// ---------- free-transform handles ----------

interface Pt { x: number; y: number }

function handlesActive(): boolean {
  if (!uiFlags.transformHandles || editingId.value) return false;
  const l = activeLayer.value;
  return !!l && !l.isGroup && !l.adjustment && !!(l.bitmap || l.text || l.shape);
}

function layerAxesDeg(rotation: number): { ex: Pt; ey: Pt } {
  const rad = (rotation * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  return { ex: { x: c, y: s }, ey: { x: -s, y: c } };
}

/** Box quad in doc px [TL, TR, BR, BL]; flips mirror content, not the box. */
function geometricQuadDoc(t: LayerTransform): Pt[] {
  const cx = t.origin[0] + t.size[0] / 2, cy = t.origin[1] + t.size[1] / 2;
  const { ex, ey } = layerAxesDeg(t.rotation);
  const w = t.size[0] / 2, h = t.size[1] / 2;
  return [
    { x: cx - ex.x * w - ey.x * h, y: cy - ex.y * w - ey.y * h },
    { x: cx + ex.x * w - ey.x * h, y: cy + ex.y * w - ey.y * h },
    { x: cx + ex.x * w + ey.x * h, y: cy + ex.y * w + ey.y * h },
    { x: cx - ex.x * w + ey.x * h, y: cy - ex.y * w + ey.y * h },
  ];
}

function docPtToScreen(p: Pt): Pt {
  return { x: store.panX + p.x * store.zoom, y: store.panY + p.y * store.zoom };
}

function midPt(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

interface HandleLayout { quad: Pt[]; rot: Pt }

function handleLayout(l: Layer): HandleLayout {
  const quad = geometricQuadDoc(l.transform).map(docPtToScreen);
  const topMid = midPt(quad[0], quad[1]);
  const { ey } = layerAxesDeg(l.transform.rotation);
  // 28 screen px above top-mid along the layer angle (up = -ey)
  const rot = { x: topMid.x - ey.x * 28, y: topMid.y - ey.y * 28 };
  return { quad, rot };
}

function handlePositions(layout: HandleLayout): { hx: number; hy: number; p: Pt }[] {
  const q = layout.quad;
  return [
    { hx: -1, hy: -1, p: q[0] }, { hx: 1, hy: -1, p: q[1] },
    { hx: 1, hy: 1, p: q[2] }, { hx: -1, hy: 1, p: q[3] },
    { hx: 0, hy: -1, p: midPt(q[0], q[1]) }, { hx: 1, hy: 0, p: midPt(q[1], q[2]) },
    { hx: 0, hy: 1, p: midPt(q[2], q[3]) }, { hx: -1, hy: 0, p: midPt(q[3], q[0]) },
  ];
}

function drawTransformHandles(ctx: CanvasRenderingContext2D) {
  const l = activeLayer.value;
  if (!handlesActive() || !l) return;
  const layout = handleLayout(l);
  const q = layout.quad;
  const topMid = midPt(q[0], q[1]);
  ctx.save();
  ctx.strokeStyle = 'rgba(80,160,255,0.9)';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
  // rotation stem + circular knob
  ctx.beginPath();
  ctx.moveTo(topMid.x, topMid.y);
  ctx.lineTo(layout.rot.x, layout.rot.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(layout.rot.x, layout.rot.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.strokeStyle = '#000';
  ctx.stroke();
  // 8px square handles: white fill, black border
  for (const h of handlePositions(layout)) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.fillRect(h.p.x - 4, h.p.y - 4, 8, 8);
    ctx.strokeRect(h.p.x - 3.5, h.p.y - 3.5, 7, 7);
  }
  ctx.restore();
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

type TransformHit = { mode: 'rotate' } | { mode: 'resize'; hx: number; hy: number } | { mode: 'move' } | null;

function hitTestTransform(p: Pt): TransformHit {
  const l = activeLayer.value;
  if (!handlesActive() || !l) return null;
  const layout = handleLayout(l);
  const q = layout.quad;
  if (dist(p, layout.rot) <= 10) return { mode: 'rotate' };
  for (const h of handlePositions(layout)) {
    if (h.hx !== 0 && h.hy !== 0 && dist(p, h.p) <= 10) return { mode: 'resize', hx: h.hx, hy: h.hy };
  }
  for (const h of handlePositions(layout)) {
    if ((h.hx === 0) !== (h.hy === 0) && dist(p, h.p) <= 10) return { mode: 'resize', hx: h.hx, hy: h.hy };
  }
  const edges: { hx: number; hy: number; a: Pt; b: Pt }[] = [
    { hx: 0, hy: -1, a: q[0], b: q[1] }, { hx: 1, hy: 0, a: q[1], b: q[2] },
    { hx: 0, hy: 1, a: q[2], b: q[3] }, { hx: -1, hy: 0, a: q[3], b: q[0] },
  ];
  for (const e of edges) if (distToSegment(p, e.a, e.b) <= 10) return { mode: 'resize', hx: e.hx, hy: e.hy };
  if (pointInQuad(q, p)) return { mode: 'move' };
  return null;
}

// ---------- transform gestures ----------

interface TransformSnapshot {
  origin: [number, number]; size: [number, number];
  rotation: number; flipX: boolean; flipY: boolean;
}

function snapTransform(l: Layer): TransformSnapshot {
  const t = l.transform;
  return {
    origin: [...t.origin] as [number, number],
    size: [...t.size] as [number, number],
    rotation: t.rotation, flipX: t.flipX, flipY: t.flipY,
  };
}

function applySnapshot(l: Layer, s: TransformSnapshot) {
  const t = l.transform;
  t.origin = [...s.origin] as [number, number];
  t.size = [...s.size] as [number, number];
  t.rotation = s.rotation;
  t.flipX = s.flipX;
  t.flipY = s.flipY;
}

interface TransformGesture {
  layer: Layer;
  before: TransformSnapshot;
  mode: 'move' | 'rotate' | 'resize';
  hx: number; hy: number;
  startDoc: Pt;
  center0: Pt; W0: number; H0: number;
  ex: Pt; ey: Pt;
  startAngle: number;         // pointer angle around center at down, degrees
  gestureFlipX: boolean; gestureFlipY: boolean;
  prevSignU: number; prevSignV: number;
  moved: boolean;
}

let tg: TransformGesture | null = null;

function startTransformGesture(te: ToolEvent): boolean {
  const hit = hitTestTransform(te.screen);
  if (!hit) return false;
  const l = activeLayer.value;
  if (!l) return false;
  const before = snapTransform(l);
  const center: Pt = {
    x: before.origin[0] + before.size[0] / 2,
    y: before.origin[1] + before.size[1] / 2,
  };
  const { ex, ey } = layerAxesDeg(before.rotation);
  tg = {
    layer: l,
    before,
    mode: hit.mode,
    hx: hit.mode === 'resize' ? hit.hx : 0,
    hy: hit.mode === 'resize' ? hit.hy : 0,
    startDoc: { ...te.doc },
    center0: center,
    W0: before.size[0], H0: before.size[1],
    ex, ey,
    startAngle: (Math.atan2(te.doc.y - center.y, te.doc.x - center.x) * 180) / Math.PI,
    gestureFlipX: false, gestureFlipY: false,
    prevSignU: 0, prevSignV: 0,
    moved: false,
  };
  return true;
}

function updateTransformGesture(te: ToolEvent) {
  const g = tg;
  if (!g) return;
  g.moved = true;
  const t = g.layer.transform;
  if (g.mode === 'move') {
    let dx = te.doc.x - g.startDoc.x, dy = te.doc.y - g.startDoc.y;
    if (te.shift) { // axis lock
      if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0;
    }
    t.origin = [g.before.origin[0] + dx, g.before.origin[1] + dy];
  } else if (g.mode === 'rotate') {
    const cur = (Math.atan2(te.doc.y - g.center0.y, te.doc.x - g.center0.x) * 180) / Math.PI;
    let rot = cur - (g.startAngle - g.before.rotation);
    if (te.shift) rot = Math.round(rot / 15) * 15; // 15° steps
    t.rotation = ((rot % 360) + 540) % 360 - 180;
  } else {
    updateResize(g, te, t);
  }
  store.dirty = true;
  store.tick++;
}

function updateResize(g: TransformGesture, te: ToolEvent, t: LayerTransform) {
  const corner = g.hx !== 0 && g.hy !== 0;
  const anchor: Pt = te.alt
    ? g.center0
    : {
        x: g.center0.x - g.ex.x * g.hx * g.W0 / 2 - g.ey.x * g.hy * g.H0 / 2,
        y: g.center0.y - g.ex.y * g.hx * g.W0 / 2 - g.ey.y * g.hy * g.H0 / 2,
      };
  const vx = te.doc.x - anchor.x, vy = te.doc.y - anchor.y;
  const u = vx * g.ex.x + vy * g.ex.y; // local-axis projection
  const v = vx * g.ey.x + vy * g.ey.y;

  // crossing past the anchor flips the content
  if (!(corner && te.shift)) {
    if (g.hx !== 0) {
      const su = Math.sign(u);
      if (su !== 0 && g.prevSignU !== 0 && su !== g.prevSignU) g.gestureFlipX = !g.gestureFlipX;
      if (su !== 0) g.prevSignU = su;
    }
    if (g.hy !== 0) {
      const sv = Math.sign(v);
      if (sv !== 0 && g.prevSignV !== 0 && sv !== g.prevSignV) g.gestureFlipY = !g.gestureFlipY;
      if (sv !== 0) g.prevSignV = sv;
    }
  }

  let W1: number, H1: number, cx: number, cy: number;
  if (corner && te.shift) {
    // proportional: diagonal projection onto the start corner direction
    const dxL = g.hx * g.W0, dyL = g.hy * g.H0;
    const len2 = dxL * dxL + dyL * dyL || 1;
    let scale = (u * dxL + v * dyL) / len2;
    if (Math.abs(scale) < 0.02) scale = scale < 0 ? -0.02 : 0.02;
    W1 = Math.max(1, Math.abs(g.W0 * scale));
    H1 = Math.max(1, Math.abs(g.H0 * scale));
    cx = anchor.x + g.ex.x * 0.5 * scale * dxL + g.ey.x * 0.5 * scale * dyL;
    cy = anchor.y + g.ex.y * 0.5 * scale * dxL + g.ey.y * 0.5 * scale * dyL;
  } else if (te.alt) {
    // center anchor: symmetric box, ×2 span around the center
    W1 = g.hx !== 0 ? Math.max(1, Math.abs(u) * 2) : g.W0;
    H1 = g.hy !== 0 ? Math.max(1, Math.abs(v) * 2) : g.H0;
    cx = g.center0.x;
    cy = g.center0.y;
  } else {
    // anchored at the opposite handle/edge
    const cdx = g.center0.x - anchor.x, cdy = g.center0.y - anchor.y;
    const U = g.hx !== 0 ? u : cdx * g.ex.x + cdy * g.ex.y;
    const V = g.hy !== 0 ? v : cdx * g.ey.x + cdy * g.ey.y;
    W1 = g.hx !== 0 ? Math.max(1, Math.abs(U)) : g.W0;
    H1 = g.hy !== 0 ? Math.max(1, Math.abs(V)) : g.H0;
    cx = anchor.x + g.ex.x * U / 2 + g.ey.x * V / 2;
    cy = anchor.y + g.ex.y * U / 2 + g.ey.y * V / 2;
  }
  t.size = [W1, H1];
  t.origin = [cx - W1 / 2, cy - H1 / 2];
  t.flipX = g.before.flipX !== g.gestureFlipX;
  t.flipY = g.before.flipY !== g.gestureFlipY;
}

function finishTransformGesture() {
  const g = tg;
  tg = null;
  if (!g) return;
  if (g.moved) {
    const before = g.before;
    const after = snapTransform(g.layer);
    const layer = g.layer;
    history.push({
      label: '变换',
      undo: () => { applySnapshot(layer, before); store.dirty = true; store.tick++; },
      redo: () => { applySnapshot(layer, after); store.dirty = true; store.tick++; },
    });
    store.dirty = true;
  }
  redrawOverlay();
}

function cursorForHit(hit: TransformHit): string | null {
  if (!hit) return null;
  if (hit.mode === 'rotate') return 'grab';
  if (hit.mode === 'move') return 'move';
  const l = activeLayer.value;
  if (!l) return null;
  const { ex, ey } = layerAxesDeg(l.transform.rotation);
  const dir = { x: ex.x * hit.hx + ey.x * hit.hy, y: ex.y * hit.hx + ey.y * hit.hy };
  if (dir.x === 0 && dir.y === 0) return 'move';
  const a = (((Math.atan2(dir.y, dir.x) * 180) / Math.PI) % 180 + 180) % 180;
  if (a < 22.5 || a >= 157.5) return 'ew-resize';
  if (a < 67.5) return 'nwse-resize';
  if (a < 112.5) return 'ns-resize';
  return 'nesw-resize';
}

function updateHandleCursor() {
  handleCursor.value = hoverPt ? cursorForHit(hitTestTransform(hoverPt)) : null;
}

// ---------- smear tool (liquify / smudge / blur) ----------

interface SmearSession {
  layer: Layer;
  target: 'image' | 'mask';
  mode: 'liquify' | 'smudge' | 'blur';
  params: WarpParams;              // diameter already converted to layer px
  pristine: HTMLCanvasElement;     // the untouched bitmap/mask object (restored at commit)
  lastLocal: Pt;
  warp: WarpStroke | null;         // liquify / smudge working copy
  blurSrc: BlurBrushSource | null; // blur: one-shot pre-blurred snapshot of the pristine layer
  overlay: HTMLCanvasElement | null; // blur: layer-local dab accumulator
  ox: CanvasRenderingContext2D | null;
  scratch: HTMLCanvasElement;
  sx: CanvasRenderingContext2D;
  painted: boolean;
}

let smear: SmearSession | null = null;

function smearLocal(s: SmearSession, docPt: Pt): Pt {
  return docToLayer(
    {
      ...s.layer.transform,
      naturalWidth: s.pristine.width, naturalHeight: s.pristine.height,
    },
    docPt,
  );
}

function beginSmearStroke(te: ToolEvent): void {
  smear = null;
  const layer = activeLayer.value;
  if (!store.doc || !layer || layer.isGroup || layer.adjustment) return;
  const target: 'image' | 'mask' = store.paintingTarget === 'mask' ? 'mask' : 'image';
  if (target === 'mask' && !layer.mask) return;
  if (target === 'image' && !layer.bitmap) return;
  const base = target === 'mask' ? layer.mask! : layer.bitmap!;
  const o = store.opts.smear;
  const layerScale = (layer.transform.size[0] / base.width) || 1; // doc px per layer px
  const params: WarpParams = {
    diameter: Math.max(2, o.diameter / layerScale),
    hardness: o.hardness,
    strength: o.strength,
  };
  const scratch = makeCanvas(4, 4);
  const s: SmearSession = {
    layer, target, mode: o.mode, params, pristine: base,
    lastLocal: { x: 0, y: 0 },
    warp: null, blurSrc: null, overlay: null, ox: null,
    scratch, sx: ctx2d(scratch),
    painted: false,
  };
  const local = smearLocal(s, te.doc);
  s.lastLocal = local;
  s.painted = true;

  if (s.mode === 'blur') {
    const sigma = blurSigma(o.diameter / 2, layerScale, Math.min(base.width, base.height));
    // whole-layer rect: the one-shot snapshot stays honest for wandering strokes
    s.blurSrc = new BlurBrushSource(base, { x: 0, y: 0, w: base.width, h: base.height }, sigma);
    const overlayCanvas = rawCanvas(makeCanvas(base.width, base.height));
    s.overlay = overlayCanvas;
    s.ox = ctx2d(overlayCanvas);
    store.strokePreview = { layerId: layer.id, canvas: overlayCanvas };
    stampBlurDab(s, local.x, local.y);
  } else {
    const warp = new WarpStroke(base);
    warp.begin(local.x, local.y, params, s.mode);
    s.warp = warp;
    // live preview: the composited bitmap/mask IS the mutated working copy for
    // the duration of the stroke; the pristine object is swapped back at commit
    // (a strokePreview overlay would stack the warp on the unwarped pixels)
    if (target === 'image') layer.bitmap = rawCanvas(warp.canvas);
    else layer.mask = rawCanvas(warp.canvas);
  }
  smear = s;
  store.tick++;
}

function dragSmear(te: ToolEvent): void {
  const s = smear;
  if (!s) return;
  const local = smearLocal(s, te.doc);
  s.painted = true;
  if (s.warp) {
    s.warp.stroke(s.lastLocal.x, s.lastLocal.y, local.x, local.y, s.params,
      s.mode === 'smudge' ? 'smudge' : 'liquify');
  } else if (s.ox) {
    smearLineStamps(s, s.lastLocal, local);
  }
  s.lastLocal = local;
  store.tick++;
}

/** Paint `source` into the layer mask with a before/after ImageData history entry. */
function commitMaskEdit(layer: Layer, label: string, source: HTMLCanvasElement): void {
  const m = layer.mask;
  if (!m) return;
  const before = ctx2dRead(m).getImageData(0, 0, m.width, m.height);
  ctx2d(m).drawImage(source, 0, 0);
  const after = ctx2dRead(m).getImageData(0, 0, m.width, m.height);
  const restore = (data: ImageData) => () => {
    if (layer.mask) ctx2dRead(layer.mask).putImageData(data, 0, 0);
    store.tick++;
  };
  history.push({ label, undo: restore(before), redo: restore(after) });
  store.dirty = true;
  store.tick++;
}

function finishSmearStroke(): void {
  const s = smear;
  smear = null;
  if (!s) return;
  const layer = s.layer;

  if (s.warp) {
    const result = s.warp.finish();
    // restore the pristine object first so history snapshots the true "before"
    if (s.target === 'image') layer.bitmap = s.pristine;
    else layer.mask = s.pristine;
    if (!s.painted) { store.tick++; return; }
    if (s.target === 'mask') {
      commitMaskEdit(layer, '涂抹', result);
      return;
    }
    rasterEdit(layer, '涂抹', bmp => { ctx2d(bmp).drawImage(result, 0, 0); });
    return;
  }

  // blur mode: an overlay of blurred dabs, committed exactly like a brush stroke
  store.strokePreview = null;
  if (!s.painted || !s.overlay) { store.tick++; return; }
  if (s.target === 'mask' && layer.mask) {
    commitMaskEdit(layer, '模糊笔刷', s.overlay);
    return;
  }
  const overlayCanvas = s.overlay;
  rasterEdit(layer, '模糊笔刷', bmp => { ctx2d(bmp).drawImage(overlayCanvas, 0, 0); });
}

function stampBlurDab(s: SmearSession, x: number, y: number): void {
  const r = Math.max(0.5, s.params.diameter / 2);
  const d = Math.ceil(r * 2 + 2);
  if (s.scratch.width !== d) { s.scratch.width = d; s.scratch.height = d; }
  const sx = s.sx;
  sx.clearRect(0, 0, d, d);
  // the brush's soft-circle shape — hardness falloff carrying the dab strength —
  // with the pre-blurred snapshot stamped through it (source-in)
  const g = sx.createRadialGradient(d / 2, d / 2, 0, d / 2, d / 2, r);
  const core = clamp(s.params.hardness, 0, 0.99);
  const a = clamp(s.params.strength, 0.01, 1);
  g.addColorStop(0, `rgba(255,255,255,${a})`);
  g.addColorStop(core, `rgba(255,255,255,${a})`);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  sx.save();
  sx.fillStyle = g;
  sx.beginPath();
  sx.arc(d / 2, d / 2, r, 0, Math.PI * 2);
  sx.fill();
  const part = s.blurSrc!.renderPart(x - d / 2, y - d / 2, d, d);
  sx.globalCompositeOperation = 'source-in';
  sx.drawImage(part, 0, 0);
  sx.restore();
  s.ox!.drawImage(s.scratch, x - d / 2, y - d / 2);
}

/** Brush/clone spacing cadence: one dab per 15% of the (layer-px) diameter. */
function smearLineStamps(s: SmearSession, from: Pt, to: Pt): void {
  const spacing = Math.max(1, s.params.diameter * 0.15);
  const dx = to.x - from.x, dy = to.y - from.y;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / spacing));
  for (let i = 1; i <= steps; i++) {
    stampBlurDab(s, from.x + (dx * i) / steps, from.y + (dy * i) / steps);
  }
}

// ---------- pointer routing ----------

function toToolEvent(e: PointerEvent): ToolEvent {
  const r = canvas.value!.getBoundingClientRect();
  const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
  return {
    doc: screenToDoc(screen.x, screen.y),
    screen,
    button: e.button,
    shift: e.shiftKey,
    alt: e.altKey,
    ctrl: e.ctrlKey || e.metaKey,
    original: e,
  };
}

function onPointerDown(e: PointerEvent) {
  if (!store.doc || editingId.value) return;
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
  const te = toToolEvent(e);
  if (e.button === 1 || spaceHeld || store.tool === 'hand') {
    panSession = { x: te.screen.x, y: te.screen.y, panX: store.panX, panY: store.panY };
    return;
  }
  if (e.button !== 0) return;
  // A gesture starting on a half-floated selection first commits the float, then
  // proceeds on the fresh state — except the gestures that ARE the float's own
  // move/transform (move tool drag, transform-handle hit). Smear additionally
  // swallows the click so the user strokes again on the committed document.
  if (floating.active) {
    if (store.tool === 'smear' || !(store.tool === 'move' || hitTestTransform(te.screen))) {
      commitFloatingSelection();
      recomposite(); // eyedropper/marquee etc. read pixels/state synchronously
    }
    if (store.tool === 'smear') return;
  }
  if (store.tool === 'eyedropper') {
    const c = sampleDocColor(te.doc);
    eyedropperDrag = { downColor: c ?? store.fg, curColor: c ?? store.fg, alt: e.altKey };
  }
  if (startTransformGesture(te)) return;
  if (store.tool === 'smear') {
    strokeActive = true;
    beginSmearStroke(te);
    return;
  }
  const tool = toolFor(store.tool);
  if (!tool) return;
  strokeActive = true;
  tool.onDown?.(te);
}

function onPointerMove(e: PointerEvent) {
  const r = canvas.value?.getBoundingClientRect();
  if (r) hoverPt = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (panSession) {
    const cur = { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
    store.panX = panSession.panX + (cur.x - panSession.x);
    store.panY = panSession.panY + (cur.y - panSession.y);
    return;
  }
  if (!canvas.value) return;
  const te = toToolEvent(e);
  if (tg) {
    updateTransformGesture(te);
    return;
  }
  if (!strokeActive) {
    toolFor(store.tool)?.onHover?.(te);
    updateHandleCursor();
    redrawOverlay();
    return;
  }
  if (eyedropperDrag) {
    const c = sampleDocColor(te.doc);
    if (c) eyedropperDrag.curColor = c;
  }
  if (smear) {
    dragSmear(te);
    redrawOverlay();
    return;
  }
  toolFor(store.tool)?.onDrag?.(te);
  redrawOverlay();
}

function onPointerUp(e: PointerEvent) {
  if (panSession) { panSession = null; return; }
  if (tg) { finishTransformGesture(); return; }
  if (!strokeActive) return;
  strokeActive = false;
  if (smear) {
    finishSmearStroke();
    redrawOverlay();
    return;
  }
  if (eyedropperDrag) {
    const ed = eyedropperDrag;
    eyedropperDrag = null;
    if (ed.alt) store.bg = ed.curColor; else store.fg = ed.curColor;
  }
  toolFor(store.tool)?.onUp?.(toToolEvent(e));
  redrawOverlay();
}

function hitTextLayer(docPt: Pt): Layer | null {
  const doc = store.doc;
  if (!doc) return null;
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i];
    if (!l.text || !l.isVisible || l.isGroup) continue;
    if (pointInQuad(transformQuad(l.transform), docPt)) return l;
  }
  return null;
}

function onDoubleClick(e: MouseEvent) {
  if (!store.doc || editingId.value) return;
  const te = toToolEvent(e as unknown as PointerEvent);
  const hit = hitTextLayer(te.doc);
  if (hit) {
    uiFlags.editingTextLayerId = hit.id;
    store.editingTextId = hit.id;
    return;
  }
  toolFor(store.tool)?.onDoubleClick?.(te);
}

function onWheel(e: WheelEvent) {
  if (!store.doc) return;
  e.preventDefault();
  const r = canvas.value!.getBoundingClientRect();
  const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (e.ctrlKey || e.altKey) {
    setZoom(store.zoom * Math.exp(-e.deltaY * 0.0015), screen);
  } else {
    store.panX -= e.deltaX;
    store.panY -= e.deltaY;
  }
}

function onKeyDown(e: KeyboardEvent) {
  if (e.code === 'Space' && !spaceHeld) { spaceHeld = true; spaceRef.value = true; }
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement
    || (e.target as HTMLElement | null)?.isContentEditable) return;
  if (lassoKey(e) || cropKey(e)) return;
  if (e.key === 'Escape') {
    // a floating selection cancels first — ahead of transform-gesture revert etc.
    if (floating.active && !editingId.value) {
      tg = null; // an in-flight handle gesture on the float dies with it
      cancelFloatingSelection();
      return;
    }
    if (tg) {
      applySnapshot(tg.layer, tg.before);
      tg = null;
      store.tick++;
      uiFlags.transformHandles = false;
      redrawOverlay();
      return;
    }
    if (uiFlags.transformHandles) {
      uiFlags.transformHandles = false;
      redrawOverlay();
      return;
    }
  }
  if (e.key === 'Enter' && floating.active && !editingId.value) {
    commitFloatingSelection();
    return;
  }
  if (e.key === 'F') {
    store.canvasOnly = !store.canvasOnly;
  }
}

function onKeyUp(e: KeyboardEvent) {
  if (e.code === 'Space') { spaceHeld = false; spaceRef.value = false; }
}

// ---------- navigator drive-back (core/navBus contract) ----------

function onNavCenter(x: number, y: number) {
  if (!store.doc) return;
  store.panX = store.viewW / 2 - x * store.zoom;
  store.panY = store.viewH / 2 - y * store.zoom;
  scheduleDraw(); // the same repaint path a pan gesture takes
}

function onNavSetView(zoom: number, left: number, top: number) {
  // Applied verbatim with no clamping: workspace tab switching calls this right
  // after setDoc — fitToScreen has already run and the view must land exactly.
  store.zoom = zoom;
  store.panX = -left * zoom;
  store.panY = -top * zoom;
  scheduleDraw();
}

// ---------- file drop ----------

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif', 'ico', 'tif', 'tiff']);

function extOf(name: string): string {
  return name.toLowerCase().split('.').pop() ?? '';
}

function baseName(p: string): string {
  const n = p.split(/[\\/]/).pop() ?? p;
  return n.replace(/\.[^.]+$/, '') || '导入图层';
}

function placeAsLayer(name: string, c: HTMLCanvasElement, docPt: Pt) {
  if (store.doc) {
    const layer = addRasterLayer(name, rawCanvas(c));
    if (layer) layer.transform.origin = [Math.round(docPt.x), Math.round(docPt.y)];
    store.tick++;
    return;
  }
  newDoc(c.width, c.height, 'transparent', name);
  const doc = store.doc as Doc | null; // defeat stale null-narrowing across the call
  if (doc) {
    doc.layers[0].bitmap = rawCanvas(c);
    doc.layers[0].name = name;
    store.tick++;
  }
}

async function importDroppedPath(path: string, docPt: Pt): Promise<void> {
  const ext = extOf(path);
  if (ext === 'comp') {
    const { openComp } = await import('../core/io/comp');
    setDoc(await openComp(path));
    return;
  }
  if (isRawPath(path)) {
    let temperature = 5000;
    try { temperature = (await rawMetadata(path)).asShotTemperature ?? 5000; } catch { /* keep fallback */ }
    placeAsLayer(baseName(path), await developRaw(path, { exposure: 0, temperature, tint: 0, boost: 1 }), docPt);
    return;
  }
  if (IMAGE_EXTS.has(ext)) {
    const { openImageFile } = await import('../core/io/raster');
    placeAsLayer(baseName(path), await openImageFile(path), docPt);
    return;
  }
  throw new Error(`不支持的文件类型“.${ext}”`);
}

async function handleDroppedPaths(paths: string[], screenPt: Pt): Promise<void> {
  const docPt = screenToDoc(screenPt.x, screenPt.y);
  for (const p of paths) {
    try {
      await importDroppedPath(p, docPt);
    } catch (err) {
      alert(`无法导入 ${baseName(p)}：${(err as Error).message}`);
    }
  }
}

/** Tauri (dragDropEnabled default) delivers drops with real file paths. */
async function setupTauriDrop() {
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    unlistenDrop = await getCurrentWebview().onDragDropEvent(ev => {
      const p = ev.payload;
      if (p.type === 'enter' || p.type === 'over') {
        dropHover.value = true;
        return;
      }
      if (p.type === 'leave') {
        dropHover.value = false;
        return;
      }
      dropHover.value = false;
      const r = host.value?.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const sx = r ? p.position.x / dpr - r.left : store.viewW / 2;
      const sy = r ? p.position.y / dpr - r.top : store.viewH / 2;
      if (p.paths.length) void handleDroppedPaths(p.paths, { x: sx, y: sy });
    });
  } catch {
    // plain-browser dev: the HTML5 handlers below are the fallback
  }
}

function onDragOverHtml() {
  dropHover.value = true;
}

function onDragLeaveHtml(e: DragEvent) {
  if (!e.relatedTarget || !(host.value?.contains(e.relatedTarget as Node) ?? false)) {
    dropHover.value = false;
  }
}

async function onDropHtml(e: DragEvent) {
  dropHover.value = false;
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (!files.length) return;
  const r = host.value?.getBoundingClientRect();
  const docPt = screenToDoc(e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0));
  for (const f of files) {
    try {
      const path = (f as File & { path?: string }).path;
      if (path) {
        await importDroppedPath(path, docPt);
        continue;
      }
      const ext = extOf(f.name);
      if (ext === 'comp') throw new Error('浏览器模式无法读取项目文件夹，请使用“文件 → 打开 Compositor 项目”');
      if (isRawPath(f.name)) throw new Error('RAW 文件需要通过应用窗口拖入');
      if (!(f.type.startsWith('image/') || IMAGE_EXTS.has(ext))) throw new Error(`不支持的文件类型“.${ext}”`);
      const bmp = await createImageBitmap(f);
      const c = makeCanvas(bmp.width, bmp.height);
      ctx2d(c).drawImage(bmp, 0, 0);
      bmp.close();
      placeAsLayer(baseName(f.name), c, docPt);
    } catch (err) {
      alert(`无法导入 ${f.name}：${(err as Error).message}`);
    }
  }
}

// ---------- lifecycle ----------

watch(() => store.tick, () => {
  recomposite();
  scheduleDraw();
});
watch(() => [store.panX, store.panY, store.zoom, store.preview, store.canvasOnly, store.selection], () => {
  scheduleDraw();
}, { deep: true });

watch(() => [store.opts.brush.size, store.opts.clone.size, store.opts.smear.diameter], () => {
  brushSizeChangedAt = performance.now();
  window.clearTimeout(brushRingTimer);
  brushRingTimer = window.setTimeout(() => redrawOverlay(), 700);
  redrawOverlay();
});

watch(() => [uiFlags.transformHandles, store.doc?.activeLayerId, editingId.value], () => {
  updateHandleCursor();
  redrawOverlay();
});

// leaving the float's own interactions (move tool / handles) commits it; 'move'
// is exempt so a command may begin the float and hand over to the move tool
watch(() => store.tool, t => {
  if (floating.active && t !== 'move') commitFloatingSelection();
});

// guides + grid settings only affect the overlay paint — overlay-only redraw
watch(guides, () => redrawOverlay());
watch(gridSettings, () => redrawOverlay());

function scheduleDraw() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    draw();
  });
}

onMounted(() => {
  window.addEventListener('resize', resize);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  if (host.value) {
    new ResizeObserver(resize).observe(host.value);
  }
  resize();
  fitToScreen();
  antsTimer = window.setInterval(() => {
    if (store.selection?.polygons?.length) {
      antsPhase = (antsPhase + 1) % 8;
      scheduleDraw();
    }
  }, 90);
  navListeners.center.add(onNavCenter);
  navListeners.setView.add(onNavSetView);
  void setupTauriDrop();
});

onUnmounted(() => {
  window.removeEventListener('resize', resize);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  navListeners.center.delete(onNavCenter);
  navListeners.setView.delete(onNavSetView);
  unlistenDrop?.();
  unlistenDrop = null;
  if (antsTimer) clearInterval(antsTimer);
  if (raf) cancelAnimationFrame(raf);
  window.clearTimeout(brushRingTimer);
});

// expose for other modules that need a redraw nudge
defineExpose({ invalidate, recomposite });

const spaceRef = ref(false);
const cursorStyle = computed(() => {
  if (spaceRef.value) return 'grab';
  if (handleCursor.value) return handleCursor.value;
  const map: Record<string, string> = {
    move: 'move', hand: 'grab', zoom: 'zoom-in', type: 'text',
    eyedropper: 'crosshair', brush: 'none', eraser: 'none', clone: 'none', smear: 'none',
  };
  return map[store.tool] ?? 'crosshair';
});
</script>

<template>
  <div
    ref="host"
    class="canvas-host"
    :class="{ 'canvas-only': store.canvasOnly }"
    @dragenter.prevent="onDragOverHtml"
    @dragover.prevent="onDragOverHtml"
    @dragleave="onDragLeaveHtml"
    @drop.prevent="onDropHtml"
  >
    <canvas
      ref="canvas"
      :style="{ cursor: cursorStyle }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @dblclick="onDoubleClick"
      @wheel="onWheel"
      @contextmenu.prevent
    />
    <canvas ref="overlay" class="overlay-canvas" />
    <InlineTextEditor v-if="editingId" :key="editingId" :layer-id="editingId" />
    <div v-if="dropHover" class="drop-overlay"></div>
    <!-- overlays assume this host's rect == the canvas viewport area; they are
         absolutely positioned with their own z-index and pointer-event policy -->
    <Rulers v-if="uiFlags.showRulers" />
    <NavigatorMini />
    <div v-if="floating.active" class="floating-hint">自由变换中：拖动移动 · Enter 提交 · Esc 取消</div>
  </div>
</template>

<style scoped>
.canvas-host {
  position: relative;
  flex: 1;
  overflow: hidden;
  background: #1e1e1e;
}
.canvas-host canvas {
  display: block;
  touch-action: none;
}
.overlay-canvas {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
  z-index: 3;
}
.drop-overlay {
  position: absolute;
  inset: 6px;
  border: 3px solid #4da3ff;
  border-radius: 10px;
  background: rgba(77, 163, 255, 0.08);
  box-shadow: inset 0 0 0 1px rgba(77, 163, 255, 0.4);
  pointer-events: none;
  z-index: 8;
}
.floating-hint {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  z-index: 20;
  pointer-events: none;
  font-size: 12px;
  color: #ddd;
  background: rgba(30, 30, 30, 0.85);
  border: 1px solid #000;
  border-radius: 4px;
  padding: 4px 10px;
  white-space: nowrap;
  user-select: none;
}
</style>
