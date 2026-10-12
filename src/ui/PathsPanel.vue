<script setup lang="ts">
// Paths panel (pen tool): document paths list + stroke/fill/to-selection ops.
// Rows list doc.paths plus the live work path (tools/pen module state); the op
// buttons target the selected saved path, falling back to the work path when
// nothing is selected. Saved-path changes go through history so undo/redo
// restores the whole paths array (it is plain data — cheap to deep-copy).
import { computed, ref, toRaw, watch } from 'vue';
import { store, history, activeLayer, rasterEdit } from '../core/store';
import { emptySelection, finalize } from '../core/selection';
import { makeCanvas, ctx2d, clamp } from '../core/canvasUtils';
import { pathToPath2D, sampleSubpath, hexToRgba, pathBoolean, type BooleanOp } from '../core/pathOps';
import { getWorkPath, clearWorkPath } from '../tools/pen';
import type { DocPath, PathSubpath } from '../core/types';

const collapsed = ref(false);
const selectedId = ref<string | null>(null);

const STAMP_SPACING = 2; // doc px between stroke stamps (soft overlap, no gaps)

const docPaths = computed<DocPath[]>(() => store.doc?.paths ?? []);

// Reads penState (reactive in tools/pen) so rows appear while drawing.
const work = computed<DocPath | null>(() => getWorkPath());
const hasWork = computed(() => !!work.value && work.value.subpaths.length > 0);

/** Op target: the selected saved path, else the work path when non-empty. */
const target = computed<DocPath | null>(() => {
  if (selectedId.value) {
    return docPaths.value.find(p => p.id === selectedId.value) ?? null;
  }
  return hasWork.value ? work.value : null;
});
const targetIsWork = computed(() => !selectedId.value && hasWork.value);
const hasStrokableTarget = computed(() =>
  !!target.value && target.value.subpaths.some(s => s.anchors.length >= 2));

function workAnchorCount(): number {
  return work.value?.subpaths.reduce((n, s) => n + s.anchors.length, 0) ?? 0;
}

// ---------- raster ops (active layer; identity layer transform assumed) ----------

function usableActiveLayer() {
  const layer = activeLayer.value;
  if (!store.doc || !layer || layer.isGroup || layer.adjustment || !layer.bitmap) return null;
  return layer;
}

function strokeTarget() {
  const path = target.value;
  const layer = usableActiveLayer();
  if (!store.doc || !path || !layer) return;
  const { size, hardness, opacity } = store.opts.brush;
  const r = Math.max(0.5, size / 2);
  // one sprite stamped everywhere: uniform stroke opacity (no per-stamp
  // build-up) — opacity applies once when the scratch merges into the layer
  const d = Math.ceil(r * 2);
  const sprite = makeCanvas(d, d);
  const spx = ctx2d(sprite);
  const g = spx.createRadialGradient(d / 2, d / 2, 0, d / 2, d / 2, r);
  const core = Math.min(clamp(hardness, 0, 1), 0.99); // guard: stop0 ≤ stop1
  g.addColorStop(0, hexToRgba(store.fg, 1));
  g.addColorStop(core, hexToRgba(store.fg, 1));
  g.addColorStop(1, hexToRgba(store.fg, 0));
  spx.fillStyle = g;
  spx.beginPath();
  spx.arc(d / 2, d / 2, r, 0, Math.PI * 2);
  spx.fill();

  const scratch = makeCanvas(store.doc.width, store.doc.height);
  const sx = ctx2d(scratch);
  for (const sub of path.subpaths) {
    for (const pt of sampleSubpath(sub, STAMP_SPACING)) {
      sx.drawImage(sprite, pt.x - d / 2, pt.y - d / 2);
    }
  }
  rasterEdit(layer, '路径描边', bmp => {
    const c = ctx2d(bmp);
    c.globalAlpha = clamp(opacity, 0, 1);
    c.drawImage(scratch, 0, 0);
    c.globalAlpha = 1;
  });
}

function fillTarget() {
  const path = target.value;
  const layer = usableActiveLayer();
  if (!path || !layer) return;
  const p2d = pathToPath2D(path.subpaths);
  rasterEdit(layer, '路径填充', bmp => {
    const c = ctx2d(bmp);
    c.fillStyle = store.fg;
    c.fill(p2d);
  });
}

/** Path → selection: white-fill the path geometry into a doc-size mask.
 *  Open subpaths are straight-closed by Canvas fill semantics (v1 rule). */
function selectionFromTarget() {
  const path = target.value;
  if (!store.doc || !path) return;
  const sel = emptySelection(store.doc);
  const mx = ctx2d(sel.mask);
  mx.fillStyle = '#fff';
  mx.fill(pathToPath2D(path.subpaths));
  finalize(sel);
  store.selection = sel;
  store.tick++; // marching ants repaint
}

// ---------- list mutations (wrapped in history) ----------

function clonePaths(paths: DocPath[]): DocPath[] {
  return JSON.parse(JSON.stringify(paths)) as DocPath[];
}

function pushPathsChange(label: string, next: DocPath[]) {
  const doc = store.doc;
  if (!doc) return;
  const before = clonePaths(doc.paths ?? []);
  const after = clonePaths(next);
  doc.paths = after; // reactive assign works even when the field was absent
  history.push({
    label,
    undo: () => {
      if (store.doc) { store.doc.paths = clonePaths(before); store.tick++; }
    },
    redo: () => {
      if (store.doc) { store.doc.paths = clonePaths(after); store.tick++; }
    },
  });
  store.dirty = true;
  store.tick++;
}

function nextPathName(paths: DocPath[]): string {
  let n = 1;
  for (const p of paths) {
    const m = /^路径 (\d+)$/.exec(p.name);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  return `路径 ${n}`;
}

/** Work path → doc.paths. Deep-copies first: the module object keeps living
 *  (cleared) as the pen's ephemeral state and must not alias document data. */
function commitWork() {
  const w = getWorkPath();
  if (!store.doc || !w || !w.subpaths.length) return;
  const plain = JSON.parse(JSON.stringify(toRaw(w))) as DocPath;
  const saved: DocPath = {
    id: crypto.randomUUID().toUpperCase(),
    name: nextPathName(store.doc.paths ?? []),
    subpaths: plain.subpaths,
  };
  pushPathsChange('提交工作路径', [...(store.doc.paths ?? []), saved]);
  selectedId.value = saved.id;
  clearWorkPath();
  store.tick++;
}

function deleteTarget() {
  if (targetIsWork.value) {
    clearWorkPath(); // ephemeral state: no history entry, like deleting unsaved work
    store.tick++;
    return;
  }
  const path = target.value;
  if (!store.doc || !path) return;
  pushPathsChange('删除路径', (store.doc.paths ?? []).filter(p => p.id !== path.id));
  selectedId.value = null;
}

// ---------- 路径运算 (boolean ops between two saved paths) ----------

const boolA = ref('');
const boolB = ref('');

// Keep the A/B dropdowns on valid entries; default to the first two paths.
watch(docPaths, (list) => {
  const has = (id: string) => list.some(p => p.id === id);
  if (!has(boolA.value)) boolA.value = list[0]?.id ?? '';
  if (!has(boolB.value) || boolB.value === boolA.value) {
    const other = list.find(p => p.id !== boolA.value);
    boolB.value = (other ?? list[0])?.id ?? '';
  }
}, { immediate: true });

const boolReady = computed(() =>
  docPaths.value.some(p => p.id === boolA.value)
  && docPaths.value.some(p => p.id === boolB.value));

function applyBoolean(op: BooleanOp) {
  const doc = store.doc;
  const pa = docPaths.value.find(p => p.id === boolA.value);
  const pb = docPaths.value.find(p => p.id === boolB.value);
  if (!doc || !pa || !pb) return;
  // plain data in/out: bypass the reactivity proxies in the O(n²) clipper and
  // keep the result free of retained refs
  const aSubs = JSON.parse(JSON.stringify(toRaw(pa).subpaths)) as PathSubpath[];
  const bSubs = JSON.parse(JSON.stringify(toRaw(pb).subpaths)) as PathSubpath[];
  const subs = pathBoolean(aSubs, bSubs, op);
  if (!subs.length) {
    alert('结果为空');
    return;
  }
  const sym = op === 'union' ? '∪' : op === 'subtract' ? '−' : '∩';
  const saved: DocPath = {
    id: crypto.randomUUID().toUpperCase(),
    name: `${pa.name}${sym}${pb.name}`,
    subpaths: JSON.parse(JSON.stringify(subs)) as PathSubpath[],
  };
  pushPathsChange('路径运算', [...(doc.paths ?? []), saved]);
  selectedId.value = saved.id; // subsequent 建立选区/描边/填充 target the result
}
</script>

<template>
  <div class="paths-panel" :class="{ collapsed }">
    <div class="panel-title" @click="collapsed = !collapsed">
      <span>路径</span>
      <span class="doc-name">{{ collapsed ? '▸' : '▾' }}</span>
    </div>
    <div class="paths-list" v-if="!collapsed">
      <div
        v-if="hasWork"
        class="paths-row"
        :class="{ active: targetIsWork }"
        title="工作路径(钢笔正在绘制)"
        @click="selectedId = null"
      >
        <span class="row-icon">✎</span>
        <span class="row-name">工作路径</span>
        <span class="row-meta">{{ workAnchorCount() }} 锚点</span>
      </div>
      <div
        v-for="p in docPaths"
        :key="p.id"
        class="paths-row"
        :class="{ active: selectedId === p.id }"
        @click="selectedId = p.id"
      >
        <span class="row-icon">◇</span>
        <span class="row-name">{{ p.name }}</span>
        <span class="row-meta">{{ p.subpaths.length }} 子路径</span>
      </div>
      <div v-if="!docPaths.length && !hasWork" class="paths-empty">无路径</div>
      <div class="paths-actions">
        <button :disabled="!hasStrokableTarget" title="用画笔预设沿路径描边(前景色)" @click="strokeTarget">描边路径</button>
        <button :disabled="!hasStrokableTarget" title="用前景色填充路径区域" @click="fillTarget">填充路径</button>
        <button :disabled="!hasStrokableTarget" title="把路径转为选区" @click="selectionFromTarget">建立选区</button>
        <button :disabled="!target" title="删除选中路径或清空工作路径" @click="deleteTarget">删除</button>
        <button
          v-if="hasWork"
          class="commit"
          title="把工作路径存入文档路径列表"
          @click="commitWork"
        >提交为路径</button>
      </div>
      <div class="paths-bool">
        <div class="bool-title">路径运算</div>
        <div class="bool-row">
          <select v-model="boolA" class="bool-a" title="路径 A">
            <option v-for="p in docPaths" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <select v-model="boolB" class="bool-b" title="路径 B">
            <option v-for="p in docPaths" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </div>
        <div class="bool-row">
          <button :disabled="!boolReady" title="合并:A∪B" @click="applyBoolean('union')">合并</button>
          <button :disabled="!boolReady" title="减去:A−B" @click="applyBoolean('subtract')">减去</button>
          <button :disabled="!boolReady" title="相交:A∩B" @click="applyBoolean('intersect')">相交</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.paths-panel {
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
.paths-list { flex: 1; overflow-y: auto; }
.paths-empty { padding: 8px 10px; font-size: 11px; color: #666; }
.paths-panel.collapsed { flex: 0 0 auto; }
.paths-panel.collapsed .paths-list { display: none; }
.paths-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  font-size: 11px;
  color: #bbb;
  cursor: pointer;
  user-select: none;
}
.paths-row:hover { background: #2c2c2c; }
.paths-row.active { background: #0e639c; color: #fff; }
.paths-row.active .row-meta { color: rgba(255, 255, 255, 0.7); }
.row-icon { width: 14px; text-align: center; color: #888; flex: 0 0 auto; }
.paths-row.active .row-icon { color: #cfe6ff; }
.row-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-meta { color: #777; font-size: 10px; flex: 0 0 auto; }
.paths-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 10px;
  border-top: 1px solid #1a1a1a;
}
.paths-actions button {
  flex: 1 1 auto;
  min-width: 0;
  padding: 3px 6px;
  font-size: 11px;
  color: #ccc;
  background: #333;
  border: 1px solid #222;
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
}
.paths-actions button:hover:not(:disabled) { background: #3d3d3d; color: #fff; }
.paths-actions button:disabled { opacity: 0.4; cursor: default; }
.paths-actions button.commit { background: #0e639c; border-color: #0a4a75; color: #fff; }
.paths-actions button.commit:hover { background: #1177ba; }
.paths-bool {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 10px;
  border-top: 1px solid #1a1a1a;
}
.bool-title { font-size: 10px; font-weight: 600; color: #888; }
.bool-row { display: flex; gap: 4px; }
.bool-row select {
  flex: 1 1 50%;
  min-width: 0;
  padding: 2px 4px;
  font-size: 11px;
  color: #ccc;
  background: #333;
  border: 1px solid #222;
  border-radius: 3px;
}
.bool-row button {
  flex: 1 1 auto;
  min-width: 0;
  padding: 3px 6px;
  font-size: 11px;
  color: #ccc;
  background: #333;
  border: 1px solid #222;
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
}
.bool-row button:hover:not(:disabled) { background: #3d3d3d; color: #fff; }
.bool-row button:disabled { opacity: 0.4; cursor: default; }
</style>
