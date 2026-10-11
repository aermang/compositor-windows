// Crop tool: drag a rect with edge handles, ratio presets in the tool options
// header. Enter or double-click applies (shifting every layer's origin — pixels
// are untouched, so it stays non-destructive); Esc cancels.

import { store, history } from '../core/store';
import { clamp } from '../core/canvasUtils';
import type { Tool, ToolEvent } from './index';

export interface CropRect { x: number; y: number; w: number; h: number }

export const cropTool: Tool = {
  id: 'crop',
  cursor: 'crosshair',
  onDown(e) {
    if (!store.doc) return;
    const cur = store.preview?.kind === 'crop' ? store.preview.rect as CropRect : null;
    if (cur) {
      const handle = cropHandleAt(cur, e.doc, handleTolerance());
      if (handle) {
        beginResize(handle, cur, e);
        return;
      }
      if (e.doc.x > cur.x && e.doc.x < cur.x + cur.w && e.doc.y > cur.y && e.doc.y < cur.y + cur.h) {
        beginMove(cur, e);
        return;
      }
    }
    const rect: CropRect = { x: e.doc.x, y: e.doc.y, w: 0, h: 0 };
    store.preview = { kind: 'crop', rect };
    const start = { ...e.doc };
    track(ev => {
      rect.x = Math.min(start.x, ev.doc.x);
      rect.y = Math.min(start.y, ev.doc.y);
      rect.w = Math.abs(ev.doc.x - start.x);
      rect.h = Math.abs(ev.doc.y - start.y);
      store.preview = { kind: 'crop', rect: { ...rect } };
    }, () => {
      if (rect.w < 2 || rect.h < 2) store.preview = null;
    });
  },
  onDoubleClick() {
    if (store.preview?.kind === 'crop') applyCrop(store.preview.rect as CropRect);
  },
};

function handleTolerance(): number {
  return 8 / store.zoom;
}

function cropHandleAt(rect: CropRect, p: { x: number; y: number }, tol: number): string | null {
  const near = (a: number, b: number) => Math.abs(a - b) <= tol;
  const x = rect.x, y = rect.y, r = x + rect.w, b = y + rect.h;
  if (near(p.x, x) && near(p.y, y)) return 'nw';
  if (near(p.x, r) && near(p.y, y)) return 'ne';
  if (near(p.x, x) && near(p.y, b)) return 'sw';
  if (near(p.x, r) && near(p.y, b)) return 'se';
  if (near(p.y, y) && p.x > x && p.x < r) return 'n';
  if (near(p.y, b) && p.x > x && p.x < r) return 's';
  if (near(p.x, x) && p.y > y && p.y < b) return 'w';
  if (near(p.x, r) && p.y > y && p.y < b) return 'e';
  return null;
}

function beginResize(handle: string, rect: CropRect, e: ToolEvent) {
  const start = { ...rect };
  const origin = { ...e.doc };
  track(ev => {
    const dx = ev.doc.x - origin.x, dy = ev.doc.y - origin.y;
    let { x, y, w, h } = start;
    if (handle.includes('e')) w = Math.max(1, start.w + dx);
    if (handle.includes('s')) h = Math.max(1, start.h + dy);
    if (handle.includes('w')) { w = Math.max(1, start.w - dx); x = start.x + (start.w - w); }
    if (handle.includes('n')) { h = Math.max(1, start.h - dy); y = start.y + (start.h - h); }
    const ratio = store.opts.crop.ratio;
    const [rw, rh] = ratioValue(ratio);
    if (rw && rh && w > 1 && h > 1) {
      // hold the dragged axis, fit the other
      if (Math.abs(dx) > Math.abs(dy)) h = w * rh / rw; else w = h * rw / rh;
    }
    rect.x = x; rect.y = y; rect.w = w; rect.h = h;
    store.preview = { kind: 'crop', rect: { ...rect } };
  });
}

function beginMove(rect: CropRect, e: ToolEvent) {
  const start = { x: rect.x, y: rect.y };
  const origin = { ...e.doc };
  track(ev => {
    rect.x = start.x + (ev.doc.x - origin.x);
    rect.y = start.y + (ev.doc.y - origin.y);
    store.preview = { kind: 'crop', rect: { ...rect } };
  });
}

function ratioValue(ratio: string): [number, number] {
  if (ratio === 'free') return [0, 0];
  const [a, b] = ratio.split(':').map(Number);
  return [a || 0, b || 0];
}

/** Wire drag continuation into the canvas view's move/up events. */
type MoveHandler = (e: ToolEvent) => void;
type UpHandler = (e: ToolEvent) => void;
let moveHandler: MoveHandler | null = null;
let upHandler: UpHandler | null = null;

function track(onMove: MoveHandler, onUp?: UpHandler) {
  moveHandler = onMove;
  upHandler = onUp ?? null;
  installRouter();
}

function installRouter() {
  if (cropTool.onDrag) return;
  cropTool.onDrag = e => moveHandler?.(e);
  cropTool.onUp = e => {
    moveHandler = null;
    const up = upHandler;
    upHandler = null;
    up?.(e);
  };
}

/** Keyboard hook: Enter applies, Esc cancels. */
export function cropKey(e: KeyboardEvent): boolean {
  if (store.preview?.kind !== 'crop') return false;
  if (e.key === 'Enter') { applyCrop(store.preview.rect as CropRect); return true; }
  if (e.key === 'Escape') { store.preview = null; return true; }
  return false;
}

/** Snapshot of doc size + per-layer origins/mask placements for crop undo. */
interface CropState {
  width: number;
  height: number;
  origins: [number, number][];
  placements: ([number, number] | null)[];
}

export function applyCrop(rect: CropRect) {
  const doc = store.doc;
  if (!doc) return;
  store.preview = null;
  const x = Math.round(clamp(rect.x, 0, doc.width - 2));
  const y = Math.round(clamp(rect.y, 0, doc.height - 2));
  const w = Math.round(Math.min(rect.w, doc.width - x));
  const h = Math.round(Math.min(rect.h, doc.height - y));
  if (w < 1 || h < 1) return;

  const before: CropState = {
    width: doc.width, height: doc.height,
    origins: doc.layers.map(l => [...l.transform.origin] as [number, number]),
    placements: doc.layers.map(l => (l.maskPlacement ? [...l.maskPlacement.origin] as [number, number] : null)),
  };
  const after: CropState = {
    width: w, height: h,
    origins: doc.layers.map(() => [0, 0] as [number, number]),
    placements: doc.layers.map(() => null),
  };

  const apply = (state: CropState) => {
    doc.width = state.width;
    doc.height = state.height;
    doc.layers.forEach((l, i) => {
      l.transform.origin = [...state.origins[i]];
      if (l.maskPlacement && state.placements[i]) l.maskPlacement.origin = [...state.placements[i]!];
    });
    store.selection = null;
    store.tick++;
    store.uiTick++;
  };

  // compute the after state, then apply it
  doc.layers.forEach((_, i) => {
    after.origins[i] = [before.origins[i][0] - x, before.origins[i][1] - y];
    if (before.placements[i]) after.placements[i] = [before.placements[i]![0] - x, before.placements[i]![1] - y];
  });
  apply(after);
  history.push({
    label: 'Crop',
    undo: () => apply(before),
    redo: () => apply(after),
  });
  store.dirty = true;
}
