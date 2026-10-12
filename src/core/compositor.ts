// The compositor: flattens a document into a single doc-size canvas, handling
// non-destructive transforms, masks, clipping masks, layer effects, all 24 blend
// modes (canvas-native where possible, per-pixel otherwise) and adjustment layers.
// Mirrors Compositor's pipeline: pass-through folders multiply their opacity and
// mask into every child; adjustment layers affect everything composited below.

import { isExoticBlend, pixelBlend } from './blend';
import { applyAdjustment } from './pixels/adjust';
import { dilatePlane } from './pixels/morph';
import { applySmartFilters } from './smartFilter';
import { refreshSmartBitmap } from './smartObject';
import {
  makeCanvas, ctx2d, ctx2dRead, drawThroughTransform, cloneCanvas,
} from './canvasUtils';
import type { Doc, Layer, LayerTransform, EffectsData } from './types';
import { cssBlend, rgbToCss } from './types';

export interface CompositeOpts {
  /** Skip stroke-preview merging (exports) */
  forExport?: boolean;
  /** Extra canvas drawn atop the active layer's own pixels (live brush stroke);
   *  `erase` knocks the layer's own pixels out instead (live eraser stroke). */
  strokePreview?: { layerId: string; canvas: HTMLCanvasElement; erase?: boolean } | null;
}

// ---------- prepareLayer per-layer cache ----------
// 缓存「transform + 智能滤镜 + effects 之后、mask/clip 之前」的画布段:mask 与
// 剪贴蒙版每帧在返回的克隆上现场执行,因此键里不需要任何 mask 相关字段。
// 失效来源:rev(就地像素编辑走 rasterEdit 等 bump)、bitmapUid(画布身份,
// undo/redo 换画布自然失效)、transform 全字段(影响缓存段内的绘制)、
// effects/smartFilters JSON、文档尺寸。opacity/blendMode 在 drawBlended 阶段
// 生效,不入键。宁可键更严格:任何拿不准的场景都让键更宽,正确性优先。

const bitmapUids = new WeakMap<HTMLCanvasElement, number>();
let nextBitmapUid = 1;

function bitmapUid(c: HTMLCanvasElement): number {
  let id = bitmapUids.get(c);
  if (id === undefined) {
    id = nextBitmapUid++;
    bitmapUids.set(c, id);
  }
  return id;
}

interface LayerCacheEntry { key: string; out: HTMLCanvasElement }

const layerCache = new Map<string, LayerCacheEntry>();
const LAYER_CACHE_CAP = 64;

/** 稳定 JSON:递归按对象键排序后序列化,避免键序不同造成伪失效/漏失效。 */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const o = val as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) sorted[k] = o[k];
      return sorted;
    }
    return val;
  });
}

function layerCacheKey(doc: Doc, layer: Layer): string {
  const t = layer.transform;
  return JSON.stringify([
    layer.rev ?? 0,
    bitmapUid(layer.bitmap!),
    stableJson(layer.effects),
    stableJson(layer.smartFilters),
    doc.width, doc.height,
    t.origin[0], t.origin[1], t.size[0], t.size[1],
    t.rotation, t.flipX, t.flipY, t.sampling,
  ]);
}

/** 仅供测试/基准:清空按层缓存(暴露给 e2e 做性能对照)。 */
export function resetPrepareLayerCache(): void {
  layerCache.clear();
}

/** Render the whole document flat. Returns a doc-size canvas. */
export function composite(doc: Doc, opts: CompositeOpts = {}): HTMLCanvasElement {
  const out = makeCanvas(doc.width, doc.height);
  const ctx = ctx2d(out);
  const prepared = new Map<string, HTMLCanvasElement>();
  // folder chain: pass-through → children carry enclosing opacity/mask products
  const chain: Layer[] = [];
  const folderMasks = new Map<string, HTMLCanvasElement | null>();

  for (const layer of doc.layers) {
    // pop folder chain until the layer's parent is on top (or root)
    while (chain.length && chain[chain.length - 1].id !== layer.parentId) chain.pop();
    if (layer.isGroup) { chain.push(layer); continue; }
    if (!layer.isVisible) continue;
    if (chain.some(fl => !fl.isVisible)) continue; // visibility is inherited

    const folders = chain;
    const envAlpha = folders.reduce((a, fl) => a * fl.opacity, 1);
    if (envAlpha <= 0) continue;
    const envMask = combinedFolderMask(doc, folders, folderMasks);

    let content: HTMLCanvasElement | null;
    if (layer.adjustment) {
      // adjustment layers have no pixels of their own; the call draws into out
      applyAdjustmentLayer(out, ctx, layer, envAlpha, envMask, prepared);
      continue;
    }
    content = prepareLayer(doc, layer, prepared, opts);
    if (!content) continue;
    prepared.set(layer.id, content);

    drawBlended(ctx, content, layer.blendMode, layer.opacity * envAlpha, envMask);
  }
  return out;
}

/** A layer's pixels in document space: transform → smart filters → effects → mask → clipping. */
export function prepareLayer(
  doc: Doc, layer: Layer, prepared: Map<string, HTMLCanvasElement>, opts: CompositeOpts = {},
): HTMLCanvasElement | null {
  if (layer.smartObjectId) refreshSmartBitmap(doc, layer); // 智能层:物化视图按需重建(rev 短路)
  if (!layer.bitmap) return null;

  // stroke-preview 层每帧都在变;调整层没有位图,根本走不到这里
  const cacheable = opts.strokePreview?.layerId !== layer.id;
  const key = cacheable ? layerCacheKey(doc, layer) : null;
  if (key) {
    const hit = layerCache.get(layer.id);
    if (hit && hit.key === key) {
      // LRU touch:delete + set 把条目挪到尾部(最近使用)
      layerCache.delete(layer.id);
      layerCache.set(layer.id, hit);
      // 返回克隆:mask/clip 阶段以及部分调用方会在返回值上就地改写
      return cloneCanvas(hit.out);
    }
  }

  const c = makeCanvas(doc.width, doc.height);
  const cx = ctx2d(c);
  drawThroughTransform(cx, layer.bitmap, layer.bitmap.width, layer.bitmap.height, layer.transform);

  // live brush stroke on this layer (a layer-local canvas like the bitmap);
  // erase strokes knock the layer's own pixels out so the preview matches the commit
  if (opts.strokePreview?.layerId === layer.id) {
    const prev = opts.strokePreview;
    if (prev.erase) {
      cx.save();
      cx.globalCompositeOperation = 'destination-out';
      drawThroughTransform(cx, prev.canvas, prev.canvas.width, prev.canvas.height, layer.transform);
      cx.restore();
    } else {
      drawThroughTransform(cx, prev.canvas, prev.canvas.width, prev.canvas.height, layer.transform);
    }
  }

  // 智能滤镜:transform 之后、effects 之前(图层样式采样的是滤镜后的像素);
  // 空栈/全禁用时 applySmartFilters 零拷贝返回 src,避免每帧多余的画布分配
  const activeFilters = layer.smartFilters?.filter(f => !!f && f.enabled) ?? [];
  if (activeFilters.length) {
    const filtered = applySmartFilters(c, activeFilters);
    if (filtered !== c) {
      cx.clearRect(0, 0, c.width, c.height);
      cx.drawImage(filtered, 0, 0);
    }
  }

  let content = c;
  if (layer.effects) content = composeEffects(c, layer.effects);
  if (content !== c) {
    cx.clearRect(0, 0, c.width, c.height);
    cx.drawImage(content, 0, 0);
  }

  // 存缓存段(mask 之前)。必须存副本:c 之后会被 mask/clip 就地改写
  if (key) {
    if (layerCache.size >= LAYER_CACHE_CAP) {
      const oldest = layerCache.keys().next().value;
      if (oldest !== undefined) layerCache.delete(oldest);
    }
    layerCache.set(layer.id, { key, out: cloneCanvas(c) });
  }

  if (layer.mask && layer.maskEnabled) {
    const m = makeCanvas(doc.width, doc.height);
    const mx = ctx2d(m);
    const mt: LayerTransform = layer.maskLinked || !layer.maskPlacement
      ? layer.transform
      : layer.maskPlacement;
    drawMaskThroughTransform(mx, layer.mask, mt);
    cx.globalCompositeOperation = 'destination-in';
    cx.drawImage(m, 0, 0);
    cx.globalCompositeOperation = 'source-over';
  }

  if (layer.maskSourceId) {
    const base = prepared.get(layer.maskSourceId);
    if (base) {
      const m = makeCanvas(doc.width, doc.height);
      const mx = ctx2d(m);
      mx.drawImage(base, 0, 0);
      cx.globalCompositeOperation = 'destination-in';
      cx.drawImage(m, 0, 0);
      cx.globalCompositeOperation = 'source-over';
    }
  }
  return c;
}

function drawMaskThroughTransform(mx: CanvasRenderingContext2D, mask: HTMLCanvasElement, t: LayerTransform) {
  // mask white reveals: use its luminance as alpha. Draw tinted white through the
  // color matrix trick: paint the mask then convert gray → alpha via pixel math.
  const tmp = makeCanvas(mask.width, mask.height);
  const tx = ctx2dRead(tmp);
  tx.drawImage(mask, 0, 0);
  const id = tx.getImageData(0, 0, tmp.width, tmp.height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i + 3] = d[i]; // gray → alpha
    d[i] = d[i + 1] = d[i + 2] = 255;
  }
  tx.putImageData(id, 0, 0);
  drawThroughTransform(mx, tmp, tmp.width, tmp.height, t);
}

function combinedFolderMask(
  doc: Doc, folders: Layer[], cache: Map<string, HTMLCanvasElement | null>,
): HTMLCanvasElement | null {
  let result: HTMLCanvasElement | null = null;
  for (const f of folders) {
    if (!f.mask || !f.maskEnabled) continue;
    let m = cache.get(f.id);
    if (m === undefined) {
      m = makeCanvas(doc.width, doc.height);
      drawMaskThroughTransform(ctx2d(m), f.mask, f.transform);
      cache.set(f.id, m);
    }
    if (!m) continue;
    if (!result) {
      result = cloneCanvas(m);
    } else {
      const rx = ctx2d(result);
      rx.globalCompositeOperation = 'multiply';
      rx.drawImage(m, 0, 0);
      rx.globalCompositeOperation = 'source-over';
    }
  }
  return result;
}

function drawBlended(
  ctx: CanvasRenderingContext2D, content: HTMLCanvasElement,
  mode: Layer['blendMode'], alpha: number, mask: HTMLCanvasElement | null,
) {
  let src: HTMLCanvasElement = content;
  if (mask) {
    src = cloneCanvas(content);
    const sx = ctx2d(src);
    sx.globalCompositeOperation = 'destination-in';
    sx.drawImage(mask, 0, 0);
    sx.globalCompositeOperation = 'source-over';
  }
  const css = cssBlend(mode);
  if (css) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = css;
    ctx.drawImage(src, 0, 0);
    ctx.restore();
    return;
  }
  if (isExoticBlend(mode)) {
    const w = ctx.canvas.width, h = ctx.canvas.height;
    const dst = ctx.getImageData(0, 0, w, h);
    const s = ctx2dRead(src).getImageData(0, 0, w, h);
    pixelBlend(dst.data, s.data, mode, alpha);
    ctx.putImageData(dst, 0, 0);
  }
}

function applyAdjustmentLayer(
  out: HTMLCanvasElement, ctx: CanvasRenderingContext2D, layer: Layer,
  envAlpha: number, envMask: HTMLCanvasElement | null,
  _prepared: Map<string, HTMLCanvasElement>,
): HTMLCanvasElement | null {
  const adj = layer.adjustment!;
  const w = out.width, h = out.height;
  let adjusted: HTMLCanvasElement;

  if (adj.kind === 'Gaussian Blur') {
    adjusted = makeCanvas(w, h);
    const ax = ctx2d(adjusted);
    ax.filter = `blur(${adj.blurRadius}px)`;
    ax.drawImage(out, 0, 0);
    ax.filter = 'none';
  } else {
    adjusted = cloneCanvas(out);
    const ax = ctx2dRead(adjusted);
    const id = ax.getImageData(0, 0, w, h);
    applyAdjustment(id.data, w, h, adj);
    ax.putImageData(id, 0, 0);
  }

  // clip to the adjustment layer's own mask (mask covers its transform rect)
  if (layer.mask && layer.maskEnabled) {
    const m = makeCanvas(w, h);
    drawMaskThroughTransform(ctx2d(m), layer.mask, layer.maskLinked || !layer.maskPlacement ? layer.transform : layer.maskPlacement);
    const ax = ctx2d(adjusted);
    ax.globalCompositeOperation = 'destination-in';
    ax.drawImage(m, 0, 0);
    ax.globalCompositeOperation = 'source-over';
  }

  // clip to the enclosing folders' combined mask (already alpha-coverage, draw directly)
  if (envMask) {
    const ax = ctx2d(adjusted);
    ax.globalCompositeOperation = 'destination-in';
    ax.drawImage(envMask, 0, 0);
    ax.globalCompositeOperation = 'source-over';
  }

  ctx.save();
  ctx.globalAlpha = layer.opacity * envAlpha;
  const css = cssBlend(layer.blendMode);
  if (css) {
    ctx.globalCompositeOperation = css;
    ctx.drawImage(adjusted, 0, 0);
  } else {
    const dst = ctx.getImageData(0, 0, w, h);
    const s = ctx2dRead(adjusted).getImageData(0, 0, w, h);
    pixelBlend(dst.data, s.data, layer.blendMode, layer.opacity * envAlpha);
    ctx.putImageData(dst, 0, 0);
  }
  ctx.restore();
  return null; // adjustment layers have no pixels of their own to clip others to
}

// ---------- Layer effects (LayerEffects.swift defaults) ----------

function silhouetteOf(content: HTMLCanvasElement): HTMLCanvasElement {
  const s = makeCanvas(content.width, content.height);
  const sx = ctx2d(s);
  sx.drawImage(content, 0, 0);
  sx.globalCompositeOperation = 'source-in';
  sx.fillStyle = '#fff';
  sx.fillRect(0, 0, s.width, s.height);
  return s;
}

function tinted(silhouette: HTMLCanvasElement, color: [number, number, number], opacity: number): HTMLCanvasElement {
  const t = makeCanvas(silhouette.width, silhouette.height);
  const tx = ctx2d(t);
  tx.drawImage(silhouette, 0, 0);
  tx.globalCompositeOperation = 'source-in';
  tx.fillStyle = rgbToCss(color, opacity);
  tx.fillRect(0, 0, t.width, t.height);
  return t;
}

/** Compose a layer's pixels with its effects into one canvas (under-effects, pixels, over-effects). */
export function composeEffects(content: HTMLCanvasElement, fx: EffectsData): HTMLCanvasElement {
  const w = content.width, h = content.height;
  const sil = silhouetteOf(content);
  const out = makeCanvas(w, h);
  const ox = ctx2d(out);

  // under the pixels: drop shadow, outer glow, outside stroke
  if (fx.shadow?.enabled) {
    const e = fx.shadow;
    const rad = (e.angle * Math.PI) / 180; // matches LayerEffects.swift: angle 90° → straight down
    const dx = -Math.cos(rad) * e.distance, dy = Math.sin(rad) * e.distance;
    ox.save();
    ox.globalAlpha = e.opacity;
    ox.shadowColor = rgbToCss(e.color);
    ox.shadowBlur = e.blur;
    ox.shadowOffsetX = dx;
    ox.shadowOffsetY = dy;
    ox.drawImage(sil, dx, dy);
    ox.drawImage(sil, dx, dy); // twice: keeps the core solid under the blur
    ox.restore();
  }

  if (fx.outerGlow?.enabled) {
    const e = fx.outerGlow;
    const g = makeCanvas(w, h);
    const gx = ctx2d(g);
    gx.filter = `blur(${e.size / 2}px)`;
    gx.drawImage(tinted(sil, e.color, e.opacity), 0, 0);
    gx.filter = 'none';
    ox.globalCompositeOperation = 'lighten';
    ox.drawImage(g, 0, 0);
    ox.globalCompositeOperation = 'source-over';
  }

  if (fx.stroke?.enabled && !fx.stroke.inside) {
    const e = fx.stroke;
    ox.drawImage(strokeCanvas(sil, e.size, e.color, e.opacity), 0, 0);
  }

  // the pixels themselves
  ox.drawImage(content, 0, 0);

  // over the pixels: color overlay, inner shadow, inner glow, inside stroke
  if (fx.colorOverlay?.enabled) {
    ox.globalCompositeOperation = 'source-atop';
    ox.fillStyle = rgbToCss(fx.colorOverlay.color, fx.colorOverlay.opacity);
    ox.fillRect(0, 0, w, h);
    ox.globalCompositeOperation = 'source-over';
  }

  if (fx.innerShadow?.enabled) {
    const e = fx.innerShadow;
    const rad = (e.angle * Math.PI) / 180;
    const dx = -Math.cos(rad) * e.distance, dy = Math.sin(rad) * e.distance;
    const inner = makeCanvas(w, h);
    const ix = ctx2d(inner);
    ix.filter = `blur(${e.blur / 2}px)`;
    ix.drawImage(sil, dx, dy);
    ix.filter = 'none';
    // invert, tint, and keep only inside the silhouette
    const inv = invertAlpha(inner);
    ix.clearRect(0, 0, w, h);
    ix.drawImage(tinted(inv, e.color, e.opacity), 0, 0);
    ix.globalCompositeOperation = 'destination-in';
    ix.drawImage(sil, 0, 0);
    ox.drawImage(inner, 0, 0);
  }

  if (fx.innerGlow?.enabled) {
    const e = fx.innerGlow;
    const inner = makeCanvas(w, h);
    const ix = ctx2d(inner);
    ix.filter = `blur(${e.size / 2}px)`;
    ix.drawImage(invertAlpha(sil), 0, 0);
    ix.filter = 'none';
    ix.globalCompositeOperation = 'source-in';
    ix.fillStyle = rgbToCss(e.color, e.opacity);
    ix.fillRect(0, 0, w, h);
    ix.globalCompositeOperation = 'destination-in';
    ix.drawImage(sil, 0, 0);
    ox.drawImage(inner, 0, 0);
  }

  if (fx.stroke?.enabled && fx.stroke.inside) {
    const e = fx.stroke;
    const outerStroke = strokeCanvas(sil, e.size, e.color, e.opacity);
    const innerStroke = makeCanvas(w, h);
    const sx2 = ctx2d(innerStroke);
    sx2.drawImage(outerStroke, 0, 0);
    sx2.globalCompositeOperation = 'destination-in';
    sx2.drawImage(sil, 0, 0);
    ox.drawImage(innerStroke, 0, 0);
  }

  return out;
}

function invertAlpha(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = makeCanvas(src.width, src.height);
  const ox = ctx2dRead(out);
  ox.drawImage(src, 0, 0);
  const id = ox.getImageData(0, 0, src.width, src.height);
  for (let i = 0; i < id.data.length; i += 4) {
    id.data[i] = id.data[i + 1] = id.data[i + 2] = 255;
    id.data[i + 3] = 255 - id.data[i + 3];
  }
  ox.putImageData(id, 0, 0);
  return out;
}

function strokeCanvas(
  sil: HTMLCanvasElement, size: number, color: [number, number, number], opacity: number,
): HTMLCanvasElement {
  const w = sil.width, h = sil.height;
  const id = ctx2dRead(sil).getImageData(0, 0, w, h);
  const plane = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < id.data.length; i += 4, p++) plane[p] = id.data[i + 3];
  const dil = dilatePlane(plane, w, h, Math.max(1, Math.round(size / 2)));
  const out = makeCanvas(w, h);
  const ox = ctx2d(out);
  const oid = ox.createImageData(w, h);
  for (let p = 0; p < plane.length; p++) {
    const a = Math.max(dil[p], plane[p]) - plane[p]; // ring outside the silhouette
    const i = p * 4;
    oid.data[i] = oid.data[i + 1] = oid.data[i + 2] = 255;
    oid.data[i + 3] = Math.round(a * opacity);
  }
  ox.putImageData(oid, 0, 0);
  // tint
  const t = makeCanvas(w, h);
  const tx = ctx2d(t);
  tx.drawImage(out, 0, 0);
  tx.globalCompositeOperation = 'source-in';
  tx.fillStyle = rgbToCss(color);
  tx.fillRect(0, 0, w, h);
  return t;
}

// 文本位图渲染已迁至 textRender.ts(活字排版智能体独占;store.upsertTextBitmap 调用)。
