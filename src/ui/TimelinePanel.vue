<script setup lang="ts">
// Timeline panel (frame animation): filmstrip, playback, onion skin, APNG export.
// State lives in core/animation (module reactive + dev hook); this panel is the
// UI shell — clicking a filmstrip row previews that frame by applying its layer
// states (frame editing = editing the layer properties themselves, PS-style).
import { ref, computed, watch } from 'vue';
import { store } from '../core/store';
import {
  anim, addFrame, duplicateFrame, deleteFrame, gotoFrame, play, stop, setOnion,
} from '../core/animation';
import { exportApngCommand } from '../core/io/apngExport';
import type { AnimFrame } from '../core/types';

const collapsed = ref(false);

const doc = computed(() => store.doc);
const frames = computed(() => store.doc?.frames ?? []);

// 切文档:先停掉可能还在跑的定时器(否则会对新文档的图层乱写),再把选帧
// 归零。时间轴不自动创建——PS 打开文档时时间轴为空,首次点「新建帧」才生成。
watch(() => store.doc?.id, () => {
  stop();
  anim.current = 0;
});

function onTogglePlay() {
  if (anim.playing) stop();
  else play();
}

function onDuration(frame: AnimFrame, ev: Event) {
  const input = ev.target as HTMLInputElement;
  const v = Math.max(0, Math.round(Number(input.value) || 0));
  frame.durationMs = v;
  input.value = String(v); // 把钳制后的值写回输入框
}

function onOnion(ev: Event) {
  setOnion((ev.target as HTMLInputElement).checked);
}

function onExport() {
  void exportApngCommand();
}
</script>

<template>
  <div class="timeline-panel" :class="{ collapsed }">
    <div class="panel-title" @click="collapsed = !collapsed">
      <span>时间轴</span>
      <span class="doc-name">{{ collapsed ? '▸' : '▾' }}</span>
    </div>
    <div class="timeline-body" v-if="!collapsed">
      <template v-if="!doc">
        <div class="timeline-empty">无文档</div>
      </template>
      <template v-else>
        <div class="filmstrip" v-if="frames.length">
          <div
            v-for="(frame, i) in frames"
            :key="frame.id"
            class="film-row"
            :class="{ active: i === anim.current }"
            title="点击预览此帧"
            @click="gotoFrame(i)"
          >
            <span class="film-name">帧 {{ i + 1 }}</span>
            <input
              class="film-delay" type="number" min="0" step="10"
              :value="frame.durationMs"
              title="帧时长(毫秒)"
              @click.stop
              @change="onDuration(frame, $event)"
            >
            <span class="film-unit">ms</span>
          </div>
        </div>
        <div class="timeline-empty" v-else>时间轴为空:点击「新建帧」创建第一帧</div>
        <div class="timeline-actions">
          <button @click="addFrame()">新建帧</button>
          <button :disabled="!frames.length" @click="duplicateFrame(anim.current)">复制帧</button>
          <button :disabled="frames.length <= 1" @click="deleteFrame(anim.current)">删除帧</button>
          <button :disabled="!frames.length" @click="onTogglePlay">
            {{ anim.playing ? '⏹ 停止' : '▶ 播放' }}
          </button>
          <button :disabled="!frames.length" @click="onExport">导出 APNG</button>
          <label class="onion-toggle" title="在画布上叠加显示前一帧(α0.3)与后一帧(α0.2)">
            <input type="checkbox" :checked="anim.onion" @change="onOnion">
            洋葱皮
          </label>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.timeline-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.panel-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 600;
  color: #ccc;
  background: #252525;
  border-bottom: 1px solid #111;
  cursor: pointer;
  user-select: none;
  flex: 0 0 auto;
}
.doc-name { color: #888; font-weight: 400; }
.timeline-body { flex: 1; overflow-y: auto; }
.timeline-empty { padding: 8px 10px; font-size: 11px; color: #666; }
.filmstrip {
  max-height: 34vh;
  overflow-y: auto;
  flex: 0 1 auto;
}
.film-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  font-size: 11px;
  color: #bbb;
  border: 1px solid transparent;
  cursor: pointer;
  user-select: none;
}
.film-row:hover { background: #2a2a2a; }
.film-row.active {
  border-color: #4a9eff;
  background: #2a2a2a;
  color: #eee;
}
.film-name { flex: 1 1 auto; }
.film-delay {
  width: 54px;
  padding: 1px 4px;
  font-size: 11px;
  color: #ddd;
  background: #1b1b1b;
  border: 1px solid #333;
}
.film-unit { color: #777; }
.timeline-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-top: 1px solid #111;
  flex: 0 0 auto;
}
.timeline-actions button {
  font-size: 11px;
  color: #ccc;
  background: #333;
  border: 1px solid #444;
  padding: 2px 8px;
  cursor: pointer;
}
.timeline-actions button:hover:not(:disabled) { background: #3d3d3d; }
.timeline-actions button:disabled { opacity: 0.4; cursor: default; }
.onion-toggle {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: #bbb;
  cursor: pointer;
  user-select: none;
}
.timeline-panel.collapsed { flex: 0 0 auto; }
.timeline-panel.collapsed .timeline-body { display: none; }
</style>
