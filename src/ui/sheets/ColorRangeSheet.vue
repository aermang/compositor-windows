<script setup lang="ts">
// 色彩范围对话框:store.dialog === 'colorRange' 时挂载。
// Photoshop 式多取样键控:单击预览取样(Shift 加入 / Alt 排除),模糊度 + 反相,
// 预览以红色 50% 叠层显示蒙版(120ms 防抖);确定时对 prepareLayer 生成的
// 文档空间图层 ImageData 运行 colorRangeMask,构建文档空间选区。

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { store, activeLayer, history } from '../../core/store';
import { colorRangeMask, sampleAt } from '../../core/selectionOps/colorRange';
import { prepareLayer } from '../../core/compositor';
import { selectionFromMaskArray } from '../../core/selection';
import { makeCanvas, ctx2d, ctx2dRead, cloneCanvas } from '../../core/canvasUtils';
import type { SelectionState } from '../../core/selection';

const NAME = 'colorRange';
const isOpen = computed(() => store.dialog === NAME);

const fuzziness = ref(40);
const invert = ref(false);
const include = ref<[number, number, number][]>([]);
const exclude = ref<[number, number, number][]>([]);
const error = ref<string | null>(null);
const hasBitmap = computed(() => !!activeLayer.value?.bitmap);

const previewRef = ref<HTMLCanvasElement | null>(null);
let src: ImageData | null = null;
let timer: number | undefined;
let priorSelection: SelectionState | null = null;
let priorMaskSnap: HTMLCanvasElement | null = null;

function cssOf(c: [number, number, number]): string {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function removeSample(list: [number, number, number][], i: number) {
  list.splice(i, 1);
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
  if (!cv || !src) return;
  const w = src.width, h = src.height;
  const mask = colorRangeMask(src, include.value, exclude.value, fuzziness.value, invert.value);
  const tmp = makeCanvas(w, h);
  const tx = ctx2dRead(tmp);
  tx.putImageData(src, 0, 0);
  const img = tx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let p = 0; p < mask.length; p++) {
    if (mask[p]) {
      const i = p * 4;
      d[i] = Math.round(255 * 0.5 + d[i] * 0.5);       // 红色 50% 叠层
      d[i + 1] = Math.round(d[i + 1] * 0.5);
      d[i + 2] = Math.round(d[i + 2] * 0.5);
      d[i + 3] = 255;
    }
  }
  tx.putImageData(img, 0, 0);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const px = ctx2d(cv);
  px.clearRect(0, 0, cv.width, cv.height);
  px.drawImage(tmp, 0, 0);
}

function schedule() {
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(renderPreview, 120);
}

function onPreviewClick(e: MouseEvent) {
  const cv = previewRef.value;
  if (!cv || !src) return;
  const rect = cv.getBoundingClientRect();
  const x = Math.floor(((e.clientX - rect.left) / rect.width) * src.width);
  const y = Math.floor(((e.clientY - rect.top) / rect.height) * src.height);
  if (x < 0 || y < 0 || x >= src.width || y >= src.height) return;
  const c = sampleAt(src, x, y);
  const list = e.altKey ? exclude : include;
  const dup = list.value.some(s => s[0] === c[0] && s[1] === c[1] && s[2] === c[2]);
  if (!dup) list.value.push(c);
  schedule();
}

function close() { store.dialog = null; store.dialogPayload = null; }

function cancel() {
  if (priorSelection) {
    // 防御性恢复打开前的选区(正常流程中确定前不会改动选区)
    priorSelection.mask = priorMaskSnap!;
    store.selection = priorSelection;
    store.tick++;
  }
  close();
}

function ok() {
  const layer = activeLayer.value;
  const doc = store.doc;
  if (!layer?.bitmap || !doc) return;
  if (!include.value.length) {
    error.value = '请先在预览中单击取样。';
    return;
  }
  error.value = null;
  const prepared = prepareLayer(doc, layer, new Map());
  if (!prepared) return;
  const img = ctx2dRead(prepared).getImageData(0, 0, doc.width, doc.height);
  const mask = colorRangeMask(img, include.value, exclude.value, fuzziness.value, invert.value);
  const prior = store.selection;
  const sel = selectionFromMaskArray(doc, mask);
  store.selection = sel;
  store.dirty = true;
  store.tick++;
  store.uiTick++;
  history.push({
    label: '色彩范围',
    undo: () => { store.selection = prior; store.dirty = true; store.tick++; store.uiTick++; },
    redo: () => { store.selection = sel; store.dirty = true; store.tick++; store.uiTick++; },
  });
  close();
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && store.dialog === NAME) cancel();
}

function teardown() {
  if (timer) { window.clearTimeout(timer); timer = undefined; }
  src = null;
  window.removeEventListener('keydown', onKey);
}

watch(isOpen, open => {
  if (open) {
    src = buildSource();
    priorSelection = store.selection;
    priorMaskSnap = store.selection ? cloneCanvas(store.selection.mask) : null;
    include.value = [];
    exclude.value = [];
    fuzziness.value = 40;
    invert.value = false;
    error.value = null;
    window.addEventListener('keydown', onKey);
    void nextTick(renderPreview);
  } else {
    teardown();
  }
}, { immediate: true });
watch([fuzziness, invert], schedule);
onBeforeUnmount(teardown);
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="backdrop" @click="cancel"></div>
    <div v-if="isOpen" class="dialog wide">
      <h3>色彩范围</h3>
      <div v-if="!hasBitmap" class="hint">当前图层没有像素内容。</div>
      <div v-else class="body">
        <div class="controls">
          <label class="row">模糊度
            <input type="range" min="0" max="200" step="1" v-model.number="fuzziness" />
            <span class="v">{{ fuzziness }}</span>
          </label>
          <label class="check"><input type="checkbox" v-model="invert" /> 反相</label>
          <div class="chips-group">
            <div class="chips-label">取样颜色</div>
            <div v-if="!include.length" class="hint">（无）</div>
            <div v-else class="chips">
              <span v-for="(c, i) in include" :key="'in' + i" class="chip">
                <span class="dot" :style="{ background: cssOf(c) }"></span>
                <button class="x" title="移除" @click="removeSample(include, i)">×</button>
              </span>
            </div>
          </div>
          <div class="chips-group">
            <div class="chips-label">排除颜色</div>
            <div v-if="!exclude.length" class="hint">（无）</div>
            <div v-else class="chips">
              <span v-for="(c, i) in exclude" :key="'ex' + i" class="chip">
                <span class="dot" :style="{ background: cssOf(c) }"></span>
                <button class="x" title="移除" @click="removeSample(exclude, i)">×</button>
              </span>
            </div>
          </div>
          <div class="hint">单击预览取样：Shift 加入 / Alt 排除</div>
          <div v-if="error" class="error">{{ error }}</div>
        </div>
        <div class="preview-box">
          <canvas ref="previewRef" class="preview" @click="onPreviewClick"></canvas>
        </div>
      </div>
      <div class="actions">
        <button class="btn" @click="cancel">取消</button>
        <button class="btn primary" :disabled="!hasBitmap" @click="ok">确定</button>
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
.body { display: grid; grid-template-columns: 230px 1fr; gap: 14px; }
.controls { display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.row input[type='range'] { flex: 1; min-width: 110px; accent-color: #0e639c; }
.row .v { min-width: 44px; text-align: right; color: #999; font-size: 11px; }
.check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #bbb; cursor: pointer; }
.hint { font-size: 11px; color: #777; line-height: 1.5; }
.error { font-size: 11px; color: #e05555; line-height: 1.5; }
.chips-group { display: flex; flex-direction: column; gap: 4px; }
.chips-label { font-size: 11px; color: #999; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip {
  display: inline-flex; align-items: center; gap: 4px;
  background: #1f1f1f; border: 1px solid #3a3a3a; border-radius: 10px;
  padding: 2px 4px 2px 2px;
}
.chip .dot { width: 14px; height: 14px; border-radius: 50%; border: 1px solid #555; }
.chip .x {
  background: none; border: none; color: #999; cursor: pointer;
  font-size: 12px; line-height: 1; padding: 0 3px;
}
.chip .x:hover { color: #fff; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
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
canvas.preview { max-width: 100%; max-height: 340px; display: block; cursor: crosshair; }
</style>
