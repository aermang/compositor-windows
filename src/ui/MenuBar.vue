<script setup lang="ts">
// Top menu bar: dropdowns generated from the command registry.

import { ref, computed } from 'vue';
import { store } from '../core/store';
import { MENU_ZH } from '../core/labels';
import { commands, runCommand } from '../commands';
import type { Command } from '../commands';

const open = ref<string | null>(null);
// MENUS values stay English: they double as lookup keys into `grouped`,
// which is keyed by the commands' English `menu` property. Only the
// rendered button text is localized via MENU_ZH.
const MENUS = ['File', 'Edit', 'Image', 'Layer', 'Select', 'Filter', 'View'];

const grouped = computed(() => {
  void store.uiTick;
  const map = new Map<string, Command[]>();
  for (const c of commands) {
    if (!map.has(c.menu)) map.set(c.menu, []);
    map.get(c.menu)!.push(c);
  }
  return map;
});

function enabled(c: Command): boolean {
  return c.enabled ? c.enabled() : true;
}

function run(c: Command) {
  open.value = null;
  if (enabled(c)) runCommand(c.id); // 走统一派发:快捷键/命令面板/动作录制共用一套 enabled+录制钩子
}

function docTitle(): string {
  const name = store.doc?.fileName?.split(/[\\/]/).pop()?.replace(/\.comp$/, '') ?? 'Untitled';
  return store.dirty ? `${name} ●` : name;
}
</script>

<template>
  <div class="menubar">
    <div class="app-name">Compositor</div>
    <div
      v-for="m in MENUS"
      :key="m"
      class="menu"
      @click="open = open === m ? null : m"
      @mouseenter="open && (open = m)"
    >
      <button class="menu-btn" :class="{ active: open === m }">{{ MENU_ZH[m] }}</button>
      <div v-if="open === m" class="dropdown">
        <template v-for="c in grouped.get(m) ?? []" :key="c.id">
          <div v-if="c.sep" class="menu-sep"></div>
          <button class="menu-item" :class="{ disabled: !enabled(c) }" @click="run(c)">
            <span>{{ c.label }}</span>
            <span class="sc">{{ c.shortcut ?? '' }}</span>
          </button>
        </template>
      </div>
    </div>
    <div class="spacer"></div>
    <div class="doc-title">{{ store.doc ? docTitle() : '无文档' }}</div>
  </div>
  <div v-if="open" class="menu-backdrop" @click="open = null" @contextmenu.prevent="open = null"></div>
</template>

<style scoped>
.menubar {
  display: flex;
  align-items: center;
  height: 30px;
  padding: 0 8px;
  background: #1d1d1d;
  border-bottom: 1px solid #000;
  color: #ccc;
  font-size: 12px;
  user-select: none;
  position: relative;
  z-index: 60;
}
.app-name {
  font-weight: 700;
  color: #fff;
  padding: 0 10px 0 4px;
  letter-spacing: 0.02em;
}
.menu { position: relative; }
.menu-btn {
  background: transparent;
  border: none;
  color: #ccc;
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 4px;
  cursor: pointer;
}
.menu-btn:hover, .menu-btn.active { background: #333; color: #fff; }
.dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  min-width: 260px;
  background: #2c2c2c;
  border: 1px solid #000;
  border-radius: 6px;
  padding: 4px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.55);
  z-index: 100;
}
.menu-item {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  width: 100%;
  background: transparent;
  border: none;
  color: #ddd;
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
}
.menu-item:hover:not(.disabled) { background: #0e639c; color: #fff; }
.menu-item.disabled { color: #555; cursor: default; }
.menu-item .sc { color: #888; font-size: 11px; }
.menu-item:hover:not(.disabled) .sc { color: #cde5ff; }
.menu-sep { height: 1px; background: #3d3d3d; margin: 4px 6px; }
.spacer { flex: 1; }
.doc-title { color: #888; font-size: 11px; padding-right: 6px; }
.menu-backdrop { position: fixed; inset: 0; z-index: 50; }
</style>
