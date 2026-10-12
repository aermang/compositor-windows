// Dodge / Burn / Sponge: a session brush that rewrites pixels in place.
// Same session pattern as heal.ts: the bitmap at stroke start is kept as the
// pristine reference, each dab stamps *processed replacement pixels* (with the
// radial profile in the alpha channel) into a layer-local overlay published via
// store.strokePreview for the live compositor merge, and pointer-up commits the
// whole overlay with a single rasterEdit. Only RGB is ever touched — the layer's
// own alpha comes out untouched because the stamp alpha itself scales with the
// source pixel's alpha. Pixels are processed at full strength and the radial
// falloff lives entirely in the stamp alpha: for a pixel covered once that is
// byte-identical to processing with k = strength·w, and overlapping dabs along
// the path blend equal colours source-over, so they saturate at one full-strength
// pass instead of diluting each other (re-apply by stroking again).

import { store, activeLayer, rasterEdit, rawCanvas } from '../core/store';
import { makeCanvas, ctx2d, ctx2dRead, docToLayer, clamp } from '../core/canvasUtils';
import type { Layer } from '../core/types';
import type { Tool, ToolEvent } from './index';

interface DodgeSession {
  layer: Layer;
  mode: 'dodge' | 'burn' | 'sponge';
  spongeMode: 'saturate' | 'desaturate';
  strength: number;                 // exposure or spongeFlow, 0..1 (snapshot at stroke start)
  size: number;                     // dab diameter, layer px
  overlay: HTMLCanvasElement;       // layer-local replacement accumulator
  ox: CanvasRenderingContext2D;     // overlay context, layer-local
  pristine: HTMLCanvasElement;      // the bitmap at stroke start (read-only reference)
  clipMask: HTMLCanvasElement | null;
  scratch: HTMLCanvasElement;       // per-dab buffer (processed rect + clip)
  sx: CanvasRenderingContext2D;
  last: { x: number; y: number };
  covered: boolean;                 // at least one dab centre landed on the bitmap
}

let session: DodgeSession | null = null;

/** Radial profile: smoothstep of (1 - t) — 1 at the dab centre, 0 at the rim,
 *  zero slope at both ends (t = dist / radius). */
function profile(t: number): number {
  if (t >= 1) return 0;
  const s = 1 - t;
  return s * s * (3 - 2 * s);
}

function localOf(s: DodgeSession, e: ToolEvent) {
  return docToLayer(
    { ...s.layer.transform, naturalWidth: s.overlay.width, naturalHeight: s.overlay.height },
    e.doc,
  );
}

/** Layer-local copy of the doc-space selection mask for stroke clipping
 *  (same construction as the painting tools'). */
function buildClipMask(layer: Layer): HTMLCanvasElement | null {
  const sel = store.selection;
  if (!sel?.bounds || !layer.bitmap) return null;
  const c = makeCanvas(layer.bitmap.width, layer.bitmap.height);
  const cx = ctx2d(c);
  const t = layer.transform;
  cx.save();
  const [ox, oy] = t.origin;
  const [w, h] = t.size;
  cx.translate(ox + w / 2, oy + h / 2);
  cx.rotate((t.rotation * Math.PI) / 180);
  cx.scale(w / c.width, h / c.height);
  cx.drawImage(sel.mask, -c.width / 2, -c.height / 2);
  cx.restore();
  return c;
}

function beginSession(e: ToolEvent): DodgeSession | null {
  const layer = activeLayer.value;
  if (!store.doc || !layer || layer.isGroup || layer.adjustment) return null;
  if (!layer.bitmap) return null;
  if (store.paintingTarget === 'mask') return null; // v1: image pixels only

  const base = layer.bitmap;
  // the slider size is in document px; strokes live in layer px
  const layerScale = (layer.transform.size[0] / base.width) || 1;
  const o = store.opts.dodge;
  const s: DodgeSession = {
    layer,
    mode: o.mode,
    spongeMode: o.spongeMode,
    strength: (o.mode === 'sponge' ? o.spongeFlow : o.exposure) / 100,
    size: Math.max(2, o.size / layerScale),
    overlay: rawCanvas(makeCanvas(base.width, base.height)),
    ox: ctx2d(makeCanvas(1, 1)), // replaced below; keep types happy
    pristine: base,
    clipMask: buildClipMask(layer),
    scratch: makeCanvas(2, 2),
    sx: ctx2d(makeCanvas(1, 1)), // replaced below; keep types happy
    last: { x: 0, y: 0 },
    covered: false,
  };
  s.sx = ctx2d(s.scratch);
  s.ox = ctx2d(s.overlay);
  const local = localOf(s, e);
  s.last = local;
  dab(s, local.x, local.y);
  store.strokePreview = { layerId: layer.id, canvas: s.overlay };
  store.tick++;
  return s;
}

/** One dab: process the pristine pixels under the disc, write the replacement
 *  colour into the scratch with the profile as its alpha, clip through the
 *  selection mask, then accumulate source-over into the overlay. */
function dab(s: DodgeSession, x: number, y: number) {
  const W = s.overlay.width, H = s.overlay.height;
  const r = Math.max(1, s.size / 2);
  if (x < -r || y < -r || x > W + r || y > H + r) return; // fully off-bitmap
  if (x >= 0 && y >= 0 && x < W && y < H) s.covered = true;

  const x0 = clamp(Math.floor(x - r), 0, W), y0 = clamp(Math.floor(y - r), 0, H);
  const x1 = clamp(Math.ceil(x + r), 0, W), y1 = clamp(Math.ceil(y + r), 0, H);
  if (x1 <= x0 || y1 <= y0) return;
  const rw = x1 - x0, rh = y1 - y0;
  if (s.scratch.width !== rw || s.scratch.height !== rh) { s.scratch.width = rw; s.scratch.height = rh; }

  const img = ctx2dRead(s.pristine).getImageData(x0, y0, rw, rh);
  const d = img.data;
  const saturate = s.spongeMode === 'saturate';
  for (let py = 0; py < rh; py++) {
    const dy = y0 + py - y;
    for (let px = 0; px < rw; px++) {
      const i = (py * rw + px) * 4;
      const w = profile(Math.hypot(x0 + px - x, dy) / r);
      if (w <= 0) { d[i + 3] = 0; continue; }
      const k = s.strength; // full strength; falloff rides on the stamp alpha below
      let r0 = d[i], g0 = d[i + 1], b0 = d[i + 2];
      if (s.mode === 'dodge') {
        r0 += (255 - r0) * k; g0 += (255 - g0) * k; b0 += (255 - b0) * k;
      } else if (s.mode === 'burn') {
        r0 *= 1 - k; g0 *= 1 - k; b0 *= 1 - k;
      } else {
        // sponge: keep luminance, move saturation. Rebuild RGB by expanding the
        // [min..max] range around min — high-saturation pushes can clip (v1).
        const mx = Math.max(r0, g0, b0), mn = Math.min(r0, g0, b0);
        const range = mx - mn;
        if (range > 0) {
          const sat = range / 255;
          const sat2 = saturate ? sat + (1 - sat) * k : sat * (1 - k);
          const scale = (sat2 * 255) / range;
          r0 = mn + (r0 - mn) * scale;
          g0 = mn + (g0 - mn) * scale;
          b0 = mn + (b0 - mn) * scale;
        }
      }
      d[i] = r0; d[i + 1] = g0; d[i + 2] = b0;
      // stamp alpha = profile × source alpha: transparent pixels stay transparent
      d[i + 3] = w * d[i + 3];
    }
  }
  s.sx.putImageData(img, 0, 0);
  if (s.clipMask) {
    s.sx.globalCompositeOperation = 'destination-in';
    s.sx.drawImage(s.clipMask, -x0, -y0);
    s.sx.globalCompositeOperation = 'source-over';
  }
  s.ox.drawImage(s.scratch, x0, y0);
}

function lineDabs(s: DodgeSession, from: { x: number; y: number }, to: { x: number; y: number }) {
  const spacing = Math.max(1, s.size / 4); // quarter-diameter cadence per spec
  const dx = to.x - from.x, dy = to.y - from.y;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / spacing));
  for (let i = 1; i <= steps; i++) {
    dab(s, from.x + (dx * i) / steps, from.y + (dy * i) / steps);
  }
}

function commit() {
  const s = session;
  session = null;
  store.strokePreview = null;
  if (!s || !s.covered) { store.tick++; return; } // no coverage → no history entry
  const label = s.mode === 'dodge' ? '减淡' : s.mode === 'burn' ? '加深' : '海绵';
  const overlay = s.overlay;
  rasterEdit(s.layer, label, bmp => {
    ctx2d(bmp).drawImage(overlay, 0, 0);
  });
}

export const dodgeTool: Tool = {
  id: 'dodge',
  cursor: 'crosshair',
  onDown(e) {
    if (!store.doc) return;
    session = beginSession(e);
  },
  onDrag(e) {
    if (!session) return;
    const local = localOf(session, e);
    lineDabs(session, session.last, local);
    session.last = local;
    store.tick++;
  },
  onUp() { commit() },
};
