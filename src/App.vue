<script setup lang="ts">
// App shell: menu bar, tool options, tool rail, canvas, right panels, status
// bar — plus the global keyboard router (command shortcuts, tool letters,
// brush size [ ], color swap/reset, layer nudge).

import { onMounted, onUnmounted } from 'vue';
import { store, activeLayer, history } from './core/store';
import { commands, runCommand, TOOL_KEYS } from './commands';
import MenuBar from './ui/MenuBar.vue';
import ToolOptions from './ui/ToolOptions.vue';
import ToolBar from './ui/ToolBar.vue';
import CanvasView from './ui/CanvasView.vue';
import LayersPanel from './ui/LayersPanel.vue';
import PropertiesPanel from './ui/PropertiesPanel.vue';
import HistoryPanel from './ui/HistoryPanel.vue';
import SmartFilterPanel from './ui/SmartFilterPanel.vue';
import PathsPanel from './ui/PathsPanel.vue';
import ChannelsPanel from './ui/ChannelsPanel.vue';
import TimelinePanel from './ui/TimelinePanel.vue';
import ActionsPanel from './ui/ActionsPanel.vue';
import CharacterPanel from './ui/CharacterPanel.vue';
import ParagraphPanel from './ui/ParagraphPanel.vue';
import LiquifyDialog from './ui/LiquifyDialog.vue';
import PuppetDialog from './ui/PuppetDialog.vue';
import StatusBar from './ui/StatusBar.vue';
import Dialogs from './ui/Dialogs.vue';
import WelcomeView from './ui/WelcomeView.vue';
import TabsBar from './ui/TabsBar.vue';

// ---------- shortcut string → matcher ----------

interface ParsedShortcut { ctrl: boolean; shift: boolean; alt: boolean; key: string }

function parseShortcut(s: string): ParsedShortcut {
  const parts = s.split('+').map(p => p.trim());
  const key = parts[parts.length - 1].toLowerCase();
  return {
    ctrl: parts.includes('Ctrl'),
    shift: parts.includes('Shift'),
    alt: parts.includes('Alt'),
    key,
  };
}

const shortcutCommands = commands
  .filter(c => c.shortcut)
  .map(c => ({ cmd: c, sc: parseShortcut(c.shortcut!) }));

function matches(sc: ParsedShortcut, e: KeyboardEvent): boolean {
  const ctrl = e.ctrlKey || e.metaKey;
  if (sc.ctrl !== ctrl) return false;
  if (sc.shift !== e.shiftKey) return false;
  if (sc.alt !== e.altKey) return false;
  // normalize '=' / '+' and '-' variants for zoom
  const k = e.key.toLowerCase();
  if (sc.key === '=' && (k === '=' || k === '+')) return true;
  if (sc.key === k) return true;
  return false;
}

function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function onKeydown(e: KeyboardEvent) {
  if (store.dialog) return;                     // dialogs handle their own keys
  if (store.editingTextId) return;              // text editing in-canvas
  if (isTypingTarget(e)) return;

  // registered command shortcuts (Ctrl-combos and a few bare keys)
  for (const { cmd, sc } of shortcutCommands) {
    if (matches(sc, e)) {
      if (!cmd.enabled || cmd.enabled()) {
        e.preventDefault();
        runCommand(cmd.id); // 统一派发(动作录制挂点)
      }
      return;
    }
  }

  // tool letters (no modifiers)
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    const tool = TOOL_KEYS[e.key.toLowerCase()];
    if (tool) {
      store.tool = tool as typeof store.tool;
      return;
    }
    if (e.key.toLowerCase() === 'x') {
      const f = store.fg; store.fg = store.bg; store.bg = f;
      return;
    }
    if (e.key.toLowerCase() === 'd') {
      store.fg = '#000000'; store.bg = '#ffffff';
      return;
    }
    if (e.key === '[' || e.key === ']') {
      const target = store.tool === 'clone' ? store.opts.clone : store.opts.brush;
      const delta = e.key === '[' ? -Math.max(1, Math.round(target.size * 0.12)) : Math.max(1, Math.round(target.size * 0.12));
      target.size = Math.max(1, Math.min(500, target.size + delta));
      return;
    }
  }

  // layer nudge
  if (e.key.startsWith('Arrow') && activeLayer.value) {
    const l = activeLayer.value;
    const step = e.shiftKey ? 10 : 1;
    const before = [...l.transform.origin] as [number, number];
    const after = [...before] as [number, number];
    if (e.key === 'ArrowLeft') after[0] -= step;
    if (e.key === 'ArrowRight') after[0] += step;
    if (e.key === 'ArrowUp') after[1] -= step;
    if (e.key === 'ArrowDown') after[1] += step;
    l.transform.origin = after;
    history.push({
      label: 'Nudge',
      undo: () => { l.transform.origin = before; store.tick++; },
      redo: () => { l.transform.origin = after; store.tick++; },
    });
    store.dirty = true;
    store.tick++;
    e.preventDefault();
  }
}

function beforeUnload(e: BeforeUnloadEvent) {
  if (store.dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('beforeunload', beforeUnload);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('beforeunload', beforeUnload);
});
</script>

<template>
  <div class="app" :class="{ 'canvas-only': store.canvasOnly }">
    <MenuBar v-if="!store.canvasOnly" />
    <ToolOptions v-if="!store.canvasOnly" />
    <div class="main">
      <ToolBar v-if="!store.canvasOnly" />
      <div class="canvas-col">
        <TabsBar v-if="!store.canvasOnly" />
        <CanvasView />
        <WelcomeView />
      </div>
      <div class="right" v-if="!store.canvasOnly">
        <LayersPanel />
        <div class="right-split"></div>
        <PropertiesPanel />
        <SmartFilterPanel />
        <PathsPanel />
        <ChannelsPanel />
        <HistoryPanel />
        <TimelinePanel />
        <ActionsPanel />
        <CharacterPanel />
        <ParagraphPanel />
      </div>
    </div>
    <StatusBar v-if="!store.canvasOnly" />
    <Dialogs />
    <LiquifyDialog v-if="store.dialog === 'liquify'" />
    <PuppetDialog v-if="store.dialog === 'puppet'" />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: #1e1e1e;
}
.main {
  display: flex;
  flex: 1;
  min-height: 0;
}
.canvas-col {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.right {
  width: 252px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid #111;
  /* 面板下限合计超过栏高时出滚动条:顺序 flex 布局盒子虽不重叠,
     但被压扁面板的内容会溢出到后续面板的盒子里拦截点击(字符/段落
     面板加入后实测触发),可滚动保证每个面板都能完整滚入视野。 */
  overflow-y: auto;
  overflow-x: hidden;
}
.right-split { height: 5px; background: #1a1a1a; cursor: row-resize; }
.right :deep(.layers-panel) { flex: 1.1; min-height: 160px; }
.right :deep(.props-panel) { flex: 1; min-height: 120px; border-top: 1px solid #111; }
.right :deep(.history-panel) { flex: 0.75; min-height: 104px; border-top: 1px solid #111; }
.right :deep(.history-panel.collapsed) { flex: 0 0 auto; min-height: 0; }
.right :deep(.smartfilter-panel) { flex: 0.7; min-height: 96px; border-top: 1px solid #111; }
.right :deep(.smartfilter-panel.collapsed) { flex: 0 0 auto; min-height: 0; }
.right :deep(.paths-panel) { flex: 0.7; min-height: 96px; border-top: 1px solid #111; }
.right :deep(.paths-panel.collapsed) { flex: 0 0 auto; min-height: 0; }
.right :deep(.channels-panel) { flex: 0.7; min-height: 96px; border-top: 1px solid #111; }
.right :deep(.channels-panel.collapsed) { flex: 0 0 auto; min-height: 0; }
.right :deep(.timeline-panel) { flex: 0.9; min-height: 116px; border-top: 1px solid #111; }
.right :deep(.timeline-panel.collapsed) { flex: 0 0 auto; min-height: 0; }
/* 动作面板:折叠时自然高度;展开(v-if 渲染出 .actions-body)时给下限,
   否则定高栏里它是唯一无下限面板,会被压扁、内容溢出叠到字符/段落面板上。 */
.right :deep(.actions-panel) { flex: 0 0 auto; min-height: 0; }
.right :deep(.actions-panel:has(.actions-body)) { flex: 0.7; min-height: 96px; }
</style>
