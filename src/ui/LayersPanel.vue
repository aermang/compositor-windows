<script setup lang="ts">
// Layers panel: Photoshop-style list (top first), thumbnails, blend mode,
// opacity, masks, badges for effects/adjustment/text, drag-to-reorder with
// group-subtree awareness, and a footer action bar.

import { ref, computed, watch } from 'vue';
import {
  store, history, activeLayer, pushStructural, pushAppearance, addRasterLayer, addGroupLayer,
  addAdjustmentLayer, deleteLayer, duplicateLayer, addMask,
} from '../core/store';
import { BLEND_MODES, ADJUSTMENT_KINDS } from '../core/types';
import type { BlendMode, AdjustmentKind, Layer } from '../core/types';
import { runCommand } from '../commands';
import { BLEND_MODE_ZH } from '../core/labels';

interface Row { layer: Layer; depth: number; last: boolean[] }

const rows = computed<Row[]>(() => {
  // touch uiTick so recompute follows structural changes
  void store.uiTick;
  void store.doc?.layers.length;
  const layers = store.doc?.layers ?? [];
  const depthOf = new Map<string, number>();
  const out: Row[] = [];
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    const depth = l.parentId ? (depthOf.get(l.parentId) ?? 0) + 1 : 0;
    depthOf.set(l.id, depth);
    out.push({ layer: l, depth, last: [] });
  }
  return out;
});

function select(layer: Layer) {
  if (store.doc) store.doc.activeLayerId = layer.id;
}

function rename(layer: Layer, e: Event) {
  const v = (e.target as HTMLInputElement).value.trim();
  if (v) {
    layer.name = v;
    store.dirty = true;
  }
  editingId.value = null;
}
const editingId = ref<string | null>(null);

function toggleVisible(layer: Layer) {
  pushAppearance(layer, 'Toggle Visibility', { isVisible: !layer.isVisible });
  layer.isVisible = !layer.isVisible;
  store.tick++;
}

// blend/opacity edits: capture the pre-interaction value so one drag = one history entry
let opacityStart: number | null = null;

function onOpacityDown() { opacityStart = activeLayer.value?.opacity ?? null; }

function onOpacityChange() {
  const l = activeLayer.value;
  if (l && opacityStart != null && opacityStart !== l.opacity) {
    const before = opacityStart;
    const after = l.opacity;
    history.push({
      label: 'Opacity',
      undo: () => { l.opacity = before; store.tick++; },
      redo: () => { l.opacity = after; store.tick++; },
    });
    store.dirty = true;
  }
  opacityStart = null;
}

function onBlendChange(e: Event) {
  const l = activeLayer.value;
  if (!l) return;
  const before = l.blendMode;
  const after = (e.target as HTMLSelectElement).value as BlendMode;
  l.blendMode = after;
  history.push({
    label: 'Blend Mode',
    undo: () => { l.blendMode = before; store.tick++; },
    redo: () => { l.blendMode = after; store.tick++; },
  });
  store.dirty = true;
}

// ---------- thumbnails ----------

const thumbTick = ref(0);
watch(() => store.tick, () => { thumbTick.value++; });

function drawThumb(canvas: HTMLCanvasElement, layer: Layer) {
  void thumbTick.value;
  const cx = canvas.getContext('2d');
  if (!cx) return;
  const w = canvas.width, h = canvas.height;
  cx.clearRect(0, 0, w, h);
  // checkerboard
  const s = 4;
  for (let y = 0; y < h; y += s) {
    for (let x = 0; x < w; x += s) {
      cx.fillStyle = ((x / s + y / s) % 2 === 0) ? '#3a3a3a' : '#2f2f2f';
      cx.fillRect(x, y, s, s);
    }
  }
  if (layer.isGroup || !layer.bitmap) return;
  const scale = Math.min(w / layer.bitmap.width, h / layer.bitmap.height);
  const dw = layer.bitmap.width * scale, dh = layer.bitmap.height * scale;
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(layer.bitmap, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function drawMaskThumb(canvas: HTMLCanvasElement, layer: Layer) {
  void thumbTick.value;
  const cx = canvas.getContext('2d');
  if (!cx || !layer.mask) return;
  const w = canvas.width, h = canvas.height;
  cx.fillStyle = '#000';
  cx.fillRect(0, 0, w, h);
  const scale = Math.min(w / layer.mask.width, h / layer.mask.height);
  const dw = layer.mask.width * scale, dh = layer.mask.height * scale;
  cx.drawImage(layer.mask, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

// ---------- drag reorder ----------

const dragId = ref<string | null>(null);
const dropHint = ref<{ id: string; where: 'above' | 'below' } | null>(null);

function onDragStart(e: DragEvent, layer: Layer) {
  dragId.value = layer.id;
  e.dataTransfer?.setData('text/plain', layer.id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}

function onDragOver(e: DragEvent, layer: Layer) {
  const row = e.currentTarget as HTMLElement | null;
  dropHint.value = { id: layer.id, where: (row && e.clientY - row.getBoundingClientRect().top < 20) ? 'above' : 'below' };
}

function subtreeRange(layers: Layer[], id: string): [number, number] {
  const start = layers.findIndex(l => l.id === id);
  if (start < 0) return [-1, -1];
  const layer = layers[start];
  let end = start;
  for (let i = start + 1; i < layers.length; i++) {
    // contiguous subtree: later layers whose parent chain leads back to this layer
    if (ancestorOf(layers, layer, layers[i])) end = i;
    else break;
  }
  return [start, end];
}

function ancestorOf(layers: Layer[], ancestor: Layer, l: Layer): boolean {
  let cur: Layer | undefined = l;
  while (cur?.parentId) {
    if (cur.parentId === ancestor.id) return true;
    cur = layers.find(x => x.id === cur!.parentId);
  }
  return false;
}

function onDrop(e: DragEvent, target: Layer, where: 'above' | 'below') {
  e.preventDefault();
  const id = dragId.value ?? e.dataTransfer?.getData('text/plain');
  dragId.value = null;
  dropHint.value = null;
  if (!id || !store.doc || id === target.id) return;
  const doc = store.doc;
  const layers = doc.layers;
  const [s] = subtreeRange(layers, id);
  if (s < 0) return;
  // cannot drop into own subtree
  if (ancestorOf(layers, layers[s], target)) return;

  pushStructural('Reorder Layers', () => {
    const cur = doc.layers;
    const [cs, ce] = subtreeRange(cur, id);
    const moving = cur.slice(cs, ce + 1).map(l => ({ ...l }));
    const rest = cur.filter(l => !moving.some(m => m.id === l.id));
    // insertion anchor in the remaining list
    const ti = rest.findIndex(l => l.id === target.id);
    let parentId: string | null;
    let insertAt: number;
    if (target.isGroup && where === 'below') {
      // dropping below a group row = top of the group's contents
      parentId = target.id;
      const ge = subtreeEndIn(rest, ti);
      insertAt = ge + 1;
    } else if (where === 'above') {
      parentId = target.parentId;
      insertAt = ti;
    } else {
      // below a non-group: after target's own subtree, as its sibling
      parentId = target.parentId;
      insertAt = subtreeEndIn(rest, ti) + 1;
    }
    for (const m of moving) m.parentId = m.id === id ? parentId : m.parentId;
    rest.splice(insertAt, 0, ...moving);
    doc.layers = rest;
    doc.activeLayerId = id;
  });
}

function subtreeEndIn(layers: Layer[], start: number): number {
  if (start < 0) return layers.length - 1;
  const head = layers[start];
  let end = start;
  for (let i = start + 1; i < layers.length; i++) {
    if (ancestorOf(layers, head, layers[i])) end = i;
    else break;
  }
  return end;
}

// ---------- footer actions ----------

function newMask() {
  const l = activeLayer.value;
  if (l) addMask(l, true);
}

function onAdjustmentPick(e: Event) {
  const kind = (e.target as HTMLSelectElement).value;
  if (kind) addAdjustmentLayer(kind as AdjustmentKind);
  (e.target as HTMLSelectElement).value = '';
}

const ADJ_SHORT: Record<AdjustmentKind, string> = {
  'Hue/Saturation': '色相/饱和度…', 'Levels': '色阶…', 'Curves': '曲线…',
  'Exposure': '曝光度…', 'Gradient Map': '渐变映射…', 'Grain': '颗粒…',
  'Invert': '反相', 'Black & White': '黑白…', 'Color Balance': '色彩平衡…',
  'Gaussian Blur': '高斯模糊…', 'Motion Blur': '动感模糊…', 'Add Noise': '添加杂色…',
};

// ---------- context menu ----------

const ctxMenu = ref<{ x: number; y: number; layer: Layer } | null>(null);
function openMenu(e: MouseEvent, layer: Layer) {
  e.preventDefault();
  select(layer);
  ctxMenu.value = { x: e.clientX, y: e.clientY, layer };
}
</script>

<template>
  <div class="layers-panel" v-if="store.doc">
    <div class="panel-head">
      <select class="blend-select" :value="activeLayer?.blendMode ?? 'Normal'" @change="onBlendChange">
        <option v-for="m in BLEND_MODES" :key="m" :value="m">{{ BLEND_MODE_ZH[m] }}</option>
      </select>
      <label class="opacity">
        <input
          type="range" min="0" max="1" step="0.01"
          :value="activeLayer?.opacity ?? 1"
          @pointerdown="onOpacityDown"
          @input="activeLayer && (activeLayer.opacity = Number(($event.target as HTMLInputElement).value)); store.tick++"
          @change="onOpacityChange"
        />
        <span>{{ Math.round((activeLayer?.opacity ?? 1) * 100) }}%</span>
      </label>
    </div>

    <div class="layer-list">
      <div
        v-for="row in rows"
        :key="row.layer.id"
        class="layer-row"
        :class="{
          active: row.layer.id === store.doc?.activeLayerId,
          'drop-above': dropHint?.id === row.layer.id && dropHint.where === 'above',
          'drop-below': dropHint?.id === row.layer.id && dropHint.where === 'below',
        }"
        :style="{ paddingLeft: 6 + row.depth * 14 + 'px' }"
        draggable="true"
        @click="select(row.layer)"
        @dragstart="onDragStart($event, row.layer)"
        @dragover.prevent="onDragOver($event, row.layer)"
        @dragleave="dropHint = null"
        @drop="onDrop($event, row.layer, dropHint?.where ?? 'above')"
        @contextmenu="openMenu($event, row.layer)"
      >
        <button
          class="eye"
          :class="{ dim: !row.layer.isVisible }"
          :title="row.layer.isVisible ? '隐藏' : '显示'"
          @click.stop="toggleVisible(row.layer)"
        >👁</button>

        <span v-if="row.layer.isGroup" class="group-icon" @click.stop="row.layer.expanded = !row.layer.expanded">
          {{ row.layer.expanded ? '📂' : '📁' }}
        </span>
        <canvas v-else class="thumb" width="40" height="30" :ref="(el) => el && drawThumb(el as HTMLCanvasElement, row.layer)"></canvas>

        <canvas
          v-if="row.layer.mask"
          class="thumb mask-thumb"
          :class="{ painting: store.paintingTarget === 'mask' && row.layer.id === store.doc?.activeLayerId }"
          width="20" height="20"
          title="点击切换到蒙版绘制"
          :ref="(el) => el && drawMaskThumb(el as HTMLCanvasElement, row.layer)"
          @click.stop="store.paintingTarget = store.paintingTarget === 'mask' ? 'image' : 'mask'"
        ></canvas>

        <span v-if="row.layer.maskSourceId" class="badge clip" title="已剪贴到下方图层">⤓</span>

        <input
          v-if="editingId === row.layer.id"
          class="name-input"
          :value="row.layer.name"
          @keydown.enter="($event.target as HTMLInputElement).blur()"
          @blur="rename(row.layer, $event)"
          autofocus
        />
        <span v-else class="name" @dblclick="editingId = row.layer.id">{{ row.layer.name }}</span>

        <span v-if="row.layer.effects && Object.values(row.layer.effects).some(f => f?.enabled)" class="badge fx" title="图层效果">fx</span>
        <span v-if="row.layer.adjustment" class="badge adj" title="调整层">◐</span>
        <span v-if="row.layer.text" class="badge txt" title="文字图层">T</span>
      </div>
    </div>

    <div class="panel-foot">
      <button class="fb" title="新建图层 (Ctrl+Shift+N)" @click="addRasterLayer()">＋</button>
      <button class="fb" title="新建组" @click="addGroupLayer()">🗂</button>
      <button class="fb" title="添加图层蒙版" @click="newMask()">⊡</button>
      <select class="fb adj-select" title="新建调整层" @change="onAdjustmentPick">
        <option value="">◐…</option>
        <option v-for="k in ADJUSTMENT_KINDS" :key="k" :value="k">{{ ADJ_SHORT[k] }}</option>
      </select>
      <button class="fb" title="图层效果" @click="store.dialog = 'effects'">fx</button>
      <button class="fb" title="复制图层 (Ctrl+J)" @click="activeLayer && duplicateLayer(activeLayer)">⧉</button>
      <button class="fb" title="向下合并 (Ctrl+E)" @click="runCommand('layer.mergeDown')">⤓</button>
      <button class="fb danger" title="删除" @click="activeLayer && deleteLayer(activeLayer)">🗑</button>
    </div>

    <!-- context menu -->
    <Teleport to="body">
      <div
        v-if="ctxMenu"
        class="ctx-backdrop"
        @click="ctxMenu = null"
        @contextmenu.prevent="ctxMenu = null"
      />
      <div v-if="ctxMenu" class="ctx-menu" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }">
        <button @click="duplicateLayer(ctxMenu.layer); ctxMenu = null">复制图层</button>
        <button @click="deleteLayer(ctxMenu.layer); ctxMenu = null">删除图层</button>
        <button v-if="!ctxMenu.layer.isGroup" @click="runCommand('layer.mergeDown'); ctxMenu = null">向下合并</button>
        <button v-if="!ctxMenu.layer.mask" @click="addMask(ctxMenu.layer, true); ctxMenu = null">添加蒙版</button>
        <button v-else-if="ctxMenu.layer.maskEnabled" @click="ctxMenu.layer.maskEnabled = false; store.tick++; ctxMenu = null">禁用蒙版</button>
        <button v-else @click="ctxMenu.layer.maskEnabled = true; store.tick++; ctxMenu = null">启用蒙版</button>
        <button @click="runCommand('layer.clip'); ctxMenu = null">{{ ctxMenu.layer.maskSourceId ? '取消剪贴蒙版' : '创建剪贴蒙版' }}</button>
        <button @click="runCommand('layer.effects'); ctxMenu = null">图层效果…</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.layers-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #252525;
}
.panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid #111;
}
.blend-select {
  flex: 1;
  background: #333;
  color: #ddd;
  border: 1px solid #444;
  border-radius: 5px;
  padding: 4px 6px;
  font-size: 11px;
}
.opacity {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: #aaa;
}
.opacity input { width: 70px; accent-color: #0e639c; }
.layer-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}
.layer-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px 3px 6px;
  height: 40px;
  cursor: default;
  border-left: 2px solid transparent;
  border-top: 1px solid transparent;
  border-bottom: 1px solid transparent;
  user-select: none;
}
.layer-row:hover { background: #2c2c2c; }
.layer-row.active { background: #11547f; }
.layer-row.active .name { color: #fff; }
.layer-row.drop-above { border-top-color: #4da3ff; }
.layer-row.drop-below { border-bottom-color: #4da3ff; }
.eye {
  border: none;
  background: transparent;
  font-size: 12px;
  cursor: pointer;
  width: 22px;
  color: #ccc;
}
.eye.dim { opacity: 0.25; }
.thumb {
  border: 1px solid #000;
  border-radius: 3px;
  background: #333;
  flex-shrink: 0;
}
.mask-thumb { width: 20px; height: 20px; }
.mask-thumb.painting { outline: 2px solid #4da3ff; }
.group-icon { font-size: 14px; cursor: pointer; width: 26px; text-align: center; }
.name {
  flex: 1;
  font-size: 12px;
  color: #ccc;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.name-input {
  flex: 1;
  background: #111;
  color: #fff;
  border: 1px solid #0e639c;
  border-radius: 3px;
  font-size: 12px;
  padding: 2px 4px;
  min-width: 0;
}
.badge {
  font-size: 10px;
  color: #888;
  border: 1px solid #444;
  border-radius: 3px;
  padding: 0 3px;
  flex-shrink: 0;
}
.badge.fx { color: #e8c268; border-color: #665720; }
.badge.adj { color: #7fc2ff; }
.badge.txt { color: #ddd; }
.panel-foot {
  display: flex;
  gap: 3px;
  padding: 6px 8px;
  border-top: 1px solid #111;
}
.fb {
  width: 26px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #bbb;
  font-size: 12px;
  cursor: pointer;
}
.fb:hover { background: #3a3a3a; color: #fff; }
.fb.danger:hover { background: #7a2b2b; }
.adj-select {
  width: 34px;
  font-size: 11px;
  padding: 0 2px;
  background: transparent;
  border: none;
  color: #bbb;
}
.adj-select:hover { background: #3a3a3a; }
.ctx-backdrop { position: fixed; inset: 0; z-index: 90; }
.ctx-menu {
  position: fixed;
  z-index: 91;
  background: #2c2c2c;
  border: 1px solid #000;
  border-radius: 6px;
  padding: 4px;
  min-width: 180px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.5);
  display: flex;
  flex-direction: column;
}
.ctx-menu button {
  border: none;
  background: transparent;
  color: #ddd;
  text-align: left;
  padding: 5px 10px;
  font-size: 12px;
  border-radius: 4px;
  cursor: pointer;
}
.ctx-menu button:hover { background: #0e639c; }
</style>
