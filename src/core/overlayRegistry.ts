// Canvas overlay registry. CanvasView's draw loop calls every registered
// renderer after the composite and built-in tool previews have been drawn.
// Features that need custom canvas overlays (pen paths, quick-mask rubylith,
// onion skin, clone/heal source markers…) register here instead of editing
// CanvasView — one shared file, zero merge conflicts.
//
// Contract: renderers draw in SCREEN space and receive the document→screen
// mappers X/Y (X(docX) = store.panX + docX * zoom). Save/restore your own ctx
// state; clearRect is done for you each frame. Re-render happens on every
// store.tick — read live state inside the renderer, don't cache stale data.

export type OverlayDraw = (
  ctx: CanvasRenderingContext2D,
  z: number,
  X: (dx: number) => number,
  Y: (dy: number) => number,
) => void;

const overlays = new Map<string, OverlayDraw>();

export function registerOverlay(id: string, draw: OverlayDraw): void {
  overlays.set(id, draw);
}

export function unregisterOverlay(id: string): void {
  overlays.delete(id);
}

export function drawRegisteredOverlays(
  ctx: CanvasRenderingContext2D,
  z: number,
  X: (dx: number) => number,
  Y: (dy: number) => number,
): void {
  for (const draw of overlays.values()) draw(ctx, z, X, Y);
}
