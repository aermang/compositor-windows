<!-- 段落面板(活字排版):对齐(left/center/right)、行距、段落框
     (boxSize null ↔ [w,h],开启后文本在框宽内自动换行)。
     改动即时 upsertTextBitmap 并入历史(可 Ctrl+Z)。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { store, upsertTextBitmap, history, findLayer } from '../core/store';
import type { Layer, TextMeta } from '../core/types';

const isText = computed(() => !!store.doc?.layers.some(
  l => l.id === store.doc?.activeLayerId && l.text,
));
const meta = computed<TextMeta | null>(() =>
  store.doc?.layers.find(l => l.id === store.doc?.activeLayerId)?.text ?? null);

// ---------- 面板控件状态 ----------
const align = ref<'left' | 'center' | 'right'>('left');
const lineSpacing = ref(24);
const boxed = ref(false);
const boxW = ref(200);
const boxH = ref(100);

// 面板值初始化自活动层;切层/历史跳转(tick)后刷新
function refresh() {
  const t = meta.value;
  if (!t) return;
  align.value = t.align;
  lineSpacing.value = t.lineSpacing;
  boxed.value = t.boxSize != null;
  if (t.boxSize) {
    boxW.value = Math.round(t.boxSize[0]);
    boxH.value = Math.round(t.boxSize[1]);
  }
}
watch(() => [store.doc?.activeLayerId, store.tick], refresh, { immediate: true });

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

function setAlign(a: 'left' | 'center' | 'right') {
  const t = meta.value;
  if (!t || t.align === a) return;
  commitMeta({ ...cloneMeta(t), align: a }, '段落对齐');
}
function onLineSpacing() {
  const t = meta.value;
  const v = num(lineSpacing.value);
  if (t && v > 0) commitMeta({ ...cloneMeta(t), lineSpacing: v }, '段落行距');
}
function onBoxToggle() {
  const t = meta.value;
  if (!t) return;
  const next = cloneMeta(t);
  next.boxSize = boxed.value
    ? [Math.max(8, num(boxW.value)), Math.max(8, num(boxH.value))]
    : null;
  commitMeta(next, boxed.value ? '开启段落框' : '关闭段落框');
}
function onBoxSize() {
  const t = meta.value;
  if (!t || !t.boxSize) return;
  const next = cloneMeta(t);
  next.boxSize = [Math.max(8, num(boxW.value)), Math.max(8, num(boxH.value))];
  commitMeta(next, '段落框尺寸');
}
</script>

<template>
  <div class="panel para-panel" v-if="!store.canvasOnly" :class="{ off: !isText }">
    <div class="panel-title">段落</div>
    <!-- 非文本层时收起主体(同字符面板:避免右栏定高布局下挤压溢出)。 -->
    <fieldset class="pp-body" v-show="isText" :disabled="!isText">
      <div class="row">
        <button
          class="pp-align-left" :class="{ on: align === 'left' }"
          title="左对齐" @click="setAlign('left')"
        >⇤</button>
        <button
          class="pp-align-center" :class="{ on: align === 'center' }"
          title="居中对齐" @click="setAlign('center')"
        >⇔</button>
        <button
          class="pp-align-right" :class="{ on: align === 'right' }"
          title="右对齐" @click="setAlign('right')"
        >⇥</button>
      </div>
      <div class="row">
        <label class="lbl">行距</label>
        <input class="pp-lines" v-model.number="lineSpacing" type="number" min="1" step="1" title="行距(px)" @change="onLineSpacing" />
      </div>
      <div class="row">
        <label class="pp-box-row"><input class="pp-box" v-model="boxed" type="checkbox" title="段落框(自动换行)" @change="onBoxToggle" /> 段落框</label>
        <label class="lbl">宽</label>
        <input class="pp-w" v-model.number="boxW" type="number" min="8" step="1" title="段落框宽(px)" @change="onBoxSize" />
        <label class="lbl">高</label>
        <input class="pp-h" v-model.number="boxH" type="number" min="8" step="1" title="段落框高(px)" @change="onBoxSize" />
      </div>
    </fieldset>
  </div>
</template>

<style scoped>
.panel { border-top: 1px solid #111; padding: 6px 8px; }
.panel-title { color: #bbb; font-size: 12px; margin-bottom: 4px; }
.hint { color: #666; font-size: 11px; }
.para-panel.off { opacity: 0.45; }
.pp-body { border: none; margin: 0; padding: 0; min-width: 0; }
.row { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
.lbl { color: #888; font-size: 11px; flex: 0 0 auto; }
.pp-box-row { display: flex; align-items: center; gap: 4px; color: #bbb; font-size: 11px; flex: 0 0 auto; }
input[type=number] {
  background: #2b2b2b; color: #ddd; border: 1px solid #222;
  border-radius: 3px; font-size: 11px; padding: 1px 3px; width: 52px; min-width: 0;
}
input[type=checkbox] { accent-color: #0e639c; }
button {
  background: #333; color: #ccc; border: 1px solid #222; border-radius: 3px;
  font-size: 11px; padding: 2px 8px; cursor: pointer;
}
button:hover { background: #3d3d3d; color: #fff; }
button.on { background: #0e639c; color: #fff; border-color: #0e639c; }
</style>
