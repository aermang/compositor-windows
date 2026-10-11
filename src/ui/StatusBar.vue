<script setup lang="ts">
// Bottom status bar: zoom, doc size, pointer position, active tool hint.

import { store, activeLayer, fitToScreen } from '../core/store';
import { TOOL_ZH } from '../core/labels';

function zoomPct(): string {
  const z = store.zoom;
  return z >= 1 ? Math.round(z * 100) + '%' : (z * 100).toFixed(1) + '%';
}
function dims(): string {
  const d = store.doc;
  return d ? `${d.width} × ${d.height}` : '—';
}
function toolName(): string {
  return TOOL_ZH[store.tool] ?? store.tool;
}
</script>

<template>
  <div class="statusbar" v-if="store.doc">
    <span class="cell tool">{{ toolName() }}</span>
    <span class="cell">{{ dims() }} px</span>
    <span class="cell zoom">
      <button @click="store.zoom = Math.max(0.005, store.zoom / 1.25)">−</button>
      <button class="pct" title="适合屏幕 (Ctrl+0)" @click="fitToScreen()">{{ zoomPct() }}</button>
      <button @click="store.zoom = Math.min(32, store.zoom * 1.25)">+</button>
    </span>
    <span class="cell layers">{{ store.doc.layers.length }} 个图层</span>
    <span class="cell name">{{ activeLayer?.name ?? '—' }}</span>
    <span class="cell right">
      <template v-if="store.selection?.bounds">选区已激活</template>
    </span>
  </div>
</template>

<style scoped>
.statusbar {
  display: flex;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  background: #1d1d1d;
  border-top: 1px solid #000;
  color: #888;
  font-size: 11px;
  gap: 16px;
  user-select: none;
}
.cell { white-space: nowrap; }
.cell.tool { color: #bbb; font-weight: 600; }
.cell.name { color: #666; }
.cell.right { margin-left: auto; color: #4da3ff; }
.zoom { display: flex; align-items: center; gap: 2px; }
.zoom button {
  background: #2a2a2a;
  color: #aaa;
  border: 1px solid #3a3a3a;
  border-radius: 3px;
  width: 18px;
  height: 16px;
  font-size: 11px;
  cursor: pointer;
  line-height: 1;
}
.zoom .pct { width: auto; padding: 0 6px; }
.zoom button:hover { background: #333; color: #fff; }
</style>
