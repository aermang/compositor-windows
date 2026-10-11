// Shared viewport state published by CanvasView and consumed by overlays
// (rulers, navigator, guides). `left/top/width/height` describe the visible
// document-pixel rect; scale is screen px per doc px (== store.zoom).

import { reactive } from 'vue';

export interface ViewportState {
  left: number; top: number; width: number; height: number;
  scale: number;
  canvasW: number; canvasH: number;
}

export const viewport = reactive<ViewportState>({
  left: 0, top: 0, width: 0, height: 0, scale: 1, canvasW: 0, canvasH: 0,
});

export function setViewport(v: Partial<ViewportState>) { Object.assign(viewport, v); }

export function docToScreen(x: number, y: number): [number, number] {
  return [(x - viewport.left) * viewport.scale, (y - viewport.top) * viewport.scale];
}

export function screenToDoc(x: number, y: number): [number, number] {
  return [x / viewport.scale + viewport.left, y / viewport.scale + viewport.top];
}
