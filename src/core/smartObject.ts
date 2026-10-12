// Smart objects: a layer's pixels live in an embedded sub-document
// (doc.smartObjects[]); the layer keeps a source-resolution materialized
// bitmap so every transform resample starts from the original pixels.
// 转换/栅格化走闭包历史;合成器每帧调用 refreshSmartBitmap,以子文档内容
// 签名(层数 + rev + 位图身份)短路,未变化时零分配返回,绝不每帧重绘。
// 与 compositor / store 的相互 import 均为惰性函数调用,ESM 下安全。
import { markRaw } from 'vue';
import { composite } from './compositor';
import { makeLayer, defaultTransform } from './types';
import type { Doc, Layer, SmartObjectRef } from './types';
import { store, history, activeLayer, uiRefresh } from './store';

/** 图层 → 内嵌子文档(无则 null)。按 smartObjectId 在当前文档的智能对象表里
 *  查找,并下钻嵌套子文档(v1 局限:只查当前文档,不含其他标签页的文档)。 */
export function smartDoc(layer: Layer): Doc | null {
  const id = layer?.smartObjectId;
  if (!id) return null;
  return findSmartRef(store.doc, id)?.doc ?? null;
}

function findSmartRef(doc: Doc | null | undefined, id: string): SmartObjectRef | null {
  for (const ref of doc?.smartObjects ?? []) {
    if (!ref?.doc) continue;
    if (ref.id === id) return ref;
    const nested = findSmartRef(ref.doc, id);
    if (nested) return nested;
  }
  return null;
}

/** 活动栅格图层 → 智能对象(像素打包进子文档,bitmap 换为源分辨率物化视图)。 */
export function convertToSmartObject(): void {
  const layer = activeLayer.value;
  const doc = store.doc;
  // 可编辑栅格层判定同 heal.ts:非组、非调整层、有位图,且尚未是智能对象
  if (!doc || !layer || layer.isGroup || layer.adjustment || !layer.bitmap) return;
  if (layer.smartObjectId) return;

  const src = layer.bitmap;
  const name = layer.name;

  // 子文档:单层 1:1 承载原位图。注意 makeLayer 的默认 transform 是
  // defaultTransform(0,0),必须显式给源尺寸,子文档合成才是恒等映射。
  const subLayer = makeLayer({ name });
  subLayer.bitmap = src;
  subLayer.transform = defaultTransform(src.width, src.height);
  const ref: SmartObjectRef = {
    id: crypto.randomUUID(),
    name,
    doc: {
      id: crypto.randomUUID(),
      width: src.width,
      height: src.height,
      resolution: doc.resolution,
      layers: [subLayer],
      activeLayerId: subLayer.id,
      fileName: null,
    },
  };
  // 源分辨率物化视图:与原位图内容逐位一致,转换前后合成结果不变
  const materialized = markRaw(composite(ref.doc));

  const before = {
    bitmap: layer.bitmap,
    text: layer.text,
    shape: layer.shape,
    rev: layer.rev,
    smartObjectId: layer.smartObjectId,
  };
  const afterRev = (layer.rev ?? 0) + 1;

  const applyForward = () => {
    if (!doc.smartObjects) doc.smartObjects = [];
    if (!doc.smartObjects.some(r => r.id === ref.id)) doc.smartObjects.push(ref);
    layer.bitmap = materialized;
    layer.text = null; // v1:转换即烘焙,文字/形状 meta 不再跟随
    layer.shape = null;
    layer.rev = afterRev;
    layer.smartObjectId = ref.id;
  };
  const applyBackward = () => {
    const arr = doc.smartObjects;
    if (arr) {
      const i = arr.findIndex(r => r.id === ref.id);
      if (i >= 0) arr.splice(i, 1);
    }
    layer.bitmap = before.bitmap;
    layer.text = before.text;
    layer.shape = before.shape;
    layer.rev = before.rev;
    layer.smartObjectId = before.smartObjectId;
  };

  applyForward();
  smartCache.set(layer, { sig: subDocSig(ref.doc.layers), canvas: materialized });
  store.dirty = true;
  store.tick++;
  uiRefresh();
  history.push({
    label: '转换为智能对象',
    undo: () => { applyBackward(); store.tick++; uiRefresh(); },
    redo: () => { applyForward(); store.tick++; uiRefresh(); },
  });
}

/** 智能对象层 → 普通栅格层(丢弃子文档引用,保留当前像素)。 */
export function rasterizeSmartObject(): void {
  const layer = activeLayer.value;
  const doc = store.doc;
  if (!doc || !layer?.smartObjectId) return;
  const id = layer.smartObjectId;
  const arr = doc.smartObjects;
  const ref = arr?.find(r => r.id === id) ?? null;
  const index = ref && arr ? arr.indexOf(ref) : -1;
  // 复制出的智能层共享同一 ref:还有别的引用者时子文档必须保留
  const shared = doc.layers.some(l => l.id !== layer.id && l.smartObjectId === id);
  const beforeRev = layer.rev ?? 0;

  const applyForward = () => {
    layer.smartObjectId = undefined;
    layer.rev = beforeRev + 1;
    if (ref && arr && !shared) {
      const i = arr.findIndex(r => r.id === id);
      if (i >= 0) arr.splice(i, 1);
    }
  };
  const applyBackward = () => {
    layer.smartObjectId = id;
    layer.rev = beforeRev;
    if (ref && arr && !shared && !arr.some(r => r.id === id)) {
      arr.splice(Math.min(index, arr.length), 0, ref);
    }
  };

  applyForward();
  store.dirty = true;
  store.tick++;
  uiRefresh();
  history.push({
    label: '栅格化智能对象',
    undo: () => { applyBackward(); store.tick++; uiRefresh(); },
    redo: () => { applyForward(); store.tick++; uiRefresh(); },
  });
}

// ---------- 物化视图缓存(热路径) ----------

interface SmartCacheEntry { sig: number; canvas: HTMLCanvasElement }
// 键 = 文档里的图层代理(层代理按 id 稳定,见 store.layerProxies)
const smartCache = new WeakMap<Layer, SmartCacheEntry>();

// 子文档位图身份号:子层位图被 undo 换了画布而 rev 未动时签名仍能变化。
// WeakMap 读取零分配;uid 只在每个新画布首次出现时分配一次。
const canvasUids = new WeakMap<HTMLCanvasElement, number>();
let nextCanvasUid = 1;
function canvasUid(c: HTMLCanvasElement): number {
  let u = canvasUids.get(c);
  if (u === undefined) {
    u = nextCanvasUid++;
    canvasUids.set(c, u);
  }
  return u;
}

function subDocSig(layers: Layer[]): number {
  let sig = layers.length + 1;
  for (const l of layers) {
    sig = (Math.imul(sig, 31) + (l.rev ?? 0)) | 0;
    if (l.bitmap) sig = (Math.imul(sig, 31) + canvasUid(l.bitmap)) | 0;
  }
  return sig | 0;
}

/** 合成器每帧调用:确保 layer.bitmap 是子文档按源分辨率的最新合成。
 *  未变化时必须零开销返回(rev 短路),变化时更新 bitmap 并 bump layer.rev。 */
export function refreshSmartBitmap(doc: Doc, layer: Layer): void {
  const id = layer.smartObjectId;
  if (!id) return;
  const ref = findSmartRef(doc, id); // 找不到(已被栅格化/表丢失)→ 不动 bitmap
  if (!ref?.doc?.layers) return;

  const sig = subDocSig(ref.doc.layers);
  const cached = smartCache.get(layer);
  if (cached && cached.sig === sig) return; // 零开销短路

  let flat: HTMLCanvasElement;
  try {
    flat = markRaw(composite(ref.doc)); // 源分辨率
  } catch {
    return; // 热路径禁止 throw:子文档损坏时保持现有视图
  }
  layer.bitmap = flat;
  smartCache.set(layer, { sig, canvas: flat });
  layer.rev = (layer.rev ?? 0) + 1; // layerCacheKey 含 rev → 自动失效缓存段
}
