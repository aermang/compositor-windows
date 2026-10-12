<script setup lang="ts">
// 智能滤镜面板:活动图层的非破坏滤镜栈。参数/开关直接改 layer.smartFilters
// (reactive 生效)+ tick 触发重合成,不进历史;整组操作(添加/删除/重排)用
// history.push 包一条历史,before/after 深拷贝数组——layer 代理按 id 复用,
// 闭包捕获安全,undo/redo 写回代理即还原文档。缓存失效无需 rev:smartFilters
// JSON 在合成器按层缓存键里,键变化自然重算。
import { computed, ref } from 'vue';
import { store, activeLayer, history } from '../core/store';
import type { SmartFilter } from '../core/types';

interface ParamDef {
  key: string;
  label: string;
  dflt: number | boolean;
  min?: number;
  max?: number;
  step?: number;
  bool?: boolean;
}
interface FilterDef {
  kind: string;
  label: string;
  params: ParamDef[];
}

// 词表与 commands.ts Filter 菜单一致;def 缺省值取自菜单里的 def
const FILTER_DEFS: FilterDef[] = [
  { kind: 'gaussianBlur', label: '高斯模糊', params: [{ key: 'radius', label: '半径', dflt: 6, min: 0, max: 50, step: 0.5 }] },
  {
    kind: 'motionBlur', label: '动感模糊', params: [
      { key: 'angle', label: '角度', dflt: 0, min: -90, max: 90, step: 1 },
      { key: 'distance', label: '距离', dflt: 20, min: 0, max: 200, step: 1 },
    ],
  },
  {
    kind: 'addNoise', label: '添加杂色', params: [
      { key: 'amount', label: '数量', dflt: 12, min: 0, max: 100, step: 1 },
      { key: 'gaussian', label: '高斯分布', dflt: false, bool: true },
      { key: 'monochromatic', label: '单色', dflt: false, bool: true },
    ],
  },
  { kind: 'grain', label: '颗粒', params: [{ key: 'amount', label: '数量', dflt: 25, min: 0, max: 100, step: 1 }] },
  { kind: 'vignette', label: '暗角', params: [{ key: 'amount', label: '数量', dflt: 50, min: 0, max: 100, step: 1 }] },
  {
    kind: 'bloom', label: '泛光', params: [
      { key: 'amount', label: '数量', dflt: 40, min: 0, max: 100, step: 1 },
      { key: 'radius', label: '半径', dflt: 12, min: 0, max: 50, step: 0.5 },
    ],
  },
  { kind: 'sharpen', label: '锐化', params: [{ key: 'amount', label: '数量', dflt: 50, min: 0, max: 100, step: 1 }] },
  { kind: 'invert', label: '反相', params: [] },
];

const collapsed = ref(false);
const pendingKind = ref('');

const layer = computed(() => {
  const l = activeLayer.value;
  if (!store.doc || !l || l.isGroup || l.adjustment) return null;
  return l;
});
const filters = computed<SmartFilter[]>(() => layer.value?.smartFilters ?? []);

const kindLabel = (kind: string): string => FILTER_DEFS.find(d => d.kind === kind)?.label ?? kind;
const paramsOf = (kind: string): ParamDef[] => FILTER_DEFS.find(d => d.kind === kind)?.params ?? [];
const numParam = (f: SmartFilter, key: string): number =>
  typeof f.params[key] === 'number' ? f.params[key] as number : 0;

function cloneFilters(list: SmartFilter[] | null): SmartFilter[] | null {
  // params 只含 number/boolean,JSON 深拷贝足够
  return list ? JSON.parse(JSON.stringify(list)) as SmartFilter[] : null;
}

/** 整组变更包一条历史:undo/redo 还原整组数组并触发重合成。 */
function pushHistory(label: string, before: SmartFilter[] | null, after: SmartFilter[] | null) {
  const l = layer.value;
  if (!l) return;
  const beforeCopy = cloneFilters(before);
  const afterCopy = cloneFilters(after);
  history.push({
    label,
    undo: () => { l.smartFilters = beforeCopy; store.tick++; },
    redo: () => { l.smartFilters = afterCopy; store.tick++; },
  });
}

function addFilter(kind: string) {
  pendingKind.value = '';
  const def = FILTER_DEFS.find(d => d.kind === kind);
  const l = layer.value;
  if (!def || !l) return;
  const params: Record<string, number | boolean> = {};
  for (const p of def.params) params[p.key] = p.dflt;
  const before = cloneFilters(l.smartFilters);
  const after: SmartFilter[] = [...(l.smartFilters ?? []), { id: crypto.randomUUID().toUpperCase(), kind, params, enabled: true }];
  l.smartFilters = after;
  pushHistory('添加智能滤镜', before, after);
  store.dirty = true;
  store.tick++;
}

function removeFilter(i: number) {
  const l = layer.value;
  if (!l?.smartFilters) return;
  const before = cloneFilters(l.smartFilters);
  const after = cloneFilters(before)!;
  after.splice(i, 1);
  l.smartFilters = after;
  pushHistory('删除智能滤镜', before, after);
  store.dirty = true;
  store.tick++;
}

function moveFilter(i: number, dir: -1 | 1) {
  const l = layer.value;
  const list = l?.smartFilters;
  if (!list) return;
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  const before = cloneFilters(list);
  const after = cloneFilters(list)!;
  [after[i], after[j]] = [after[j], after[i]];
  l.smartFilters = after;
  pushHistory('调整智能滤镜顺序', before, after);
  store.dirty = true;
  store.tick++;
}

// 参数/开关是即时调整,不逐格写历史(与破坏版滤镜对话框的实时预览一致)
function setNum(f: SmartFilter, p: ParamDef, e: Event) {
  f.params[p.key] = Number((e.target as HTMLInputElement).value);
  store.dirty = true;
  store.tick++;
}
function setBool(f: SmartFilter, p: ParamDef, e: Event) {
  f.params[p.key] = (e.target as HTMLInputElement).checked;
  store.dirty = true;
  store.tick++;
}
function toggle(f: SmartFilter) {
  f.enabled = !f.enabled;
  store.dirty = true;
  store.tick++;
}
</script>

<template>
  <div class="smartfilter-panel" :class="{ collapsed }">
    <div class="panel-title" @click="collapsed = !collapsed">
      <span>智能滤镜</span>
      <span class="doc-name">{{ collapsed ? '▸' : '▾' }}</span>
    </div>
    <div class="sf-body" v-if="!collapsed">
      <template v-if="layer">
        <div v-if="!filters.length" class="sf-empty">无智能滤镜</div>
        <div v-for="(f, i) in filters" :key="f.id" class="sf-item">
          <div class="sf-row">
            <input
              type="checkbox" class="sf-eye" :checked="f.enabled"
              :title="f.enabled ? '禁用滤镜' : '启用滤镜'" @change="toggle(f)"
            />
            <span class="sf-kind" :class="{ off: !f.enabled }">{{ kindLabel(f.kind) }}</span>
            <span class="sf-spacer" />
            <button class="sf-btn" :disabled="i === 0" title="上移" @click="moveFilter(i, -1)">↑</button>
            <button class="sf-btn" :disabled="i === filters.length - 1" title="下移" @click="moveFilter(i, 1)">↓</button>
            <button class="sf-btn danger" title="删除" @click="removeFilter(i)">✕</button>
          </div>
          <div v-for="p in paramsOf(f.kind)" :key="p.key" class="sf-param">
            <label v-if="p.bool" class="sf-bool">
              <input type="checkbox" :checked="f.params[p.key] === true" @change="setBool(f, p, $event)" />
              <span>{{ p.label }}</span>
            </label>
            <template v-else>
              <span class="sf-plabel">{{ p.label }}</span>
              <input
                type="range" :min="p.min" :max="p.max" :step="p.step"
                :value="numParam(f, p.key)" @input="setNum(f, p, $event)"
              />
              <span class="sf-pval">{{ numParam(f, p.key) }}</span>
            </template>
          </div>
        </div>
        <select class="sf-add" v-model="pendingKind" @change="addFilter(pendingKind)">
          <option value="" disabled>添加智能滤镜…</option>
          <option v-for="d in FILTER_DEFS" :key="d.kind" :value="d.kind">{{ d.label }}</option>
        </select>
      </template>
      <div v-else class="sf-empty">无智能滤镜</div>
    </div>
  </div>
</template>

<style scoped>
.smartfilter-panel {
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
.sf-body { flex: 1; overflow-y: auto; }
.sf-empty { padding: 8px 10px; font-size: 11px; color: #666; }
.smartfilter-panel.collapsed { flex: 0 0 auto; }
.smartfilter-panel.collapsed .sf-body { display: none; }

.sf-item {
  padding: 5px 8px 6px;
  border-bottom: 1px solid #1c1c1c;
}
.sf-row {
  display: flex;
  align-items: center;
  gap: 5px;
}
.sf-eye { flex: 0 0 auto; accent-color: #4a90d9; }
.sf-kind { font-size: 11px; color: #ddd; }
.sf-kind.off { color: #555; text-decoration: line-through; }
.sf-spacer { flex: 1; }
.sf-btn {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  padding: 0;
  font-size: 10px;
  line-height: 1;
  color: #bbb;
  background: #2e2e2e;
  border: 1px solid #3a3a3a;
  border-radius: 3px;
  cursor: pointer;
}
.sf-btn:hover:not(:disabled) { background: #3a3a3a; color: #fff; }
.sf-btn:disabled { opacity: 0.35; cursor: default; }
.sf-btn.danger:hover { background: #6e2b2b; color: #fff; }
.sf-param {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0 0 22px;
}
.sf-bool {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #aaa;
  cursor: pointer;
}
.sf-bool input { accent-color: #4a90d9; }
.sf-plabel { flex: 0 0 34px; font-size: 10px; color: #999; }
.sf-param input[type="range"] { flex: 1; min-width: 0; height: 12px; accent-color: #4a90d9; }
.sf-pval { flex: 0 0 30px; font-size: 10px; color: #bbb; text-align: right; font-variant-numeric: tabular-nums; }
.sf-add {
  margin: 6px 8px;
  padding: 3px 6px;
  font-size: 11px;
  color: #ccc;
  background: #2e2e2e;
  border: 1px solid #3a3a3a;
  border-radius: 3px;
  width: calc(100% - 16px);
}
</style>
