<script setup lang="ts">
// Photoshop-style History panel: chronological step list (document's initial
// state first), current step highlighted, undone future steps dimmed but still
// clickable. Click any row to jump forward/backward via History.jumpTo(), which
// replays the existing undo/redo closures. Header shows the document name;
// footer has step/back/forward and 清除历史.
//
// Reactivity: History is a plain class, so the list recomputes from the
// reactive historyRevision counter (bumped on every push/undo/redo/clear) —
// this catches every entry source, including pushes that never bump store.tick.

import { computed, ref, watch, nextTick } from 'vue';
import { store, history, undo, redo, invalidate, uiRefresh } from '../core/store';
import { historyRevision } from '../core/history';

interface HistRow { target: number; num: string; label: string }

// Known English history labels → Chinese display names (labels pushed elsewhere
// in the app; display-only mapping, unknown labels pass through unchanged).
const LABEL_ZH: Record<string, string> = {
  'Add Layer': '新建图层',
  'Delete Layer': '删除图层',
  'Merge Down': '向下合并',
  'Merge Visible': '合并可见图层',
  'Reorder Layers': '图层顺序',
  'Toggle Visibility': '显示/隐藏',
  'Opacity': '不透明度',
  'Blend Mode': '混合模式',
  'Move Layer': '移动图层',
  'Nudge': '微移',
  'Transform': '自由变换',
  'Crop': '裁剪',
  'Image Size': '图像大小',
  'Canvas Size': '画布大小',
  'Paint Mask': '绘制蒙版',
  'Curves': '曲线',
  'Levels': '色阶',
  'Hue/Saturation': '色相/饱和度',
  'Exposure': '曝光度',
  'Gradient Map': '渐变映射',
  'Grain': '颗粒',
  'B&W': '黑白',
  'Color Balance': '色彩平衡',
  'Gaussian Blur': '高斯模糊',
  'Motion Blur': '动感模糊',
  'Add Noise': '添加杂色',
  'Camera Raw Filter': 'Camera Raw 滤镜',
};

function zhLabel(label: string): string {
  return LABEL_ZH[label] ?? label;
}

// Row 0 is the synthetic initial state at history index -1 (打开/新建);
// row k>0 maps to entries[k-1]. Chronological order, oldest at top.
const rows = computed<HistRow[]>(() => {
  void historyRevision.n;        // recompute on every history mutation
  void store.doc?.fileName;      // and on open/new/save-as (label of row 0)
  const opened = !!store.doc?.fileName;
  const out: HistRow[] = [{ target: -1, num: '', label: opened ? '打开' : '新建' }];
  history.entries.forEach((e, i) => out.push({ target: i, num: String(i + 1), label: zhLabel(e.label) }));
  return out;
});

const current = computed(() => {
  void historyRevision.n;
  return history.index;
});

const canUndo = computed(() => {
  void historyRevision.n;
  return history.canUndo;
});

const canRedo = computed(() => {
  void historyRevision.n;
  return history.canRedo;
});

const docName = computed(() => {
  const f = store.doc?.fileName ?? null;
  if (!f) return store.doc ? '未标题' : '';
  return f.split(/[\\/]/).pop()?.replace(/\.comp$/, '') || f;
});

// ---------- navigation ----------

function jump(target: number) {
  if (!store.doc || target === history.index) return;
  if (history.jumpTo(target)) {
    store.dirty = true;
    invalidate();
    uiRefresh();
  }
}

function stepBack() { if (canUndo.value) undo(); }
function stepForward() { if (canRedo.value) redo(); }

function clearHistory() {
  if (!store.doc) return;
  history.clear(); // keeps the current document state, drops all steps
}

// keep the current step in view after jumps and pushes (PS behavior)
const collapsed = ref(false);
const listEl = ref<HTMLElement | null>(null);

watch(current, async () => {
  if (collapsed.value) return;
  await nextTick();
  listEl.value?.querySelector('.hist-row.current')?.scrollIntoView({ block: 'nearest' });
});
</script>

<template>
  <div class="history-panel" :class="{ collapsed }">
    <div
      class="panel-title"
      :title="collapsed ? '展开历史记录' : '折叠历史记录'"
      @click="collapsed = !collapsed"
    >
      <span class="chevron">{{ collapsed ? '▸' : '▾' }}</span>
      <span class="title-text">历史记录</span>
      <span v-if="docName" class="doc-name" :title="docName" @click.stop>{{ docName }}</span>
    </div>

    <div v-show="!collapsed" ref="listEl" class="hist-list">
      <div v-if="!store.doc" class="hint">未打开文档</div>
      <template v-else>
        <div
          v-for="row in rows"
          :key="row.target"
          class="hist-row"
          :class="{ current: row.target === current, future: row.target > current }"
          :title="row.label"
          @click="jump(row.target)"
        >
          <span class="num">{{ row.num }}</span>
          <span class="label">{{ row.label }}</span>
        </div>
        <div v-if="rows.length === 1" class="hint">暂无历史步骤</div>
      </template>
    </div>

    <div class="panel-foot">
      <button class="fb" title="后退一步 (Ctrl+Z)" :disabled="!canUndo" @click="stepBack">◀</button>
      <button class="fb" title="前进一步 (Ctrl+Shift+Z)" :disabled="!canRedo" @click="stepForward">▶</button>
      <span class="spacer"></span>
      <button class="fb clear" title="清除所有历史步骤（保留当前画面）" :disabled="!store.doc" @click="clearHistory">清除历史</button>
    </div>
  </div>
</template>

<style scoped>
.history-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #252525;
}
.panel-title {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 10px;
  border-bottom: 1px solid #111;
  cursor: default;
  user-select: none;
}
.chevron {
  font-size: 9px;
  color: #888;
  width: 10px;
  flex-shrink: 0;
}
.title-text {
  font-size: 11px;
  font-weight: 700;
  color: #999;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.doc-name {
  margin-left: auto;
  font-size: 11px;
  color: #6f9fc8;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hist-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}
.hist-row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 8px 0 10px;
  cursor: default;
  border-left: 2px solid transparent;
  user-select: none;
}
.hist-row:hover { background: #2c2c2c; }
.hist-row.current {
  background: #11547f;
  border-left-color: #4da3ff;
}
.hist-row.current .label,
.hist-row.current .num { color: #fff; }
.hist-row.future .label { color: #777; }
.hist-row.future .num { color: #666; }
.num {
  width: 18px;
  text-align: right;
  font-size: 10px;
  color: #777;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.label {
  flex: 1;
  font-size: 12px;
  color: #ccc;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hint {
  padding: 6px 10px;
  font-size: 11px;
  color: #666;
}
.panel-foot {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 6px 8px;
  border-top: 1px solid #111;
}
.fb {
  height: 22px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #bbb;
  font-size: 11px;
  cursor: pointer;
  padding: 0 7px;
}
.fb:hover:not(:disabled) { background: #3a3a3a; color: #fff; }
.fb:disabled { opacity: 0.35; cursor: default; }
.fb.clear:hover:not(:disabled) { background: #7a2b2b; color: #fff; }
.spacer { flex: 1; }
</style>
