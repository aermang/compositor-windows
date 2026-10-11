<script setup lang="ts">
// Right-bottom panel: per-kind editors for the active adjustment layer
// (with a live histogram and an interactive Curves editor), layer effects
// summary, and transform readout/edit for raster layers.

import { ref, computed, watch, onMounted } from 'vue';
import { store, activeLayer, history } from '../core/store';
import { runCommand } from '../commands';
import { ctx2dRead, clamp } from '../core/canvasUtils';
import { histogram } from '../core/pixels/adjust';
import { autoLevelsEndpoints } from '../core/pixels/autoLevels';
import type { AutoLevelsMode, AutoLevelsResult } from '../core/pixels/autoLevels';
import { defaultEffects, rgbToCss } from '../core/types';
import type { CurvePoint, EffectsData, Layer } from '../core/types';
import { ADJUSTMENT_ZH, EFFECT_ZH } from '../core/labels';

const layer = activeLayer;
const adj = computed(() => layer.value?.adjustment ?? null);

// live histogram of the flattened doc below the adjustment
const hist = ref<{ rgb: Uint32Array; luma: Uint32Array } | null>(null);
const histTick = ref(0);
watch(() => store.tick, () => { histTick.value++; loadHistogram(); });

/** 直方图/自动色阶共用的取样画布:调节层之下最底部可见位图,长边缩到 ≤512。 */
function histSourceCanvas(): HTMLCanvasElement | null {
  const doc = store.doc;
  if (!doc || !adj.value) return null;
  const below = doc.layers.slice(0, doc.layers.findIndex(l => l.id === layer.value?.id));
  // cheap source: bottom-most visible bitmap
  let src: HTMLCanvasElement | null = null;
  for (const l of below) {
    if (l.isVisible && l.bitmap) { src = l.bitmap; break; }
  }
  if (!src) return null;
  if (src.width <= 512 && src.height <= 512) return src;
  const s = Math.min(512 / src.width, 512 / src.height);
  const oc = document.createElement('canvas');
  oc.width = Math.max(1, Math.round(src.width * s));
  oc.height = Math.max(1, Math.round(src.height * s));
  oc.getContext('2d')!.drawImage(src, 0, 0, oc.width, oc.height);
  return oc;
}

function loadHistogram() {
  const c = histSourceCanvas();
  if (!c) { hist.value = null; return; }
  const data = ctx2dRead(c).getImageData(0, 0, c.width, c.height).data;
  hist.value = histogram(data);
}

onMounted(loadHistogram);

// push one history entry per slider interaction
let pendingLabel: string | null = null;
let pendingBefore = '';

function beginEdit(label: string) {
  if (pendingLabel !== label) {
    commitEdit();
    pendingLabel = label;
    pendingBefore = JSON.stringify(adj.value ?? {});
  }
}
function commitEdit() {
  if (!pendingLabel || !layer.value) { pendingLabel = null; return; }
  const before = JSON.parse(pendingBefore);
  const after = JSON.parse(JSON.stringify(adj.value ?? {}));
  const target = layer.value;
  const apply = (v: unknown) => { if (target.adjustment) Object.assign(target.adjustment, v); store.tick++; };
  history.push({
    label: pendingLabel,
    undo: () => apply(before),
    redo: () => apply(after),
  });
  store.dirty = true;
  pendingLabel = null;
}

function touch(label: string) {
  // slider input: begin on first change; commit on change end via commitEdit binding
  beginEdit(label);
  store.tick++;
}

/** 自动色阶:用调节层之下的直方图取样源计算端点,写入调节层自身 Levels 数据。
 *  contrast 只写 RGB 复合槽 ranges[0];color/colorNeutral 逐通道写 ranges[1..3]
 *  (colorNeutral 再写各通道伽马)。渲染端先套 RGB 槽再叠加通道槽,与 Photoshop 语义一致。 */
function autoLevels(mode: AutoLevelsMode) {
  const a = adj.value;
  if (!a || a.kind !== 'Levels') return;
  const src = histSourceCanvas();
  if (!src) return;
  let res: AutoLevelsResult | null = null;
  try {
    res = autoLevelsEndpoints(ctx2dRead(src).getImageData(0, 0, src.width, src.height), mode);
  } catch { /* 空图等:放弃 */ }
  if (!res) return;
  beginEdit('自动色阶');
  const r = a.levels.ranges;
  r[0].black = res.rgb.black;
  r[0].white = res.rgb.white;
  if (mode !== 'contrast') {
    for (let c = 0; c < 3; c++) {
      r[c + 1].black = res.channels[c].black;
      r[c + 1].white = res.channels[c].white;
      if (mode === 'colorNeutral') r[c + 1].gamma = res.gammas[c];
    }
  }
  store.tick++;
  commitEdit();
}

const curveChannelIdx = { RGB: 0, Red: 1, Green: 2, Blue: 3 } as const;

/** The Levels range being edited (RGB shares slot 0 with the per-channel ranges). */
const levelsRange = computed(() => {
  const a = adj.value;
  if (!a) return null;
  return a.levels.ranges[curveChannelIdx[a.levels.channel]];
});

/** SVG path for the small Levels histogram. */
const levelsHistPath = computed(() => {
  const h = hist.value;
  if (!h) return '';
  const data = h.rgb;
  const max = Math.max(...data, 1);
  const pts: string[] = [];
  for (let i = 0; i < 256; i++) {
    const v = Math.min(60, data[i] / max * 60);
    pts.push(`${i},${60 - v}`);
  }
  return `M0,60 L${pts.join(' L')} L255,60`;
});

function hexToRgb01(hex: string): [number, number, number] {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

// ---------- Curves editor ----------

const curvesCanvas = ref<HTMLCanvasElement | null>(null);
const draggingPoint = ref<number | null>(null);

function curvePoints(): CurvePoint[] {
  const a = adj.value;
  if (!a) return [];
  return a.curves.channels[curveChannelIdx[a.curves.channel]];
}

watch(() => [adj.value?.curves.channel, store.uiTick], () => scheduleCurvesDraw());
watch(() => store.tick, () => {
  // redraw when points change from elsewhere (undo)
  scheduleCurvesDraw();
});
watch(histTick, () => scheduleCurvesDraw());

let curvesRaf = 0;
function scheduleCurvesDraw() {
  if (curvesRaf) return;
  curvesRaf = requestAnimationFrame(() => { curvesRaf = 0; drawCurves(); });
}

function drawCurves() {
  const canvas = curvesCanvas.value;
  const a = adj.value;
  if (!canvas || !a) return;
  const cx = canvas.getContext('2d')!;
  const S = canvas.width;
  cx.clearRect(0, 0, S, S);
  cx.fillStyle = '#1b1b1b';
  cx.fillRect(0, 0, S, S);

  // histogram (luma for RGB, combined channel counts otherwise) behind
  const ch = curveChannelIdx[a.curves.channel];
  const h = hist.value;
  if (h) {
    const data = ch === 0 ? h.luma : h.rgb;
    const max = Math.max(...data, 1);
    cx.fillStyle = 'rgba(255,255,255,0.14)';
    for (let x = 0; x < 256; x++) {
      const v = data[x] / max;
      cx.fillRect(x / 256 * S, S - v * S, S / 256, v * S);
    }
  }

  // grid
  cx.strokeStyle = 'rgba(255,255,255,0.08)';
  cx.beginPath();
  for (let i = 1; i < 4; i++) {
    cx.moveTo(i * S / 4, 0); cx.lineTo(i * S / 4, S);
    cx.moveTo(0, i * S / 4); cx.lineTo(S, i * S / 4);
  }
  cx.stroke();

  // the curve through the points (same monotone spline as the renderer)
  const pts = curvePoints();
  cx.strokeStyle = '#4da3ff';
  cx.lineWidth = 1.5;
  cx.beginPath();
  const ys = curveSamples(pts);
  for (let x = 0; x < 256; x++) {
    const y = ys[x];
    const px = x / 255 * S, py = S - y / 255 * S;
    if (x === 0) cx.moveTo(px, py); else cx.lineTo(px, py);
  }
  cx.stroke();

  // handles
  cx.fillStyle = '#fff';
  for (const p of pts) {
    cx.beginPath();
    cx.arc(p.x / 255 * S, S - p.y / 255 * S, 4, 0, Math.PI * 2);
    cx.fill();
  }
  cx.strokeStyle = '#000';
  cx.lineWidth = 1;
  for (const p of pts) {
    cx.beginPath();
    cx.arc(p.x / 255 * S, S - p.y / 255 * S, 4, 0, Math.PI * 2);
    cx.stroke();
  }
}

/** Sample the spline at every x — mirrors adjust.ts so the preview matches. */
function curveSamples(pts: CurvePoint[]): Uint8Array {
  const out = new Uint8Array(256);
  const P = [...pts].sort((a, b) => a.x - b.x);
  if (P.length < 2) {
    for (let x = 0; x < 256; x++) out[x] = clamp(P[0]?.y ?? x, 0, 255);
    return out;
  }
  // Fritsch–Carlson tangents (same as the C port)
  const n = P.length;
  const d: number[] = [], m: number[] = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((P[i + 1].y - P[i].y) / Math.max(1e-6, P[i + 1].x - P[i].x));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  let seg = 0;
  for (let x = 0; x < 256; x++) {
    while (seg < n - 2 && x > P[seg + 1].x) seg++;
    const h = P[seg + 1].x - P[seg].x || 1;
    const t = clamp((x - P[seg].x) / h, 0, 1);
    const t2 = t * t, t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * P[seg].y + (t3 - 2 * t2 + t) * h * m[seg]
      + (-2 * t3 + 3 * t2) * P[seg + 1].y + (t3 - t2) * h * m[seg + 1];
    out[x] = clamp(y, 0, 255);
  }
  return out;
}

function curvesPointer(e: PointerEvent) {
  const canvas = curvesCanvas.value;
  const a = adj.value;
  if (!canvas || !a) return;
  const r = canvas.getBoundingClientRect();
  const x = Math.round(clamp((e.clientX - r.left) / r.width, 0, 1) * 255);
  const y = Math.round(clamp(1 - (e.clientY - r.top) / r.height, 0, 1) * 255);
  const pts = a.curves.channels[curveChannelIdx[a.curves.channel]];
  if (e.type === 'pointerdown') {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    beginEdit('Curves');
    const hit = pts.findIndex(p => Math.abs(p.x - x) < 10 && Math.abs(p.y - y) < 14);
    if (hit >= 0) {
      draggingPoint.value = hit;
    } else {
      const insert = pts.findIndex(p => p.x > x);
      const idx = insert < 0 ? pts.length : insert;
      pts.splice(idx, 0, { x, y });
      draggingPoint.value = idx;
    }
  } else if (e.type === 'pointermove' && draggingPoint.value != null) {
    const i = draggingPoint.value;
    const minX = i === 0 ? 0 : pts[i - 1].x + 1;
    const maxX = i === pts.length - 1 ? 255 : pts[i + 1].x - 1;
    pts[i].x = clamp(x, minX, maxX);
    pts[i].y = y;
  } else if (e.type === 'pointerup') {
    draggingPoint.value = null;
    commitEdit();
  }
  store.tick++;
  scheduleCurvesDraw();
}

function removeCurvePoint(e: MouseEvent) {
  const a = adj.value;
  if (!a) return;
  const canvas = curvesCanvas.value!;
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width * 255;
  const y = 255 - (e.clientY - r.top) / r.height * 255;
  const pts = a.curves.channels[curveChannelIdx[a.curves.channel]];
  const hit = pts.findIndex(p => Math.abs(p.x - x) < 8 && Math.abs(p.y - y) < 10);
  if (hit > 0 && hit < pts.length - 1) {  // endpoints stay
    pts.splice(hit, 1);
    store.tick++;
    scheduleCurvesDraw();
  }
}

// ---------- effects (summary + quick toggles; full editor is the fx dialog) ----------

function toggleFx(kind: keyof EffectsData) {
  const l = layer.value as Layer | null;
  if (!l) return;
  if (!l.effects) l.effects = {};
  const cur = (l.effects[kind] ?? defaultEffects(kind)) as { enabled: boolean };
  if (!l.effects[kind]) {
    l.effects[kind] = { ...defaultEffects(kind), enabled: true } as never;
  } else {
    (l.effects[kind] as { enabled: boolean }).enabled = !cur.enabled;
  }
  store.dirty = true;
  store.tick++;
}

const FX_LABELS: Record<keyof EffectsData, string> = EFFECT_ZH;

// Chinese display labels for the Black & White channel weights
const BW_LABELS = {
  reds: '红色', yellows: '黄色', greens: '绿色',
  cyans: '青色', blues: '蓝色', magentas: '洋红',
} as const;

// ---------- transform ----------

function setTransform(key: 'x' | 'y' | 'w' | 'h' | 'rot', e: Event) {
  const l = layer.value;
  if (!l) return;
  const v = Number((e.target as HTMLInputElement).value);
  const before = { ...l.transform, origin: [...l.transform.origin] as [number, number], size: [...l.transform.size] as [number, number] };
  const after = { ...before, origin: [...before.origin] as [number, number], size: [...before.size] as [number, number] };
  if (key === 'x') after.origin[0] = v;
  if (key === 'y') after.origin[1] = v;
  if (key === 'w') after.size[0] = v;
  if (key === 'h') after.size[1] = v;
  if (key === 'rot') after.rotation = v;
  l.transform = after;
  history.push({
    label: 'Transform',
    undo: () => { l.transform = before; store.tick++; },
    redo: () => { l.transform = after; store.tick++; },
  });
  store.dirty = true;
  store.tick++;
}
</script>

<template>
  <div class="props-panel">
    <!-- adjustment editor -->
    <template v-if="adj">
      <div class="section-title">{{ ADJUSTMENT_ZH[adj.kind] }}</div>

      <!-- Hue/Saturation -->
      <template v-if="adj.kind === 'Hue/Saturation'">
        <label class="row">色相
          <input type="range" min="-180" max="180" v-model.number="adj.hueSat.hue" @input="touch('Hue/Saturation')" @change="commitEdit()" />
          <span class="v">{{ adj.hueSat.hue }}</span>
        </label>
        <label class="row">饱和度
          <input type="range" min="-100" max="100" v-model.number="adj.hueSat.saturation" @input="touch('Hue/Saturation')" @change="commitEdit()" />
          <span class="v">{{ adj.hueSat.saturation }}</span>
        </label>
        <label class="row">明度
          <input type="range" min="-100" max="100" v-model.number="adj.hueSat.lightness" @input="touch('Hue/Saturation')" @change="commitEdit()" />
          <span class="v">{{ adj.hueSat.lightness }}</span>
        </label>
        <label class="check"><input type="checkbox" v-model="adj.hueSat.colorize" @change="touch('Hue/Saturation'); commitEdit()" /> 色彩化</label>
        <template v-if="adj.hueSat.colorize">
          <label class="row">色彩化色相
            <input type="range" min="0" max="360" v-model.number="adj.hueSat.colorizeHue" @input="touch('Hue/Saturation')" @change="commitEdit()" />
            <span class="v">{{ adj.hueSat.colorizeHue }}°</span>
          </label>
          <label class="row">色彩化饱和度
            <input type="range" min="0" max="100" v-model.number="adj.hueSat.colorizeSat" @input="touch('Hue/Saturation')" @change="commitEdit()" />
            <span class="v">{{ adj.hueSat.colorizeSat }}</span>
          </label>
        </template>
      </template>

      <!-- Levels -->
      <template v-else-if="adj.kind === 'Levels' && levelsRange">
        <select class="select" v-model="adj.levels.channel">
          <option value="RGB">RGB</option><option value="Red">红</option><option value="Green">绿</option><option value="Blue">蓝</option>
        </select>
        <div class="histogram-small">
          <svg viewBox="0 0 256 60" preserveAspectRatio="none">
            <path v-if="levelsHistPath" :d="levelsHistPath" fill="rgba(255,255,255,0.25)" />
          </svg>
        </div>
        <label class="row">黑场
          <input type="range" min="0" max="254" v-model.number="levelsRange.black" @input="touch('Levels')" @change="commitEdit()" />
          <span class="v">{{ levelsRange.black }}</span>
        </label>
        <label class="row">灰场(伽马)
          <input type="range" min="0.1" max="3" step="0.01" v-model.number="levelsRange.gamma" @input="touch('Levels')" @change="commitEdit()" />
          <span class="v">{{ levelsRange.gamma.toFixed(2) }}</span>
        </label>
        <label class="row">白场
          <input type="range" min="1" max="255" v-model.number="levelsRange.white" @input="touch('Levels')" @change="commitEdit()" />
          <span class="v">{{ levelsRange.white }}</span>
        </label>
        <div class="btn-row">
          <button class="btn" title="按 RGB 复合直方图自动黑白场" @click="autoLevels('contrast')">自动(对比度)</button>
          <button class="btn" title="逐通道自动黑白场" @click="autoLevels('color')">自动(颜色)</button>
          <button class="btn" title="逐通道黑白场 + 中性灰伽马" @click="autoLevels('colorNeutral')">自动(颜色+中性)</button>
        </div>
      </template>

      <!-- Curves -->
      <template v-else-if="adj.kind === 'Curves'">
        <select class="select" v-model="adj.curves.channel" @change="scheduleCurvesDraw">
          <option value="RGB">RGB</option><option value="Red">红</option><option value="Green">绿</option><option value="Blue">蓝</option>
        </select>
        <canvas
          ref="curvesCanvas"
          class="curves"
          width="220" height="220"
          @pointerdown="curvesPointer"
          @pointermove="curvesPointer"
          @pointerup="curvesPointer"
          @dblclick="removeCurvePoint"
        ></canvas>
        <div class="hint">单击添加点 · 拖动塑形 · 双击删除点</div>
      </template>

      <!-- Exposure -->
      <template v-else-if="adj.kind === 'Exposure'">
        <label class="row">曝光
          <input type="range" min="-4" max="4" step="0.05" v-model.number="adj.exposure.exposure" @input="touch('Exposure')" @change="commitEdit()" />
          <span class="v">{{ adj.exposure.exposure.toFixed(2) }}</span>
        </label>
        <label class="row">位移
          <input type="range" min="-0.5" max="0.5" step="0.01" v-model.number="adj.exposure.offset" @input="touch('Exposure')" @change="commitEdit()" />
          <span class="v">{{ adj.exposure.offset.toFixed(2) }}</span>
        </label>
        <label class="row">灰度系数
          <input type="range" min="0.1" max="3" step="0.01" v-model.number="adj.exposure.gamma" @input="touch('Exposure')" @change="commitEdit()" />
          <span class="v">{{ adj.exposure.gamma.toFixed(2) }}</span>
        </label>
      </template>

      <!-- Gradient Map -->
      <template v-else-if="adj.kind === 'Gradient Map'">
        <label class="row">阴影
          <input type="color" :value="rgbToCss(adj.gradientMap.shadows)"
            @input="adj.gradientMap.shadows = hexToRgb01(($event.target as HTMLInputElement).value); touch('Gradient Map')"
            @change="commitEdit()" />
        </label>
        <label class="row">高光
          <input type="color" :value="rgbToCss(adj.gradientMap.highlights)"
            @input="adj.gradientMap.highlights = hexToRgb01(($event.target as HTMLInputElement).value); touch('Gradient Map')"
            @change="commitEdit()" />
        </label>
        <label class="check"><input type="checkbox" v-model="adj.gradientMap.reversed" @change="touch('Gradient Map'); commitEdit()" /> 反转</label>
      </template>

      <!-- Grain -->
      <template v-else-if="adj.kind === 'Grain'">
        <label class="row">数量
          <input type="range" min="0" max="100" v-model.number="adj.grain.amount" @input="touch('Grain')" @change="commitEdit()" />
          <span class="v">{{ adj.grain.amount }}</span>
        </label>
        <label class="row">大小
          <input type="range" min="0.5" max="8" step="0.1" v-model.number="adj.grain.size" @input="touch('Grain')" @change="commitEdit()" />
          <span class="v">{{ adj.grain.size.toFixed(1) }}</span>
        </label>
        <label class="row">粗糙度
          <input type="range" min="0" max="100" v-model.number="adj.grain.roughness" @input="touch('Grain')" @change="commitEdit()" />
          <span class="v">{{ adj.grain.roughness }}</span>
        </label>
        <button class="btn" @click="adj.grain.seed = (Math.random() * 4294967295) >>> 0; store.tick++">重新播种</button>
      </template>

      <!-- Black & White -->
      <template v-else-if="adj.kind === 'Black & White'">
        <label v-for="k of (['reds','yellows','greens','cyans','blues','magentas'] as const)" :key="k" class="row">{{ BW_LABELS[k] }}
          <input type="range" min="0" max="100" v-model.number="adj.blackWhite[k]" @input="touch('B&W')" @change="commitEdit()" />
          <span class="v">{{ adj.blackWhite[k] }}</span>
        </label>
      </template>

      <!-- Color Balance -->
      <template v-else-if="adj.kind === 'Color Balance'">
        <div class="sub-title">阴影</div>
        <label class="row">青色–红色<input type="range" min="-100" max="100" v-model.number="adj.colorBalance.shadowCyanRed" @input="touch('Color Balance')" @change="commitEdit()" /><span class="v">{{ adj.colorBalance.shadowCyanRed }}</span></label>
        <label class="row">洋红–绿色<input type="range" min="-100" max="100" v-model.number="adj.colorBalance.shadowMagentaGreen" @input="touch('Color Balance')" @change="commitEdit()" /><span class="v">{{ adj.colorBalance.shadowMagentaGreen }}</span></label>
        <label class="row">黄色–蓝色<input type="range" min="-100" max="100" v-model.number="adj.colorBalance.shadowYellowBlue" @input="touch('Color Balance')" @change="commitEdit()" /><span class="v">{{ adj.colorBalance.shadowYellowBlue }}</span></label>
        <div class="sub-title">中间调</div>
        <label class="row">青色–红色<input type="range" min="-100" max="100" v-model.number="adj.colorBalance.midCyanRed" @input="touch('Color Balance')" @change="commitEdit()" /><span class="v">{{ adj.colorBalance.midCyanRed }}</span></label>
        <label class="row">洋红–绿色<input type="range" min="-100" max="100" v-model.number="adj.colorBalance.midMagentaGreen" @input="touch('Color Balance')" @change="commitEdit()" /><span class="v">{{ adj.colorBalance.midMagentaGreen }}</span></label>
        <label class="row">黄色–蓝色<input type="range" min="-100" max="100" v-model.number="adj.colorBalance.midYellowBlue" @input="touch('Color Balance')" @change="commitEdit()" /><span class="v">{{ adj.colorBalance.midYellowBlue }}</span></label>
        <div class="sub-title">高亮</div>
        <label class="row">青色–红色<input type="range" min="-100" max="100" v-model.number="adj.colorBalance.highlightCyanRed" @input="touch('Color Balance')" @change="commitEdit()" /><span class="v">{{ adj.colorBalance.highlightCyanRed }}</span></label>
        <label class="row">洋红–绿色<input type="range" min="-100" max="100" v-model.number="adj.colorBalance.highlightMagentaGreen" @input="touch('Color Balance')" @change="commitEdit()" /><span class="v">{{ adj.colorBalance.highlightMagentaGreen }}</span></label>
        <label class="row">黄色–蓝色<input type="range" min="-100" max="100" v-model.number="adj.colorBalance.highlightYellowBlue" @input="touch('Color Balance')" @change="commitEdit()" /><span class="v">{{ adj.colorBalance.highlightYellowBlue }}</span></label>
        <label class="check"><input type="checkbox" v-model="adj.colorBalance.preserveLuminosity" @change="touch('Color Balance'); commitEdit()" /> 保持明度</label>
      </template>

      <!-- Gaussian Blur -->
      <template v-else-if="adj.kind === 'Gaussian Blur'">
        <label class="row">半径
          <input type="range" min="0" max="120" step="0.5" v-model.number="adj.blurRadius" @input="touch('Gaussian Blur')" @change="commitEdit()" />
          <span class="v">{{ adj.blurRadius.toFixed(1) }} px</span>
        </label>
      </template>

      <!-- Motion Blur -->
      <template v-else-if="adj.kind === 'Motion Blur'">
        <label class="row">角度
          <input type="range" min="-90" max="90" v-model.number="adj.motionAngle" @input="touch('Motion Blur')" @change="commitEdit()" />
          <span class="v">{{ adj.motionAngle }}°</span>
        </label>
        <label class="row">距离
          <input type="range" min="1" max="200" v-model.number="adj.motionDistance" @input="touch('Motion Blur')" @change="commitEdit()" />
          <span class="v">{{ adj.motionDistance }} px</span>
        </label>
      </template>

      <!-- Add Noise -->
      <template v-else-if="adj.kind === 'Add Noise'">
        <label class="row">数量
          <input type="range" min="0" max="100" v-model.number="adj.noiseAmount" @input="touch('Add Noise')" @change="commitEdit()" />
          <span class="v">{{ adj.noiseAmount }}</span>
        </label>
        <label class="check"><input type="checkbox" v-model="adj.noiseGaussian" @change="touch('Add Noise'); commitEdit()" /> 高斯分布</label>
        <label class="check"><input type="checkbox" v-model="adj.noiseMonochromatic" @change="touch('Add Noise'); commitEdit()" /> 单色</label>
      </template>

      <!-- Invert: nothing to edit -->
      <div v-else-if="adj.kind === 'Invert'" class="hint">反转所有颜色，无参数。</div>
    </template>

    <!-- non-adjustment layer: effects + transform -->
    <template v-else-if="layer">
      <div class="section-title">图层效果</div>
      <div class="fx-grid">
        <label v-for="(label, kind) in FX_LABELS" :key="kind" class="check fx-toggle">
          <input
            type="checkbox"
            :checked="!!(layer.effects?.[kind as keyof EffectsData] as { enabled?: boolean } | undefined)?.enabled"
            @change="toggleFx(kind as keyof EffectsData)"
          /> {{ label }}
        </label>
      </div>
      <button class="btn" @click="store.dialog = 'effects'">图层效果设置…</button>

      <div class="section-title">变换</div>
      <div class="grid2" v-if="!layer.isGroup">
        <label class="field">X <input type="number" :value="Math.round(layer.transform.origin[0])" @change="setTransform('x', $event)" /></label>
        <label class="field">Y <input type="number" :value="Math.round(layer.transform.origin[1])" @change="setTransform('y', $event)" /></label>
        <label class="field">W <input type="number" :value="Math.round(layer.transform.size[0])" @change="setTransform('w', $event)" /></label>
        <label class="field">H <input type="number" :value="Math.round(layer.transform.size[1])" @change="setTransform('h', $event)" /></label>
        <label class="field wide">旋转 <input type="number" step="0.5" :value="layer.transform.rotation" @change="setTransform('rot', $event)" /></label>
      </div>
      <div class="btn-row">
        <button class="btn" title="水平翻转" @click="runCommand('layer.flipH')">水平翻转</button>
        <button class="btn" title="垂直翻转" @click="runCommand('layer.flipV')">垂直翻转</button>
      </div>
    </template>

    <div v-else class="hint">未选择图层</div>
  </div>
</template>

<style scoped>
.props-panel {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px;
  overflow-y: auto;
  flex: 1;
}
.section-title {
  font-size: 11px;
  font-weight: 700;
  color: #999;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-top: 4px;
}
.sub-title { font-size: 11px; color: #777; margin-top: 4px; }
.row { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #bbb; }
.row .v { min-width: 38px; text-align: right; color: #888; }
.row input[type='range'] { flex: 1; accent-color: #0e639c; min-width: 0; }
.check { display: flex; align-items: center; gap: 5px; font-size: 11px; color: #bbb; cursor: pointer; }
.hint { font-size: 11px; color: #666; }
.select {
  background: #333; color: #ddd; border: 1px solid #444;
  border-radius: 5px; padding: 3px 6px; font-size: 11px; width: fit-content;
}
.curves {
  width: 220px;
  height: 220px;
  border: 1px solid #000;
  border-radius: 4px;
  cursor: crosshair;
  touch-action: none;
}
.histogram-small {
  background: #1b1b1b;
  border: 1px solid #000;
  border-radius: 4px;
  height: 60px;
}
.histogram-small svg { width: 100%; height: 100%; display: block; }
.btn {
  background: #333; color: #ddd; border: 1px solid #444;
  border-radius: 5px; padding: 4px 10px; font-size: 11px; cursor: pointer;
}
.btn:hover { background: #3a3a3a; }
.btn-row { display: flex; gap: 6px; }
.fx-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.grid2 .wide { grid-column: 1 / -1; }
.field { display: flex; align-items: center; gap: 5px; font-size: 11px; color: #999; }
.field input {
  width: 56px; background: #333; color: #ddd; border: 1px solid #444;
  border-radius: 4px; padding: 2px 4px; font-size: 11px;
}
input[type='color'] {
  width: 34px; height: 20px; padding: 0; border: 1px solid #444;
  border-radius: 3px; background: none; cursor: pointer;
}
</style>
