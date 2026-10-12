<script setup lang="ts">
// 通道面板:复合/RGB 灰度查看 + alpha 通道(存储选区)列表。
// 点击 R/G/B 把复合图对应通道渲染成灰度快照,经 overlayRegistry 覆盖显示;
// 点击 RGB 行清除。alpha 行提供 载入为选区 / 删除(core/channels)。
// v1 局限:单通道查看是快照式,不随后续编辑实时刷新。
import { computed, ref, watch, onUnmounted } from 'vue';
import { store, flattenDoc } from '../core/store';
import { makeCanvas, ctx2dRead } from '../core/canvasUtils';
import { registerOverlay, unregisterOverlay } from '../core/overlayRegistry';
import { loadChannelAsSelection, deleteChannel } from '../core/channels';
import type { AlphaChannel } from '../core/types';

const collapsed = ref(false);

type GrayView = 'R' | 'G' | 'B';
const viewing = ref<'RGB' | GrayView>('RGB');
let snapshot: HTMLCanvasElement | null = null;

const alphaChannels = computed<AlphaChannel[]>(() => store.doc?.alphaChannels ?? []);
const hasChannels = () => alphaChannels.value.length > 0;

// 单通道灰度快照:复合图 → 通道平面展开成灰度(透明处为黑)。
function buildChannelSnapshot(kind: GrayView): HTMLCanvasElement | null {
  const doc = store.doc;
  if (!doc) return null;
  const flat = flattenDoc();
  const w = doc.width, h = doc.height;
  if (flat.width !== w || flat.height !== h) return null;
  const src = ctx2dRead(flat).getImageData(0, 0, w, h).data;
  const out = makeCanvas(w, h);
  const ox = ctx2dRead(out);
  const id = ox.createImageData(w, h);
  const off = kind === 'R' ? 0 : kind === 'G' ? 1 : 2;
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    const v = src[i + off];
    id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
    id.data[i + 3] = 255;
  }
  ox.putImageData(id, 0, 0);
  return out;
}

// Overlay renderer:把灰度快照铺在合成图上(文档空间→屏幕),幂等——
// 非 RGB 视图或有快照时才画;每帧重画,读 live 状态。
registerOverlay('channel-view', (ctx, z, X, Y) => {
  const snap = snapshot;
  if (viewing.value === 'RGB' || !snap || !store.doc) return;
  ctx.save();
  ctx.drawImage(snap, X(0), Y(0), snap.width * z, snap.height * z);
  ctx.restore();
});
onUnmounted(() => unregisterOverlay('channel-view'));

function viewChannel(kind: GrayView): void {
  snapshot = buildChannelSnapshot(kind);
  if (!snapshot) { viewing.value = 'RGB'; return; }
  viewing.value = kind;
  store.tick++; // 重绘画布
}

function viewComposite(): void {
  if (viewing.value === 'RGB') return;
  viewing.value = 'RGB';
  snapshot = null;
  store.tick++;
}

// 换文档时旧快照失效,回到复合视图。
watch(() => store.doc, () => {
  viewing.value = 'RGB';
  snapshot = null;
});

const onLoad = (ch: AlphaChannel) => loadChannelAsSelection(ch);
const onDelete = (ch: AlphaChannel) => deleteChannel(ch);
</script>

<template>
  <div class="channels-panel" :class="{ collapsed }">
    <div class="panel-title" @click="collapsed = !collapsed">
      <span>通道</span>
      <span class="doc-name">{{ collapsed ? '▸' : '▾' }}</span>
    </div>
    <div v-if="!collapsed" class="ch-body">
      <template v-if="store.doc">
        <div class="ch-row" :class="{ active: viewing === 'RGB' }" title="复合通道(点击退出单通道查看)" @click="viewComposite">
          <span class="row-icon">◉</span>
          <span class="row-name">RGB</span>
        </div>
        <div
          v-for="c in (['R', 'G', 'B'] as const)"
          :key="c"
          class="ch-row"
          :class="{ active: viewing === c }"
          :title="`单通道查看 ${c}(灰度快照)`"
          @click="viewChannel(c)"
        >
          <span class="row-icon">▨</span>
          <span class="row-name">{{ c }}</span>
        </div>
        <div class="ch-sep"></div>
        <div v-for="ch in alphaChannels" :key="ch.id" class="ch-row ch-alpha-row">
          <span class="row-icon">◈</span>
          <span class="row-name" :title="ch.name">{{ ch.name }}</span>
          <button class="ch-btn" title="把此通道载入为选区" @click.stop="onLoad(ch)">载入为选区</button>
          <button class="ch-btn" title="删除通道" @click.stop="onDelete(ch)">删除</button>
        </div>
        <div v-if="!hasChannels()" class="ch-empty">无 alpha 通道</div>
      </template>
      <div v-else class="ch-empty">无文档</div>
    </div>
  </div>
</template>

<style scoped>
.channels-panel {
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
.ch-body { flex: 1; overflow-y: auto; }
.ch-empty { padding: 8px 10px; font-size: 11px; color: #666; }
.channels-panel.collapsed { flex: 0 0 auto; }
.channels-panel.collapsed .ch-body { display: none; }
.ch-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  font-size: 11px;
  color: #bbb;
  cursor: pointer;
  user-select: none;
}
.ch-row:hover { background: #2c2c2c; }
.ch-row.active { background: #0e639c; color: #fff; }
.row-icon { width: 14px; text-align: center; color: #888; flex: 0 0 auto; }
.ch-row.active .row-icon { color: #cfe6ff; }
.row-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-alpha-row { cursor: default; }
.ch-alpha-row:hover { background: #2c2c2c; }
.ch-sep { height: 1px; background: #1a1a1a; margin: 3px 6px; }
.ch-btn {
  flex: 0 0 auto;
  padding: 1px 5px;
  font-size: 10px;
  color: #ccc;
  background: #333;
  border: 1px solid #222;
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
}
.ch-btn:hover { background: #3d3d3d; color: #fff; }
</style>
