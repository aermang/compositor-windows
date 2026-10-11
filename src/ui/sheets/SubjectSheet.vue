<script setup lang="ts">
// 主体近似对话框:store.dialog === 'subject' 时挂载,payload { mode: 'select' | 'removeBg' }。
// select  → 由主体蒙版生成选区;removeBg → 把主体蒙版乘入图层蒙版(非破坏性)。
// 管线:approxSubjectMask → refineMatte(radius=优化边缘) → shiftEdge(模糊 |v|/2 后
// 以 0.75/0.25 阈值二值化) → 蒙版对比斜率。简化算法版(原版使用系统机器学习)。

import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import {
  store, activeLayer, history, rawCanvas, invalidate, uiRefresh,
} from '../../core/store';
import { emptySelection, finalize } from '../../core/selection';
import { approxSubjectMask } from '../../core/selectionOps/subjectApprox';
import { refineMatte } from '../../core/selectionOps/guidedMatte';
import { snapCanvas } from '../../core/history';
import { makeCanvas, ctx2d, ctx2dRead, cloneCanvas, drawThroughTransform } from '../../core/canvasUtils';
import type { Layer } from '../../core/types';

const NAME = 'subject';
const isOpen = computed(() => store.dialog === NAME);

const mode = ref<'select' | 'removeBg'>('select');
const title = computed(() => (mode.value === 'removeBg' ? '移除背景' : '选取主体'));

const s = reactive({ radius: 12, contrast: 25, shift: 0 });
const running = ref(false);
const error = ref<string | null>(null);
const hasBitmap = computed(() => !!activeLayer.value?.bitmap);

const previewRef = ref<HTMLCanvasElement | null>(null);
let src: ImageData | null = null;
let baseMatte: Float32Array | null = null;
let guide: Float32Array | null = null;
let timer: number | undefined;

/** 非预乘亮度引导平面(0..1);全透明像素为 0。 */
function lumaGuidePlane(img: ImageData): Float32Array {
  const w = img.width, h = img.height, d = img.data;
  const out = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4, a = d[i + 3];
    if (a === 0) continue;
    const r = Math.min(255, (d[i] * 255 + a / 2) / a);
    const g = Math.min(255, (d[i + 1] * 255 + a / 2) / a);
    const b = Math.min(255, (d[i + 2] * 255 + a / 2) / a);
    out[p] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }
  return out;
}

/** 边缘复制的可分离盒式模糊。 */
function boxBlurPlane(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0) return src;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, x + k))];
      tmp[row + x] = acc / win;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
      out[y * w + x] = acc / win;
    }
  }
  return out;
}

/** 优化边缘 → 边缘移动 → 蒙版对比。 */
function chain(base: Float32Array, g: Float32Array, w: number, h: number): Float32Array {
  const m = refineMatte(g, base, w, h, s.radius);
  if (s.shift !== 0) {
    const blurred = boxBlurPlane(m, w, h, Math.max(1, Math.round(Math.abs(s.shift) / 2)));
    const th = s.shift > 0 ? 0.25 : 0.75; // 正值向外扩展,负值向内收缩
    for (let p = 0; p < m.length; p++) m[p] = blurred[p] >= th ? 1 : 0;
  }
  if (s.contrast > 0) {
    const k = (100 + s.contrast) / Math.max(1, 100 - s.contrast);
    for (let p = 0; p < m.length; p++) {
      const v = (m[p] - 0.5) * k + 0.5;
      m[p] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }
  return m;
}

/** ≤500px 长边的图层位图副本 ImageData。 */
function buildSource(): ImageData | null {
  const bmp = activeLayer.value?.bitmap;
  if (!bmp || bmp.width < 1 || bmp.height < 1) return null;
  const long = Math.max(bmp.width, bmp.height);
  const k = long > 500 ? 500 / long : 1;
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const c = makeCanvas(w, h);
  const cx = ctx2d(c);
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(bmp, 0, 0, w, h);
  return ctx2dRead(c).getImageData(0, 0, w, h);
}

function renderPreview() {
  const cv = previewRef.value;
  if (!cv || !src || !baseMatte || !guide) return;
  const w = src.width, h = src.height;
  const matte = chain(baseMatte, guide, w, h);
  const tmp = makeCanvas(w, h);
  const tx = ctx2dRead(tmp);
  tx.putImageData(src, 0, 0);
  const img = tx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let p = 0; p < matte.length; p++) {
    d[p * 4 + 3] = Math.round(d[p * 4 + 3] * matte[p]); // 蒙版乘入 alpha 预览
  }
  tx.putImageData(img, 0, 0);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const px = ctx2d(cv);
  px.clearRect(0, 0, cv.width, cv.height);
  px.drawImage(tmp, 0, 0);
}

function schedule() {
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(renderPreview, 80);
}

function close() { store.dialog = null; store.dialogPayload = null; }
function cancel() { close(); }

/** 全分辨率主体蒙版(图层位图坐标系)。 */
function fullResMatte(bmp: HTMLCanvasElement): Float32Array {
  const img = ctx2dRead(bmp).getImageData(0, 0, bmp.width, bmp.height);
  const base = approxSubjectMask(img);
  return chain(base, lumaGuidePlane(img), bmp.width, bmp.height);
}

function okSelect(layer: Layer) {
  const doc = store.doc;
  const bmp = layer.bitmap;
  if (!doc || !bmp) return;
  const matte = fullResMatte(bmp);
  const mc = makeCanvas(bmp.width, bmp.height);
  const mi = ctx2dRead(mc).createImageData(bmp.width, bmp.height);
  for (let p = 0; p < matte.length; p++) {
    const i = p * 4;
    mi.data[i] = mi.data[i + 1] = mi.data[i + 2] = 255;
    mi.data[i + 3] = matte[p] * 255 >= 128 ? 255 : 0;
  }
  ctx2dRead(mc).putImageData(mi, 0, 0);
  // 蒙版画布经图层变换绘制到文档空间,再进入选区
  const dc = makeCanvas(doc.width, doc.height);
  drawThroughTransform(ctx2d(dc), mc, bmp.width, bmp.height, layer.transform);
  const prior = store.selection;
  const sel = emptySelection(doc);
  ctx2d(sel.mask).drawImage(dc, 0, 0);
  finalize(sel);
  store.selection = sel;
  history.push({
    label: '选取主体',
    undo: () => { store.selection = prior; store.dirty = true; store.tick++; store.uiTick++; },
    redo: () => { store.selection = sel; store.dirty = true; store.tick++; store.uiTick++; },
  });
  store.dirty = true;
  store.tick++;
  store.uiTick++;
}

function okRemoveBg(layer: Layer) {
  const bmp = layer.bitmap;
  if (!bmp) return;
  const matte = fullResMatte(bmp);
  const compatible = !!layer.mask
    && layer.mask.width === bmp.width && layer.mask.height === bmp.height;
  const before = layer.mask ? snapCanvas(layer.mask) : null;
  const beforeEnabled = layer.maskEnabled;

  const mc = makeCanvas(bmp.width, bmp.height);
  const mx = ctx2dRead(mc);
  if (compatible && layer.mask) {
    mx.drawImage(layer.mask, 0, 0); // 白色显示,红通道承载灰度
  } else {
    mx.fillStyle = '#fff';
    mx.fillRect(0, 0, bmp.width, bmp.height);
  }
  const id = mx.getImageData(0, 0, bmp.width, bmp.height);
  const d = id.data;
  for (let p = 0; p < matte.length; p++) {
    const gray = Math.round(d[p * 4] * matte[p]);
    d[p * 4] = d[p * 4 + 1] = d[p * 4 + 2] = gray;
    d[p * 4 + 3] = 255;
  }
  mx.putImageData(id, 0, 0);

  layer.mask = rawCanvas(mc);
  layer.maskEnabled = true;
  layer.maskLinked = true;
  const after = snapCanvas(layer.mask);
  history.push({
    label: '移除背景',
    undo: () => {
      layer.mask = before ? rawCanvas(cloneCanvas(before)) : null;
      layer.maskEnabled = beforeEnabled;
      store.dirty = true; invalidate(); uiRefresh();
    },
    redo: () => {
      layer.mask = rawCanvas(cloneCanvas(after!));
      layer.maskEnabled = true;
      store.dirty = true; invalidate(); uiRefresh();
    },
  });
  store.dirty = true;
  invalidate();
  uiRefresh();
}

function ok() {
  const layer = activeLayer.value;
  if (!layer?.bitmap || running.value) return;
  running.value = true;
  error.value = null;
  window.setTimeout(() => {
    try {
      if (mode.value === 'removeBg') okRemoveBg(layer);
      else okSelect(layer);
      running.value = false;
      close();
    } catch (e) {
      running.value = false;
      error.value = e instanceof Error ? e.message : String(e);
    }
  }, 30);
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && store.dialog === NAME) cancel();
}

function teardown() {
  if (timer) { window.clearTimeout(timer); timer = undefined; }
  src = null; baseMatte = null; guide = null;
  window.removeEventListener('keydown', onKey);
}

watch(isOpen, open => {
  if (open) {
    const p = store.dialogPayload as { mode?: 'select' | 'removeBg' } | null;
    mode.value = p?.mode === 'removeBg' ? 'removeBg' : 'select';
    error.value = null;
    src = buildSource();
    if (src) {
      baseMatte = approxSubjectMask(src);
      guide = lumaGuidePlane(src);
    } else {
      baseMatte = null;
      guide = null;
    }
    window.addEventListener('keydown', onKey);
    void nextTick(renderPreview);
  } else {
    teardown();
  }
}, { immediate: true });
watch(s, schedule); // reactive 源默认深监听
onBeforeUnmount(teardown);
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="backdrop" @click="cancel"></div>
    <div v-if="isOpen" class="dialog wide">
      <h3>{{ title }}</h3>
      <div v-if="!hasBitmap" class="hint">当前图层没有像素内容。</div>
      <template v-else>
        <div class="hint">
          {{ mode === 'removeBg' ? '将把主体蒙版乘入图层蒙版（非破坏性，可撤销）。' : '将根据主体近似蒙版创建选区。' }}
        </div>
        <div class="body">
          <div class="controls">
            <label class="row">优化边缘
              <input type="range" min="0" max="40" step="1" v-model.number="s.radius" />
              <span class="v">{{ s.radius }}</span>
            </label>
            <label class="row">蒙版对比
              <input type="range" min="0" max="100" step="1" v-model.number="s.contrast" />
              <span class="v">{{ s.contrast }}</span>
            </label>
            <label class="row">边缘移动
              <input type="range" min="-10" max="10" step="1" v-model.number="s.shift" />
              <span class="v">{{ s.shift }}</span>
            </label>
            <div v-if="running" class="hint">计算中…</div>
            <div v-if="error" class="error">{{ error }}</div>
          </div>
          <div class="preview-box">
            <canvas ref="previewRef" class="preview"></canvas>
          </div>
        </div>
      </template>
      <div class="actions">
        <span class="note">简化算法版（原版使用系统机器学习）</span>
        <button class="btn" @click="cancel">取消</button>
        <button class="btn primary" :disabled="!hasBitmap || running" @click="ok">确定</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.45);
  z-index: 200;
}
.dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: #2b2b2b;
  border: 1px solid #000;
  border-radius: 10px;
  padding: 18px 20px;
  min-width: 340px;
  max-width: 640px;
  max-height: 82vh;
  overflow-y: auto;
  color: #ddd;
  box-shadow: 0 16px 48px rgba(0,0,0,0.6);
  z-index: 201;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dialog.wide { min-width: 560px; }
h3 { margin: 0 0 4px; font-size: 14px; color: #fff; }
.body { display: grid; grid-template-columns: 220px 1fr; gap: 14px; }
.controls { display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.row input[type='range'] { flex: 1; min-width: 110px; accent-color: #0e639c; }
.row .v { min-width: 44px; text-align: right; color: #999; font-size: 11px; }
.hint { font-size: 11px; color: #777; line-height: 1.5; }
.error { font-size: 11px; color: #e05555; line-height: 1.5; }
.actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 6px; }
.note { margin-right: auto; font-size: 10px; color: #666; }
.btn {
  background: #333; color: #ddd; border: 1px solid #454545;
  border-radius: 5px; padding: 6px 14px; font-size: 12px; cursor: pointer;
}
.btn:hover { background: #3a3a3a; }
.btn.primary { background: #0e639c; border-color: #1177bb; color: #fff; }
.btn.primary:hover { background: #1177bb; }
.btn.primary:disabled { opacity: 0.5; cursor: default; }
.preview-box {
  display: flex; align-items: center; justify-content: center;
  background: conic-gradient(#3a3a3a 0 25%, #2e2e2e 0 50%, #3a3a3a 0 75%, #2e2e2e 0) 0 0 / 16px 16px;
  border: 1px solid #444; border-radius: 4px; padding: 6px; min-height: 120px;
}
canvas.preview { max-width: 100%; max-height: 340px; display: block; }
</style>
