// Small canvas + geometry helpers shared across the renderer and tools.

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { willReadFrequently: false });
  if (!ctx) throw new Error('2D context unavailable');
  return ctx;
}

export function ctx2dRead(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D context unavailable');
  return ctx;
}

export function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = makeCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}

export function snapshotCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  return cloneCanvas(src);
}

export interface DocPoint { x: number; y: number }

/** Document-space quad corners of a layer transform (top-left, top-right, bottom-right, bottom-left). */
export function transformQuad(t: {
  origin: [number, number]; size: [number, number]; rotation: number; flipX: boolean; flipY: boolean;
}): DocPoint[] {
  const [ox, oy] = t.origin;
  const [w, h] = t.size;
  const sx = t.flipX ? -1 : 1;
  const sy = t.flipY ? -1 : 1;
  const rad = (t.rotation * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const local: DocPoint[] = [
    { x: -w / 2 * sx, y: -h / 2 * sy }, { x: w / 2 * sx, y: -h / 2 * sy },
    { x: w / 2 * sx, y: h / 2 * sy }, { x: -w / 2 * sx, y: h / 2 * sy },
  ];
  const cx = ox + w / 2, cy = oy + h / 2;
  return local.map(p => ({
    x: cx + p.x * cos - p.y * sin,
    y: cy + p.x * sin + p.y * cos,
  }));
}

/** Inverse of transformQuad's mapping: document point → layer-local pixel. */
export function docToLayer(t: LayerTransformLike, p: DocPoint): DocPoint {
  const [ox, oy] = t.origin;
  const [w, h] = t.size;
  const cx = ox + w / 2, cy = oy + h / 2;
  const rad = (-t.rotation * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = p.x - cx, dy = p.y - cy;
  const rx = dx * cos - dy * sin, ry = dx * sin + dy * cos;
  const sx = t.flipX ? -1 : 1, sy = t.flipY ? -1 : 1;
  const naturalW = t.naturalWidth ?? w, naturalH = t.naturalHeight ?? h;
  return {
    x: (rx * sx + w / 2) * (naturalW / w),
    y: (ry * sy + h / 2) * (naturalH / h),
  };
}

interface LayerTransformLike {
  origin: [number, number]; size: [number, number]; rotation: number; flipX: boolean; flipY: boolean;
  naturalWidth?: number; naturalHeight?: number; sampling?: string;
}

/** Draw a canvas through a layer transform into a document-space context. */
export function drawThroughTransform(
  ctx: CanvasRenderingContext2D, image: CanvasImageSource,
  naturalW: number, naturalH: number, t: LayerTransformLike,
) {
  const [ox, oy] = t.origin;
  const [w, h] = t.size;
  ctx.save();
  ctx.imageSmoothingEnabled = t.sampling !== 'Nearest';
  ctx.imageSmoothingQuality = t.sampling === 'High quality' ? 'high' : 'low';
  ctx.translate(ox + w / 2, oy + h / 2);
  if (t.rotation) ctx.rotate((t.rotation * Math.PI) / 180);
  const sx = (t.flipX ? -1 : 1) * (w / naturalW);
  const sy = (t.flipY ? -1 : 1) * (h / naturalH);
  ctx.scale(sx, sy);
  ctx.drawImage(image, -naturalW / 2, -naturalH / 2, naturalW, naturalH);
  ctx.restore();
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function pointInQuad(quad: DocPoint[], p: DocPoint): boolean {
  let inside = false;
  for (let i = 0, j = quad.length - 1; i < quad.length; j = i++) {
    const a = quad[i], b = quad[j];
    if ((a.y > p.y) !== (b.y > p.y) &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
