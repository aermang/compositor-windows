<script setup lang="ts">
// 导航器缩略图：zoom ≥ 300% 时悬浮于画布区域右上角。显示整幅文档的
// 延迟合成缩略图 + 当前视口矩形；点击/拖拽即通过 navBus 让画布居中到
// 对应文档点。自包含定位（absolute、右上角），父容器只需覆盖画布区域。

import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { store, flattenDoc } from '../core/store';
import { viewport } from '../core/viewport';
import { navCenter } from '../core/navBus';

const MAX_W = 126;
const MAX_H = 90;
const DEBOUNCE_MS = 250;

const visible = computed(() => store.zoom >= 3 && !store.canvasOnly && !!store.doc);

/** thumbnail px per doc px */
const scale = computed(() => {
  const d = store.doc;
  if (!d || d.width <= 0 || d.height <= 0) return 0;
  return Math.min(MAX_W / d.width, MAX_H / d.height);
});
const thumbW = computed(() => Math.max(1, Math.round((store.doc?.width ?? 1) * scale.value)));
const thumbH = computed(() => Math.max(1, Math.round((store.doc?.height ?? 1) * scale.value)));

const thumbC = ref<HTMLCanvasElement | null>(null);

function renderThumb(): void {
  const c = thumbC.value;
  if (!c || !store.doc || !visible.value) return;
  const dpr = window.devicePixelRatio || 1;
  const w = thumbW.value;
  const h = thumbH.value;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(flattenDoc(), 0, 0, w, h);
}

let timer: number | undefined;
function scheduleThumb(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(renderThumb, DEBOUNCE_MS);
}

watch(() => store.tick, scheduleThumb);
watch([thumbW, thumbH, visible], () => {
  window.clearTimeout(timer);
  renderThumb();
});
onMounted(renderThumb);
onBeforeUnmount(() => window.clearTimeout(timer));

// 视口矩形 = 缩略图上的可见文档矩形 ∩ 图像矩形（px）。
const rectStyle = computed(() => {
  const s = scale.value;
  if (!s) return { display: 'none' };
  const l = Math.max(0, viewport.left * s);
  const t = Math.max(0, viewport.top * s);
  const r = Math.min(thumbW.value, (viewport.left + viewport.width) * s);
  const b = Math.min(thumbH.value, (viewport.top + viewport.height) * s);
  return {
    left: `${l.toFixed(1)}px`,
    top: `${t.toFixed(1)}px`,
    width: `${Math.max(2, r - l).toFixed(1)}px`,
    height: `${Math.max(2, b - t).toFixed(1)}px`,
  };
});

// ---- 点击 / 拖拽导航 ----
let dragging = false;
const box = ref<HTMLDivElement | null>(null);

function navFromEvent(e: PointerEvent): void {
  const el = box.value;
  if (!el || !store.doc) return;
  const r = el.getBoundingClientRect();
  const s = scale.value;
  if (!s) return;
  const x = Math.min(store.doc.width, Math.max(0, (e.clientX - r.left) / s));
  const y = Math.min(store.doc.height, Math.max(0, (e.clientY - r.top) / s));
  navCenter(Math.round(x), Math.round(y));
}

function onDown(e: PointerEvent): void {
  dragging = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  navFromEvent(e);
}
function onMove(e: PointerEvent): void {
  if (dragging) navFromEvent(e);
}
function onUp(): void {
  dragging = false;
}
</script>

<template>
  <div v-if="visible" class="nav-mini">
    <div
      ref="box"
      class="nav-box"
      :style="{ width: thumbW + 'px', height: thumbH + 'px' }"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
    >
      <canvas ref="thumbC" class="nav-thumb" :style="{ width: thumbW + 'px', height: thumbH + 'px' }"></canvas>
      <div class="nav-rect" :style="rectStyle"></div>
    </div>
    <div class="nav-zoom">{{ Math.round(store.zoom * 100) }}%</div>
  </div>
</template>

<style scoped>
.nav-mini {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 40;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
  user-select: none;
}
.nav-box {
  position: relative;
  border: 1px solid #000;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.55);
  cursor: crosshair;
  touch-action: none;
  /* 棋盘格表示透明区域 */
  background:
    linear-gradient(45deg, #3a3a3a 25%, transparent 25%, transparent 75%, #3a3a3a 75%),
    linear-gradient(45deg, #3a3a3a 25%, transparent 25%, transparent 75%, #3a3a3a 75%);
  background-color: #2b2b2b;
  background-size: 10px 10px;
  background-position: 0 0, 5px 5px;
}
.nav-thumb {
  display: block;
  image-rendering: auto;
}
.nav-rect {
  position: absolute;
  border: 2px solid #4da3ff;
  background: rgba(77, 163, 255, 0.12);
  pointer-events: none;
  box-sizing: border-box;
}
.nav-zoom {
  font-size: 10px;
  color: #999;
  background: rgba(30, 30, 30, 0.85);
  border: 1px solid #000;
  border-radius: 3px;
  padding: 1px 5px;
}
</style>
