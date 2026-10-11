// Rotate the whole canvas 90°. Pure placement math — bitmaps are never
// resampled: every layer keeps its size, gains ±90° of rotation, and its
// center is rotated about the document center. Doc width/height swap.
//
// Point math (y-down screen coords, doc W×H):
//   CW 90°: (x, y) → (H − y, x)   — old top-left lands on new top-right
//   CCW 90°: (x, y) → (y, W − x)  — old top-left lands on new bottom-left
// (These already include the re-centering onto the swapped document.)
//
// History note: pushStructural only snapshots the layers array, so it cannot
// restore doc.width/height on undo — a rotated-then-undone doc would keep the
// swapped size. Doc-dimension edits in this codebase (Dialogs.vue image/canvas
// size) therefore push a custom history entry capturing w/h + transforms, and
// this module follows that idiom. Guides (view state, outside the doc) are
// remapped inside the same entry so undo/redo stay coherent.

import { store, history, fitToScreen, invalidate, uiRefresh } from './store';
import { guides } from './guides';
import type { CanvasGuide } from './guides';

interface RotateSnapshot {
  w: number;
  h: number;
  origins: [number, number][];
  rotations: number[];
  maskOrigins: ([number, number] | null)[];
  maskRotations: (number | null)[];
  gs: CanvasGuide[];
}

function rotPoint(x: number, y: number, W: number, H: number, cw: boolean): [number, number] {
  return cw ? [H - y, x] : [y, W - x];
}

/** Rotate a box origin about the doc center, keeping its size (no resampling). */
function rotOrigin(
  o: [number, number], size: [number, number], W: number, H: number, cw: boolean,
): [number, number] {
  const [ncx, ncy] = rotPoint(o[0] + size[0] / 2, o[1] + size[1] / 2, W, H, cw);
  return [ncx - size[0] / 2, ncy - size[1] / 2];
}

function rotRotation(r: number, cw: boolean): number {
  return (((cw ? r + 90 : r - 90) % 360) + 360) % 360;
}

function remapGuide(g: CanvasGuide, W: number, H: number, cw: boolean): CanvasGuide {
  if (cw) {
    // h@p → v@(H−p); v@p → h@p
    return g.axis === 'h'
      ? { ...g, axis: 'v', position: H - g.position }
      : { ...g, axis: 'h', position: g.position };
  }
  // h@p → v@p; v@p → h@(W−p)
  return g.axis === 'h'
    ? { ...g, axis: 'v', position: g.position }
    : { ...g, axis: 'h', position: W - g.position };
}

export function rotateCanvas90(clockwise: boolean): void {
  const doc = store.doc;
  if (!doc) return;
  const W = doc.width;
  const H = doc.height;

  const before: RotateSnapshot = {
    w: W,
    h: H,
    origins: doc.layers.map(l => [...l.transform.origin] as [number, number]),
    rotations: doc.layers.map(l => l.transform.rotation),
    maskOrigins: doc.layers.map(l =>
      l.maskPlacement ? ([...l.maskPlacement.origin] as [number, number]) : null),
    maskRotations: doc.layers.map(l => l.maskPlacement ? l.maskPlacement.rotation : null),
    gs: guides.map(g => ({ ...g })),
  };

  // Layer/mask sizes never change, so they are safe to read live while
  // building the "after" state.
  const after: RotateSnapshot = {
    w: H,
    h: W,
    origins: doc.layers.map((l, i) => rotOrigin(before.origins[i], l.transform.size, W, H, clockwise)),
    rotations: before.rotations.map(r => rotRotation(r, clockwise)),
    maskOrigins: doc.layers.map((l, i) => {
      const o = before.maskOrigins[i];
      if (!o || !l.maskPlacement) return null;
      return rotOrigin(o, l.maskPlacement.size, W, H, clockwise);
    }),
    maskRotations: before.maskRotations.map(r => (r === null ? null : rotRotation(r, clockwise))),
    gs: before.gs.map(g => remapGuide(g, W, H, clockwise)),
  };

  const apply = (st: RotateSnapshot): void => {
    doc.width = st.w;
    doc.height = st.h;
    doc.layers.forEach((l, i) => {
      l.transform.origin = [...st.origins[i]];
      l.transform.rotation = st.rotations[i];
      if (l.maskPlacement && st.maskOrigins[i]) {
        l.maskPlacement.origin = [...st.maskOrigins[i]!];
        l.maskPlacement.rotation = st.maskRotations[i]!;
      }
    });
    guides.splice(0, guides.length, ...st.gs.map(g => ({ ...g })));
    store.selection = null;
    store.tick++;
    store.uiTick++;
  };

  apply(after);
  history.push({
    label: clockwise ? '旋转画布 90°（顺时针）' : '旋转画布 90°（逆时针）',
    undo: () => apply(before),
    redo: () => apply(after),
  });
  store.dirty = true;
  fitToScreen();
  invalidate();
  uiRefresh();
}
