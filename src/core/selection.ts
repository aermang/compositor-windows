// Selections are a doc-size mask canvas (alpha = coverage) plus traced outline
// polygons for marching ants. Path tools rasterize into the mask; the wand builds
// it from flood fills. Combine ops follow Photoshop's add/subtract/intersect.

import { makeCanvas, ctx2d, ctx2dRead, cloneCanvas } from './canvasUtils';
import { traceMask } from './pixels/wand';
import { dilatePlane, erodePlane } from './pixels/morph';
import type { Doc } from './types';

export type SelectionOp = 'replace' | 'add' | 'sub' | 'intersect';

export interface SelectionState {
  mask: HTMLCanvasElement;                 // doc-size; alpha channel carries coverage
  bounds: { x: number; y: number; w: number; h: number } | null;
  polygons: number[][] | null;              // doc-space outlines for the ants
}

export function emptySelection(doc: Doc): SelectionState {
  return { mask: makeCanvas(doc.width, doc.height), bounds: null, polygons: [] };
}

export function selectionBounds(mask: HTMLCanvasElement): SelectionState['bounds'] {
  const w = mask.width, h = mask.height;
  const d = ctx2dRead(mask).getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function refreshOutline(sel: SelectionState) {
  const w = sel.mask.width, h = sel.mask.height;
  const d = ctx2dRead(sel.mask).getImageData(0, 0, w, h).data;
  const plane = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) plane[p] = d[i + 3];
  sel.polygons = traceMask(plane, w, h);
}

/** Build/modify a selection from a path drawn on a scratch canvas (already doc-space). */
export function combinePath(sel: SelectionState, scratch: HTMLCanvasElement, op: SelectionOp): SelectionState {
  combine(sel, scratch, op);
  return finalize(sel);
}

export function combine(sel: SelectionState, other: HTMLCanvasElement, op: SelectionOp) {
  const mx = ctx2d(sel.mask);
  mx.save();
  switch (op) {
    case 'replace':
      mx.clearRect(0, 0, sel.mask.width, sel.mask.height);
      mx.drawImage(other, 0, 0);
      break;
    case 'add':
      mx.drawImage(other, 0, 0);
      break;
    case 'sub':
      mx.globalCompositeOperation = 'destination-out';
      mx.drawImage(other, 0, 0);
      break;
    case 'intersect':
      mx.globalCompositeOperation = 'destination-in';
      mx.drawImage(other, 0, 0);
      break;
  }
  mx.restore();
}

export function finalize(sel: SelectionState): SelectionState {
  sel.bounds = selectionBounds(sel.mask);
  refreshOutline(sel);
  return sel;
}

export function selectionFromMaskArray(doc: Doc, mask: Uint8Array): SelectionState {
  const sel = emptySelection(doc);
  const id = ctx2dRead(sel.mask).createImageData(doc.width, doc.height);
  for (let p = 0; p < mask.length; p++) {
    const i = p * 4;
    id.data[i] = id.data[i + 1] = id.data[i + 2] = 255;
    id.data[i + 3] = mask[p];
  }
  ctx2dRead(sel.mask).putImageData(id, 0, 0);
  return finalize(sel);
}

export function invertSelection(sel: SelectionState): SelectionState {
  const inv = cloneCanvas(sel.mask);
  const ix = ctx2dRead(inv);
  const id = ix.getImageData(0, 0, inv.width, inv.height);
  for (let i = 0; i < id.data.length; i += 4) {
    id.data[i] = id.data[i + 1] = id.data[i + 2] = 255;
    id.data[i + 3] = 255 - id.data[i + 3];
  }
  ix.putImageData(id, 0, 0);
  sel.mask = inv;
  return finalize(sel);
}

export function featherSelection(sel: SelectionState, radius: number): SelectionState {
  const out = makeCanvas(sel.mask.width, sel.mask.height);
  const ox = ctx2d(out);
  ox.filter = `blur(${radius}px)`;
  ox.drawImage(sel.mask, 0, 0);
  ox.filter = 'none';
  sel.mask = out;
  return finalize(sel);
}

export function growSelection(sel: SelectionState, pixels: number): SelectionState {
  // expand > 0 dilates, contract < 0 erodes, on the alpha plane
  const w = sel.mask.width, h = sel.mask.height;
  const id = ctx2dRead(sel.mask).getImageData(0, 0, w, h);
  const plane = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < id.data.length; i += 4, p++) plane[p] = id.data[i + 3];
  const out = pixels >= 0 ? dilatePlane(plane, w, h, pixels) : erodePlane(plane, w, h, -pixels);
  const nid = ctx2dRead(sel.mask).createImageData(w, h);
  for (let p = 0; p < out.length; p++) {
    nid.data[p * 4] = nid.data[p * 4 + 1] = nid.data[p * 4 + 2] = 255;
    nid.data[p * 4 + 3] = out[p];
  }
  ctx2dRead(sel.mask).putImageData(nid, 0, 0);
  return finalize(sel);
}

export function isEmptySelection(sel: SelectionState | null): boolean {
  return !sel || !sel.bounds;
}

/** Clip a canvas (doc-space content) to the selection, in place on a copy. */
export function applySelectionClip(content: HTMLCanvasElement, sel: SelectionState | null): HTMLCanvasElement {
  if (!sel || !sel.bounds) return content;
  const out = cloneCanvas(content);
  const ox = ctx2d(out);
  ox.globalCompositeOperation = 'destination-in';
  ox.drawImage(sel.mask, 0, 0);
  ox.globalCompositeOperation = 'source-over';
  return out;
}
