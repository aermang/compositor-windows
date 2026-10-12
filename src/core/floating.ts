// 漂浮选区(Photoshop 自由变换式 Cmd-T 选区浮动):
// begin 把"当前图层 prepared 渲染 ∩ 选区"的像素提升为源图层上方的一个新栅格图层
// ('漂浮选区'),并从源图层位图清掉这些像素;commit 把漂浮图层按其当前变换合并回
// 源图层位图网格(必要时扩边);cancel 直接还原 begin。begin/commit 共用一个历史
// 手势条目 '变换选区内容'(commit 用全量快照改写该条目的 undo/redo,保证撤销/
// 重做一致)。Esc 取消会移除仍在栈顶的手势条目,不留历史足迹。

import { reactive } from 'vue';
import { store, activeLayer, history, replaceLayers, wrapLayer, unwrapLayer, rawCanvas, findLayer, invalidate, uiRefresh, bumpLayerRev } from './store';
import { prepareLayer } from './compositor';
import { makeCanvas, ctx2d, cloneCanvas, transformQuad } from './canvasUtils';
import { applySelectionClip, selectionBounds, isEmptySelection } from './selection';
import { makeLayer, defaultTransform } from './types';
import type { Doc, Layer, LayerTransform } from './types';
import type { HistoryEntry } from './history';

/** 漂浮选区模块状态(CanvasView 在 D 轮接线读取)。 */
export const floating = reactive<{
  active: boolean;
  layerId: string | null;   // 漂浮图层 id
  sourceId: string | null;  // 被浮起的源图层 id
}>({ active: false, layerId: null, sourceId: null });

interface LayerSnapshot {
  layers: Layer[];          // unwrapLayer 快照(位图画布按引用共享,内容靠 beforeBitmap/clearedBitmap 恢复)
  activeId: string | null;
}

interface FloatGesture {
  sourceId: string;
  floatingLayerId: string;
  entry: HistoryEntry | null;
  before: LayerSnapshot;            // begin 前结构
  afterBegin: LayerSnapshot;        // begin 后结构(漂浮中)
  committed: LayerSnapshot | null;  // commit 后结构(条目 redo 据此分支)
  beforeBitmap: HTMLCanvasElement;  // 源图层清除前位图内容
  clearedBitmap: HTMLCanvasElement; // 源图层清除后位图内容
}

let gesture: FloatGesture | null = null;

function resetState(): void {
  gesture = null;
  floating.active = false;
  floating.layerId = null;
  floating.sourceId = null;
}

function snapshot(): LayerSnapshot {
  return {
    layers: store.doc!.layers.map(unwrapLayer),
    activeId: store.doc!.activeLayerId,
  };
}

/** 把 content 原样重画进 target(尺寸应一致),用于恢复被就地清除的位图。 */
function repaintInto(target: HTMLCanvasElement | null, content: HTMLCanvasElement): void {
  if (!target) return;
  const tx = ctx2d(target);
  tx.clearRect(0, 0, target.width, target.height);
  tx.drawImage(content, 0, 0);
}

/**
 * 文档空间画布 → 图层位图空间绘制:drawThroughTransform 的逆映射
 * (位图中心 ← 平移/旋转/翻转/缩放的逆)。源图层变换为恒等放置
 * (size == 位图尺寸、旋转 0)时是精确映射;一般变换下是近似
 * (旋转/缩放的蒙版会被重采样),调用方需自行接受该误差。
 */
export function drawDocIntoBitmapSpace(
  bx: CanvasRenderingContext2D, docCanvas: HTMLCanvasElement,
  t: LayerTransform, bitmapW: number, bitmapH: number,
): void {
  const [ox, oy] = t.origin;
  const [w, h] = t.size;
  const sx = t.flipX ? -1 : 1;
  const sy = t.flipY ? -1 : 1;
  bx.save();
  bx.imageSmoothingEnabled = true;
  bx.imageSmoothingQuality = 'high';
  bx.translate(bitmapW / 2, bitmapH / 2);
  bx.scale(bitmapW / (w * sx), bitmapH / (h * sy));
  bx.rotate((-t.rotation * Math.PI) / 180);
  bx.translate(-(ox + w / 2), -(oy + h / 2));
  bx.drawImage(docCanvas, 0, 0);
  bx.restore();
}

/**
 * 从源图层位图清除选区内像素。清除必须发生在图层自身位图上:
 * 恒等放置时精确;一般变换下把选区蒙版经逆变换画到位图空间再
 * destination-out,是可接受的近似(边缘会有重采样误差)。
 */
function clearSelectionFromBitmap(layer: Layer, selMask: HTMLCanvasElement): void {
  const bmp = layer.bitmap!;
  const scratch = makeCanvas(bmp.width, bmp.height);
  drawDocIntoBitmapSpace(ctx2d(scratch), selMask, layer.transform, bmp.width, bmp.height);
  const bx = ctx2d(bmp);
  bx.save();
  bx.globalCompositeOperation = 'destination-out';
  bx.drawImage(scratch, 0, 0);
  bx.restore();
}

function makeHistoryEntry(st: FloatGesture): HistoryEntry {
  return {
    label: '变换选区内容',
    undo: () => {
      // 恢复清除前的位图内容(快照里的位图引用与被清的是同一画布对象)
      const srcSnap = st.before.layers.find(l => l.id === st.sourceId);
      if (srcSnap) repaintInto(srcSnap.bitmap, st.beforeBitmap);
      replaceLayers(st.before.layers, st.before.activeId);
      if (gesture === st) resetState();
    },
    redo: () => {
      if (st.committed) {
        // 已提交:重做到合并后的最终结构(位图对象即最终内容)
        replaceLayers(st.committed.layers, st.committed.activeId);
        if (gesture === st) resetState();
      } else {
        // 漂浮中:重做恢复"已浮起"状态并重新进入漂浮模式
        replaceLayers(st.afterBegin.layers, st.afterBegin.activeId);
        const srcSnap = st.afterBegin.layers.find(l => l.id === st.sourceId);
        if (srcSnap) repaintInto(srcSnap.bitmap, st.clearedBitmap);
        if (gesture === st) resetState();
        floating.active = true;
        floating.layerId = st.floatingLayerId;
        floating.sourceId = st.sourceId;
      }
    },
  };
}

/** 开始漂浮选区:需要文档 + 非空选区 + 当前为栅格图层。成功返回 true。 */
export function beginFloatingSelection(): boolean {
  if (floating.active) return false;
  const doc = store.doc;
  const sel = store.selection;
  const src = activeLayer.value;
  if (!doc || !sel || isEmptySelection(sel)) return false;
  if (!src || !src.bitmap || src.isGroup || src.adjustment) return false;

  // prepared 渲染(变换/效果/蒙版都已应用)到文档空间,再按选区裁剪
  const prepared = prepareLayer(doc, src, new Map());
  if (!prepared) return false;
  const clipped = applySelectionClip(prepared, sel);
  const bounds = selectionBounds(clipped);
  if (!bounds || bounds.w < 1 || bounds.h < 1) return false;

  const pixels = makeCanvas(bounds.w, bounds.h);
  ctx2d(pixels).drawImage(clipped, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, bounds.w, bounds.h);

  const before = snapshot();
  const beforeBitmap = cloneCanvas(src.bitmap);

  clearSelectionFromBitmap(src, sel.mask);
  bumpLayerRev(src); // 就地清除像素且不走 rasterEdit:保持合成器按层缓存诚实
  const clearedBitmap = cloneCanvas(src.bitmap);

  // 漂浮图层:插在源图层上方,同父级/不透明度/混合模式
  const fl = makeLayer({
    name: '漂浮选区',
    parentId: src.parentId,
    opacity: src.opacity,
    blendMode: src.blendMode,
  });
  fl.bitmap = rawCanvas(pixels);
  fl.transform = { ...defaultTransform(bounds.w, bounds.h), origin: [bounds.x, bounds.y] };

  const idx = doc.layers.findIndex(l => l.id === src.id);
  const insertAt = idx < 0 ? doc.layers.length : idx + 1;
  const layers = [...doc.layers];
  layers.splice(insertAt, 0, unwrapLayer(fl));
  doc.layers = layers.map(wrapLayer);
  doc.activeLayerId = fl.id;

  const st: FloatGesture = {
    sourceId: src.id,
    floatingLayerId: fl.id,
    entry: null,
    before,
    beforeBitmap,
    clearedBitmap,
    afterBegin: snapshot(),
    committed: null,
  };
  const entry = makeHistoryEntry(st);
  st.entry = entry;
  history.push(entry);
  gesture = st;

  // 原版会把选区随像素一起变换;这里保持简单:丢弃选区
  store.selection = null;
  floating.active = true;
  floating.layerId = fl.id;
  floating.sourceId = src.id;
  store.dirty = true;
  invalidate();
  uiRefresh();
  return true;
}

/** 把漂浮图层内容合并回源图层位图网格(必要时扩源位图并调原点)。 */
function mergeFloatingIntoSource(doc: Doc, src: Layer, flt: Layer): void {
  const prepared = prepareLayer(doc, flt, new Map());
  if (!prepared) return;

  // 漂浮图层变换后的文档空间轴对齐包围盒
  const quad = transformQuad(flt.transform);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of quad) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  x0 = Math.floor(x0); y0 = Math.floor(y0);
  x1 = Math.ceil(x1); y1 = Math.ceil(y1);

  const bmp = src.bitmap!;
  const [sox, soy] = src.transform.origin;
  const [ssw, ssh] = src.transform.size;
  // 恒等放置(无旋转、绘制尺寸==位图尺寸)时扩边才是精确的;旋转源不扩边
  const axisAligned = src.transform.rotation === 0
    && Math.abs(ssw - bmp.width) < 0.5 && Math.abs(ssh - bmp.height) < 0.5;
  const ux0 = Math.min(x0, sox), uy0 = Math.min(y0, soy);
  const ux1 = Math.max(x1, sox + ssw), uy1 = Math.max(y1, soy + ssh);
  if (axisAligned
    && (ux0 < sox - 0.5 || uy0 < soy - 0.5 || ux1 > sox + ssw + 0.5 || uy1 > soy + ssh + 0.5)) {
    const gw = Math.max(1, Math.round(ux1 - ux0));
    const gh = Math.max(1, Math.round(uy1 - uy0));
    const nb = makeCanvas(gw, gh);
    ctx2d(nb).drawImage(bmp, Math.round(sox - ux0), Math.round(soy - uy0));
    src.bitmap = rawCanvas(nb);
    if (src.mask) {
      // 有蒙版则同样扩边,新区域填白(全显)
      const nm = makeCanvas(gw, gh);
      const nx = ctx2d(nm);
      nx.fillStyle = '#fff';
      nx.fillRect(0, 0, gw, gh);
      nx.drawImage(src.mask, Math.round(sox - ux0), Math.round(soy - uy0));
      src.mask = rawCanvas(nm);
    }
    src.transform = { ...src.transform, origin: [Math.round(ux0), Math.round(uy0)], size: [gw, gh] };
  }

  // 漂浮内容(文档空间)经源图层逆变换画进位图网格
  const target = src.bitmap!;
  drawDocIntoBitmapSpace(ctx2d(target), prepared, src.transform, target.width, target.height);
  bumpLayerRev(src); // 就地合并像素且不走 rasterEdit:保持合成器按层缓存诚实
}

/** 提交漂浮:合并回源图层、移除漂浮图层、改写历史条目为最终快照。 */
export function commitFloatingSelection(): void {
  const st = gesture;
  if (!st) return;
  const doc = store.doc;
  if (doc) {
    const src = findLayer(st.sourceId);
    const flt = findLayer(st.floatingLayerId);
    if (src && src.bitmap && flt && flt.bitmap) {
      mergeFloatingIntoSource(doc, src, flt);
      // 直接移除漂浮图层(不走 deleteLayer,避免多出一条 'Delete Layer' 历史)
      doc.layers = doc.layers.filter(l => l.id !== flt.id).map(wrapLayer);
      doc.activeLayerId = src.id;
    }
    // 源或漂浮图层已不存在(被删除等):漂浮图层留在文档里作为普通图层,仅退出模式
    st.committed = snapshot();
  }
  resetState();
  store.dirty = true;
  invalidate();
  uiRefresh();
}

/** 取消漂浮:还原 begin 并移除仍在栈顶的手势历史条目。 */
export function cancelFloatingSelection(): void {
  const st = gesture;
  if (!st || !st.entry) return;
  st.entry.undo();
  if (history.entries[history.index] === st.entry) {
    history.entries.pop();
    history.index--;
  }
}
