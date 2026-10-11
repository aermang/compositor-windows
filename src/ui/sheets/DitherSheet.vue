<script setup lang="ts">
// 抖动滤镜对话框:store.dialog === 'dither' 时挂载。
// 预览基于图层位图的 ≤500px 长边副本(80ms 防抖),确定时经 rasterEdit 一次性写回。

import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { store, activeLayer, rasterEdit } from '../../core/store';
import { applyDither } from '../../core/pixels/dither';
import type { DitherSettings } from '../../core/pixels/dither';
import { makeCanvas, ctx2d, ctx2dRead } from '../../core/canvasUtils';

const NAME = 'dither';
const isOpen = computed(() => store.dialog === NAME);

const STYLES: { value: DitherSettings['style']; label: string }[] = [
  { value: 'atkinson', label: '阿特金森' },
  { value: 'floydSteinberg', label: '弗洛伊德-斯坦伯格' },
  { value: 'bayer2', label: '拜耳 2×2' },
  { value: 'bayer4', label: '拜耳 4×4' },
  { value: 'bayer8', label: '拜耳 8×8' },
  { value: 'halftoneDots', label: '半色调圆点' },
  { value: 'halftoneLines', label: '半色调线条' },
  { value: 'halftoneDiamonds', label: '半色调菱形' },
  { value: 'macPatterns', label: 'Mac 图案' },
  { value: 'ascii', label: 'ASCII' },
];

const s = reactive<DitherSettings>({
  style: 'floydSteinberg',
  levels: 2,
  diffusion: 100,
  cellSize: 12,
  angle: 45,
  pixelSize: 1,
  textSize: 14,
  density: 0,
  contrast: 0,
  lightOnDark: false,
  colorMode: 'blackWhite',
  colorA: '#000000',
  colorB: '#ffffff',
});

const isFS = computed(() => s.style === 'floydSteinberg');
const isHalftone = computed(
  () => s.style === 'halftoneDots' || s.style === 'halftoneLines' || s.style === 'halftoneDiamonds',
);
const isAscii = computed(() => s.style === 'ascii');
const hasBitmap = computed(() => !!activeLayer.value?.bitmap);

const previewRef = ref<HTMLCanvasElement | null>(null);
let src: ImageData | null = null;
let timer: number | undefined;

function onStyle(e: Event) {
  s.style = (e.target as HTMLSelectElement).value as DitherSettings['style'];
}
function onColorMode(e: Event) {
  s.colorMode = (e.target as HTMLSelectElement).value as DitherSettings['colorMode'];
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
  const tmp = makeCanvas(src.width, src.height);
  const tx = ctx2dRead(tmp);
  tx.putImageData(src, 0, 0);
  const img = tx.getImageData(0, 0, tmp.width, tmp.height);
  applyDither(img, { ...s });
  tx.putImageData(img, 0, 0);
  if (cv.width !== src.width || cv.height !== src.height) {
    cv.width = src.width;
    cv.height = src.height;
  }
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

function ok() {
  const layer = activeLayer.value;
  if (!layer?.bitmap) return;
  const settings: DitherSettings = { ...s };
  rasterEdit(layer, '抖动', bmp => {
    const cx = ctx2dRead(bmp);
    const img = cx.getImageData(0, 0, bmp.width, bmp.height);
    applyDither(img, settings);
    cx.putImageData(img, 0, 0);
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
      <h3>抖动</h3>
      <div v-if="!hasBitmap" class="hint">当前图层没有像素内容。</div>
      <div v-else class="body">
        <div class="controls">
          <label class="field">风格
            <select class="select" :value="s.style" @change="onStyle">
              <option v-for="o in STYLES" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </label>
          <label class="row">色调级数
            <input type="range" min="2" max="8" step="1" v-model.number="s.levels" />
            <span class="v">{{ s.levels }}</span>
          </label>
          <label v-if="isFS" class="row">扩散
            <input type="range" min="0" max="100" step="1" v-model.number="s.diffusion" />
            <span class="v">{{ s.diffusion }}%</span>
          </label>
          <template v-if="isHalftone">
            <label class="row">单元大小
              <input type="range" min="4" max="64" step="1" v-model.number="s.cellSize" />
              <span class="v">{{ s.cellSize }} px</span>
            </label>
            <label class="row">角度
              <input type="range" min="-90" max="90" step="1" v-model.number="s.angle" />
              <span class="v">{{ s.angle }}°</span>
            </label>
          </template>
          <label v-if="!isAscii" class="row">像素大小
            <input type="range" min="1" max="32" step="1" v-model.number="s.pixelSize" />
            <span class="v">{{ s.pixelSize }} px</span>
          </label>
          <label v-if="isAscii" class="row">文字大小
            <input type="range" min="6" max="64" step="1" v-model.number="s.textSize" />
            <span class="v">{{ s.textSize }} px</span>
          </label>
          <label class="row">密度
            <input type="range" min="-100" max="100" step="1" v-model.number="s.density" />
            <span class="v">{{ s.density }}</span>
          </label>
          <label class="row">对比度
            <input type="range" min="-100" max="100" step="1" v-model.number="s.contrast" />
            <span class="v">{{ s.contrast }}</span>
          </label>
          <label class="check"><input type="checkbox" v-model="s.lightOnDark" /> 明色于暗色</label>
          <label class="field">颜色
            <select class="select" :value="s.colorMode" @change="onColorMode">
              <option value="blackWhite">黑白</option>
              <option value="twoColors">双色</option>
              <option value="original">保留原色</option>
            </select>
          </label>
          <div v-if="s.colorMode === 'twoColors'" class="row colors">
            <label class="field">暗色 <input type="color" v-model="s.colorA" /></label>
            <label class="field">亮色 <input type="color" v-model="s.colorB" /></label>
          </div>
        </div>
        <div class="preview-box">
          <canvas ref="previewRef" class="preview"></canvas>
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
.body { display: grid; grid-template-columns: 240px 1fr; gap: 14px; }
.controls { display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.row input[type='range'] { flex: 1; min-width: 110px; accent-color: #0e639c; }
.row .v { min-width: 44px; text-align: right; color: #999; font-size: 11px; }
.field { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #aaa; }
.check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #bbb; cursor: pointer; }
.hint { font-size: 11px; color: #777; line-height: 1.5; }
.select {
  background: #1f1f1f; color: #eee; border: 1px solid #444;
  border-radius: 4px; padding: 4px 6px; font-size: 12px; flex: 1;
}
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
.btn {
  background: #333; color: #ddd; border: 1px solid #454545;
  border-radius: 5px; padding: 6px 14px; font-size: 12px; cursor: pointer;
}
.btn:hover { background: #3a3a3a; }
.btn.primary { background: #0e639c; border-color: #1177bb; color: #fff; }
.btn.primary:hover { background: #1177bb; }
.btn.primary:disabled { opacity: 0.5; cursor: default; }
input[type='color'] { width: 34px; height: 22px; padding: 0; border: 1px solid #444; border-radius: 3px; background: none; cursor: pointer; }
.preview-box {
  display: flex; align-items: center; justify-content: center;
  background: conic-gradient(#3a3a3a 0 25%, #2e2e2e 0 50%, #3a3a3a 0 75%, #2e2e2e 0) 0 0 / 16px 16px;
  border: 1px solid #444; border-radius: 4px; padding: 6px; min-height: 120px;
}
canvas.preview { max-width: 100%; max-height: 340px; display: block; }
</style>
