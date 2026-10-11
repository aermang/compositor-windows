<script setup lang="ts">
// 网格设置弹窗（store.dialog === 'grid'）：网格大小 / 细分 / 颜色（预设色板
// + 自定义取色器）/ 样式（线条·虚线·点）/ 不透明度。
// 所有修改即时写入 gridSettings 并 saveGrid()（localStorage 即存），
// 同时 bump tick 让画布立刻重绘网格；「取消/确定」仅关闭弹窗。

import { computed, onMounted, onBeforeUnmount } from 'vue';
import { store, invalidate } from '../core/store';
import { gridSettings, saveGrid, GRID_PRESETS } from '../core/guides';
import type { GridSettings } from '../core/guides';
import { clamp } from '../core/canvasUtils';

const open = computed(() => store.dialog === 'grid');
const isCustom = computed(() => !GRID_PRESETS.some(p => p.value === gridSettings.color));

function save(): void {
  saveGrid();
  invalidate(); // 画布重绘（网格随 tick 刷新）
}

function setSpacing(v: number): void {
  gridSettings.spacing = Math.round(clamp(Number.isFinite(v) ? v : 2, 2, 4096));
  gridSettings.subdivisions = Math.round(
    clamp(gridSettings.subdivisions, 1, Math.min(64, gridSettings.spacing)),
  );
  save();
}
function setSubdivisions(v: number): void {
  gridSettings.subdivisions = Math.round(
    clamp(Number.isFinite(v) ? v : 1, 1, Math.min(64, gridSettings.spacing)),
  );
  save();
}
function setOpacity(v: number): void {
  gridSettings.opacity = Math.round(clamp(Number.isFinite(v) ? v : 1, 1, 100));
  save();
}
function setColor(hex: string): void {
  gridSettings.color = hex.toLowerCase();
  save();
}
function setStyle(s: GridSettings['style']): void {
  gridSettings.style = s;
  save();
}

function close(): void {
  store.dialog = null;
  store.dialogPayload = null;
}

function onKey(e: KeyboardEvent): void {
  if (open.value && e.key === 'Escape') close();
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

const STYLE_OPTIONS: { v: GridSettings['style']; label: string }[] = [
  { v: 'lines', label: '线条' },
  { v: 'dashed', label: '虚线' },
  { v: 'dots', label: '点' },
];
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="backdrop" @click="close"></div>
    <div v-if="open" class="dialog">
      <h3>网格设置</h3>

      <div class="grid2">
        <label class="field">网格大小
          <input
            type="number" min="2" max="4096" step="1"
            :value="gridSettings.spacing"
            @input="setSpacing(Number(($event.target as HTMLInputElement).value))"
          />
          <span class="unit">px</span>
        </label>
        <label class="field">细分
          <input
            type="number" min="1" :max="Math.min(64, gridSettings.spacing)" step="1"
            :value="gridSettings.subdivisions"
            @input="setSubdivisions(Number(($event.target as HTMLInputElement).value))"
          />
        </label>
      </div>
      <div class="hint">细分每格间距 {{ (gridSettings.spacing / gridSettings.subdivisions).toFixed(2) }} px（细分不可超过网格大小）</div>

      <div class="row-label">颜色</div>
      <div class="swatches">
        <button
          v-for="p in GRID_PRESETS" :key="p.value"
          class="swatch" :class="{ on: gridSettings.color === p.value }"
          :style="{ background: p.value }"
          :title="p.label"
          @click="setColor(p.value)"
        ></button>
        <label class="swatch custom" :class="{ on: isCustom }" :style="{ background: gridSettings.color }" title="自定义">
          <input
            type="color"
            :value="isCustom ? gridSettings.color : '#00e5ff'"
            @input="setColor(($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>

      <div class="row-label">样式</div>
      <div class="row">
        <label v-for="o in STYLE_OPTIONS" :key="o.v" class="check">
          <input type="radio" :value="o.v" :checked="gridSettings.style === o.v" @change="setStyle(o.v)" />
          {{ o.label }}
        </label>
      </div>

      <label class="row">不透明度
        <input
          type="range" min="1" max="100" step="1"
          :value="gridSettings.opacity"
          @input="setOpacity(Number(($event.target as HTMLInputElement).value))"
        />
        <span class="v">{{ gridSettings.opacity }}%</span>
      </label>

      <div class="hint">修改即时生效并已保存。</div>
      <div class="actions">
        <button class="btn" @click="close">取消</button>
        <button class="btn primary" @click="close">确定</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
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
  color: #ddd;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
  z-index: 201;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
h3 { margin: 0 0 4px; font-size: 14px; color: #fff; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.row input[type='range'] { flex: 1; min-width: 120px; accent-color: #0e639c; }
.row .v { min-width: 44px; text-align: right; color: #999; font-size: 11px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.field { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #aaa; }
.field input[type='number'] {
  width: 70px; background: #1f1f1f; color: #eee; border: 1px solid #444;
  border-radius: 4px; padding: 4px 6px; font-size: 12px;
}
.unit { font-size: 11px; color: #777; }
.check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #bbb; cursor: pointer; }
.hint { font-size: 11px; color: #777; line-height: 1.5; }
.row-label { font-size: 11px; font-weight: 700; color: #999; }
.swatches { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.swatch {
  width: 24px; height: 24px;
  border: 1px solid #555;
  border-radius: 4px;
  cursor: pointer;
  padding: 0;
  position: relative;
}
.swatch.on { outline: 2px solid #0e639c; outline-offset: 1px; }
.swatch.custom { border-style: dashed; display: inline-flex; align-items: center; justify-content: center; }
.swatch.custom input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
.btn {
  background: #333; color: #ddd; border: 1px solid #454545;
  border-radius: 5px; padding: 6px 14px; font-size: 12px; cursor: pointer;
}
.btn:hover { background: #3a3a3a; }
.btn.primary { background: #0e639c; border-color: #1177bb; color: #fff; }
.btn.primary:hover { background: #1177bb; }
</style>
