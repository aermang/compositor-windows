// 选区剪贴板:内部像素剪贴板(pixelClip,文档空间原点)+ 尽力写入系统剪贴板
// PNG(WebView2 支持时)。复制取"当前图层 prepared 渲染 ∩ 选区";合并复制取
// flattenDoc ∩ 选区;粘贴把剪贴板内容作为新图层放回原位置。

import {
  store, activeLayer, flattenDoc, rasterEdit, addRasterLayer,
  duplicateLayer, insertLayerAboveActive, rawCanvas,
} from './store';
import { prepareLayer } from './compositor';
import { makeCanvas, ctx2d, cloneCanvas } from './canvasUtils';
import { applySelectionClip, selectionBounds, isEmptySelection } from './selection';
import { drawDocIntoBitmapSpace } from './floating';
import { makeLayer, defaultTransform } from './types';

/** 内部像素剪贴板:文档空间画布 + 原点(画布左上角在文档中的位置)。 */
let pixelClip: { canvas: HTMLCanvasElement; origin: [number, number] } | null = null;

/** UI 接线用:内部像素剪贴板是否有内容(粘贴命令可用性)。 */
export function hasPixelClip(): boolean {
  return pixelClip !== null;
}

/** 尽力把画布作为 PNG 写入系统剪贴板;失败(权限/不支持)静默忽略。 */
function writeSystemPng(c: HTMLCanvasElement): void {
  try {
    c.toBlob((blob) => {
      if (!blob) return;
      try {
        void navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      } catch { /* WebView2 无权限或不支持 ClipboardItem */ }
    }, 'image/png');
  } catch { /* toBlob 不可用 */ }
}

/** 从"已按选区裁剪的文档空间画布"取 alpha 包围盒建立像素剪贴板。 */
function setClipFromDocCanvas(clipped: HTMLCanvasElement): boolean {
  const bounds = selectionBounds(clipped);
  if (!bounds) return false;
  const c = makeCanvas(bounds.w, bounds.h);
  ctx2d(c).drawImage(clipped, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, bounds.w, bounds.h);
  pixelClip = { canvas: c, origin: [bounds.x, bounds.y] };
  writeSystemPng(c);
  return true;
}

/** 复制选区内像素(当前图层,含变换/效果/蒙版的 prepared 渲染)。 */
export function copySelection(): void {
  const doc = store.doc;
  const sel = store.selection;
  const layer = activeLayer.value;
  if (!doc || !sel || isEmptySelection(sel) || !layer || !layer.bitmap) return;
  const prepared = prepareLayer(doc, layer, new Map());
  if (!prepared) return;
  setClipFromDocCanvas(applySelectionClip(prepared, sel));
}

/** 剪切:先复制,再从当前图层位图清除选区内像素(带 '剪切' 历史)。 */
export function cutSelection(): void {
  const doc = store.doc;
  const sel = store.selection;
  const layer = activeLayer.value;
  if (!doc || !sel || isEmptySelection(sel) || !layer || !layer.bitmap) return;
  copySelection();
  rasterEdit(layer, '剪切', (bmp) => {
    // 与漂浮选区同款近似:选区蒙版经逆变换画到位图空间再 destination-out;
    // 图层恒等放置时精确,一般变换下边缘有重采样误差
    const scratch = makeCanvas(bmp.width, bmp.height);
    drawDocIntoBitmapSpace(ctx2d(scratch), sel.mask, layer.transform, bmp.width, bmp.height);
    const bx = ctx2d(bmp);
    bx.save();
    bx.globalCompositeOperation = 'destination-out';
    bx.drawImage(scratch, 0, 0);
    bx.restore();
  });
}

/** 合并复制:整个文档压平结果按选区裁剪。 */
export function copyMerged(): void {
  const doc = store.doc;
  const sel = store.selection;
  if (!doc || !sel || isEmptySelection(sel)) return;
  setClipFromDocCanvas(applySelectionClip(flattenDoc(), sel));
}

/** 粘贴:像素剪贴板内容作为新图层放回其原位置;成功返回 true。 */
export function pasteClip(): boolean {
  if (!pixelClip || !store.doc) return false;
  const bmp = cloneCanvas(pixelClip.canvas);
  const layer = addRasterLayer('粘贴的图层', bmp);
  if (!layer) return false;
  layer.transform.origin = [pixelClip.origin[0], pixelClip.origin[1]];
  store.selection = null;
  return true;
}

/** 通过拷贝的图层:有选区时把选区内像素(近似的包围盒裁剪)原位建新图层;无选区时复制当前图层。 */
export function layerViaCopy(): void {
  const doc = store.doc;
  const sel = store.selection;
  const src = activeLayer.value;
  if (!doc || !src) return;
  if (!sel || isEmptySelection(sel) || !src.bitmap) {
    duplicateLayer(src);
    return;
  }
  const prepared = prepareLayer(doc, src, new Map());
  if (!prepared) return;
  const clipped = applySelectionClip(prepared, sel);
  const bounds = selectionBounds(clipped);
  if (!bounds) return;
  const bmp = makeCanvas(bounds.w, bounds.h);
  ctx2d(bmp).drawImage(clipped, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, bounds.w, bounds.h);
  const copy = makeLayer({
    name: '通过拷贝的图层',
    parentId: src.parentId,
    opacity: src.opacity,
    blendMode: src.blendMode,
  });
  copy.bitmap = rawCanvas(bmp);
  copy.transform = { ...defaultTransform(bounds.w, bounds.h), origin: [bounds.x, bounds.y] };
  insertLayerAboveActive(copy);
}
