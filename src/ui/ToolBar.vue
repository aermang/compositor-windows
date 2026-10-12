<script setup lang="ts">
// Left tool rail, Photoshop order and single-letter keys.

import { store } from '../core/store';
import type { ToolId } from '../core/store';

const TOOLS: { id: ToolId; label: string; key: string; icon: string }[] = [
  { id: 'move', label: '移动', key: 'V', icon: '↖' },
  { id: 'marquee', label: '选框', key: 'M', icon: '▭' },
  { id: 'lasso', label: '套索', key: 'L', icon: '⟅' },
  { id: 'wand', label: '魔棒', key: 'W', icon: '✦' },
  { id: 'crop', label: '裁剪', key: 'C', icon: '⌗' },
  { id: 'brush', label: '画笔', key: 'B', icon: '🖌' },
  { id: 'eraser', label: '橡皮擦', key: 'E', icon: '🧽' },
  { id: 'clone', label: '仿制图章', key: 'S', icon: '⎘' },
  { id: 'heal', label: '修复画笔', key: 'J', icon: '🩹' },
  { id: 'dodge', label: '减淡', key: 'O', icon: '🌗' },
  { id: 'patch', label: '修补', key: '', icon: '🧷' },
  { id: 'camove', label: '感知移动', key: '', icon: '🪄' },
  { id: 'smear', label: '涂抹', key: 'R', icon: '🌀' },
  { id: 'gradient', label: '渐变', key: 'G', icon: '▤' },
  { id: 'shape', label: '形状', key: 'U', icon: '▭' },
  { id: 'pen', label: '钢笔', key: 'P', icon: '✒' },
  { id: 'type', label: '文字', key: 'T', icon: 'T' },
  { id: 'eyedropper', label: '吸管', key: 'I', icon: '💧' },
  { id: 'hand', label: '抓手', key: 'H', icon: '✋' },
  { id: 'zoom', label: '缩放', key: 'Z', icon: '🔍' },
];

function swapColors() {
  const f = store.fg;
  store.fg = store.bg;
  store.bg = f;
}
function resetColors() {
  store.fg = '#000000';
  store.bg = '#ffffff';
}
</script>

<template>
  <div class="toolbar">
    <button
      v-for="t in TOOLS"
      :key="t.id"
      class="tool-btn"
      :class="{ active: store.tool === t.id }"
      :title="`${t.label} (${t.key})`"
      @click="store.tool = t.id"
    >
      <span class="icon">{{ t.icon }}</span>
    </button>

    <div class="swatches">
      <div class="swatch-stack">
        <label class="swatch fg" :title="'前景色 — 按 X 交换'">
          <input type="color" v-model="store.fg" />
        </label>
        <label class="swatch bg" :title="'背景色'">
          <input type="color" v-model="store.bg" />
        </label>
      </div>
      <div class="swatch-actions">
        <button class="mini" title="交换颜色 (X)" @click="swapColors">⇄</button>
        <button class="mini" title="默认颜色 (D)" @click="resetColors">◻</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  width: 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 0;
  background: #252525;
  border-right: 1px solid #111;
  overflow-y: auto;
}
.tool-btn {
  width: 38px;
  height: 34px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #bbb;
  font-size: 15px;
  cursor: pointer;
  display: grid;
  place-items: center;
}
.tool-btn:hover { background: #333; color: #fff; }
.tool-btn.active { background: #0e639c; color: #fff; }
.swatches {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.swatch-stack {
  position: relative;
  width: 34px;
  height: 34px;
}
.swatch {
  position: absolute;
  width: 20px;
  height: 20px;
  border: 1px solid #888;
  border-radius: 3px;
  overflow: hidden;
  cursor: pointer;
}
.swatch.fg { left: 0; top: 0; z-index: 2; }
.swatch.bg { right: 0; bottom: 0; z-index: 1; }
.swatch input {
  position: absolute;
  inset: -4px;
  width: 28px;
  height: 28px;
  border: none;
  padding: 0;
  cursor: pointer;
}
.swatch-actions { display: flex; gap: 2px; }
.mini {
  width: 16px;
  height: 16px;
  border: none;
  background: transparent;
  color: #999;
  font-size: 10px;
  cursor: pointer;
  border-radius: 3px;
}
.mini:hover { background: #333; color: #fff; }
</style>
