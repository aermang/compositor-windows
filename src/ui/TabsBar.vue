<script setup lang="ts">
// Photoshop-style document tab strip: one tab per open document, dirty dot
// before the name, × close (hidden for a sole blank tab), ＋ new tab, and a
// right-click context menu (关闭 / 关闭其他). Mounted always; ensureTab()
// guarantees at least one tab exists (a blank one shows alongside WelcomeView).

import { onMounted, onUnmounted, ref } from 'vue';
import { store } from '../core/store';
import {
  workspace, ensureTab, switchTab, newTab, closeTab, closeOthers, tabTitle,
} from '../core/workspace';

const ctx = ref<{ x: number; y: number; index: number } | null>(null);

function onContext(e: MouseEvent, i: number) {
  e.preventDefault();
  ctx.value = { x: e.clientX, y: e.clientY, index: i };
}

function ctxClose() {
  if (ctx.value) closeTab(ctx.value.index);
  ctx.value = null;
}

function ctxCloseOthers() {
  if (ctx.value) closeOthers(ctx.value.index);
  ctx.value = null;
}

function onWindowMouseDown(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (ctx.value && t && !t.closest('.tabs-ctx')) ctx.value = null;
}

/** Live dirty flag: the active tab reads the store, others their snapshot. */
function isDirty(i: number): boolean {
  return i === workspace.activeIndex ? store.dirty : workspace.tabs[i].dirty;
}

/** A lone blank tab carries nothing closable. */
function isSoleBlank(): boolean {
  return workspace.tabs.length === 1 && !workspace.tabs[0].doc && !workspace.tabs[0].dirty;
}

onMounted(() => {
  ensureTab();
  window.addEventListener('mousedown', onWindowMouseDown);
});
onUnmounted(() => {
  window.removeEventListener('mousedown', onWindowMouseDown);
});
</script>

<template>
  <div class="tabs-bar">
    <div class="tabs-scroll">
      <div
        v-for="(t, i) in workspace.tabs"
        :key="t.id"
        class="tab"
        :class="{ active: i === workspace.activeIndex }"
        :title="tabTitle(t)"
        @click="switchTab(i)"
        @click.middle.prevent="closeTab(i)"
        @contextmenu="onContext($event, i)"
      >
        <span v-if="isDirty(i)" class="dot">●</span>
        <span class="label">{{ tabTitle(t) }}</span>
        <button
          v-if="!isSoleBlank()"
          class="close"
          title="关闭"
          @click.stop="closeTab(i)"
        >×</button>
      </div>
    </div>
    <button class="new-tab" title="新建标签页" @click="newTab()">＋</button>
    <div v-if="ctx" class="tabs-ctx" :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }">
      <button class="ctx-item" @click="ctxClose">关闭</button>
      <button class="ctx-item" :disabled="workspace.tabs.length <= 1" @click="ctxCloseOthers">关闭其他</button>
    </div>
  </div>
</template>

<style scoped>
.tabs-bar {
  position: relative;   /* stack above the absolute WelcomeView overlay */
  z-index: 20;
  display: flex;
  align-items: stretch;
  height: 30px;
  flex-shrink: 0;
  background: #1e1e1e;
  border-bottom: 1px solid #111;
  user-select: none;
}
.tabs-scroll {
  display: flex;
  align-items: stretch;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.tabs-scroll::-webkit-scrollbar { display: none; }
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 90px;
  max-width: 220px;
  padding: 0 8px 0 12px;
  box-sizing: border-box;
  background: #1a1a1a;
  color: #9a9a9a;
  font-size: 12px;
  border-right: 1px solid #111;
  cursor: pointer;
}
.tab:hover { color: #ccc; background: #202020; }
.tab.active {
  background: #252525;
  color: #e8e8e8;
  box-shadow: inset 0 2px 0 #4da3ff;
}
.label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dot {
  color: #4da3ff;
  font-size: 8px;
  line-height: 1;
  flex-shrink: 0;
}
.close {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: none;
  border: none;
  border-radius: 4px;
  color: #888;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.close:hover { background: #3a3a3a; color: #fff; }
.new-tab {
  width: 30px;
  flex-shrink: 0;
  background: none;
  border: none;
  color: #999;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.new-tab:hover { color: #fff; background: #2a2a2a; }
.tabs-ctx {
  position: fixed;
  z-index: 300;
  min-width: 120px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: #2b2b2b;
  border: 1px solid #000;
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
}
.ctx-item {
  background: none;
  border: none;
  border-radius: 4px;
  text-align: left;
  padding: 6px 10px;
  color: #ddd;
  font-size: 12px;
  cursor: pointer;
}
.ctx-item:hover { background: #0e639c; color: #fff; }
.ctx-item:disabled { opacity: 0.4; cursor: default; }
.ctx-item:disabled:hover { background: none; color: #ddd; }
</style>
