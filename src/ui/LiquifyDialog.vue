<!-- 液化工作区(全屏模态)。确定/取消由本组件负责关 dialog。 -->
<script setup lang="ts">
// 液化工作区:取活动栅格图层的 bitmap 克隆为工作画布(bitmap 尺寸,忽略图层
// 变换),拖拽向 src/core/pixels/liquify 的位移场里盖章,applyField 逆映射出
// 预览(rAF 节流);冻结画笔写 freeze 场并在覆盖层上叠加半透明红色;重建按住
// 渐进回退;确定经 rasterEdit 以 clearRect+drawImage 替换语义提交(自动历史),
// 取消/Esc 直接关 dialog 不提交。
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { store, activeLayer, rasterEdit } from '../core/store';
import { makeCanvas, ctx2d, ctx2dRead, docToLayer } from '../core/canvasUtils';
import { createField, stampBrush, reconstruct, applyField } from '../core/pixels/liquify';
import type { LiquifyField } from '../core/pixels/liquify';

type Mode =
  | 'forward' | 'twistCW' | 'twistCCW' | 'pucker' | 'bloat' | 'pushLeft'
  | 'freeze' | 'reconstruct';

const TOOLS: { id: Mode | 'reset'; label: string; title: string }[] = [
  { id: 'forward', label: '向前变形', title: '向前变形:内容沿拖拽方向推移' },
  { id: 'twistCW', label: '顺时针转', title: '顺时针扭转:内容绕中心顺时针旋转' },
  { id: 'twistCCW', label: '逆时针转', title: '逆时针扭转:内容绕中心逆时针旋转' },
  { id: 'pucker', label: '褶皱', title: '褶皱:内容向笔刷中心收缩' },
  { id: 'bloat', label: '膨胀', title: '膨胀:内容向笔刷边缘扩散' },
  { id: 'pushLeft', label: '左推', title: '左推:内容沿拖拽方向左侧移动' },
  { id: 'freeze', label: '冻结蒙版', title: '冻结蒙版:涂过的区域受保护不变形(红色显示)' },
  { id: 'reconstruct', label: '重建', title: '重建:按住画布渐进回退变形' },
  { id: 'reset', label: '全部恢复', title: '全部恢复:清空全部变形与冻结' },
];

const MODE_HINT: Record<Mode, string> = {
  forward: '在画布上拖拽,内容跟随拖拽方向变形。',
  twistCW: '按住或拖拽,内容顺时针扭转。',
  twistCCW: '按住或拖拽,内容逆时针扭转。',
  pucker: '按住或拖拽,内容向中心收缩。',
  bloat: '按住或拖拽,内容从中心向外膨胀。',
  pushLeft: '拖拽时内容被推向行进方向的左侧。',
  freeze: '涂抹以冻结区域;冻结区不受任何变形工具影响。',
  reconstruct: '按住画布不动,变形按帧渐进恢复。',
};

const mode = ref<Mode>('forward');
const brushSize = ref(150);
const pressure = ref(50);
const ready = ref(false);
const fit = ref({ w: 0, h: 0 });
const info = ref('');

const previewCanvas = ref<HTMLCanvasElement | null>(null);
const overlayCanvas = ref<HTMLCanvasElement | null>(null);
const stageEl = ref<HTMLDivElement | null>(null);

// big buffers stay OUT of Vue's reactivity
let work: HTMLCanvasElement | null = null; // pristine source pixels
let field: LiquifyField | null = null;
let emptyField: LiquifyField | null = null;
let freezeCv: HTMLCanvasElement | null = null; // cached red freeze visualization
let freezeDirty = true;
let touched = false;

let renderRaf = 0;
let overlayRaf = 0;
let reconRaf = 0;
let ro: ResizeObserver | null = null;

function close() {
  store.dialog = null;
}

// ---------- open / close ----------

async function open() {
  const layer = activeLayer.value;
  const bmp = layer && !layer.isGroup ? layer.bitmap : null;
  if (!layer || !bmp) {
    ready.value = false;
    return;
  }
  work = makeCanvas(bmp.width, bmp.height);
  ctx2dRead(work).drawImage(bmp, 0, 0); // first context call → willReadFrequently sticks
  field = createField(bmp.width, bmp.height);
  emptyField = createField(bmp.width, bmp.height);
  freezeCv = makeCanvas(bmp.width, bmp.height);
  freezeDirty = true;
  touched = false;
  ready.value = true;
  await nextTick(); // work area (stage/preview refs) mounts with ready=true

  const pc = previewCanvas.value;
  const oc = overlayCanvas.value;
  if (pc) { pc.width = bmp.width; pc.height = bmp.height; }
  if (oc) { oc.width = bmp.width; oc.height = bmp.height; }
  info.value = `${bmp.width} × ${bmp.height} px`;

  window.addEventListener('keydown', onKey, true);
  if (stageEl.value) {
    ro = new ResizeObserver(refit);
    ro.observe(stageEl.value);
  }
  refit();
  renderNow();
  installDebug();
}

function teardown() {
  stopReconstruct();
  if (renderRaf) { cancelAnimationFrame(renderRaf); renderRaf = 0; }
  if (overlayRaf) { cancelAnimationFrame(overlayRaf); overlayRaf = 0; }
  window.removeEventListener('keydown', onKey, true);
  ro?.disconnect();
  ro = null;
  uninstallDebug();
  work = null;
  field = null;
  emptyField = null;
  freezeCv = null;
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    close();
  }
}

onMounted(() => { void nextTick(open); });
onBeforeUnmount(teardown);

// ---------- fit stage ----------

function refit() {
  if (!work || !stageEl.value) return;
  const pad = 24;
  const aw = Math.max(40, stageEl.value.clientWidth - pad);
  const ah = Math.max(40, stageEl.value.clientHeight - pad);
  const s = Math.min(aw / work.width, ah / work.height);
  fit.value = {
    w: Math.max(1, Math.floor(work.width * s)),
    h: Math.max(1, Math.floor(work.height * s)),
  };
}

// ---------- painting ----------

function spacing(): number {
  return Math.max(1, brushSize.value * 0.075);
}

function dab(x: number, y: number, dirx: number, diry: number) {
  if (!field) return;
  const r = brushSize.value / 2;
  const pr = pressure.value / 100;
  if (mode.value === 'freeze') {
    stampFreeze(field, x, y, r, pr);
  } else if (mode.value !== 'reconstruct') {
    stampBrush(field, mode.value, x, y, r, pr, dirx, diry);
  }
  touched = true;
}

/** Freeze brush: accumulate protection with the same (1-t)^2 profile. */
function stampFreeze(f: LiquifyField, cx: number, cy: number, radius: number, pr: number) {
  const r = Math.max(1, radius);
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(f.w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(f.h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dist = Math.hypot(x - cx, y - cy);
      if (dist >= r) continue;
      const t = dist / r;
      const v = pr * (1 - t) * (1 - t);
      const i = y * f.w + x;
      if (v > 0 && f.freeze[i] < 1) f.freeze[i] = Math.min(1, f.freeze[i] + v);
    }
  }
  freezeDirty = true;
}

function onTool(id: Mode | 'reset') {
  if (id === 'reset') {
    resetAll();
    return;
  }
  mode.value = id;
}

function resetAll() {
  if (!field) return;
  field.dx.fill(0);
  field.dy.fill(0);
  field.freeze.fill(0);
  freezeDirty = true;
  touched = false;
  renderNow();
}

// ---------- pointer ----------

let dragging = false;
let lastX = 0;
let lastY = 0;
let pending = 0;
let cursor: { x: number; y: number } | null = null;

function toWork(e: PointerEvent): { x: number; y: number } {
  const c = previewCanvas.value!;
  const r = c.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * c.width,
    y: ((e.clientY - r.top) / r.height) * c.height,
  };
}

function onDown(e: PointerEvent) {
  if (!ready.value || !previewCanvas.value) return;
  const p = toWork(e);
  cursor = p;
  try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
  scheduleOverlay();
  if (mode.value === 'reconstruct') {
    startReconstruct();
    return;
  }
  dragging = true;
  lastX = p.x;
  lastY = p.y;
  pending = spacing();
  dab(p.x, p.y, 0, 0);
  scheduleRender();
}

function onMove(e: PointerEvent) {
  if (!previewCanvas.value) return;
  const p = toWork(e);
  cursor = p;
  scheduleOverlay();
  if (!dragging) return;
  const dx = p.x - lastX;
  const dy = p.y - lastY;
  const len = Math.hypot(dx, dy);
  if (len <= 0) return;
  const nx = dx / len;
  const ny = dy / len;
  const sp = spacing();
  let travelled = 0;
  while (travelled + pending <= len) {
    travelled += pending;
    const f = travelled / len;
    dab(lastX + dx * f, lastY + dy * f, nx, ny);
    pending = sp;
  }
  pending -= len - travelled;
  lastX = p.x;
  lastY = p.y;
  scheduleRender();
}

function onUp(e: PointerEvent) {
  dragging = false;
  stopReconstruct();
  try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
}

function onLeave() {
  if (dragging) return;
  cursor = null;
  scheduleOverlay();
}

function startReconstruct() {
  stopReconstruct();
  const step = () => {
    if (!field || !emptyField) return;
    reconstruct(field, emptyField, 0.2);
    touched = true;
    renderNow();
    reconRaf = requestAnimationFrame(step);
  };
  reconRaf = requestAnimationFrame(step);
}

function stopReconstruct() {
  if (reconRaf) { cancelAnimationFrame(reconRaf); reconRaf = 0; }
}

watch(brushSize, () => scheduleOverlay());

// ---------- rendering ----------

function renderNow() {
  if (!work || !field || !previewCanvas.value) return;
  const out = applyField(work, field);
  const pc = previewCanvas.value;
  const c = ctx2d(pc);
  c.clearRect(0, 0, pc.width, pc.height);
  c.drawImage(out, 0, 0);
  renderOverlay();
}

function scheduleRender() {
  if (renderRaf) return;
  renderRaf = requestAnimationFrame(() => { renderRaf = 0; renderNow(); });
}

function renderOverlay() {
  const oc = overlayCanvas.value;
  if (!oc || !field) return;
  if (freezeDirty && freezeCv) {
    freezeDirty = false;
    const n = field.w * field.h;
    const img = ctx2d(freezeCv).createImageData(field.w, field.h);
    const d = img.data;
    for (let i = 0; i < n; i++) {
      const fzi = field.freeze[i];
      if (fzi > 0) {
        const o = i * 4;
        d[o] = 255;
        d[o + 3] = Math.round(fzi * 115); // 半透明红
      }
    }
    ctx2d(freezeCv).putImageData(img, 0, 0);
  }
  const c = ctx2d(oc);
  c.clearRect(0, 0, oc.width, oc.height);
  if (freezeCv) c.drawImage(freezeCv, 0, 0);
  if (cursor) {
    c.beginPath();
    c.arc(cursor.x, cursor.y, Math.max(1, brushSize.value / 2), 0, Math.PI * 2);
    c.lineWidth = 1;
    c.strokeStyle = mode.value === 'freeze' ? 'rgba(255,120,120,0.95)' : 'rgba(255,255,255,0.85)';
    c.stroke();
    c.strokeStyle = 'rgba(0,0,0,0.55)';
    c.setLineDash([3, 3]);
    c.stroke();
    c.setLineDash([]);
  }
}

function scheduleOverlay() {
  if (overlayRaf) return;
  overlayRaf = requestAnimationFrame(() => { overlayRaf = 0; renderOverlay(); });
}

// ---------- commit ----------

function commit() {
  const layer = activeLayer.value;
  if (!layer || !work || !field) { close(); return; }
  if (touched) {
    const out = applyField(work, field);
    // 替换语义:液化产出是完整新图,source-over 会把半透明侵蚀像素"自愈"
    rasterEdit(layer, '液化', b => {
      const c = ctx2dRead(b);
      c.clearRect(0, 0, b.width, b.height);
      c.drawImage(out, 0, 0);
    });
  }
  close();
}

/** Document point → working-canvas point (layer-local bitmap pixel). */
function docToWork(x: number, y: number): { x: number; y: number } {
  const layer = activeLayer.value;
  if (!layer) return { x, y };
  const p = docToLayer(layer.transform, { x, y });
  return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
}

// ---------- dev/test hook ----------

function installDebug() {
  if (!import.meta.env.DEV) return;
  (window as unknown as { __lxDebug?: unknown }).__lxDebug = {
    getField: () => field,
    applyNow: () => renderNow(),
    canvasRect: () => previewCanvas.value?.getBoundingClientRect() ?? null,
    docToWork,
    commitPreview: () => commit(),
  };
}

function uninstallDebug() {
  if (!import.meta.env.DEV) return;
  delete (window as unknown as { __lxDebug?: unknown }).__lxDebug;
}
</script>

<template>
  <div class="liquify-overlay">
    <div class="liquify-shell">
      <div class="liquify-title">
        <span>液化</span>
        <button class="lx-close" title="取消并关闭 (Esc)" @click="close">×</button>
      </div>

      <div v-if="!ready" class="liquify-body lx-empty">
        <div class="lx-empty-box">
          <div class="lx-empty-main">当前没有可液化的栅格图层</div>
          <div class="lx-empty-sub">请先在图层面板选择一个包含位图像素的图层,再打开液化工作区。</div>
          <button class="lx-btn primary" @click="close">关闭</button>
        </div>
      </div>

      <template v-else>
        <div class="liquify-body lx-work">
          <div class="lx-tools">
            <button
              v-for="t in TOOLS" :key="t.id"
              class="lx-tool" :class="{ on: mode === t.id }"
              :title="t.title"
              @click="onTool(t.id)"
            >{{ t.label }}</button>
          </div>

          <div ref="stageEl" class="lx-stage">
            <div class="lx-stack" :style="{ width: fit.w + 'px', height: fit.h + 'px' }">
              <canvas
                ref="previewCanvas"
                class="lx-preview"
                @pointerdown="onDown"
                @pointermove="onMove"
                @pointerup="onUp"
                @pointercancel="onUp"
                @pointerleave="onLeave"
              ></canvas>
              <canvas ref="overlayCanvas" class="lx-overlay"></canvas>
            </div>
          </div>

          <div class="lx-params">
            <div class="lx-pgroup">
              <div class="lx-plabel">画笔大小 <span class="lx-pval">{{ brushSize }}</span></div>
              <input v-model.number="brushSize" type="range" min="4" max="600" step="1" />
            </div>
            <div class="lx-pgroup">
              <div class="lx-plabel">压力 <span class="lx-pval">{{ pressure }}</span></div>
              <input v-model.number="pressure" type="range" min="1" max="100" step="1" />
            </div>
            <div class="lx-hint">{{ MODE_HINT[mode] }}</div>
            <div class="lx-hint dim">{{ info }}</div>
          </div>
        </div>

        <div class="lx-foot">
          <span class="lx-foot-hint">拖拽应用当前工具 · Esc 取消</span>
          <div class="lx-actions">
            <button class="lx-btn" @click="close">取消</button>
            <button class="lx-btn primary" @click="commit">确定</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.liquify-overlay {
  position: fixed; inset: 0; z-index: 400;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center;
}
.liquify-shell {
  width: min(92vw, 1100px); height: min(90vh, 780px);
  background: #2b2b2b; border: 1px solid #111; border-radius: 6px;
  display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
}
.liquify-title {
  padding: 8px 12px; color: #ddd; font-size: 13px;
  border-bottom: 1px solid #111; display: flex; justify-content: space-between; align-items: center;
}
.lx-close { background: none; border: none; color: #aaa; font-size: 18px; cursor: pointer; }
.lx-close:hover { color: #fff; }
.liquify-body { flex: 1; min-height: 0; display: flex; color: #888; }

/* empty state */
.lx-empty { align-items: center; justify-content: center; }
.lx-empty-box { display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; }
.lx-empty-main { color: #ccc; font-size: 14px; }
.lx-empty-sub { color: #777; font-size: 12px; max-width: 360px; line-height: 1.6; }

/* work layout: tools | stage | params */
.lx-work { flex: 1; }
.lx-tools {
  width: 96px; flex: none; display: flex; flex-direction: column; gap: 4px;
  padding: 10px 8px; border-right: 1px solid #1c1c1c; overflow-y: auto;
}
.lx-tool {
  background: #333; color: #ccc; border: 1px solid #454545; border-radius: 4px;
  padding: 6px 4px; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.lx-tool:hover { background: #3a3a3a; }
.lx-tool.on { background: #0e639c; border-color: #1177bb; color: #fff; }

.lx-stage {
  flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center;
  background-color: #232323; overflow: hidden;
}
.lx-stack {
  position: relative; flex: none;
  background-color: #262626;
  background-image:
    linear-gradient(45deg, #333 25%, transparent 25%),
    linear-gradient(-45deg, #333 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #333 75%),
    linear-gradient(-45deg, transparent 75%, #333 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  box-shadow: 0 0 0 1px #111, 0 8px 24px rgba(0, 0, 0, 0.4);
}
.lx-preview {
  position: absolute; inset: 0; width: 100%; height: 100%;
  cursor: crosshair; touch-action: none; display: block;
}
.lx-overlay {
  position: absolute; inset: 0; width: 100%; height: 100%;
  pointer-events: none; display: block;
}

.lx-params {
  width: 190px; flex: none; display: flex; flex-direction: column; gap: 14px;
  padding: 14px 12px; border-left: 1px solid #1c1c1c; overflow-y: auto;
}
.lx-pgroup { display: flex; flex-direction: column; gap: 6px; }
.lx-plabel { display: flex; justify-content: space-between; font-size: 12px; color: #bbb; }
.lx-pval { color: #8ab4dc; font-variant-numeric: tabular-nums; }
.lx-params input[type='range'] { width: 100%; accent-color: #0e639c; }
.lx-hint { font-size: 11px; color: #777; line-height: 1.6; }
.lx-hint.dim { color: #5c5c5c; }

.lx-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 14px; border-top: 1px solid #1c1c1c;
}
.lx-foot-hint { font-size: 11px; color: #666; }
.lx-actions { display: flex; gap: 8px; }
.lx-btn {
  background: #333; color: #ddd; border: 1px solid #454545; border-radius: 5px;
  padding: 6px 16px; font-size: 12px; cursor: pointer;
}
.lx-btn:hover { background: #3a3a3a; }
.lx-btn.primary { background: #0e639c; border-color: #1177bb; color: #fff; }
.lx-btn.primary:hover { background: #1177bb; }

.lx-tools::-webkit-scrollbar, .lx-params::-webkit-scrollbar { width: 10px; }
.lx-tools::-webkit-scrollbar-thumb, .lx-params::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 5px; }
.lx-tools::-webkit-scrollbar-track, .lx-params::-webkit-scrollbar-track { background: transparent; }
</style>
