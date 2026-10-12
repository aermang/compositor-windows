<!-- 字符面板(活字排版):对活动文本层施加逐范围字符样式。
     顶层控件(字体/字号/颜色/字距)直接改 TextMeta 顶层;
     B/I/基线偏移(TextMeta 无顶层字段)以全内容 range 合并写入;
     「起始/结束 + 应用」把当前控件值构造/合并为 TextStyleRange 写入 ranges。
     所有改动即时 upsertTextBitmap 并入历史(可 Ctrl+Z)。
     DEV 钩子:window.__typeDebug = { applyRange, meta, bitmapFingerprint }。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { store, upsertTextBitmap, history, findLayer } from '../core/store';
import type { Layer, TextMeta, TextStyleRange } from '../core/types';

const FONT_OPTIONS = ['Inter', 'Microsoft YaHei', 'SimSun', 'KaiTi', 'Arial', 'Georgia', 'Consolas'];
const RANGE_FIELD_NAMES = [
  'fontName', 'fontSize', 'color', 'bold', 'italic', 'tracking', 'baselineShift',
] as const;

const isText = computed(() => !!store.doc?.layers.some(
  l => l.id === store.doc?.activeLayerId && l.text,
));
const meta = computed<TextMeta | null>(() =>
  store.doc?.layers.find(l => l.id === store.doc?.activeLayerId)?.text ?? null);

// ---------- 面板控件状态 ----------
const family = ref('Inter');
const fontSize = ref(48);
const colorHex = ref('#000000');
const bold = ref(false);
const italic = ref(false);
const tracking = ref(0);
const baseline = ref(0);
const start = ref(0);
const end = ref(0);

const fontChoices = computed(() => {
  const cur = family.value;
  return FONT_OPTIONS.includes(cur) ? FONT_OPTIONS : [cur, ...FONT_OPTIONS];
});

function familyOf(fontName: string): string {
  return fontName.replace(/-(Regular|Bold|Italic|BoldItalic|Light|Semibold|Medium)$/, '');
}
function rgb01ToHex(rgb: [number, number, number]): string {
  const h = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}
function hexToRgb01(hex: string): [number, number, number] {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
function cpLen(s: string): number {
  let n = 0;
  for (const c of s) { void c; n++; }
  return n;
}
function num(v: number | string): number {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}
function cloneMeta(t: TextMeta): TextMeta {
  return JSON.parse(JSON.stringify(t)) as TextMeta;
}
function textLayer(): Layer | null {
  return store.doc?.layers.find(l => l.id === store.doc?.activeLayerId && l.text) ?? null;
}

// 覆盖全内容的 range(B/I/基线等"准顶层"字段的读取处)
function wholeRange(): TextStyleRange | null {
  const t = meta.value;
  if (!t) return null;
  const len = cpLen(t.content);
  return t.ranges?.find(r => r.start <= 0 && r.end >= len) ?? null;
}

// 面板值初始化自活动层顶层 meta;切层/历史跳转(tick)后刷新
function refresh() {
  const t = meta.value;
  if (!t) return;
  family.value = familyOf(t.fontName);
  fontSize.value = t.fontSize;
  colorHex.value = rgb01ToHex(t.color);
  tracking.value = t.tracking;
  const full = wholeRange();
  bold.value = full?.bold ?? false;
  italic.value = full?.italic ?? false;
  baseline.value = full?.baselineShift ?? 0;
  start.value = 0;
  end.value = cpLen(t.content);
}
watch(() => [store.doc?.activeLayerId, store.tick], refresh, { immediate: true });

// 提交一份新 meta:即时重渲染 + 推入历史(undo 恢复旧 meta 并重渲染)
function commitMeta(next: TextMeta, label: string) {
  const layer = textLayer();
  if (!layer?.text) return;
  const before = cloneMeta(layer.text);
  if (JSON.stringify(before) === JSON.stringify(next)) return; // 空改动不进历史
  upsertTextBitmap(layer, next);
  const after = cloneMeta(next);
  history.push({
    label,
    undo: () => { const l = findLayer(layer.id); if (l?.text) upsertTextBitmap(l, cloneMeta(before)); },
    redo: () => { const l = findLayer(layer.id); if (l?.text) upsertTextBitmap(l, cloneMeta(after)); },
  });
}

/** 构造/合并一个 TextStyleRange 写入 ranges:与既有 [start,end) 完全相同的范围
 *  就地合并(新定义的字段覆盖),否则追加。数组序 = 优先级(先到先得)。 */
function applyRange(opts: Partial<TextStyleRange> & { start?: number; end?: number }) {
  const t = meta.value;
  if (!t) return;
  const len = cpLen(t.content);
  const s = Math.max(0, Math.min(len, Math.round(num(opts.start ?? 0))));
  const e = Math.max(0, Math.min(len, Math.round(num(opts.end ?? len))));
  if (e <= s) return; // 空范围忽略
  const nr = { start: s, end: e } as TextStyleRange;
  for (const k of RANGE_FIELD_NAMES) {
    const v = opts[k];
    if (v !== undefined) (nr as unknown as Record<string, unknown>)[k] = v;
  }
  const ranges = (t.ranges ?? []).map(r => ({ ...r }));
  const i = ranges.findIndex(r => r.start === s && r.end === e);
  if (i >= 0) ranges[i] = { ...ranges[i], ...nr };
  else ranges.push(nr);
  commitMeta({ ...cloneMeta(t), ranges }, '字符样式');
}

// ---------- 顶层控件(直接改 TextMeta 顶层) ----------
function onFont() {
  const t = meta.value;
  if (t) commitMeta({ ...cloneMeta(t), fontName: family.value }, '文字字体');
}
function onSize() {
  const t = meta.value;
  const v = num(fontSize.value);
  if (t && v > 0) commitMeta({ ...cloneMeta(t), fontSize: v }, '文字字号');
}
function onColor() {
  const t = meta.value;
  if (t) commitMeta({ ...cloneMeta(t), color: hexToRgb01(colorHex.value) }, '文字颜色');
}
function onTracking() {
  const t = meta.value;
  if (t) commitMeta({ ...cloneMeta(t), tracking: num(tracking.value) }, '文字字距');
}

// ---------- 准顶层字段(TextMeta 无此字段,以全内容 range 表达) ----------
function toggleBold() {
  const len = meta.value ? cpLen(meta.value!.content) : 0;
  if (len > 0) applyRange({ start: 0, end: len, bold: !bold.value });
}
function toggleItalic() {
  const len = meta.value ? cpLen(meta.value!.content) : 0;
  if (len > 0) applyRange({ start: 0, end: len, italic: !italic.value });
}
function onBaseline() {
  const len = meta.value ? cpLen(meta.value!.content) : 0;
  if (len > 0) applyRange({ start: 0, end: len, baselineShift: num(baseline.value) });
}

// 「应用」:把当前控件值作为样式施加到 [起始, 结束)
function onApply() {
  applyRange({
    start: num(start.value),
    end: num(end.value),
    fontName: family.value,
    fontSize: num(fontSize.value),
    color: hexToRgb01(colorHex.value),
    bold: bold.value,
    italic: italic.value,
    tracking: num(tracking.value),
    baselineShift: num(baseline.value),
  });
}

// ---------- DEV/测试钩子(参考 __lxDebug/__ppDebug 模式) ----------
if (import.meta.env.DEV) {
  (window as unknown as { __typeDebug?: unknown }).__typeDebug = {
    applyRange: (opts: Partial<TextStyleRange> & { start?: number; end?: number }) => applyRange(opts),
    meta: () => {
      const t = meta.value;
      return t ? cloneMeta(t) : null;
    },
    bitmapFingerprint: () => {
      const l = textLayer();
      if (!l?.bitmap) return null;
      const cx = l.bitmap.getContext('2d');
      if (!cx) return null;
      const d = cx.getImageData(0, 0, l.bitmap.width, l.bitmap.height).data;
      let h = 0x811c9dc5;
      for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193); }
      return { fp: (h >>> 0).toString(16), w: l.bitmap.width, h: l.bitmap.height };
    },
  };
}
</script>

<template>
  <div class="panel char-panel" v-if="!store.canvasOnly" :class="{ off: !isText }">
    <div class="panel-title">字符</div>
    <!-- 非文本层时收起主体:右栏为定高 flex 列,面板自然高度会把属性面板
         挤压溢出、拦截下方控件的点击(集成期回归发现的布局冲突)。 -->
    <fieldset class="cp-body" v-show="isText" :disabled="!isText">
      <div class="row">
        <select class="cp-font" v-model="family" title="字体" @change="onFont">
          <option v-for="f in fontChoices" :key="f" :value="f">{{ f }}</option>
        </select>
      </div>
      <div class="row">
        <label class="lbl">字号</label>
        <input class="cp-size" v-model.number="fontSize" type="number" min="4" max="512" step="1" title="字号(px)" @change="onSize" />
        <input class="cp-color" v-model="colorHex" type="color" title="颜色" @change="onColor" />
        <button class="cp-bold" :class="{ on: bold }" title="仿粗体" @click="toggleBold"><b>B</b></button>
        <button class="cp-italic" :class="{ on: italic }" title="仿斜体" @click="toggleItalic"><i>I</i></button>
      </div>
      <div class="row">
        <label class="lbl">字距</label>
        <input class="cp-tracking" v-model.number="tracking" type="number" step="1" title="字距(px)" @change="onTracking" />
        <label class="lbl">基线</label>
        <input class="cp-baseline" v-model.number="baseline" type="number" step="1" title="基线偏移(px,正上负下)" @change="onBaseline" />
      </div>
      <div class="row">
        <label class="lbl">起始</label>
        <input class="cp-start" v-model.number="start" type="number" min="0" step="1" title="范围起始(0=首字符)" />
        <label class="lbl">结束</label>
        <input class="cp-end" v-model.number="end" type="number" min="0" step="1" title="范围结束(缺省=内容长度)" />
        <button class="cp-apply" title="把当前字符样式施加到指定范围" @click="onApply">应用</button>
      </div>
    </fieldset>
  </div>
</template>

<style scoped>
.panel { border-top: 1px solid #111; padding: 6px 8px; }
.panel-title { color: #bbb; font-size: 12px; margin-bottom: 4px; }
.hint { color: #666; font-size: 11px; }
.char-panel.off { opacity: 0.45; }
.cp-body { border: none; margin: 0; padding: 0; min-width: 0; }
.row { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
.lbl { color: #888; font-size: 11px; flex: 0 0 auto; }
select, input[type=number] {
  background: #2b2b2b; color: #ddd; border: 1px solid #222;
  border-radius: 3px; font-size: 11px; padding: 1px 3px; min-width: 0;
}
select.cp-font { flex: 1 1 auto; width: 100%; }
input[type=number] { width: 52px; }
input.cp-color { width: 26px; height: 20px; padding: 0; border: 1px solid #222; background: none; }
button {
  background: #333; color: #ccc; border: 1px solid #222; border-radius: 3px;
  font-size: 11px; padding: 2px 7px; cursor: pointer; flex: 0 0 auto;
}
button:hover { background: #3d3d3d; color: #fff; }
button.on { background: #0e639c; color: #fff; border-color: #0e639c; }
button.cp-apply { flex: 1 1 auto; }
</style>
