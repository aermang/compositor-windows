<script setup lang="ts">
// Camera Raw 滤镜 — large Photoshop-style filter dialog.
//
// Rendered (standalone) whenever store.dialog === 'cameraRaw' via its own
// <Teleport to="body">. Source is the active layer bitmap; a pristine
// full-resolution ImageData snapshot is taken once per open and a downscaled
// (long edge ≤ 720px) preview copy drives every slider re-render (debounced
// ~80ms through applyCameraRaw with scale = previewW/origW so radii shrink).
// 确定 commits ONCE at full resolution via rasterEdit(); disabled (eye-off)
// sections are reset to defaults inside the settings copy handed to the engine.

import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { store, activeLayer, rasterEdit } from '../core/store';
import { makeCanvas, ctx2d, ctx2dRead } from '../core/canvasUtils';
import { histogram } from '../core/pixels/adjust';
import {
  applyCameraRaw, autoWhiteBalance, cameraRawIsIdentity,
  defaultCameraRawSettings, normalizeCameraRawSettings,
} from '../core/cameraRaw';
import type { CameraRawSettings, CameraRawPointCurvePoint } from '../core/cameraRaw';

// ---------- section registry (keys mirror CameraRawSettings top level) ----------

type SectionKey =
  | 'light' | 'color' | 'curve' | 'mixer' | 'grading' | 'effects'
  | 'detail' | 'optics' | 'geometry' | 'calibration';

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: 'light', label: '光线' },
  { key: 'color', label: '颜色' },
  { key: 'curve', label: '曲线' },
  { key: 'mixer', label: '颜色混合器' },
  { key: 'grading', label: '颜色分级' },
  { key: 'effects', label: '效果' },
  { key: 'detail', label: '细节' },
  { key: 'optics', label: '光学' },
  { key: 'geometry', label: '几何' },
  { key: 'calibration', label: '校准' },
];

const isOpen = computed(() => store.dialog === 'cameraRaw');
const layerName = computed(() => activeLayer.value?.name ?? '');
const previewInfo = ref('');

// working copy of the settings (fresh defaults each open); the object handed
// to the engine is rebuilt by effectiveSettings() with eye-off sections reset.
const settings = reactive<CameraRawSettings>(defaultCameraRawSettings());
const enabled = reactive<Record<SectionKey, boolean>>({
  light: true, color: true, curve: true, mixer: true, grading: true,
  effects: true, detail: true, optics: true, geometry: true, calibration: true,
});
const collapsed = reactive<Record<SectionKey, boolean>>({
  light: false, color: false, curve: false, mixer: true, grading: true,
  effects: true, detail: true, optics: true, geometry: true, calibration: true,
});

// huge buffers stay OUT of Vue's reactivity
let snapshotFull: ImageData | null = null; // pristine full-res snapshot, taken once
let previewSrc: ImageData | null = null;   // pristine downscaled preview source
let previewScale = 1;
const seed = ref(1); // fixed per open so preview grain == committed grain

const previewCanvas = ref<HTMLCanvasElement | null>(null);
const histCanvas = ref<HTMLCanvasElement | null>(null);
const curveCanvas = ref<HTMLCanvasElement | null>(null);

function fmt(v: number): string {
  return String(Math.round(v * 100) / 100);
}

function close() { store.dialog = null; store.dialogPayload = null; }

// ---------- open / close ----------

function open() {
  const layer = activeLayer.value;
  const bmp = layer?.bitmap;
  if (!layer || !bmp) { close(); return; }
  snapshotFull = ctx2dRead(bmp).getImageData(0, 0, bmp.width, bmp.height);

  const long = Math.max(bmp.width, bmp.height);
  const sc = long > 720 ? 720 / long : 1;
  const pw = Math.max(1, Math.round(bmp.width * sc));
  const ph = Math.max(1, Math.round(bmp.height * sc));
  const stage = makeCanvas(bmp.width, bmp.height);
  ctx2d(stage).putImageData(snapshotFull, 0, 0);
  const tmp = makeCanvas(pw, ph);
  const tc = ctx2d(tmp);
  tc.imageSmoothingEnabled = true;
  tc.imageSmoothingQuality = 'high';
  tc.drawImage(stage, 0, 0, pw, ph);
  previewSrc = ctx2dRead(tmp).getImageData(0, 0, pw, ph);
  previewScale = pw / bmp.width;
  previewInfo.value = `${bmp.width}×${bmp.height} · 预览 ${pw}×${ph} (${Math.round(previewScale * 100)}%)`;
  seed.value = 1 + Math.floor(Math.random() * 2147483646);

  // fresh state every open
  Object.assign(settings, defaultCameraRawSettings());
  for (const s of SECTIONS) { enabled[s.key] = true; }
  mixerSel.value = 0;
  wheelKey.value = 'shadows';
  curveChan.value = 'pointRgb';
  curveDrag = -1;

  const pc = previewCanvas.value;
  if (pc) { pc.width = pw; pc.height = ph; }
  window.addEventListener('keydown', onKey, true);
  renderPreview();
  drawCurve();
}

function teardown() {
  if (renderTimer) { window.clearTimeout(renderTimer); renderTimer = 0; }
  window.removeEventListener('keydown', onKey, true);
  snapshotFull = null;
  previewSrc = null;
}

function onKey(e: KeyboardEvent) {
  if (!isOpen.value) return;
  if (e.key === 'Escape') { e.preventDefault(); close(); }
}

watch(isOpen, v => { if (v) void nextTick(open); else teardown(); });
onMounted(() => { if (isOpen.value) void nextTick(open); });
onBeforeUnmount(teardown);

// ---------- effective settings (eye-off sections → defaults) ----------

function effectiveSettings(): CameraRawSettings {
  const n = normalizeCameraRawSettings(settings);
  const d = defaultCameraRawSettings();
  const nb = n as unknown as Record<string, unknown>;
  const db = d as unknown as Record<string, unknown>;
  for (const s of SECTIONS) if (!enabled[s.key]) nb[s.key] = db[s.key];
  return n;
}

// ---------- preview rendering (debounced) ----------

let renderTimer = 0;
function scheduleRender() {
  if (renderTimer) window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => { renderTimer = 0; renderPreview(); }, 80);
}
watch([settings, enabled], scheduleRender);

function renderPreview() {
  const src = previewSrc;
  const pc = previewCanvas.value;
  if (!src || !pc) return;
  const eff = effectiveSettings();
  const work = new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
  const out = applyCameraRaw(work, eff, seed.value, previewScale);
  if (out.width === pc.width && out.height === pc.height) {
    ctx2dRead(pc).putImageData(out, 0, 0);
  } else {
    // engine keeps output dims today; draw fit-scaled just in case
    const off = makeCanvas(out.width, out.height);
    ctx2d(off).putImageData(out, 0, 0);
    const cx = ctx2d(pc);
    cx.clearRect(0, 0, pc.width, pc.height);
    const s = Math.min(pc.width / out.width, pc.height / out.height);
    const dw = out.width * s, dh = out.height * s;
    cx.drawImage(off, (pc.width - dw) / 2, (pc.height - dh) / 2, dw, dh);
  }
  drawHist(out.data);
}

function drawHist(data: Uint8ClampedArray) {
  const hc = histCanvas.value;
  if (!hc) return;
  const cx = ctx2d(hc);
  const { luma } = histogram(data);
  cx.clearRect(0, 0, hc.width, hc.height);
  let max = 1;
  for (let i = 0; i < 256; i++) if (luma[i] > max) max = luma[i];
  cx.fillStyle = 'rgba(255,255,255,0.35)';
  const bw = hc.width / 256;
  for (let i = 0; i < 256; i++) {
    const v = luma[i] / max;
    if (v > 0) cx.fillRect(i * bw, hc.height * (1 - v), Math.ceil(bw), v * hc.height);
  }
}

// ---------- commit ----------

function onOk() {
  const layer = activeLayer.value;
  const bmp = layer?.bitmap;
  if (!layer || !bmp) { close(); return; }
  const eff = effectiveSettings();
  if (cameraRawIsIdentity(eff)) { close(); return; } // no-op → no history entry
  const sd = seed.value;
  rasterEdit(layer, 'Camera Raw 滤镜', b => {
    const ctx = ctx2dRead(b);
    const img = ctx.getImageData(0, 0, b.width, b.height);
    const out = applyCameraRaw(img, eff, sd, 1);
    if (out.width === b.width && out.height === b.height) {
      ctx.putImageData(out, 0, 0);
    } else {
      b.width = out.width;
      b.height = out.height;
      ctx2dRead(b).putImageData(out, 0, 0);
    }
  });
  close();
}

// ---------- 颜色: auto white balance ----------

function doAutoWB() {
  if (!previewSrc) return;
  const wb = autoWhiteBalance(previewSrc);
  settings.color.whiteBalance = 'custom';
  settings.color.temperature = wb.temperature;
  settings.color.tint = wb.tint;
}

function setWbMode(e: Event) {
  settings.color.whiteBalance = (e.target as HTMLSelectElement).value === 'auto' ? 'auto' : 'custom';
}
function setGlowStyle(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  settings.effects.glow.style = (v === 'bloom' || v === 'halation' ? v : 'diffusion');
}
function setVignetteStyle(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  settings.effects.vignette.style = (v === 'colorPriority' || v === 'paintOverlay' ? v : 'highlightPriority');
}

// ---------- 颜色混合器 (8 hue families, compact selector + 3 sliders) ----------

const MIXER_FAMILY_LABELS = ['红色', '橙色', '黄色', '绿色', '浅绿色', '蓝色', '紫色', '洋红'];
const mixerSel = ref(0);
const fam = computed(() => settings.mixer.families[mixerSel.value] ?? settings.mixer.families[0]);

// ---------- 颜色分级 (4 wheels, compact selector + hue/sat/lum + blending/balance) ----------

type WheelKey = 'shadows' | 'midtones' | 'highlights' | 'global';
const WHEELS: { key: WheelKey; label: string }[] = [
  { key: 'shadows', label: '阴影' },
  { key: 'midtones', label: '中间调' },
  { key: 'highlights', label: '高光' },
  { key: 'global', label: '全局' },
];
const wheelKey = ref<string>('shadows');
const wheel = computed(() => settings.grading[wheelKey.value as WheelKey]);
const wheelColor = computed(() => {
  const w = settings.grading[wheelKey.value as WheelKey];
  const sat = Math.max(10, w.saturation);
  const lig = 50 + w.luminance * 0.15;
  return `hsl(${Math.round(w.hue)}, ${Math.round(sat)}%, ${Math.round(lig)}%)`;
});

// ---------- 曲线: point curve mini editor (Fritsch–Carlson monotone cubic) ----------

type CurveChanKey = 'pointRgb' | 'pointRed' | 'pointGreen' | 'pointBlue';
const CURVE_CHAN_LABELS: { key: CurveChanKey; label: string }[] = [
  { key: 'pointRgb', label: 'RGB' },
  { key: 'pointRed', label: '红色' },
  { key: 'pointGreen', label: '绿色' },
  { key: 'pointBlue', label: '蓝色' },
];
const curveChan = ref<string>('pointRgb');
const CURVE_SIZE = 160;
const CURVE_DPR = 2;
let curveDrag = -1;

function curvePts(): CameraRawPointCurvePoint[] {
  return settings.curve[curveChan.value as CurveChanKey];
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** Fritsch–Carlson monotone cubic through sorted points (same idea as adjust.ts). */
function curveSpline(pts: CameraRawPointCurvePoint[]): (x: number) => number {
  const p = [...pts].sort((a, b) => a.x - b.x);
  const n = p.length;
  if (n === 1) { const y = p[0].y; return () => y; }
  const d: number[] = [];
  const m: number[] = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((p[i + 1].y - p[i].y) / Math.max(1e-6, p[i + 1].x - p[i].x));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x: number) => {
    if (x <= p[0].x) return p[0].y;
    if (x >= p[n - 1].x) return p[n - 1].y;
    let i = 0;
    while (i < n - 2 && x > p[i + 1].x) i++;
    const h = p[i + 1].x - p[i].x || 1e-6;
    const t = (x - p[i].x) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p[i].y + (t3 - 2 * t2 + t) * h * m[i]
      + (-2 * t3 + 3 * t2) * p[i + 1].y + (t3 - t2) * h * m[i + 1];
  };
}

function drawCurve() {
  const c = curveCanvas.value;
  if (!c) return;
  if (c.width !== CURVE_SIZE * CURVE_DPR) { c.width = CURVE_SIZE * CURVE_DPR; c.height = CURVE_SIZE * CURVE_DPR; }
  const cx = ctx2d(c);
  cx.setTransform(CURVE_DPR, 0, 0, CURVE_DPR, 0, 0);
  cx.fillStyle = '#1b1b1b';
  cx.fillRect(0, 0, CURVE_SIZE, CURVE_SIZE);
  cx.strokeStyle = 'rgba(255,255,255,0.08)';
  cx.lineWidth = 1;
  cx.beginPath();
  for (let i = 1; i < 4; i++) {
    cx.moveTo(i * CURVE_SIZE / 4, 0); cx.lineTo(i * CURVE_SIZE / 4, CURVE_SIZE);
    cx.moveTo(0, i * CURVE_SIZE / 4); cx.lineTo(CURVE_SIZE, i * CURVE_SIZE / 4);
  }
  cx.stroke();
  cx.strokeStyle = 'rgba(255,255,255,0.15)';
  cx.beginPath(); cx.moveTo(0, CURVE_SIZE); cx.lineTo(CURVE_SIZE, 0); cx.stroke();

  const pts = [...curvePts()].sort((a, b) => a.x - b.x);
  cx.strokeStyle = '#4da3ff';
  cx.lineWidth = 1.5;
  cx.beginPath();
  if (pts.length < 2) {
    cx.moveTo(0, CURVE_SIZE); cx.lineTo(CURVE_SIZE, 0);
  } else {
    const f = curveSpline(pts);
    for (let i = 0; i <= 100; i++) {
      const x = i / 100;
      const y = clamp01(f(x));
      const px = x * CURVE_SIZE, py = CURVE_SIZE - y * CURVE_SIZE;
      if (i === 0) cx.moveTo(px, py); else cx.lineTo(px, py);
    }
  }
  cx.stroke();
  for (const p of pts) {
    const px = p.x * CURVE_SIZE, py = CURVE_SIZE - p.y * CURVE_SIZE;
    cx.fillStyle = '#fff';
    cx.beginPath(); cx.arc(px, py, 3.5, 0, Math.PI * 2); cx.fill();
    cx.strokeStyle = '#000';
    cx.lineWidth = 1;
    cx.stroke();
  }
}

function curvePos(e: MouseEvent): { x: number; y: number } {
  const c = curveCanvas.value!;
  const r = c.getBoundingClientRect();
  return {
    x: clamp01((e.clientX - r.left) / r.width),
    y: clamp01(1 - (e.clientY - r.top) / r.height),
  };
}

function onCurvePointer(e: PointerEvent) {
  const pts = curvePts();
  const pos = curvePos(e);
  if (e.type === 'pointerdown') {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (pts.length === 0) pts.push({ x: 0, y: 0 }, { x: 1, y: 1 });
    const hit = pts.findIndex(p => Math.abs(p.x - pos.x) < 0.07 && Math.abs(p.y - pos.y) < 0.07);
    if (hit >= 0) {
      curveDrag = hit;
    } else {
      const at = pts.findIndex(p => p.x > pos.x);
      const idx = at < 0 ? pts.length : at;
      pts.splice(idx, 0, { x: pos.x, y: pos.y });
      curveDrag = idx;
    }
  } else if (e.type === 'pointermove' && curveDrag >= 0) {
    const i = curveDrag;
    if (i > 0 && i < pts.length - 1) {
      // interior points slide in x between their neighbours
      const minX = pts[i - 1].x + 0.004;
      const maxX = pts[i + 1].x - 0.004;
      pts[i].x = minX <= maxX ? clamp01(Math.min(maxX, Math.max(minX, pos.x))) : pts[i].x;
    }
    pts[i].y = pos.y; // endpoints locked in x, free in y
  } else if (e.type === 'pointerup' || e.type === 'pointercancel') {
    curveDrag = -1;
  }
  drawCurve();
}

function onCurveDblClick(e: MouseEvent) {
  const pts = curvePts();
  const pos = curvePos(e);
  const hit = pts.findIndex(p => Math.abs(p.x - pos.x) < 0.06 && Math.abs(p.y - pos.y) < 0.06);
  if (hit > 0 && hit < pts.length - 1) { // endpoints stay
    pts.splice(hit, 1);
    drawCurve();
  }
}

watch(curveChan, drawCurve);
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="veil">
      <div class="sheet" role="dialog" aria-label="Camera Raw 滤镜">
        <header class="head">
          <h3>Camera Raw 滤镜</h3>
          <span class="hint">{{ layerName }}</span>
        </header>

        <div class="body">
          <!-- left: histogram + preview -->
          <div class="left">
            <canvas ref="histCanvas" class="hist" width="512" height="44"></canvas>
            <div class="preview-wrap checker">
              <canvas ref="previewCanvas" class="preview"></canvas>
            </div>
          </div>

          <!-- right: scrollable sections -->
          <div class="right">
            <section v-for="s in SECTIONS" :key="s.key" class="sec">
              <header class="sec-head" @click="collapsed[s.key] = !collapsed[s.key]">
                <span class="tri" :class="{ closed: collapsed[s.key] }">▼</span>
                <span class="sec-title">{{ s.label }}</span>
                <button
                  type="button" class="eye" :class="{ off: !enabled[s.key] }"
                  :title="enabled[s.key] ? '停用此部分（不参与应用）' : '启用此部分'"
                  @click.stop="enabled[s.key] = !enabled[s.key]"
                >👁</button>
              </header>

              <div v-show="!collapsed[s.key]" class="sec-body" :class="{ dim: !enabled[s.key] }">
                <!-- 光线 -->
                <template v-if="s.key === 'light'">
                  <label class="row">曝光
                    <input type="range" min="-5" max="5" step="0.05" v-model.number="settings.light.exposure" />
                    <span class="v">{{ fmt(settings.light.exposure) }}</span>
                  </label>
                  <label class="row">对比度
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.light.contrast" />
                    <span class="v">{{ settings.light.contrast }}</span>
                  </label>
                  <label class="row">高光
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.light.highlights" />
                    <span class="v">{{ settings.light.highlights }}</span>
                  </label>
                  <label class="row">阴影
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.light.shadows" />
                    <span class="v">{{ settings.light.shadows }}</span>
                  </label>
                  <label class="row">白色
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.light.whites" />
                    <span class="v">{{ settings.light.whites }}</span>
                  </label>
                  <label class="row">黑色
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.light.blacks" />
                    <span class="v">{{ settings.light.blacks }}</span>
                  </label>
                </template>

                <!-- 颜色 -->
                <template v-else-if="s.key === 'color'">
                  <div class="inline">
                    <span class="mini">白平衡</span>
                    <select class="select" :value="settings.color.whiteBalance" @change="setWbMode">
                      <option value="custom">自定义</option>
                      <option value="auto">自动</option>
                    </select>
                    <button type="button" class="btn small" @click="doAutoWB">自动</button>
                  </div>
                  <div v-if="settings.color.whiteBalance === 'auto'" class="hint">自动模式根据图像自动计算色温/色调。</div>
                  <label class="row">色温
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.color.temperature" />
                    <span class="v">{{ settings.color.temperature }}</span>
                  </label>
                  <label class="row">色调
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.color.tint" />
                    <span class="v">{{ settings.color.tint }}</span>
                  </label>
                  <label class="row">自然饱和度
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.color.vibrance" />
                    <span class="v">{{ settings.color.vibrance }}</span>
                  </label>
                  <label class="row">饱和度
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.color.saturation" />
                    <span class="v">{{ settings.color.saturation }}</span>
                  </label>
                </template>

                <!-- 曲线 -->
                <template v-else-if="s.key === 'curve'">
                  <div class="subhead">参数</div>
                  <label class="row">高光
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.curve.highlights" />
                    <span class="v">{{ settings.curve.highlights }}</span>
                  </label>
                  <label class="row">亮调
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.curve.lights" />
                    <span class="v">{{ settings.curve.lights }}</span>
                  </label>
                  <label class="row">暗调
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.curve.darks" />
                    <span class="v">{{ settings.curve.darks }}</span>
                  </label>
                  <label class="row">阴影
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.curve.shadows" />
                    <span class="v">{{ settings.curve.shadows }}</span>
                  </label>
                  <div class="splits">
                    <span class="mini">分割点</span>
                    <label class="mini">阴影 <input type="number" min="5" max="90" step="1" v-model.number="settings.curve.shadowSplit" /></label>
                    <label class="mini">暗调 <input type="number" min="5" max="90" step="1" v-model.number="settings.curve.darkSplit" /></label>
                    <label class="mini">亮调 <input type="number" min="5" max="90" step="1" v-model.number="settings.curve.lightSplit" /></label>
                  </div>

                  <div class="subhead">点曲线</div>
                  <div class="curve-row">
                    <canvas
                      ref="curveCanvas" class="curve-canvas"
                      @pointerdown="onCurvePointer" @pointermove="onCurvePointer"
                      @pointerup="onCurvePointer" @pointercancel="onCurvePointer"
                      @dblclick="onCurveDblClick"
                    ></canvas>
                    <div class="curve-side">
                      <select class="select" v-model="curveChan">
                        <option v-for="c in CURVE_CHAN_LABELS" :key="c.key" :value="c.key">{{ c.label }}</option>
                      </select>
                      <div class="hint">点击添加点，拖动调整，双击删除（端点锁定）。</div>
                    </div>
                  </div>
                  <label class="row">优化饱和度
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.curve.refineSaturation" />
                    <span class="v">{{ settings.curve.refineSaturation }}</span>
                  </label>
                </template>

                <!-- 颜色混合器 -->
                <template v-else-if="s.key === 'mixer'">
                  <div class="inline">
                    <span class="mini">色系</span>
                    <select class="select" v-model.number="mixerSel">
                      <option v-for="(lbl, i) in MIXER_FAMILY_LABELS" :key="lbl" :value="i">{{ lbl }}</option>
                    </select>
                  </div>
                  <label class="row">色相
                    <input type="range" min="-100" max="100" step="1" v-model.number="fam.hue" />
                    <span class="v">{{ fam.hue }}</span>
                  </label>
                  <label class="row">饱和度
                    <input type="range" min="-100" max="100" step="1" v-model.number="fam.saturation" />
                    <span class="v">{{ fam.saturation }}</span>
                  </label>
                  <label class="row">明度
                    <input type="range" min="-100" max="100" step="1" v-model.number="fam.luminance" />
                    <span class="v">{{ fam.luminance }}</span>
                  </label>
                </template>

                <!-- 颜色分级 -->
                <template v-else-if="s.key === 'grading'">
                  <div class="inline">
                    <select class="select" v-model="wheelKey">
                      <option v-for="w in WHEELS" :key="w.key" :value="w.key">{{ w.label }}</option>
                    </select>
                    <span class="swatch" :style="{ background: wheelColor }"></span>
                  </div>
                  <label class="row">色相
                    <input type="range" min="0" max="360" step="1" v-model.number="wheel.hue" />
                    <span class="v">{{ wheel.hue }}°</span>
                  </label>
                  <label class="row">饱和度
                    <input type="range" min="0" max="100" step="1" v-model.number="wheel.saturation" />
                    <span class="v">{{ wheel.saturation }}</span>
                  </label>
                  <label class="row">明亮度
                    <input type="range" min="-100" max="100" step="1" v-model.number="wheel.luminance" />
                    <span class="v">{{ wheel.luminance }}</span>
                  </label>
                  <label class="row">混合
                    <input type="range" min="0" max="100" step="1" v-model.number="settings.grading.blending" />
                    <span class="v">{{ settings.grading.blending }}</span>
                  </label>
                  <label class="row">平衡
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.grading.balance" />
                    <span class="v">{{ settings.grading.balance }}</span>
                  </label>
                </template>

                <!-- 效果 -->
                <template v-else-if="s.key === 'effects'">
                  <label class="row">纹理
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.effects.texture" />
                    <span class="v">{{ settings.effects.texture }}</span>
                  </label>
                  <label class="row">清晰度
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.effects.clarity" />
                    <span class="v">{{ settings.effects.clarity }}</span>
                  </label>
                  <label class="row">去雾
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.effects.dehaze" />
                    <span class="v">{{ settings.effects.dehaze }}</span>
                  </label>

                  <div class="subhead">发光</div>
                  <label class="row">数量
                    <input type="range" min="0" max="100" step="1" v-model.number="settings.effects.glow.amount" />
                    <span class="v">{{ settings.effects.glow.amount }}</span>
                  </label>
                  <div class="inline">
                    <span class="mini">风格</span>
                    <select class="select" :value="settings.effects.glow.style" @change="setGlowStyle">
                      <option value="diffusion">扩散</option>
                      <option value="bloom">绽放</option>
                      <option value="halation">光晕</option>
                    </select>
                  </div>
                  <label class="row">范围
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.effects.glow.range" />
                    <span class="v">{{ settings.effects.glow.range }}</span>
                  </label>
                  <label class="row">扩散
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.effects.glow.spread" />
                    <span class="v">{{ settings.effects.glow.spread }}</span>
                  </label>
                  <label class="row">暖色
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.effects.glow.warmth" />
                    <span class="v">{{ settings.effects.glow.warmth }}</span>
                  </label>

                  <div class="subhead">晕影</div>
                  <label class="row">数量
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.effects.vignette.amount" />
                    <span class="v">{{ settings.effects.vignette.amount }}</span>
                  </label>
                  <div class="inline">
                    <span class="mini">风格</span>
                    <select class="select" :value="settings.effects.vignette.style" @change="setVignetteStyle">
                      <option value="highlightPriority">高光优先</option>
                      <option value="colorPriority">颜色优先</option>
                      <option value="paintOverlay">绘画叠加</option>
                    </select>
                  </div>
                  <label class="row">中点
                    <input type="range" min="0" max="100" step="1" v-model.number="settings.effects.vignette.midpoint" />
                    <span class="v">{{ settings.effects.vignette.midpoint }}</span>
                  </label>
                  <label class="row">圆角
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.effects.vignette.roundness" />
                    <span class="v">{{ settings.effects.vignette.roundness }}</span>
                  </label>
                  <label class="row">羽化
                    <input type="range" min="0" max="100" step="1" v-model.number="settings.effects.vignette.feather" />
                    <span class="v">{{ settings.effects.vignette.feather }}</span>
                  </label>
                  <label class="row">高光
                    <input type="range" min="0" max="100" step="1" v-model.number="settings.effects.vignette.highlights" />
                    <span class="v">{{ settings.effects.vignette.highlights }}</span>
                  </label>

                  <div class="subhead">颗粒</div>
                  <label class="row">数量
                    <input type="range" min="0" max="100" step="1" v-model.number="settings.effects.grain.amount" />
                    <span class="v">{{ settings.effects.grain.amount }}</span>
                  </label>
                  <label class="row">大小
                    <input type="range" min="0" max="100" step="1" v-model.number="settings.effects.grain.size" />
                    <span class="v">{{ settings.effects.grain.size }}</span>
                  </label>
                  <label class="row">粗糙度
                    <input type="range" min="0" max="100" step="1" v-model.number="settings.effects.grain.roughness" />
                    <span class="v">{{ settings.effects.grain.roughness }}</span>
                  </label>
                </template>

                <!-- 细节 -->
                <template v-else-if="s.key === 'detail'">
                  <div class="subhead">锐化</div>
                  <label class="row">数量
                    <input type="range" min="0" max="150" step="1" v-model.number="settings.detail.sharpen.amount" />
                    <span class="v">{{ settings.detail.sharpen.amount }}</span>
                  </label>
                  <label class="row">半径
                    <input type="range" min="0" max="100" step="1" v-model.number="settings.detail.sharpen.radius" />
                    <span class="v">{{ settings.detail.sharpen.radius }}</span>
                  </label>
                  <label class="row">细节
                    <input type="range" min="0" max="100" step="1" v-model.number="settings.detail.sharpen.detail" />
                    <span class="v">{{ settings.detail.sharpen.detail }}</span>
                  </label>
                  <label class="row">蒙版
                    <input type="range" min="0" max="100" step="1" v-model.number="settings.detail.sharpen.masking" />
                    <span class="v">{{ settings.detail.sharpen.masking }}</span>
                  </label>

                  <div class="subhead">降噪 · 明度</div>
                  <label class="row">明度
                    <input type="range" min="0" max="100" step="1" v-model.number="settings.detail.noiseLuminance.amount" />
                    <span class="v">{{ settings.detail.noiseLuminance.amount }}</span>
                  </label>
                  <label class="row">细节
                    <input type="range" min="0" max="100" step="1" v-model.number="settings.detail.noiseLuminance.detail" />
                    <span class="v">{{ settings.detail.noiseLuminance.detail }}</span>
                  </label>
                  <label class="row">对比度
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.detail.noiseLuminance.contrast" />
                    <span class="v">{{ settings.detail.noiseLuminance.contrast }}</span>
                  </label>

                  <div class="subhead">降噪 · 颜色</div>
                  <label class="row">颜色
                    <input type="range" min="0" max="100" step="1" v-model.number="settings.detail.noiseColor.amount" />
                    <span class="v">{{ settings.detail.noiseColor.amount }}</span>
                  </label>
                  <label class="row">细节
                    <input type="range" min="0" max="100" step="1" v-model.number="settings.detail.noiseColor.detail" />
                    <span class="v">{{ settings.detail.noiseColor.detail }}</span>
                  </label>
                  <label class="row">平滑度
                    <input type="range" min="0" max="100" step="1" v-model.number="settings.detail.noiseColor.smoothness" />
                    <span class="v">{{ settings.detail.noiseColor.smoothness }}</span>
                  </label>
                </template>

                <!-- 光学 -->
                <template v-else-if="s.key === 'optics'">
                  <label class="check"><input type="checkbox" v-model="settings.optics.removeCA" /> 消除色差</label>
                  <label class="row">畸变
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.optics.distortion" />
                    <span class="v">{{ settings.optics.distortion }}</span>
                  </label>
                  <label class="row">去紫边
                    <input type="range" min="0" max="100" step="1" v-model.number="settings.optics.defringePurple.amount" />
                    <span class="v">{{ settings.optics.defringePurple.amount }}</span>
                  </label>
                  <label class="row">去绿边
                    <input type="range" min="0" max="100" step="1" v-model.number="settings.optics.defringeGreen.amount" />
                    <span class="v">{{ settings.optics.defringeGreen.amount }}</span>
                  </label>
                  <div class="subhead">镜头晕影</div>
                  <label class="row">数量
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.optics.lensVignette.amount" />
                    <span class="v">{{ settings.optics.lensVignette.amount }}</span>
                  </label>
                  <label class="row">中点
                    <input type="range" min="0" max="100" step="1" v-model.number="settings.optics.lensVignette.midpoint" />
                    <span class="v">{{ settings.optics.lensVignette.midpoint }}</span>
                  </label>
                </template>

                <!-- 几何 -->
                <template v-else-if="s.key === 'geometry'">
                  <label class="row">垂直
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.geometry.vertical" />
                    <span class="v">{{ settings.geometry.vertical }}</span>
                  </label>
                  <label class="row">水平
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.geometry.horizontal" />
                    <span class="v">{{ settings.geometry.horizontal }}</span>
                  </label>
                  <label class="row">长宽比
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.geometry.aspect" />
                    <span class="v">{{ settings.geometry.aspect }}</span>
                  </label>
                  <label class="row">缩放
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.geometry.scale" />
                    <span class="v">{{ settings.geometry.scale }}</span>
                  </label>
                  <label class="row">偏移X
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.geometry.offsetX" />
                    <span class="v">{{ settings.geometry.offsetX }}</span>
                  </label>
                  <label class="row">偏移Y
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.geometry.offsetY" />
                    <span class="v">{{ settings.geometry.offsetY }}</span>
                  </label>
                  <label class="row">旋转
                    <input type="range" min="-45" max="45" step="0.1" v-model.number="settings.geometry.rotate" />
                    <span class="v">{{ fmt(settings.geometry.rotate) }}°</span>
                  </label>
                  <label class="check"><input type="checkbox" v-model="settings.geometry.constrainCrop" /> 约束裁剪</label>
                </template>

                <!-- 校准 -->
                <template v-else>
                  <div class="inline">
                    <span class="mini">流程版本</span>
                    <select class="select" v-model.number="settings.calibration.processVersion">
                      <option :value="1">1</option>
                      <option :value="2">2</option>
                      <option :value="3">3</option>
                      <option :value="4">4</option>
                      <option :value="5">5</option>
                      <option :value="6">6</option>
                    </select>
                  </div>
                  <label class="row">阴影色调
                    <input type="range" min="-100" max="100" step="1" v-model.number="settings.calibration.shadowTint" />
                    <span class="v">{{ settings.calibration.shadowTint }}</span>
                  </label>
                </template>
              </div>
            </section>
          </div>
        </div>

        <footer class="foot">
          <span class="hint">{{ previewInfo }}</span>
          <div class="actions">
            <button type="button" class="btn" @click="close">取消</button>
            <button type="button" class="btn primary" @click="onOk">确定</button>
          </div>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.veil {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
}
.sheet {
  display: flex;
  flex-direction: column;
  width: min(1180px, 94vw);
  height: min(840px, 90vh);
  background: #2b2b2b;
  border: 1px solid #000;
  border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
  color: #ddd;
  overflow: hidden;
}
.head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid #1c1c1c;
}
h3 { margin: 0; font-size: 14px; color: #fff; }
.body { flex: 1; display: flex; min-height: 0; }
.left { flex: 1; display: flex; flex-direction: column; padding: 12px; min-width: 0; }
.hist {
  width: 100%;
  height: 44px;
  background: #1b1b1b;
  border: 1px solid #1f1f1f;
  border-radius: 4px;
  margin-bottom: 10px;
}
.preview-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  overflow: hidden;
}
.checker {
  background-color: #262626;
  background-image:
    linear-gradient(45deg, #333 25%, transparent 25%),
    linear-gradient(-45deg, #333 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #333 75%),
    linear-gradient(-45deg, transparent 75%, #333 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}
.preview { max-width: 100%; max-height: 100%; }

.right {
  width: 340px;
  flex: none;
  overflow-y: auto;
  border-left: 1px solid #1c1c1c;
  padding: 4px 12px 16px;
}
.sec { border-bottom: 1px solid #333; padding: 2px 0 10px; }
.sec:last-child { border-bottom: none; }
.sec-head { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; padding: 6px 0; }
.tri { font-size: 9px; color: #888; transition: transform 0.15s; }
.tri.closed { transform: rotate(-90deg); }
.sec-title { flex: 1; font-size: 12px; font-weight: 700; color: #fff; }
.eye {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 3px;
}
.eye:hover { background: #3a3a3a; }
.eye.off { opacity: 0.3; filter: grayscale(1); }
.sec-body { display: flex; flex-direction: column; gap: 7px; }
.sec-body.dim { opacity: 0.45; }
.subhead { font-size: 11px; font-weight: 700; color: #9ab8d8; margin-top: 4px; }

.row {
  display: grid;
  grid-template-columns: 68px 1fr 42px;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #bbb;
}
.row input[type='range'] { width: 100%; accent-color: #0e639c; }
.row .v { text-align: right; color: #999; font-size: 11px; font-variant-numeric: tabular-nums; }

.inline { display: flex; align-items: center; gap: 8px; }
.mini { font-size: 11px; color: #999; display: inline-flex; align-items: center; gap: 5px; }
.mini input[type='number'] {
  width: 46px;
  background: #1f1f1f;
  color: #eee;
  border: 1px solid #444;
  border-radius: 4px;
  padding: 3px 4px;
  font-size: 11px;
}
.splits { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

.select {
  background: #1f1f1f;
  color: #eee;
  border: 1px solid #444;
  border-radius: 4px;
  padding: 4px 6px;
  font-size: 12px;
}
.check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #bbb; cursor: pointer; }
.hint { font-size: 11px; color: #777; line-height: 1.5; }

.curve-row { display: flex; gap: 10px; align-items: flex-start; }
.curve-canvas {
  width: 160px;
  height: 160px;
  flex: none;
  border: 1px solid #3a3a3a;
  border-radius: 4px;
  cursor: crosshair;
  touch-action: none;
}
.curve-side { flex: 1; display: flex; flex-direction: column; gap: 8px; padding-top: 2px; min-width: 0; }
.swatch {
  width: 22px;
  height: 22px;
  flex: none;
  border: 1px solid #444;
  border-radius: 50%;
}

.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-top: 1px solid #1c1c1c;
}
.actions { display: flex; gap: 8px; }
.btn {
  background: #333;
  color: #ddd;
  border: 1px solid #454545;
  border-radius: 5px;
  padding: 6px 14px;
  font-size: 12px;
  cursor: pointer;
}
.btn:hover { background: #3a3a3a; }
.btn.primary { background: #0e639c; border-color: #1177bb; color: #fff; }
.btn.primary:hover { background: #1177bb; }
.btn.small { padding: 4px 8px; font-size: 11px; }

.right::-webkit-scrollbar { width: 10px; }
.right::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 5px; }
.right::-webkit-scrollbar-track { background: transparent; }
</style>
