// Tiny navigation event bus: overlay UI (navigator mini-map, rulers) requests
// viewport changes; CanvasView subscribes and applies them. Deliberately
// dependency-free so both sides can import it without cycles.

export const navListeners = {
  /** Ask the canvas to center the view on a document point (doc px). */
  center: new Set<(x: number, y: number) => void>(),
  /** Ask the canvas to show an absolute view: zoom + visible doc-px origin. */
  setView: new Set<(zoom: number, left: number, top: number) => void>(),
};

export function navCenter(x: number, y: number): void {
  for (const fn of navListeners.center) fn(x, y);
}

export function navSetView(zoom: number, left: number, top: number): void {
  for (const fn of navListeners.setView) fn(zoom, left, top);
}
