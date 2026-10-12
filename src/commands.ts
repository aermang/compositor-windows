// Command registry: one source for the menu bar, keyboard shortcuts and the
// Search Commands palette (Ctrl+F). Shortcut spelling: Ctrl+Shift+Key, using
// the Photoshop map from the macOS app with ⌘→Ctrl, ⌥→Alt.

import { store, activeLayer } from './core/store';
import {
  newDoc, setDoc, addRasterLayer, addGroupLayer, addAdjustmentLayer, deleteLayer, duplicateLayer,
  mergeDown, flattenDoc, addMask, undo, redo, setZoom, fitToScreen, centerCanvas,
  pushStructural, rasterEdit, rawCanvas, history,
} from './core/store';
import { makeLayer, ADJUSTMENT_KINDS } from './core/types';
import type { AdjustmentKind } from './core/types';
import { makeCanvas, ctx2d, ctx2dRead, cloneCanvas } from './core/canvasUtils';
import { invertSelection, emptySelection, finalize, isEmptySelection } from './core/selection';
import { prepareLayer } from './core/compositor';
import { invertApply, addNoiseApply, grainApply, motionBlurApply } from './core/pixels/adjust';
import { openImageFile, openImageWithMeta, exportCanvas } from './core/io/raster';
import { openComp, saveComp } from './core/io/comp';
import { basename } from './core/recent';
import { copySelection, cutSelection, copyMerged, pasteClip, layerViaCopy, hasPixelClip } from './core/clipboard';
import { beginFloatingSelection, floating } from './core/floating';
import { workspace, ensureTab, closeTab, tabDidSave, tabDidLoad } from './core/workspace';
import { rotateCanvas90 } from './core/rotateCanvas';
import { uiFlags } from './core/uiFlags';
import { guides } from './core/guides';
import { readFile, writeFile } from './core/io/fs';
import { exportPsd } from './core/io/psdExport';
import { exportApngCommand } from './core/io/apngExport';
import { exportGifCommand } from './core/io/gifExport';
import { importTiff, exportTiffCommand } from './core/io/tiff';
import { storeSelectionAsChannel } from './core/channels';
import { autoTone, autoContrast, autoColor } from './core/pixels/autoAdjust';
import {
  vibranceApply, channelMixerApply, photoFilterApply, shadowHighlightApply,
} from './core/pixels/creativeAdjust';
import { toggleQuickMask } from './core/quickMask';
import { isRawPath, rawMetadata, developRaw } from './core/io/raw';
import { convertToSmartObject, rasterizeSmartObject } from './core/smartObject';
import { recordStep } from './core/actions';
import { isPsd } from './core/io/psd/builder';
import { ADJUSTMENT_ZH } from './core/labels';
import { applyCrop } from './tools/crop';

export interface Command {
  id: string;
  label: string;
  menu: string;          // File, Edit, Image, Layer, Select, Filter, View
  shortcut?: string;
  sep?: boolean;         // render a separator above this item
  run(): void | Promise<void>;
  enabled?(): boolean;
}

export const commands: Command[] = [];
function cmd(c: Command) { commands.push(c); }

const hasDoc = () => !!store.doc;
const hasLayer = () => !!activeLayer.value && !activeLayer.value!.isGroup;

// ---------- File ----------

cmd({ id: 'file.new', label: '新建…', menu: 'File', shortcut: 'Ctrl+N', run: () => { store.dialog = 'new'; } });
cmd({ id: 'file.openImage', label: '打开图像…', menu: 'File', shortcut: 'Ctrl+O', run: openImage });
cmd({ id: 'file.openComp', label: '打开 Compositor 项目…', menu: 'File', run: openProject });
cmd({ id: 'file.recents', label: '最近打开…', menu: 'File', run: () => { store.dialog = 'recents'; } });
cmd({ id: 'file.importLayer', label: '导入图像为图层…', menu: 'File', sep: true, enabled: hasDoc, run: importAsLayer });
cmd({ id: 'file.importPdf', label: '导入 PDF…', menu: 'File', run: importPdfPick });
cmd({ id: 'file.save', label: '保存项目', menu: 'File', shortcut: 'Ctrl+S', sep: true, enabled: hasDoc, run: saveProject });
cmd({ id: 'file.saveAs', label: '项目另存为…', menu: 'File', shortcut: 'Ctrl+Shift+S', enabled: hasDoc, run: () => saveProject(true) });
cmd({ id: 'file.exportPng', label: '导出 PNG', menu: 'File', shortcut: 'Ctrl+Shift+E', sep: true, enabled: hasDoc, run: () => exportFlat('png') });
cmd({ id: 'file.exportJpeg', label: '导出 JPEG…', menu: 'File', shortcut: 'Ctrl+Alt+S', enabled: hasDoc, run: () => exportFlat('jpeg') });
cmd({ id: 'file.exportPsd', label: '导出 PSD…', menu: 'File', enabled: hasDoc, run: exportPsdFlat });
cmd({ id: 'file.exportApng', label: '导出 APNG 动画…', menu: 'File', enabled: hasDoc, run: exportApngCommand });
cmd({ id: 'file.exportGif', label: '导出 GIF 动画…', menu: 'File', enabled: hasDoc, run: exportGifCommand });
cmd({ id: 'file.exportTiff', label: '导出 TIFF…', menu: 'File', enabled: hasDoc, run: exportTiffCommand });
cmd({ id: 'file.exportAs', label: '导出为…', menu: 'File', shortcut: 'Ctrl+Alt+W', enabled: hasDoc, run: () => { store.dialog = 'export'; } });
cmd({
  id: 'file.close', label: '关闭文档', menu: 'File', shortcut: 'Ctrl+W', sep: true,
  run: () => { ensureTab(); closeTab(workspace.activeIndex); },
});

// ---------- Edit ----------

cmd({ id: 'edit.undo', label: '撤销', menu: 'Edit', shortcut: 'Ctrl+Z', run: undo, enabled: () => history.canUndo });
cmd({ id: 'edit.redo', label: '重做', menu: 'Edit', shortcut: 'Ctrl+Shift+Z', run: redo, enabled: () => history.canRedo });
cmd({
  id: 'edit.cut', label: '剪切图层', menu: 'Edit', shortcut: 'Ctrl+X', sep: true,
  enabled: () => hasLayer() && !floating.active,
  run: () => {
    if (store.selection && !isEmptySelection(store.selection)) { cutSelection(); return; }
    copyLayer();
    if (activeLayer.value) deleteLayer(activeLayer.value);
  },
});
cmd({
  id: 'edit.copy', label: '拷贝图层', menu: 'Edit', shortcut: 'Ctrl+C',
  enabled: () => hasLayer() && !floating.active,
  run: () => {
    if (store.selection && !isEmptySelection(store.selection)) { copySelection(); return; }
    copyLayer();
  },
});
cmd({
  id: 'edit.copyMerged', label: '合并复制', menu: 'Edit', shortcut: 'Ctrl+Shift+C',
  enabled: () => hasDoc() && !!store.selection && !floating.active,
  run: () => { copyMerged(); },
});
cmd({
  id: 'edit.paste', label: '粘贴图层', menu: 'Edit', shortcut: 'Ctrl+V',
  enabled: () => (hasPixelClip() || !!store.clipLayer) && !floating.active,
  run: () => {
    if (pasteClip()) return;
    const clip = store.clipLayer;
    if (!clip) return;
    const copy = duplicateLayer(clip);
    if (copy) {
      copy.name = clip.name;
      copy.transform.origin = [16, 16];
    }
  },
});
cmd({
  id: 'edit.clear', label: '清除', menu: 'Edit', shortcut: 'Delete',
  enabled: () => hasLayer() && !floating.active,
  run: () => {
    const layer = activeLayer.value!;
    if (!layer.bitmap) return;
    rasterEdit(layer, '清除', bmp => {
      const bx = ctx2d(bmp);
      if (store.selection?.bounds) {
        // selection mask is doc-space; scale to the bitmap (1:1 when the layer fills the doc)
        bx.globalCompositeOperation = 'destination-out';
        bx.drawImage(store.selection.mask, 0, 0, bmp.width, bmp.height);
        bx.globalCompositeOperation = 'source-over';
      } else {
        bx.clearRect(0, 0, bmp.width, bmp.height);
      }
    });
  },
});
cmd({
  id: 'edit.fillFg', label: '用前景色填充', menu: 'Edit', shortcut: 'Alt+Delete',
  enabled: () => hasLayer() && !floating.active,
  run: () => fillActive(store.fg),
});
cmd({
  id: 'edit.fillBg', label: '用背景色填充', menu: 'Edit', shortcut: 'Ctrl+Delete',
  enabled: () => hasLayer() && !floating.active,
  run: () => fillActive(store.bg),
});
cmd({
  id: 'edit.contentFill', label: '内容识别填充…', menu: 'Edit', shortcut: 'Shift+F5',
  enabled: () => hasDoc() && !!store.selection,
  run: () => { store.dialog = 'contentFill'; },
});
cmd({
  id: 'edit.puppet', label: '操控变形…', menu: 'Edit', enabled: hasLayer,
  run: () => { store.dialog = 'puppet'; },
});
cmd({
  id: 'edit.freeTransform', label: '自由变换', menu: 'Edit', shortcut: 'Ctrl+T', sep: true,
  run: () => {
    // with a live selection Ctrl+T floats it (commit on Esc/Enter/tool-switch);
    // otherwise toggle whole-layer transform handles
    if (store.selection && beginFloatingSelection()) return;
    uiFlags.transformHandles = !uiFlags.transformHandles;
  },
});
cmd({ id: 'edit.shortcuts', label: '键盘快捷键', menu: 'Edit', sep: true, run: () => { store.dialog = 'shortcuts'; } });

// ---------- Image ----------

cmd({
  id: 'image.autoTone', label: '自动色调', menu: 'Image', shortcut: 'Ctrl+Shift+L',
  enabled: hasLayer, run: () => { autoTone(activeLayer.value!); },
});
cmd({
  id: 'image.autoContrast', label: '自动对比度', menu: 'Image', shortcut: 'Ctrl+Alt+Shift+L',
  enabled: hasLayer, run: () => { autoContrast(activeLayer.value!); },
});
cmd({
  id: 'image.autoColor', label: '自动颜色', menu: 'Image', shortcut: 'Ctrl+Shift+B',
  enabled: hasLayer, run: () => { autoColor(activeLayer.value!); },
});
cmd({ id: 'image.imageSize', label: '图像大小…', menu: 'Image', shortcut: 'Ctrl+Alt+I', sep: true, enabled: hasDoc, run: () => { store.dialog = 'imageSize'; } });
cmd({ id: 'image.canvasSize', label: '画布大小…', menu: 'Image', shortcut: 'Ctrl+Alt+C', enabled: hasDoc, run: () => { store.dialog = 'canvasSize'; } });
cmd({ id: 'image.info', label: '图像信息…', menu: 'Image', enabled: hasDoc, run: () => { store.dialog = 'imageInfo'; } });
cmd({
  id: 'image.cropToSelection', label: '裁剪到选区', menu: 'Image', enabled: () => hasDoc() && !!store.selection?.bounds,
  run: () => {
    const b = store.selection!.bounds!;
    applyCrop({ x: b.x, y: b.y, w: b.w, h: b.h });
  },
});
cmd({
  id: 'image.trim', label: '裁切', menu: 'Image', enabled: hasDoc,
  run: () => {
    const flat = flattenDoc();
    const b = alphaBounds(flat);
    if (b) applyCrop({ x: b.x, y: b.y, w: b.w, h: b.h });
  },
});
cmd({
  id: 'image.flipCanvasH', label: '水平翻转画布', menu: 'Image', sep: true, enabled: hasDoc,
  run: () => pushStructural('翻转画布', () => {
    const doc = store.doc!;
    doc.layers.forEach(l => {
      l.transform.origin = [doc.width - l.transform.origin[0] - l.transform.size[0], l.transform.origin[1]];
      l.transform.flipX = !l.transform.flipX;
    });
  }),
});
cmd({
  id: 'image.flipCanvasV', label: '垂直翻转画布', menu: 'Image', enabled: hasDoc,
  run: () => pushStructural('翻转画布', () => {
    const doc = store.doc!;
    doc.layers.forEach(l => {
      l.transform.origin = [l.transform.origin[0], doc.height - l.transform.origin[1] - l.transform.size[1]];
      l.transform.flipY = !l.transform.flipY;
    });
  }),
});
cmd({ id: 'image.rotate90cw', label: '旋转画布 90°（顺时针）', menu: 'Image', enabled: hasDoc, run: () => { rotateCanvas90(true); } });
cmd({ id: 'image.rotate90ccw', label: '旋转画布 90°（逆时针）', menu: 'Image', enabled: hasDoc, run: () => { rotateCanvas90(false); } });

// ---------- Layer ----------

cmd({ id: 'layer.new', label: '新建图层', menu: 'Layer', shortcut: 'Ctrl+Shift+N', enabled: hasDoc, run: () => { addRasterLayer(); } });
cmd({ id: 'layer.newGroup', label: '新建组', menu: 'Layer', enabled: hasDoc, run: () => { addGroupLayer(); } });
cmd({ id: 'layer.toSmart', label: '转换为智能对象', menu: 'Layer', enabled: hasLayer, run: () => { convertToSmartObject(); } });
cmd({
  id: 'layer.rasterizeSmart', label: '栅格化智能对象', menu: 'Layer',
  enabled: () => !!activeLayer.value?.smartObjectId, run: () => { rasterizeSmartObject(); },
});
cmd({
  // Ctrl+J: via-copy honors an active selection (选区内像素建新图层), else duplicates the layer
  id: 'layer.duplicate', label: '复制图层', menu: 'Layer', shortcut: 'Ctrl+J', sep: true, enabled: hasLayer,
  run: () => { layerViaCopy(); },
});
cmd({
  id: 'layer.delete', label: '删除图层', menu: 'Layer', enabled: () => !!activeLayer.value && !floating.active,
  run: () => { if (activeLayer.value) deleteLayer(activeLayer.value); },
});
cmd({
  id: 'layer.mergeDown', label: '向下合并', menu: 'Layer', shortcut: 'Ctrl+E', sep: true,
  enabled: () => hasLayer() && !floating.active,
  run: () => { if (activeLayer.value) mergeDown(activeLayer.value); },
});
cmd({
  id: 'layer.mergeVisible', label: '合并可见图层', menu: 'Layer', enabled: () => hasDoc() && !floating.active,
  run: () => {
    const doc = store.doc!;
    const flat = flattenDoc();
    pushStructural('合并可见图层', () => {
      const merged = makeLayer({ name: 'Merged' });
      merged.bitmap = rawCanvas(flat);
      merged.transform = { origin: [0, 0], size: [flat.width, flat.height], rotation: 0, flipX: false, flipY: false, sampling: 'High quality' };
      // keep only the hidden layers; the merged raster replaces everything visible
      doc.layers = doc.layers.filter(l => !l.isVisible).map(l => l);
      doc.layers.push(merged);
      doc.activeLayerId = merged.id;
    });
  },
});
for (const kind of ADJUSTMENT_KINDS) {
  cmd({
    id: `layer.adj.${kind}`, label: `新建调整层：${ADJUSTMENT_ZH[kind]}`, menu: 'Layer', enabled: hasDoc,
    run: () => { addAdjustmentLayer(kind as AdjustmentKind); },
  });
}
cmd({
  id: 'layer.addMask', label: '添加图层蒙版（显示全部）', menu: 'Layer', sep: true, enabled: hasLayer,
  run: () => { if (activeLayer.value) addMask(activeLayer.value, true); },
});
cmd({
  id: 'layer.toggleMask', label: '启用/禁用蒙版', menu: 'Layer', enabled: () => !!activeLayer.value?.mask,
  run: () => {
    const l = activeLayer.value!;
    l.maskEnabled = !l.maskEnabled;
    store.dirty = true;
    store.tick++;
  },
});
cmd({
  id: 'layer.linkMask', label: '链接/取消链接蒙版', menu: 'Layer', enabled: () => !!activeLayer.value?.mask,
  run: () => {
    const l = activeLayer.value!;
    l.maskLinked = !l.maskLinked;
    if (l.maskLinked) l.maskPlacement = null;
    else l.maskPlacement = { ...l.transform };
    store.dirty = true;
    store.tick++;
  },
});
cmd({
  id: 'layer.effects', label: '图层效果…', menu: 'Layer', sep: true, enabled: hasLayer,
  run: () => { store.dialog = 'effects'; },
});
cmd({
  id: 'layer.flipH', label: '水平翻转图层', menu: 'Layer', enabled: hasLayer,
  run: () => { const l = activeLayer.value!; l.transform.flipX = !l.transform.flipX; store.dirty = true; store.tick++; },
});
cmd({
  id: 'layer.flipV', label: '垂直翻转图层', menu: 'Layer', enabled: hasLayer,
  run: () => { const l = activeLayer.value!; l.transform.flipY = !l.transform.flipY; store.dirty = true; store.tick++; },
});
cmd({
  id: 'layer.clip', label: '创建/释放剪贴蒙版', menu: 'Layer', shortcut: 'Ctrl+Alt+G', enabled: hasLayer,
  run: () => {
    const l = activeLayer.value!;
    if (l.maskSourceId) {
      l.maskSourceId = null;
    } else {
      const idx = store.doc!.layers.findIndex(x => x.id === l.id);
      for (let i = idx - 1; i >= 0; i--) {
        const below = store.doc!.layers[i];
        if (!below.isGroup && !below.adjustment) { l.maskSourceId = below.id; break; }
      }
    }
    store.dirty = true;
    store.tick++;
  },
});

// ---------- Select ----------

cmd({
  id: 'select.all', label: '全选', menu: 'Select', shortcut: 'Ctrl+A', enabled: hasDoc,
  run: () => {
    const sel = emptySelection(store.doc!);
    const cx = ctx2d(sel.mask);
    cx.fillStyle = '#fff';
    cx.fillRect(0, 0, sel.mask.width, sel.mask.height);
    finalize(sel);
    store.selection = sel;
  },
});
cmd({
  id: 'select.deselect', label: '取消选择', menu: 'Select', shortcut: 'Ctrl+D',
  run: () => { store.selection = null; },
});
cmd({
  id: 'select.quickMask', label: '切换快速蒙版', menu: 'Select', shortcut: 'Q', sep: true,
  enabled: hasDoc,
  run: () => { toggleQuickMask(); },
});
cmd({
  id: 'select.inverse', label: '反选', menu: 'Select', shortcut: 'Ctrl+Shift+I', enabled: () => !!store.selection,
  run: () => { if (store.selection) invertSelection(store.selection); },
});
cmd({
  id: 'select.feather', label: '羽化…', menu: 'Select', enabled: () => !!store.selection,
  run: () => { store.dialog = 'feather'; },
});
cmd({
  id: 'select.expand', label: '扩展…', menu: 'Select', run: () => { store.dialogPayload = 1; store.dialog = 'expand'; },
});
cmd({
  id: 'select.contract', label: '收缩…', menu: 'Select', run: () => { store.dialogPayload = -1; store.dialog = 'expand'; },
});
cmd({
  id: 'select.layerPixels', label: '载入图层像素为选区', menu: 'Select', enabled: hasLayer,
  run: () => {
    const layer = activeLayer.value!;
    if (!layer.bitmap) return;
    const prepared = prepareLayer(store.doc!, layer, new Map());
    const sel = emptySelection(store.doc!);
    const sx = ctx2d(sel.mask);
    if (prepared) sx.drawImage(prepared, 0, 0);
    finalize(sel);
    store.selection = sel;
  },
});
cmd({ id: 'select.colorRange', label: '色彩范围…', menu: 'Select', sep: true, enabled: hasDoc, run: () => { store.dialog = 'colorRange'; } });
cmd({
  id: 'select.subject', label: '选取主体', menu: 'Select', enabled: hasDoc,
  run: () => { store.dialogPayload = { mode: 'select' }; store.dialog = 'subject'; },
});
cmd({
  id: 'select.removeBackground', label: '移除背景', menu: 'Select', enabled: hasDoc,
  run: () => { store.dialogPayload = { mode: 'removeBg' }; store.dialog = 'subject'; },
});
cmd({
  id: 'select.storeChannel', label: '存储选区', menu: 'Select', sep: true,
  enabled: () => !!store.selection, run: () => { storeSelectionAsChannel(); },
});

// ---------- Filter (destructive on the active layer) ----------

for (const f of [
  { id: 'gaussianBlur', label: '高斯模糊…', def: { radius: 6 } },
  { id: 'motionBlur', label: '动感模糊…', def: { angle: 0, distance: 20 } },
  { id: 'addNoise', label: '添加杂色…', def: { amount: 12, gaussian: false, monochromatic: false } },
  { id: 'grain', label: '颗粒…', def: { amount: 25 } },
  { id: 'vignette', label: '暗角…', def: { amount: 50 } },
  { id: 'bloom', label: '泛光…', def: { amount: 40, radius: 12 } },
  { id: 'sharpen', label: '锐化', def: { amount: 50 } },
  { id: 'vibrance', label: '自然饱和度…', def: { vibrance: 50, saturation: 0 } },
  {
    id: 'channelMixer', label: '通道混合器…', def: {
      redFromRed: 100, redFromGreen: 0, redFromBlue: 0,
      greenFromRed: 0, greenFromGreen: 100, greenFromBlue: 0,
      blueFromRed: 0, blueFromGreen: 0, blueFromBlue: 100,
    },
  },
  { id: 'photoFilter', label: '照片滤镜…', def: { warmth: 40, density: 25 } },
  { id: 'shadowHighlight', label: '阴影/高光…', def: { shadows: 30, highlights: 20 } },
]) {
  cmd({
    id: `filter.${f.id}`, label: f.label, menu: 'Filter', enabled: hasLayer,
    run: () => { store.dialogPayload = { kind: f.id, def: f.def }; store.dialog = 'filter'; },
  });
}
cmd({
  id: 'filter.invert', label: '反相', menu: 'Filter', shortcut: 'Ctrl+I', sep: true, enabled: hasLayer,
  run: () => applyFilterToActive('invert', {}),
});
cmd({
  id: 'filter.last', label: '上次滤镜', menu: 'Filter', shortcut: 'Ctrl+Alt+F', enabled: () => !!lastFilter,
  run: () => { if (lastFilter) applyFilterToActive(lastFilter.kind, lastFilter.params); },
});
cmd({
  id: 'filter.cameraRaw', label: 'Camera Raw 滤镜…', menu: 'Filter', sep: true,
  enabled: () => !!activeLayer.value?.bitmap, run: () => { store.dialog = 'cameraRaw'; },
});
cmd({ id: 'filter.dither', label: '抖动…', menu: 'Filter', enabled: () => !!activeLayer.value?.bitmap, run: () => { store.dialog = 'dither'; } });
cmd({ id: 'filter.scanlines', label: '扫描线…', menu: 'Filter', enabled: () => !!activeLayer.value?.bitmap, run: () => { store.dialog = 'scanlines'; } });
cmd({ id: 'filter.liquify', label: '液化…', menu: 'Filter', enabled: hasLayer, run: () => { store.dialog = 'liquify'; } });

// ---------- View ----------

cmd({ id: 'view.zoomIn', label: '放大', menu: 'View', shortcut: 'Ctrl+=', run: () => setZoom(store.zoom * 1.25) });
cmd({ id: 'view.zoomOut', label: '缩小', menu: 'View', shortcut: 'Ctrl+-', run: () => setZoom(store.zoom / 1.25) });
cmd({ id: 'view.fit', label: '按屏幕大小缩放', menu: 'View', shortcut: 'Ctrl+0', run: fitToScreen });
cmd({ id: 'view.actual', label: '实际像素', menu: 'View', shortcut: 'Ctrl+1', run: () => { setZoom(1); centerCanvas(); } });
cmd({
  id: 'view.grid', label: '显示网格', menu: 'View', shortcut: "Ctrl+'", sep: true,
  run: () => { store.showGrid = !store.showGrid; },
});
cmd({
  id: 'view.pixelGrid', label: '显示像素网格（800%+）', menu: 'View',
  run: () => { store.showPixelGrid = !store.showPixelGrid; },
});
cmd({ id: 'view.gridSettings', label: '网格设置…', menu: 'View', run: () => { store.dialog = 'grid'; } });
cmd({ id: 'view.clearGuides', label: '清除参考线', menu: 'View', run: () => { guides.splice(0, guides.length); } });
cmd({ id: 'view.rulers', label: '显示标尺', menu: 'View', run: () => { uiFlags.showRulers = !uiFlags.showRulers; } });
cmd({
  id: 'view.fullscreen', label: '切换全屏', menu: 'View', shortcut: 'F',
  run: () => { store.canvasOnly = !store.canvasOnly; },
});
cmd({ id: 'view.search', label: '搜索命令', menu: 'View', shortcut: 'Ctrl+F', run: () => { store.dialog = 'search'; } });

// ---------- helpers ----------

function copyLayer() {
  const layer = activeLayer.value;
  if (!layer) return;
  const clip = { ...layer, bitmap: layer.bitmap ? cloneCanvas(layer.bitmap) : null, mask: layer.mask ? cloneCanvas(layer.mask) : null };
  store.clipLayer = clip;
}

function fillActive(color: string) {
  const layer = activeLayer.value!;
  if (!layer.bitmap) return;
  rasterEdit(layer, '填充', bmp => {
    const bx = ctx2d(bmp);
    if (store.selection) {
      const region = cloneCanvas(bmp);
      const rx = ctx2d(region);
      rx.fillStyle = color;
      rx.fillRect(0, 0, bmp.width, bmp.height);
      rx.globalCompositeOperation = 'destination-in';
      // selection mask is doc-space; assume identity for fills when sizes match
      if (store.selection.mask.width === bmp.width && store.selection.mask.height === bmp.height) {
        rx.drawImage(store.selection.mask, 0, 0);
      }
      rx.globalCompositeOperation = 'source-over';
      bx.drawImage(region, 0, 0);
    } else {
      bx.fillStyle = color;
      bx.fillRect(0, 0, bmp.width, bmp.height);
    }
  });
}

export function alphaBounds(c: HTMLCanvasElement): { x: number; y: number; w: number; h: number } | null {
  const d = ctx2dRead(c).getImageData(0, 0, c.width, c.height).data;
  let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// ---------- file flows ----------

async function pickFile(extensions: string[] | null, directory = false): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const result = await open({
    directory,
    multiple: false,
    filters: directory ? undefined : (extensions ? [{ name: 'Images', extensions }] : undefined),
  });
  return typeof result === 'string' ? result : null;
}

async function pickSave(defaultName: string): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  return save({ defaultPath: defaultName });
}

const OPEN_IMAGE_EXTS = [
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'tif', 'tiff', 'pdf',
  'psd', 'psb', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw',
];
const PLAIN_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg']);

async function openImage() {
  const path = await pickFile(OPEN_IMAGE_EXTS);
  if (!path) return;
  await openPathByKind(path);
}

/** Shared open dispatch (打开图像 + 最近打开): .comp project, PSD sheet, RAW sheet or plain image. */
export async function openPathByKind(path: string): Promise<void> {
  if (path.toLowerCase().endsWith('.comp')) {
    try {
      const doc = await openComp(path);
      setDoc(doc);
      tabDidLoad(path, basename(path));
    } catch (err) {
      alert(`无法打开项目：${(err as Error).message}`);
    }
    return;
  }
  if (/\.(tif|tiff)$/i.test(path)) {
    try {
      const doc = await importTiff(path);
      setDoc(doc);
      tabDidLoad(path, basename(path));
    } catch (err) {
      alert(`无法打开 TIFF：${(err as Error).message}`);
    }
    return;
  }
  if (/\.pdf$/i.test(path)) {
    await importPdfOpen(path);
    return;
  }
  if (isRawPath(path)) {
    try {
      const meta = await rawMetadata(path);
      store.dialogPayload = { path, meta };
      store.dialog = 'raw';
    } catch (err) {
      alert(`无法读取 RAW 文件：${(err as Error).message}`);
    }
    return;
  }
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (!PLAIN_IMAGE_EXTS.has(ext)) {
    // PSD magic sniff ('8BPS') on the first bytes: routes .psd/.psb (and
    // mislabeled files) to the PSD sheet; unknown content falls through
    let psd = false;
    try {
      psd = isPsd((await readFile(path)).buffer as ArrayBuffer);
    } catch { /* unreadable: let the image decoder report it */ }
    if (psd) {
      store.dialogPayload = { path };
      store.dialog = 'psd';
      return;
    }
  }
  try {
    const { canvas, icc, iccName } = await openImageWithMeta(path);
    const name = path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
    newDoc(canvas.width, canvas.height, 'transparent', name);
    const doc = store.doc!;
    doc.layers[0].bitmap = rawCanvas(canvas);
    doc.layers[0].name = name;
    // PNG iCCP / JPEG APP2 提取所得;随 .comp 与导出回写(Preserve 口径)
    if (icc) { doc.iccProfile = icc; doc.iccName = iccName; }
    store.tick++;
    tabDidLoad(path, name);
  } catch (err) {
    alert(`无法打开图像：${(err as Error).message}`);
  }
}

async function importPdfPick() {
  const path = await pickFile(['pdf']);
  if (!path) return;
  await importPdfOpen(path);
}

/** PDF → 新文档,每页一个图层(多页全导;页数上限在 pdfImport 内)。 */
async function importPdfOpen(path: string) {
  try {
    const { importPdf } = await import('./core/io/pdfImport');
    const doc = await importPdf(path, true);
    setDoc(doc);
    tabDidLoad(path, basename(path));
  } catch (err) {
    alert(`无法打开 PDF：${(err as Error).message}`);
  }
}

async function openProject() {
  const path = await pickFile(null, true);
  if (!path) return;
  try {
    const doc = await openComp(path);
    setDoc(doc);
    tabDidLoad(path, basename(path));
  } catch (err) {
    alert(`无法打开项目：${(err as Error).message}`);
  }
}

async function importAsLayer() {
  const path = await pickFile([
    'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg',
    'cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw',
  ]);
  if (!path) return;
  const lower = path.toLowerCase();
  if (lower.endsWith('.psd') || lower.endsWith('.psb')) {
    alert('PSD 请通过 文件 → 打开图像 导入全部图层');
    return;
  }
  try {
    let canvas: HTMLCanvasElement;
    if (isRawPath(path)) {
      const meta = await rawMetadata(path);
      canvas = await developRaw(path, {
        exposure: 0, temperature: meta.asShotTemperature, tint: meta.asShotTint, boost: 50,
      });
    } else {
      canvas = await openImageFile(path);
    }
    const name = path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
    const layer = addRasterLayer(name, rawCanvas(canvas));
    if (layer) layer.transform.size = [canvas.width, canvas.height];
    store.tick++;
  } catch (err) {
    alert(`无法导入图像：${(err as Error).message}`);
  }
}

async function saveProject(saveAs = false) {
  const doc = store.doc;
  if (!doc) return;
  let path = doc.fileName;
  if (saveAs || !path) {
    const picked = await pickSave(`${(path ?? 'Untitled').split(/[\\/]/).pop()?.replace(/\.comp$/, '') ?? 'Untitled'}.comp`);
    if (!picked) return;
    path = picked.endsWith('.comp') ? picked : picked + '.comp';
    doc.fileName = path;
  }
  try {
    await saveComp(doc, path);
    store.dirty = false;
    tabDidSave(path);
  } catch (err) {
    alert(`无法保存项目：${(err as Error).message}`);
  }
}

function withExtension(path: string, ext: string): string {
  return path.toLowerCase().endsWith('.' + ext) ? path : path + '.' + ext;
}

async function exportFlat(format: 'png' | 'jpeg') {
  if (!store.doc) return;
  const flat = flattenDoc();
  if (format === 'jpeg') {
    // JPEG has no alpha: composite over white
    const opaque = makeCanvas(flat.width, flat.height);
    const ox = ctx2d(opaque);
    ox.fillStyle = '#fff';
    ox.fillRect(0, 0, opaque.width, opaque.height);
    ox.drawImage(flat, 0, 0);
    const path = await pickSave('Untitled.jpg');
    if (path) await exportCanvas(opaque, withExtension(path, 'jpg'), 'jpeg', 0.92);
    return;
  }
  const path = await pickSave('Untitled.png');
  if (path) await exportCanvas(flat, withExtension(path, 'png'), 'png');
}

/** 导出 PSD(含图层):二进制 ArrayBuffer 经 write_file 写盘,与 exportCanvas 同一写文件通道。 */
async function exportPsdFlat() {
  const doc = store.doc;
  if (!doc) return;
  const path = await pickSave('Untitled.psd');
  if (!path) return;
  try {
    await writeFile(withExtension(path, 'psd'), new Uint8Array(exportPsd(doc)));
  } catch (err) {
    alert(`无法导出 PSD：${(err as Error).message}`);
  }
}

// ---------- filters ----------

export interface LastFilter { kind: string; params: Record<string, number | boolean> }
let lastFilter: LastFilter | null = null;

const CANVAS_FILTER_KINDS = new Set(['gaussianBlur', 'bloom', 'vignette', 'sharpen']);

export function applyFilterToActive(kind: string, params: Record<string, number | boolean>) {
  const layer = activeLayer.value;
  if (!layer?.bitmap) return;
  lastFilter = { kind, params };
  rasterEdit(layer, `滤镜：${kind}`, bmp => {
    if (CANVAS_FILTER_KINDS.has(kind)) {
      canvasFilter(bmp, kind, params);   // draw-based; whole-layer for v1
      return;
    }
    // pixel filters honor the selection bounds when one is active
    const b = store.selection?.bounds ?? null;
    const x = b ? Math.max(0, Math.round(b.x)) : 0;
    const y = b ? Math.max(0, Math.round(b.y)) : 0;
    const w = b ? Math.max(0, Math.min(bmp.width - x, Math.round(b.w))) : bmp.width;
    const h = b ? Math.max(0, Math.min(bmp.height - y, Math.round(b.h))) : bmp.height;
    if (w <= 0 || h <= 0) return;
    const bx = ctx2dRead(bmp);
    const sub = bx.getImageData(x, y, w, h);
    switch (kind) {
      case 'invert': invertApply(sub.data); break;
      case 'addNoise':
        addNoiseApply(sub.data, w, Number(params.amount), !!params.gaussian, !!params.monochromatic, 1);
        break;
      case 'grain': grainApply(sub.data, w, Number(params.amount), 7); break;
      case 'motionBlur': motionBlurApply(sub.data, w, h, Number(params.angle), Number(params.distance)); break;
      case 'vibrance': vibranceApply(sub.data, w, Number(params.vibrance), Number(params.saturation)); break;
      case 'channelMixer': channelMixerApply(sub.data, params); break;
      case 'photoFilter': photoFilterApply(sub.data, Number(params.warmth), Number(params.density)); break;
      case 'shadowHighlight': shadowHighlightApply(sub.data, w, h, Number(params.shadows), Number(params.highlights)); break;
    }
    bx.putImageData(sub, x, y);
  });
}

function canvasFilter(bmp: HTMLCanvasElement, kind: string, params: Record<string, number | boolean>) {
  // canvas-native filters that need drawImage (blur-based)
  const copy = cloneCanvas(bmp);
  const bx = ctx2d(bmp);
  bx.clearRect(0, 0, bmp.width, bmp.height);
  if (kind === 'gaussianBlur') {
    bx.filter = `blur(${Number(params.radius)}px)`;
    bx.drawImage(copy, 0, 0);
    bx.filter = 'none';
  } else if (kind === 'bloom') {
    const bright = cloneCanvas(copy);
    const px = ctx2dRead(bright).getImageData(0, 0, bright.width, bright.height);
    for (let i = 0; i < px.data.length; i += 4) {
      const l = (px.data[i] + px.data[i + 1] + px.data[i + 2]) / 3;
      const keep = Math.max(0, l - 160) / 95 * (Number(params.amount) / 100);
      px.data[i] *= keep; px.data[i + 1] *= keep; px.data[i + 2] *= keep; px.data[i + 3] *= keep;
    }
    ctx2dRead(bright).putImageData(px, 0, 0);
    bx.drawImage(copy, 0, 0);
    bx.globalCompositeOperation = 'screen';
    bx.filter = `blur(${Number(params.radius)}px)`;
    bx.drawImage(bright, 0, 0);
    bx.filter = 'none';
    bx.globalCompositeOperation = 'source-over';
  } else if (kind === 'vignette') {
    bx.drawImage(copy, 0, 0);
    const g = bx.createRadialGradient(
      bmp.width / 2, bmp.height / 2, Math.min(bmp.width, bmp.height) * 0.35,
      bmp.width / 2, bmp.height / 2, Math.hypot(bmp.width, bmp.height) / 2,
    );
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${Number(params.amount) / 100})`);
    bx.fillStyle = g;
    bx.fillRect(0, 0, bmp.width, bmp.height);
  } else if (kind === 'sharpen') {
    // unsharp: original + (original − blurred) × amount
    const blurred = cloneCanvas(copy);
    const blx = ctx2d(blurred);
    blx.filter = 'blur(1px)';
    blx.drawImage(copy, 0, 0);
    blx.filter = 'none';
    bx.drawImage(copy, 0, 0);
    bx.globalCompositeOperation = 'difference';
    bx.drawImage(blurred, 0, 0);
    // difference result in bmp; scale by amount and add back
    const diff = cloneCanvas(bmp);
    const dx = ctx2dRead(diff).getImageData(0, 0, diff.width, diff.height);
    const a = Number(params.amount) / 100;
    for (let i = 0; i < dx.data.length; i += 4) {
      dx.data[i] *= a; dx.data[i + 1] *= a; dx.data[i + 2] *= a;
    }
    ctx2dRead(diff).putImageData(dx, 0, 0);
    bx.clearRect(0, 0, bmp.width, bmp.height);
    bx.drawImage(copy, 0, 0);
    bx.globalCompositeOperation = 'lighter';
    bx.drawImage(diff, 0, 0);
    bx.globalCompositeOperation = 'source-over';
  }
}

export function commandById(id: string): Command | undefined {
  return commands.find(c => c.id === id);
}

export function runCommand(id: string) {
  const c = commandById(id);
  if (c && (!c.enabled || c.enabled())) {
    recordStep(id); // 动作录制挂点(未录制时零开销)
    void c.run();
  }
}

// tool-letter shortcuts handled by App.vue
export const TOOL_KEYS: Record<string, string> = {
  v: 'move', b: 'brush', e: 'eraser', j: 'heal', s: 'clone', p: 'pen',
  t: 'type', g: 'gradient', u: 'shape', i: 'eyedropper', m: 'marquee',
  w: 'wand', l: 'lasso', c: 'crop', h: 'hand', z: 'zoom', r: 'smear', o: 'dodge',
};
