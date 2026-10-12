<script setup lang="ts">
// Every modal in one place, switched on store.dialog ('new', 'export',
// 'imageSize', 'canvasSize', 'feather', 'expand', 'filter', 'effects',
// 'search', 'shortcuts', 'about'). Payloads ride on store.dialogPayload.

import { ref, computed, reactive, watch } from 'vue';
import { store, newDoc, activeLayer, history, flattenDoc } from '../core/store';
import { commands, runCommand, applyFilterToActive, openPathByKind } from '../commands';
import { featherSelection, growSelection } from '../core/selection';
import { makeCanvas, ctx2d, clamp } from '../core/canvasUtils';
import { defaultEffects } from '../core/types';
import type { EffectsData, Layer } from '../core/types';
import { exportCanvas } from '../core/io/raster';
import { exportPsd } from '../core/io/psdExport';
import { writeFile } from '../core/io/fs';
import { EFFECT_ZH } from '../core/labels';
import { getRecents, removeRecent } from '../core/recent';
import type { RecentEntry } from '../core/recent';
import CameraRawSheet from './CameraRawSheet.vue';
import GridSettingsSheet from './GridSettingsSheet.vue';
import DitherSheet from './sheets/DitherSheet.vue';
import ScanlinesSheet from './sheets/ScanlinesSheet.vue';
import SubjectSheet from './sheets/SubjectSheet.vue';
import ContentFillSheet from './sheets/ContentFillSheet.vue';
import ColorRangeSheet from './sheets/ColorRangeSheet.vue';
// D4 owns these two; imports stay dangling until the sheets land
import RawSheet from './RawSheet.vue';
import PsdSheet from './PsdSheet.vue';

const dialog = computed(() => store.dialog);

function close() { store.dialog = null; store.dialogPayload = null; }

// Self-gated sheets (below) render their own Teleport + backdrop + Esc
// handling on these dialog values — the generic backdrop must not double up.
const SHEET_DIALOGS = new Set([
  'cameraRaw', 'grid', 'dither', 'scanlines', 'subject', 'contentFill', 'colorRange', 'raw', 'psd',
]);

// ---------- New ----------

const newState = reactive({ width: 1600, height: 1200, background: 'white' as 'white' | 'transparent' });
const PRESETS = [
  { label: '剪贴板 1080p', w: 1920, h: 1080 },
  { label: 'A4 150dpi', w: 1240, h: 1754 },
  { label: '正方形 2048', w: 2048, h: 2048 },
  { label: '图标 512', w: 512, h: 512 },
];

// ---------- Export ----------

const exportState = reactive({ format: 'png', quality: 0.92, scale: 1, path: '', bitDepth: 8 as 8 | 16 });

async function chooseExportPath() {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const ext = exportState.format === 'jpeg' ? 'jpg' : exportState.format;
  const p = await save({ defaultPath: `export.${ext}` });
  if (p) exportState.path = p;
}

async function doExport() {
  if (!store.doc || !exportState.path) return;
  if (exportState.format === 'psd') {
    // PSD 保留图层:按文档原尺寸导出,忽略缩放;位深写入文档口径(exportPsd 读它)
    const path = exportState.path.toLowerCase().endsWith('.psd')
      ? exportState.path : exportState.path + '.psd';
    store.doc.bitDepth = exportState.bitDepth;
    await writeFile(path, new Uint8Array(exportPsd(store.doc)));
    close();
    return;
  }
  const flat = flattenDoc();
  const s = exportState.scale;
  let out = flat;
  if (s !== 1) {
    out = makeCanvas(Math.round(flat.width * s), Math.round(flat.height * s));
    ctx2d(out).drawImage(flat, 0, 0, out.width, out.height);
  }
  let final = out;
  if (exportState.format === 'jpeg') {
    const opaque = makeCanvas(out.width, out.height);
    const ox = ctx2d(opaque);
    ox.fillStyle = '#fff';
    ox.fillRect(0, 0, opaque.width, opaque.height);
    ox.drawImage(out, 0, 0);
    final = opaque;
  }
  const ext = exportState.format === 'jpeg' ? 'jpg' : exportState.format;
  const path = exportState.path.toLowerCase().endsWith('.' + ext)
    ? exportState.path : exportState.path + '.' + ext;
  await exportCanvas(final, path, exportState.format as 'png' | 'jpeg' | 'webp', exportState.quality);
  close();
}

// ---------- Image Size / Canvas Size ----------

const sizeState = reactive({ width: 0, height: 0, link: true });

// ---------- Image Info ----------

// 位深是来源/导出口径标志(TIFF/PSD 导出与 .comp 走它),非内部合成精度(恒 8bit)。
const infoDepth = computed({
  get: () => store.doc?.bitDepth ?? 8,
  set: v => { if (store.doc) { store.doc.bitDepth = v; store.dirty = true; } },
});
watch(dialog, d => {
  if (!store.doc) return;
  if (d === 'imageSize' || d === 'canvasSize') {
    sizeState.width = store.doc.width;
    sizeState.height = store.doc.height;
  }
});

function onSizeW(v: number) {
  sizeState.width = clamp(Math.round(v), 1, 30000);
  if (sizeState.link && store.doc) {
    sizeState.height = Math.round(sizeState.width * store.doc.height / store.doc.width);
  }
}
function onSizeH(v: number) {
  sizeState.height = clamp(Math.round(v), 1, 30000);
  if (sizeState.link && store.doc) {
    sizeState.width = Math.round(sizeState.height * store.doc.width / store.doc.height);
  }
}

function applyImageSize() {
  const doc = store.doc;
  if (!doc) return;
  const sx = sizeState.width / doc.width;
  const sy = sizeState.height / doc.height;
  const before = {
    w: doc.width, h: doc.height,
    origins: doc.layers.map(l => [...l.transform.origin] as [number, number]),
    sizes: doc.layers.map(l => [...l.transform.size] as [number, number]),
  };
  const after = {
    w: sizeState.width, h: sizeState.height,
    origins: before.origins.map(o => [o[0] * sx, o[1] * sy] as [number, number]),
    sizes: before.sizes.map(s => [s[0] * sx, s[1] * sy] as [number, number]),
  };
  const apply = (st: typeof before) => {
    doc.width = st.w;
    doc.height = st.h;
    doc.layers.forEach((l, i) => {
      l.transform.origin = [...st.origins[i]];
      l.transform.size = [...st.sizes[i]];
    });
    store.selection = null;
    store.tick++;
    store.uiTick++;
  };
  apply(after);
  history.push({
    label: 'Image Size',
    undo: () => apply(before),
    redo: () => apply(after),
  });
  store.dirty = true;
  close();
}

// canvas size: 9-grid anchor
const anchor = ref(4); // 0..8, 4 = center
function applyCanvasSize() {
  const doc = store.doc;
  if (!doc) return;
  const dx = Math.round((doc.width - sizeState.width) * (anchor.value % 3) / 2);
  const dy = Math.round((doc.height - sizeState.height) * Math.floor(anchor.value / 3) / 2);
  const before = {
    w: doc.width, h: doc.height,
    origins: doc.layers.map(l => [...l.transform.origin] as [number, number]),
  };
  const after = {
    w: sizeState.width, h: sizeState.height,
    origins: before.origins.map(o => [o[0] + dx, o[1] + dy] as [number, number]),
  };
  const apply = (st: typeof before) => {
    doc.width = st.w;
    doc.height = st.h;
    doc.layers.forEach((l, i) => { l.transform.origin = [...st.origins[i]]; });
    store.selection = null;
    store.tick++;
    store.uiTick++;
  };
  apply(after);
  history.push({
    label: 'Canvas Size',
    undo: () => apply(before),
    redo: () => apply(after),
  });
  store.dirty = true;
  close();
}

// ---------- Feather / Expand ----------

const featherRadius = ref(4);
const expandPixels = ref(4);

// ---------- Filter dialog ----------

interface FilterDef { key: string; label: string; min: number; max: number; step: number; unit?: string }
const FILTER_PARAMS: Record<string, FilterDef[]> = {
  gaussianBlur: [{ key: 'radius', label: '半径', min: 0, max: 100, step: 0.5, unit: 'px' }],
  motionBlur: [
    { key: 'angle', label: '角度', min: -90, max: 90, step: 1, unit: '°' },
    { key: 'distance', label: '距离', min: 1, max: 200, step: 1, unit: 'px' },
  ],
  addNoise: [{ key: 'amount', label: '数量', min: 0, max: 100, step: 1, unit: '%' }],
  grain: [{ key: 'amount', label: '数量', min: 0, max: 100, step: 1, unit: '%' }],
  vignette: [{ key: 'amount', label: '数量', min: 0, max: 100, step: 1, unit: '%' }],
  bloom: [
    { key: 'amount', label: '数量', min: 0, max: 100, step: 1, unit: '%' },
    { key: 'radius', label: '半径', min: 1, max: 60, step: 1, unit: 'px' },
  ],
  sharpen: [{ key: 'amount', label: '数量', min: 0, max: 200, step: 1, unit: '%' }],
  vibrance: [
    { key: 'vibrance', label: '自然饱和度', min: 0, max: 100, step: 1, unit: '%' },
    { key: 'saturation', label: '饱和度', min: -100, max: 100, step: 1, unit: '%' },
  ],
  channelMixer: [
    { key: 'redFromRed', label: '红-红', min: -200, max: 200, step: 1, unit: '%' },
    { key: 'redFromGreen', label: '红-绿', min: -200, max: 200, step: 1, unit: '%' },
    { key: 'redFromBlue', label: '红-蓝', min: -200, max: 200, step: 1, unit: '%' },
    { key: 'greenFromRed', label: '绿-红', min: -200, max: 200, step: 1, unit: '%' },
    { key: 'greenFromGreen', label: '绿-绿', min: -200, max: 200, step: 1, unit: '%' },
    { key: 'greenFromBlue', label: '绿-蓝', min: -200, max: 200, step: 1, unit: '%' },
    { key: 'blueFromRed', label: '蓝-红', min: -200, max: 200, step: 1, unit: '%' },
    { key: 'blueFromGreen', label: '蓝-绿', min: -200, max: 200, step: 1, unit: '%' },
    { key: 'blueFromBlue', label: '蓝-蓝', min: -200, max: 200, step: 1, unit: '%' },
  ],
  photoFilter: [
    { key: 'warmth', label: '色温(冷→暖)', min: -100, max: 100, step: 1, unit: '' },
    { key: 'density', label: '浓度', min: 0, max: 100, step: 1, unit: '%' },
  ],
  shadowHighlight: [
    { key: 'shadows', label: '阴影量', min: 0, max: 100, step: 1, unit: '%' },
    { key: 'highlights', label: '高光量', min: 0, max: 100, step: 1, unit: '%' },
  ],
};
// key stays the canonical English param name (drives filterState.params);
// label is the Chinese display text.
const FILTER_CHECKS: Record<string, { key: string; label: string }[]> = {
  addNoise: [{ key: 'gaussian', label: '高斯分布' }, { key: 'monochromatic', label: '单色' }],
};

const filterState = reactive<{ kind: string; params: Record<string, number | boolean> }>({ kind: '', params: {} });

watch(dialog, d => {
  if (d === 'filter') {
    const p = store.dialogPayload as { kind: string; def: Record<string, number | boolean> };
    filterState.kind = p.kind;
    filterState.params = { ...p.def };
  }
});

const filterLabel = computed(
  () => commands.find(c => c.id === `filter.${filterState.kind}`)?.label.replace('…', '') ?? 'Filter',
);

function okFilter() {
  applyFilterToActive(filterState.kind, { ...filterState.params });
  close();
}

function cancelFilter() {
  close();
}

// ---------- Effects dialog ----------

const fxLayer = computed<Layer | null>(() => activeLayer.value);

function fx(kind: keyof EffectsData): Record<string, unknown> | null {
  return (fxLayer.value?.effects?.[kind] ?? null) as Record<string, unknown> | null;
}
function ensureFx(kind: keyof EffectsData): Record<string, unknown> {
  const l = fxLayer.value;
  if (!l) return {};
  if (!l.effects) l.effects = {};
  if (!l.effects[kind]) l.effects[kind] = { ...defaultEffects(kind) } as never;
  return l.effects[kind] as unknown as Record<string, unknown>;
}
function toggleFxEnabled(kind: keyof EffectsData, on: boolean) {
  ensureFx(kind).enabled = on;
  store.dirty = true;
  store.tick++;
}

const FX_SECTIONS: { key: keyof EffectsData; label: string }[] = [
  { key: 'shadow', label: EFFECT_ZH.shadow },
  { key: 'innerShadow', label: EFFECT_ZH.innerShadow },
  { key: 'outerGlow', label: EFFECT_ZH.outerGlow },
  { key: 'innerGlow', label: EFFECT_ZH.innerGlow },
  { key: 'stroke', label: EFFECT_ZH.stroke },
  { key: 'colorOverlay', label: EFFECT_ZH.colorOverlay },
];

// color inputs need #rrggbb strings from 0-1 triples
function toHex(rgb: [number, number, number] | undefined): string {
  if (!rgb) return '#000000';
  return '#' + rgb.map(v => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('');
}
function fromHex(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
function touchFx() { store.dirty = true; store.tick++; }

// ---------- Search palette ----------

const searchQuery = ref('');
const searchResults = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  void store.uiTick;
  if (!q) return commands.filter(c => !c.id.startsWith('layer.adj.')).slice(0, 12);
  return commands
    .filter(c => c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
    .slice(0, 20);
});
const searchSel = ref(0);
watch(searchResults, () => { searchSel.value = 0; });

function runSearch(i: number) {
  const c = searchResults.value[i];
  if (!c) return;
  close();
  searchQuery.value = '';
  if (!c.enabled || c.enabled()) runCommand(c.id); // 统一派发(动作录制挂点)
}

function onDialogKey(e: KeyboardEvent) {
  if (dialog.value === 'search') {
    if (e.key === 'ArrowDown') { searchSel.value = Math.min(searchResults.value.length - 1, searchSel.value + 1); e.preventDefault(); }
    if (e.key === 'ArrowUp') { searchSel.value = Math.max(0, searchSel.value - 1); e.preventDefault(); }
    if (e.key === 'Enter') { runSearch(searchSel.value); e.preventDefault(); }
  }
  if (e.key === 'Escape') close();
}

// ---------- Recents ----------

const recents = ref<RecentEntry[]>([]);
watch(dialog, d => {
  if (d !== 'recents') return;
  void getRecents().then(list => { recents.value = list; });
});

function openRecent(path: string) {
  close();
  void openPathByKind(path);
}

function removeRecentEntry(path: string) {
  removeRecent(path);
  recents.value = recents.value.filter(e => e.path !== path);
}

const SHORTCUT_GROUPS: { title: string; pairs: [string, string][] }[] = [
  {
    title: '工具',
    pairs: [
      ['V', '移动'], ['M', '选框'], ['L', '套索'], ['W', '魔棒'], ['C', '裁剪'],
      ['B', '画笔'], ['E', '橡皮擦'], ['R', '涂抹'], ['S / J', '仿制图章'], ['G', '渐变'],
      ['U', '形状'], ['T', '文字'], ['I', '吸管'], ['H', '抓手'], ['Z', '缩放'],
    ],
  },
  {
    title: '视图',
    pairs: [
      ['Ctrl + / −', '放大 / 缩小'], ['Ctrl+0', '按屏幕大小'], ['Ctrl+1', '实际像素'],
      ['Ctrl+wheel', '指针处缩放'], ['Space (hold)', '空格拖移'], ['F', '隐藏面板'],
      ['[ / ]', '笔刷大小 −+'],
    ],
  },
  {
    title: '编辑',
    pairs: [
      ['Ctrl+Z / Ctrl+Shift+Z', '撤销 / 重做'], ['Ctrl+J', '复制图层'],
      ['Ctrl+T', '自由变换 / 浮动选区'], ['Ctrl+Shift+C', '合并复制'],
      ['Ctrl+E', '向下合并'], ['Ctrl+Shift+N', '新建图层'], ['Ctrl+A / Ctrl+D', '全选 / 取消选择'],
      ['Ctrl+Shift+I', '反选'], ['Ctrl+I', '反相颜色'], ['Shift+F5', '内容识别填充'],
      ['Ctrl+Alt+F', '上次滤镜'],
      ['X', '交换颜色'], ['D', '默认颜色'], ['Arrows', '微移图层'],
    ],
  },
  {
    title: '文件',
    pairs: [
      ['Ctrl+N', '新建'], ['Ctrl+O', '打开图像'], ['Ctrl+S', '保存项目'],
      ['Ctrl+Shift+S', '项目另存为'], ['Ctrl+Shift+E', '导出 PNG'], ['Ctrl+W', '关闭文档'],
      ['Ctrl+F', '搜索命令'],
    ],
  },
];
</script>

<template>
  <Teleport to="body">
    <!-- backdrop -->
    <div v-if="dialog && dialog !== 'search' && !SHEET_DIALOGS.has(dialog)" class="backdrop" @click="close"></div>

    <!-- New -->
    <div v-if="dialog === 'new'" class="dialog" @keydown="onDialogKey">
      <h3>新建文档</h3>
      <div class="grid2">
        <label class="field">宽度 <input type="number" v-model.number="newState.width" min="1" max="30000" /></label>
        <label class="field">高度 <input type="number" v-model.number="newState.height" min="1" max="30000" /></label>
      </div>
      <div class="row">
        <button v-for="p in PRESETS" :key="p.label" class="btn small" @click="newState.width = p.w; newState.height = p.h">{{ p.label }}</button>
      </div>
      <div class="row">
        <label class="check"><input type="radio" value="white" v-model="newState.background" /> 白色</label>
        <label class="check"><input type="radio" value="transparent" v-model="newState.background" /> 透明</label>
      </div>
      <div class="actions">
        <button class="btn" @click="close">取消</button>
        <button class="btn primary" @click="newDoc(newState.width, newState.height, newState.background, ''); close()">创建</button>
      </div>
    </div>

    <!-- Export -->
    <div v-if="dialog === 'export' && store.doc" class="dialog" @keydown="onDialogKey">
      <h3>导出图像</h3>
      <div class="row">
        <select class="select" v-model="exportState.format">
          <option value="png">PNG</option>
          <option value="jpeg">JPEG</option>
          <option value="webp">WebP</option>
          <option value="psd">PSD（含图层）</option>
        </select>
        <label v-if="exportState.format !== 'psd'" class="field">缩放
          <input type="number" min="0.05" max="8" step="0.05" v-model.number="exportState.scale" />
        </label>
        <label v-if="exportState.format === 'psd'" class="field">位深
          <select class="select" v-model.number="exportState.bitDepth">
            <option :value="8">8 位/通道</option>
            <option :value="16">16 位/通道</option>
          </select>
        </label>
      </div>
      <label v-if="exportState.format !== 'png' && exportState.format !== 'psd'" class="row">质量
        <input type="range" min="0.3" max="1" step="0.01" v-model.number="exportState.quality" />
        <span class="v">{{ Math.round(exportState.quality * 100) }}%</span>
      </label>
      <div class="row">
        <span class="hint">{{ store.doc.width }}×{{ store.doc.height }} → {{ Math.round(store.doc.width * exportState.scale) }}×{{ Math.round(store.doc.height * exportState.scale) }}</span>
      </div>
      <div class="row">
        <input class="path-input" :value="exportState.path" placeholder="选择保存位置…" readonly @click="chooseExportPath" />
        <button class="btn" @click="chooseExportPath">浏览…</button>
      </div>
      <div class="actions">
        <button class="btn" @click="close">取消</button>
        <button class="btn primary" :disabled="!exportState.path" @click="doExport">导出</button>
      </div>
    </div>

    <!-- Image Size -->
    <div v-if="dialog === 'imageSize' && store.doc" class="dialog" @keydown="onDialogKey">
      <h3>图像大小</h3>
      <div class="grid2">
        <label class="field">宽度 <input type="number" :value="sizeState.width" @input="onSizeW(Number(($event.target as HTMLInputElement).value))" /></label>
        <label class="field">高度 <input type="number" :value="sizeState.height" @input="onSizeH(Number(($event.target as HTMLInputElement).value))" /></label>
      </div>
      <label class="check"><input type="checkbox" v-model="sizeState.link" /> 保持纵横比</label>
      <div class="hint">图层按比例缩放（导出时重采样，非破坏性）。</div>
      <div class="actions">
        <button class="btn" @click="close">取消</button>
        <button class="btn primary" @click="applyImageSize">调整大小</button>
      </div>
    </div>

    <!-- Canvas Size -->
    <div v-if="dialog === 'canvasSize' && store.doc" class="dialog" @keydown="onDialogKey">
      <h3>画布大小</h3>
      <div class="grid2">
        <label class="field">宽度 <input type="number" :value="sizeState.width" @input="onSizeW(Number(($event.target as HTMLInputElement).value))" /></label>
        <label class="field">高度 <input type="number" :value="sizeState.height" @input="onSizeH(Number(($event.target as HTMLInputElement).value))" /></label>
      </div>
      <div class="anchor-grid">
        <button
          v-for="i in 9" :key="i"
          class="anchor" :class="{ on: anchor === i - 1 }"
          @click="anchor = i - 1"
        ></button>
      </div>
      <div class="actions">
        <button class="btn" @click="close">取消</button>
        <button class="btn primary" @click="applyCanvasSize">调整大小</button>
      </div>
    </div>

    <!-- Image Info -->
    <div v-if="dialog === 'imageInfo' && store.doc" class="dialog" @keydown="onDialogKey">
      <h3>图像信息</h3>
      <div class="hint">
        <div>尺寸:{{ store.doc.width }} × {{ store.doc.height }} px</div>
        <div>分辨率:{{ store.doc.resolution }} dpi</div>
        <div>图层:{{ store.doc.layers.length }}</div>
        <div>ICC:{{ store.doc.iccName ?? 'sRGB(未嵌入)' }}</div>
      </div>
      <label class="field">位深(来源/导出口径,TIFF/PSD 导出生效)
        <select class="select" v-model.number="infoDepth">
          <option :value="8">8 位/通道</option>
          <option :value="16">16 位/通道</option>
        </select>
      </label>
      <div class="actions">
        <button class="btn primary" @click="close">关闭</button>
      </div>
    </div>

    <!-- Feather -->
    <div v-if="dialog === 'feather' && store.selection" class="dialog" @keydown="onDialogKey">
      <h3>羽化选区</h3>
      <label class="row">半径
        <input type="range" min="0.5" max="60" step="0.5" v-model.number="featherRadius" />
        <span class="v">{{ featherRadius }} px</span>
      </label>
      <div class="actions">
        <button class="btn" @click="close">取消</button>
        <button class="btn primary" @click="featherSelection(store.selection!, featherRadius); store.tick++; close()">应用</button>
      </div>
    </div>

    <!-- Expand / Contract -->
    <div v-if="dialog === 'expand' && store.selection" class="dialog" @keydown="onDialogKey">
      <h3>{{ (store.dialogPayload as number) > 0 ? '扩展选区' : '收缩选区' }}</h3>
      <label class="row">像素
        <input type="range" min="1" max="60" step="1" v-model.number="expandPixels" />
        <span class="v">{{ expandPixels }} px</span>
      </label>
      <div class="actions">
        <button class="btn" @click="close">取消</button>
        <button class="btn primary" @click="growSelection(store.selection!, (store.dialogPayload as number) * expandPixels); store.tick++; close()">应用</button>
      </div>
    </div>

    <!-- Filter -->
    <div v-if="dialog === 'filter'" class="dialog" @keydown="onDialogKey">
      <h3>{{ filterLabel }}</h3>
      <label v-for="p in FILTER_PARAMS[filterState.kind] ?? []" :key="p.key" class="row">{{ p.label }}
        <input
          type="range" :min="p.min" :max="p.max" :step="p.step"
          v-model.number="(filterState.params as Record<string, number>)[p.key]"
        />
        <span class="v">{{ (filterState.params as Record<string, number>)[p.key] }}{{ p.unit }}</span>
      </label>
      <label v-for="ck in FILTER_CHECKS[filterState.kind] ?? []" :key="ck.key" class="check">
        <input type="checkbox" v-model="(filterState.params as Record<string, boolean>)[ck.key]" /> {{ ck.label }}
      </label>
      <div class="actions">
        <button class="btn" @click="cancelFilter">取消</button>
        <button class="btn primary" @click="okFilter">确定</button>
      </div>
    </div>

    <!-- Effects -->
    <div v-if="dialog === 'effects' && fxLayer" class="dialog wide" @keydown="onDialogKey">
      <h3>图层效果 — {{ fxLayer.name }}</h3>
      <div v-for="sec of FX_SECTIONS" :key="sec.key" class="fx-section">
        <label class="check title">
          <input
            type="checkbox"
            :checked="!!fx(sec.key)?.enabled"
            @change="toggleFxEnabled(sec.key, ($event.target as HTMLInputElement).checked)"
          /> {{ sec.label }}
        </label>
        <template v-if="fx(sec.key)?.enabled">
          <!-- shadow-like: angle / distance / blur / color / opacity -->
          <template v-if="sec.key === 'shadow' || sec.key === 'innerShadow'">
            <label class="row">角度
              <input type="range" min="0" max="360" step="1" v-model.number="(ensureFx(sec.key).angle as number)" @input="touchFx" />
              <span class="v">{{ ensureFx(sec.key).angle }}°</span>
            </label>
            <label class="row">距离
              <input type="range" min="0" max="200" step="1" v-model.number="(ensureFx(sec.key).distance as number)" @input="touchFx" />
              <span class="v">{{ ensureFx(sec.key).distance }} px</span>
            </label>
            <label class="row">模糊
              <input type="range" min="0" max="100" step="1" v-model.number="(ensureFx(sec.key).blur as number)" @input="touchFx" />
              <span class="v">{{ ensureFx(sec.key).blur }} px</span>
            </label>
            <div class="row">
              <label class="field">颜色
                <input type="color" :value="toHex(ensureFx(sec.key).color as [number, number, number])"
                  @input="ensureFx(sec.key).color = fromHex(($event.target as HTMLInputElement).value); touchFx()" />
              </label>
              <label class="row">不透明度
                <input type="range" min="0" max="1" step="0.01" v-model.number="(ensureFx(sec.key).opacity as number)" @input="touchFx" />
                <span class="v">{{ Math.round((ensureFx(sec.key).opacity as number) * 100) }}%</span>
              </label>
            </div>
          </template>

          <!-- glow-like: size / color / opacity -->
          <template v-else-if="sec.key === 'outerGlow' || sec.key === 'innerGlow'">
            <label class="row">大小
              <input type="range" min="0" max="100" step="1" v-model.number="(ensureFx(sec.key).size as number)" @input="touchFx" />
              <span class="v">{{ ensureFx(sec.key).size }} px</span>
            </label>
            <div class="row">
              <label class="field">颜色
                <input type="color" :value="toHex(ensureFx(sec.key).color as [number, number, number])"
                  @input="ensureFx(sec.key).color = fromHex(($event.target as HTMLInputElement).value); touchFx()" />
              </label>
              <label class="row">不透明度
                <input type="range" min="0" max="1" step="0.01" v-model.number="(ensureFx(sec.key).opacity as number)" @input="touchFx" />
                <span class="v">{{ Math.round((ensureFx(sec.key).opacity as number) * 100) }}%</span>
              </label>
            </div>
          </template>

          <!-- stroke: size / inside / color / opacity -->
          <template v-else-if="sec.key === 'stroke'">
            <label class="row">大小
              <input type="range" min="0" max="60" step="1" v-model.number="(ensureFx(sec.key).size as number)" @input="touchFx" />
              <span class="v">{{ ensureFx(sec.key).size }} px</span>
            </label>
            <label class="check"><input type="checkbox" v-model="(ensureFx(sec.key).inside as boolean)" @change="touchFx" /> 内部</label>
            <div class="row">
              <label class="field">颜色
                <input type="color" :value="toHex(ensureFx(sec.key).color as [number, number, number])"
                  @input="ensureFx(sec.key).color = fromHex(($event.target as HTMLInputElement).value); touchFx()" />
              </label>
              <label class="row">不透明度
                <input type="range" min="0" max="1" step="0.01" v-model.number="(ensureFx(sec.key).opacity as number)" @input="touchFx" />
                <span class="v">{{ Math.round((ensureFx(sec.key).opacity as number) * 100) }}%</span>
              </label>
            </div>
          </template>

          <!-- color overlay -->
          <template v-else-if="sec.key === 'colorOverlay'">
            <div class="row">
              <label class="field">颜色
                <input type="color" :value="toHex(ensureFx(sec.key).color as [number, number, number])"
                  @input="ensureFx(sec.key).color = fromHex(($event.target as HTMLInputElement).value); touchFx()" />
              </label>
              <label class="row">不透明度
                <input type="range" min="0" max="1" step="0.01" v-model.number="(ensureFx(sec.key).opacity as number)" @input="touchFx" />
                <span class="v">{{ Math.round((ensureFx(sec.key).opacity as number) * 100) }}%</span>
              </label>
            </div>
          </template>
        </template>
      </div>
      <div class="actions">
        <button class="btn" @click="close">关闭</button>
      </div>
    </div>

    <!-- Search palette -->
    <div v-if="dialog === 'search'" class="palette" @keydown="onDialogKey">
      <input ref="searchBox" class="palette-input" v-model="searchQuery" placeholder="搜索命令…（↑↓ 选择，Enter 运行）" autofocus />
      <div class="palette-list">
        <div
          v-for="(c, i) in searchResults"
          :key="c.id"
          class="palette-item"
          :class="{ sel: i === searchSel, disabled: c.enabled && !c.enabled() }"
          @click="runSearch(i)"
          @mousemove="searchSel = i"
        >
          <span class="pl-menu">{{ c.menu }}</span>
          <span class="pl-label">{{ c.label }}</span>
          <span class="pl-sc">{{ c.shortcut ?? '' }}</span>
        </div>
      </div>
    </div>

    <!-- Shortcuts -->
    <div v-if="dialog === 'shortcuts'" class="dialog wide" @keydown="onDialogKey">
      <h3>键盘快捷键</h3>
      <div class="shortcut-cols">
        <div v-for="g in SHORTCUT_GROUPS" :key="g.title" class="shortcut-group">
          <div class="group-title">{{ g.title }}</div>
          <div v-for="[k, d] of g.pairs" :key="k" class="shortcut-pair">
            <span class="key">{{ k }}</span><span class="desc">{{ d }}</span>
          </div>
        </div>
      </div>
      <div class="actions"><button class="btn primary" @click="close">关闭</button></div>
    </div>

    <!-- Recents -->
    <div v-if="dialog === 'recents'" class="dialog" @keydown="onDialogKey">
      <h3>最近打开</h3>
      <div v-if="!recents.length" class="hint">暂无最近项目</div>
      <div v-else class="recent-list">
        <div v-for="e in recents" :key="e.path" class="recent-item" @click="openRecent(e.path)">
          <span class="recent-name">{{ e.name }}</span>
          <span class="recent-path">{{ e.path }}</span>
          <button class="btn small" title="从列表移除" @click.stop="removeRecentEntry(e.path)">✕</button>
        </div>
      </div>
      <div class="actions"><button class="btn primary" @click="close">关闭</button></div>
    </div>

    <!-- About -->
    <div v-if="dialog === 'about'" class="dialog" @keydown="onDialogKey">
      <h3>Windows 版 Compositor</h3>
      <p class="hint">基于 Photoshop 式图层的图像编辑器，macOS 版 Compositor 的 Windows 移植，读写同一 <code>.comp</code> 项目格式。</p>
      <p class="hint">图层 · 混合模式 · 蒙版 · 调整层 · 效果 · 选区 · 文字 · 滤镜</p>
      <div class="actions"><button class="btn primary" @click="close">关闭</button></div>
    </div>

    <!-- self-gated sheets: each mounts its own Teleport on its store.dialog value -->
    <CameraRawSheet />
    <GridSettingsSheet />
    <DitherSheet />
    <ScanlinesSheet />
    <SubjectSheet />
    <ContentFillSheet />
    <ColorRangeSheet />
    <RawSheet />
    <PsdSheet />
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.45);
  z-index: 200;
}
.dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: #2b2b2b;
  border: 1px solid #000;
  border-radius: 10px;
  padding: 18px 20px;
  min-width: 340px;
  max-width: 480px;
  max-height: 82vh;
  overflow-y: auto;
  color: #ddd;
  box-shadow: 0 16px 48px rgba(0,0,0,0.6);
  z-index: 201;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dialog.wide { min-width: 460px; }
h3 { margin: 0 0 4px; font-size: 14px; color: #fff; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.row input[type='range'] { flex: 1; min-width: 120px; accent-color: #0e639c; }
.row .v { min-width: 44px; text-align: right; color: #999; font-size: 11px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.field { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #aaa; }
.field input[type='number'] {
  width: 70px; background: #1f1f1f; color: #eee; border: 1px solid #444;
  border-radius: 4px; padding: 4px 6px; font-size: 12px;
}
.check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #bbb; cursor: pointer; }
.check.title { font-weight: 700; color: #fff; }
.hint { font-size: 11px; color: #777; line-height: 1.5; }
.select {
  background: #1f1f1f; color: #eee; border: 1px solid #444;
  border-radius: 4px; padding: 4px 6px; font-size: 12px;
}
.path-input {
  flex: 1; background: #1f1f1f; color: #999; border: 1px solid #444;
  border-radius: 4px; padding: 4px 8px; font-size: 11px; min-width: 160px;
}
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
.btn {
  background: #333; color: #ddd; border: 1px solid #454545;
  border-radius: 5px; padding: 6px 14px; font-size: 12px; cursor: pointer;
}
.btn:hover { background: #3a3a3a; }
.btn.primary { background: #0e639c; border-color: #1177bb; color: #fff; }
.btn.primary:hover { background: #1177bb; }
.btn.primary:disabled { opacity: 0.5; cursor: default; }
.btn.small { padding: 4px 8px; font-size: 11px; }
.anchor-grid { display: grid; grid-template-columns: repeat(3, 28px); gap: 3px; justify-content: center; padding: 6px 0; }
.anchor { height: 28px; border: 1px solid #444; background: #1f1f1f; border-radius: 4px; cursor: pointer; }
.anchor.on { background: #0e639c; border-color: #1177bb; }
.fx-section { border-top: 1px solid #3a3a3a; padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.fx-section .row input[type='range'] { max-width: 180px; }
input[type='color'] { width: 34px; height: 22px; padding: 0; border: 1px solid #444; border-radius: 3px; background: none; cursor: pointer; }
.palette {
  position: fixed;
  top: 14%;
  left: 50%;
  transform: translateX(-50%);
  width: 520px;
  background: #2b2b2b;
  border: 1px solid #000;
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 16px 48px rgba(0,0,0,0.6);
  z-index: 201;
}
.palette-input {
  width: 100%;
  box-sizing: border-box;
  background: #1f1f1f;
  border: none;
  border-bottom: 1px solid #000;
  color: #fff;
  font-size: 14px;
  padding: 12px 14px;
  outline: none;
}
.palette-list { max-height: 340px; overflow-y: auto; }
.palette-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 14px;
  font-size: 12px;
  color: #ccc;
  cursor: pointer;
}
.palette-item.sel { background: #0e639c; color: #fff; }
.palette-item.disabled { opacity: 0.45; }
.pl-menu { color: #6f9fd8; font-size: 10px; text-transform: uppercase; width: 44px; }
.palette-item.sel .pl-menu { color: #cde5ff; }
.pl-label { flex: 1; }
.pl-sc { color: #888; font-size: 11px; }
.palette-item.sel .pl-sc { color: #cde5ff; }
.shortcut-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.shortcut-group { display: flex; flex-direction: column; gap: 3px; }
.group-title { font-size: 11px; font-weight: 700; color: #999; text-transform: uppercase; margin: 4px 0; }
.shortcut-pair { display: flex; justify-content: space-between; gap: 12px; font-size: 11px; }
.shortcut-pair .key { color: #ddd; background: #1f1f1f; border: 1px solid #3a3a3a; border-radius: 3px; padding: 1px 6px; }
.shortcut-pair .desc { color: #888; }
.recent-list { display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow-y: auto; min-width: 380px; }
.recent-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border-radius: 5px; cursor: pointer;
}
.recent-item:hover { background: #333; }
.recent-name { color: #ddd; font-size: 12px; white-space: nowrap; }
.recent-path {
  flex: 1; color: #777; font-size: 11px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.recent-item .btn { flex: none; }
code { background: #1f1f1f; padding: 1px 5px; border-radius: 3px; }
</style>
