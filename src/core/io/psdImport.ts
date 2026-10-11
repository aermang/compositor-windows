// PsdImportResult → 本应用的 Doc 约定:图层自底向顶、画布经 rawCanvas(markRaw)、
// 蒙版从"蒙版矩形空间"折算到"图层位图像素空间"(链接蒙版经图层变换绘制,两者同栅格)、
// 剪贴蒙版链解析为 maskSourceId、调整图层草稿映射到 AdjustmentData、文字草稿经
// upsertTextBitmap 现场渲染位图。矢量图层优先保留读者已栅格化的画布,同时挂上
// 参数化 ShapeMeta,与形状工具创建的图层一致。

import { makeCanvas, ctx2d } from '../canvasUtils';
import { makeLayer, defaultTransform, defaultAdjustment } from '../types';
import type {
  AdjustmentData, AdjustmentKind, BlendMode, CurvesSettings, Doc, HueSatSettings,
  Layer, LevelsSettings, ShapeMeta, TextMeta,
} from '../types';
import { rawCanvas, upsertTextBitmap } from '../store';
import type { PsdImportResult, PsdLayerRecord, PsdShapeDraft, PsdTextDraft } from './psd/builder';

// 记录未携带蒙版矩形,只能按图层左上角对齐;尺寸一致时通常恰好重合,不一致时提示。
const MASK_ALIGN_NOTE = '蒙版已按图层左上角对齐导入，与图层边界不一致时可能有偏移';

// adjustments.ts 只产出这三种应用内调整名,其余 kind 一律跳过并记说明。
const SUPPORTED_ADJUSTMENTS: Record<string, AdjustmentKind> = {
  'Levels': 'Levels',
  'Curves': 'Curves',
  'Hue/Saturation': 'Hue/Saturation',
};

export function psdToDoc(result: PsdImportResult): Doc {
  // PSD 记录与本应用图层同为自底向顶,顺序直通。
  const layers: Layer[] = [];
  for (const rec of result.layers) {
    layers.push(recordToLayer(rec, result, layers));
  }
  return {
    id: crypto.randomUUID().toUpperCase(),
    width: result.width,
    height: result.height,
    resolution: result.resolution,
    layers,
    activeLayerId: layers.length ? layers[layers.length - 1].id : null,
    fileName: null,
  };
}

/** 导入说明:读者注释 + 转换期告警(蒙版对齐、被跳过的调整图层),已去重。 */
export function psdNotes(result: PsdImportResult): string[] {
  const notes = new Set(result.notes);
  for (const rec of result.layers) {
    if (maskIsApproximate(rec, result)) notes.add(MASK_ALIGN_NOTE);
    const kind = rec.adjustment ? SUPPORTED_ADJUSTMENTS[rec.adjustment.kind] : undefined;
    if (rec.adjustment && !kind) notes.add(`不支持的调整图层已跳过（${displayName(rec)}）`);
  }
  return [...notes];
}

function recordToLayer(rec: PsdLayerRecord, result: PsdImportResult, below: Layer[]): Layer {
  const layer = makeLayer({
    name: displayName(rec),
    id: rec.id, // parentId 已引用读者生成的 id,必须原样保留
    isGroup: rec.isGroup,
    parentId: rec.parentId,
    opacity: Math.min(1, Math.max(0, rec.opacity)),
    blendMode: rec.blendMode as BlendMode, // 读者已把未知签名归一为 'Normal'
    isVisible: !rec.hidden,
  });

  const adjKind = rec.adjustment ? SUPPORTED_ADJUSTMENTS[rec.adjustment.kind] : undefined;
  if (rec.adjustment && adjKind) layer.adjustment = adjustmentData(rec.adjustment, adjKind);

  if (rec.canvas) {
    layer.bitmap = rawCanvas(rec.canvas);
    layer.transform = defaultTransform(rec.canvas.width, rec.canvas.height);
    layer.transform.origin = [rec.bounds.x, rec.bounds.y];
  } else {
    // 组与调整图层没有自己的像素,变换覆盖整个文档(与 addGroupLayer/addAdjustmentLayer 一致)
    layer.transform = defaultTransform(result.width, result.height);
  }

  layer.mask = buildMask(rec, result);

  // 剪贴蒙版:作用于同组内下方最近一个非组、非调整图层(链式剪贴因此自然成立,
  // 因为下方图层的 prepared 内容已含其自身的剪贴结果)。
  if (rec.clipping && !rec.isGroup && !adjKind) {
    for (let j = below.length - 1; j >= 0; j--) {
      const b = below[j];
      if (b.parentId === rec.parentId && !b.isGroup && !b.adjustment) {
        layer.maskSourceId = b.id;
        break;
      }
    }
  }

  if (rec.text) applyTextDraft(layer, rec.text, rec);
  if (rec.shape && !rec.isGroup) applyShapeDraft(layer, rec.shape, rec);

  return layer;
}

function displayName(rec: PsdLayerRecord): string {
  return rec.name !== '' ? rec.name : '图层';
}

/** PSD 草稿数据本就按本应用设置接口组装(见 io/psd/adjustments.ts),整体覆写对应槽位。 */
function adjustmentData(
  draft: { kind: string; data: unknown },
  kind: AdjustmentKind,
): AdjustmentData {
  const adj = defaultAdjustment(kind);
  if (kind === 'Levels') adj.levels = draft.data as LevelsSettings;
  else if (kind === 'Curves') adj.curves = draft.data as CurvesSettings;
  else adj.hueSat = draft.data as HueSatSettings;
  return adj;
}

/**
 * 蒙版空间折算:先按 maskDefault 铺底(0→黑,即蒙版矩形之外隐藏;255→白),
 * 再把蒙版画布画到左上角。记录不带蒙版矩形偏移;尺寸与目标一致时通常恰好重合。
 */
function buildMask(rec: PsdLayerRecord, result: PsdImportResult): HTMLCanvasElement | null {
  if (!rec.mask) return null;
  const bw = rec.canvas ? rec.canvas.width : result.width;  // 调整图层/组:文档空间
  const bh = rec.canvas ? rec.canvas.height : result.height;
  const m = makeCanvas(bw, bh);
  const mx = ctx2d(m);
  mx.fillStyle = rec.maskDefault === 0 ? '#000' : '#fff';
  mx.fillRect(0, 0, bw, bh);
  mx.drawImage(rec.mask, 0, 0);
  return rawCanvas(m);
}

function maskIsApproximate(rec: PsdLayerRecord, result: PsdImportResult): boolean {
  if (!rec.mask) return false;
  const tw = rec.canvas ? rec.canvas.width : result.width;
  const th = rec.canvas ? rec.canvas.height : result.height;
  return rec.mask.width !== tw || rec.mask.height !== th;
}

/** 文字草稿 → TextMeta + 现场渲染位图;变换按 PSD 记录边界/旋转/翻转重建。 */
function applyTextDraft(layer: Layer, draft: PsdTextDraft, rec: PsdLayerRecord) {
  const meta: TextMeta = {
    content: draft.text,
    fontName: draft.font,
    fontSize: Math.max(1, draft.sizePx),
    color: parseCssRgb(draft.colorCss),
    align: 'left',
    tracking: draft.trackingPx,
    lineSpacing: Math.max(1, draft.sizePx * 1.2),
    boxSize: [Math.max(1, Math.round(rec.bounds.w)), Math.max(1, Math.round(rec.bounds.h))],
  };
  // boxSize 已给定,渲染不依赖 store 当前文档;位图高度按应用约定留 4 倍余量。
  upsertTextBitmap(layer, meta);
  if (!layer.bitmap) return;
  layer.transform = {
    ...defaultTransform(layer.bitmap.width, layer.bitmap.height),
    origin: [rec.bounds.x, rec.bounds.y],
    rotation: draft.rotation,
    flipY: draft.flipY,
  };
}

/** 矢量草稿:参数化 meta 与栅格并存(与形状工具产物一致);缺栅格时按草稿自绘兜底。 */
function applyShapeDraft(layer: Layer, draft: PsdShapeDraft, rec: PsdLayerRecord) {
  if (!layer.bitmap) {
    layer.bitmap = rawCanvas(rasterizeShape(draft, rec.bounds.w, rec.bounds.h));
    layer.transform = defaultTransform(layer.bitmap.width, layer.bitmap.height);
    layer.transform.origin = [rec.bounds.x, rec.bounds.y];
  }
  layer.shape = {
    kind: draft.kind,
    color: [draft.fillRgb[0] / 255, draft.fillRgb[1] / 255, draft.fillRgb[2] / 255],
    cornerRadius: draft.kind === 'roundedRectangle' ? draft.radius : 0,
    lineWidth: 0,
    start: [0, 1],
    end: [1, 0],
  } satisfies ShapeMeta;
}

function rasterizeShape(draft: PsdShapeDraft, w: number, h: number): HTMLCanvasElement {
  const c = makeCanvas(Math.max(1, w), Math.max(1, h));
  const cx = ctx2d(c);
  cx.fillStyle = draft.fillCss;
  if (draft.kind === 'ellipse') {
    cx.beginPath();
    cx.ellipse(c.width / 2, c.height / 2, c.width / 2, c.height / 2, 0, 0, Math.PI * 2);
    cx.fill();
  } else if (draft.kind === 'roundedRectangle') {
    const r = Math.min(draft.radius, Math.min(c.width, c.height) / 2);
    cx.beginPath();
    cx.moveTo(r, 0);
    cx.arcTo(c.width, 0, c.width, c.height, r);
    cx.arcTo(c.width, c.height, 0, c.height, r);
    cx.arcTo(0, c.height, 0, 0, r);
    cx.arcTo(0, 0, c.width, 0, r);
    cx.closePath();
    cx.fill();
  } else {
    cx.fillRect(0, 0, c.width, c.height);
  }
  return c;
}

function parseCssRgb(css: string): [number, number, number] {
  const m = css.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (!m) return [0, 0, 0];
  const c = (v: string): number => Math.min(1, Math.max(0, Number(v) / 255));
  return [c(m[1]), c(m[2]), c(m[3])];
}
