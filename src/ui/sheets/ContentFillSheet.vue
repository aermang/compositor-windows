<script setup lang="ts">
// 内容识别填充对话框:store.dialog === 'contentFill' 时挂载。
// 在选区包围盒(向四周外扩 48px 以提供 donor)对应的图层位图子区域上运行
// contentFill,选区掩码按 文档→位图 比例缩放,alpha ≥ 128 视为目标像素。
// 计算是同步的,套一层 setTimeout 让"正在填充"状态先绘制。

import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { store, activeLayer, rasterEdit } from '../../core/store';
import { contentFill } from '../../core/selectionOps/contentFill';
import { isEmptySelection } from '../../core/selection';
import { makeCanvas, ctx2d, ctx2dRead } from '../../core/canvasUtils';

const NAME = 'contentFill';
const isOpen = computed(() => store.dialog === NAME);

const running = ref(false);
const error = ref<string | null>(null);
const hasBitmap = computed(() => !!activeLayer.value?.bitmap);
const hasSelection = computed(() => !!store.doc && !isEmptySelection(store.selection));
const ready = computed(() => hasBitmap.value && hasSelection.value);
const boundsInfo = computed(() => {
  const b = store.selection?.bounds;
  return b ? `${b.w}×${b.h} px` : '';
});

/** 选区包围盒向外的余量(位图像素)。 */
const MARGIN = 48;

function close() { store.dialog = null; store.dialogPayload = null; }
function cancel() { close(); }

function ok() {
  const layer = activeLayer.value;
  const doc = store.doc;
  const sel = store.selection;
  if (!layer?.bitmap || !doc || !sel?.bounds || running.value) return;
  running.value = true;
  error.value = null;
  window.setTimeout(() => {
    try {
      const bmp = layer.bitmap!;
      const b = sel.bounds!;
      const sx = bmp.width / doc.width;
      const sy = bmp.height / doc.height;
      const x0 = Math.max(0, Math.floor(b.x * sx) - MARGIN);
      const y0 = Math.max(0, Math.floor(b.y * sy) - MARGIN);
      const x1 = Math.min(bmp.width, Math.ceil((b.x + b.w) * sx) + MARGIN);
      const y1 = Math.min(bmp.height, Math.ceil((b.y + b.h) * sy) + MARGIN);
      const subW = x1 - x0, subH = y1 - y0;
      if (subW <= 0 || subH <= 0) {
        error.value = '选区不在当前图层范围内。';
        running.value = false;
        return;
      }
      const bcx = ctx2dRead(bmp);
      const sub = bcx.getImageData(x0, y0, subW, subH);
      // 文档空间选区掩码 → 位图子区域坐标
      const mc = makeCanvas(subW, subH);
      ctx2d(mc).drawImage(sel.mask!, x0 / sx, y0 / sy, subW / sx, subH / sy, 0, 0, subW, subH);
      const md = ctx2dRead(mc).getImageData(0, 0, subW, subH).data;
      const target = new Uint8Array(subW * subH);
      for (let p = 0; p < target.length; p++) target[p] = md[p * 4 + 3] >= 128 ? 255 : 0;
      const res = contentFill(sub, target);
      if (!res.ok) {
        error.value = res.reason ?? '填充失败。';
        running.value = false;
        return;
      }
      rasterEdit(layer, '内容识别填充', canvas => {
        ctx2dRead(canvas).putImageData(sub, x0, y0);
      });
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

watch(isOpen, open => {
  if (open) {
    error.value = null;
    running.value = false;
    window.addEventListener('keydown', onKey);
  } else {
    window.removeEventListener('keydown', onKey);
  }
}, { immediate: true });
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="backdrop" @click="cancel"></div>
    <div v-if="isOpen" class="dialog">
      <h3>内容识别填充</h3>
      <div v-if="!hasBitmap" class="hint">当前图层没有像素内容。</div>
      <div v-else-if="!hasSelection" class="error">请先创建选区。</div>
      <template v-else>
        <div class="hint">将使用周围像素填充选区内容。</div>
        <div class="hint">选区大小:{{ boundsInfo }}</div>
      </template>
      <div v-if="running" class="hint">正在填充…</div>
      <div v-if="error" class="error">{{ error }}</div>
      <div class="actions">
        <button class="btn" @click="cancel">取消</button>
        <button class="btn primary" :disabled="!ready || running" @click="ok">确定</button>
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
  max-width: 480px;
  max-height: 82vh;
  overflow-y: auto;
  color: #ddd;
  box-shadow: 0 16px 48px rgba(0,0,0,0.6);
  z-index: 201;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
h3 { margin: 0 0 4px; font-size: 14px; color: #fff; }
.hint { font-size: 11px; color: #777; line-height: 1.5; }
.error { font-size: 11px; color: #e05555; line-height: 1.5; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
.btn {
  background: #333; color: #ddd; border: 1px solid #454545;
  border-radius: 5px; padding: 6px 14px; font-size: 12px; cursor: pointer;
}
.btn:hover { background: #3a3a3a; }
.btn.primary { background: #0e639c; border-color: #1177bb; color: #fff; }
.btn.primary:hover { background: #1177bb; }
.btn.primary:disabled { opacity: 0.5; cursor: default; }
</style>
