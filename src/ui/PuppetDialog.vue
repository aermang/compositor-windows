<!-- 操控变形工作区(全屏模态)。确定/取消由本组件负责关 dialog。 -->
<script setup lang="ts">
// 操控变形(Puppet Warp)工作区:取活动栅格图层的 bitmap 克隆为工作画布
// (bitmap 尺寸,忽略图层变换,同液化 v1 局限)。点击放图钉(吸附最近格点),
// 拖动图钉实时 solveMesh + renderWarped 预览(rAF 节流);Alt+点击删除图钉;
// 网格密度滑杆重建网格(图钉重新吸附,变形复位)。确定经 rasterEdit 以
// clearRect+drawImage 替换语义提交(自动历史),取消/Esc 直接关 dialog 不提交。
// 引擎见 src/core/pixels/puppet.ts(IDW 位移插值 + 三角网格仿射渲染)。
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { store, activeLayer, rasterEdit } from '../core/store';
import { makeCanvas, ctx2d, ctx2dRead } from '../core/canvasUtils';
import {
  createMesh, solveMesh, renderWarped, snapToCell, cellPoint, gridStep,
} from '../core/pixels/puppet';
import type { PuppetMesh, PuppetPin } from '../core/pixels/puppet';

type Mode = 'add' | 'move' | 'del';

const TOOLS: { id: Mode | 'reset'; label: string; title: string }[] = [
  { id: 'add', label: '添加图钉', title: '添加图钉:点击画布放置图钉(自动吸附最近格点)' },
  { id: 'move', label: '拖动图钉', title: '拖动图钉:按住图钉拖拽使内容跟随变形(拖动即位移,v1 不做独立旋转)' },
  { id: 'del', label: '删除图钉', title: '删除图钉:点击图钉删除(任何模式下 Alt+点击图钉同样删除)' },
  { id: 'reset', label: '全部重置', title: '全部重置:移除全部图钉并复位网格' },
];

const MODE_HINT: Record<Mode, string> = {
  add: '在画布上点击放置图钉;点在已有图钉上则直接进入拖动。',
  move: '按住图钉拖拽,周围内容跟随;至少放两个图钉(其中一个当锚点)才能局部变形。',
  del: '点击图钉将其删除;任何模式下 Alt+点击图钉也可删除。',
};

const mode = ref<Mode>('add');
const spacing = ref(32); // 网格间距 8-64
const ready = ref(false);
const fit = ref({ w: 0, h: 0 });
const pinCount = ref(0);
const info = ref('');

const previewCanvas = ref<HTMLCanvasElement | null>(null);
const overlayCanvas = ref<HTMLCanvasElement | null>(null);
const stageEl = ref<HTMLDivElement | null>(null);

// big buffers stay OUT of Vue's reactivity
let work: HTMLCanvasElement | null = null; // pristine source pixels
let mesh: PuppetMesh | null = null;
let pins: PuppetPin[] = [];   // current pin positions (work coords)
let cells: number[] = [];     // cells[i] = grid point pin i is snapped onto
let touched = false;          // any pin dragged → commit is meaningful
let dragging = false;
let dragIdx = -1;
let hoverIdx = -1;

let renderRaf = 0;
let overlayRaf = 0;
let ro: ResizeObserver | null = null;

function close() {
  store.dialog = null;
}

function syncPinCount() {
  pinCount.value = pins.length;
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
  mesh = createMesh(work.width, work.height, spacing.value);
  pins = [];
  cells = [];
  touched = false;
  dragging = false;
  dragIdx = -1;
  hoverIdx = -1;
  syncPinCount();
  ready.value = true;
  await nextTick(); // work area (stage/preview refs) mounts with ready=true

  const pc = previewCanvas.value;
  const oc = overlayCanvas.value;
  if (pc) { pc.width = work.width; pc.height = work.height; }
  if (oc) { oc.width = work.width; oc.height = work.height; }
  info.value = `${work.width} × ${work.height} px`;

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
  if (renderRaf) { cancelAnimationFrame(renderRaf); renderRaf = 0; }
  if (overlayRaf) { cancelAnimationFrame(overlayRaf); overlayRaf = 0; }
  window.removeEventListener('keydown', onKey, true);
  ro?.disconnect();
  ro = null;
  uninstallDebug();
  work = null;
  mesh = null;
  pins = [];
  cells = [];
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

function fitScale(): number {
  if (!work || !fit.value.w) return 1;
  return fit.value.w / work.width;
}

// ---------- pins ----------

function addPinAt(x: number, y: number): number {
  if (!mesh) return -1;
  const cell = snapToCell(mesh, x, y);
  const pos = cellPoint(mesh, cell);
  pins.push({ x: pos.x, y: pos.y });
  cells.push(cell);
  syncPinCount();
  renderNow();
  return pins.length - 1;
}

function deletePin(i: number) {
  if (!pins[i]) return;
  pins.splice(i, 1);
  cells.splice(i, 1);
  if (dragIdx === i) { dragging = false; dragIdx = -1; }
  else if (dragIdx > i) dragIdx--;
  if (hoverIdx === i) hoverIdx = -1;
  else if (hoverIdx > i) hoverIdx--;
  syncPinCount();
  renderNow();
}

function resetAll() {
  pins = [];
  cells = [];
  touched = false;
  dragging = false;
  dragIdx = -1;
  hoverIdx = -1;
  syncPinCount();
  renderNow();
}

function onTool(id: Mode | 'reset') {
  if (id === 'reset') {
    resetAll();
    return;
  }
  mode.value = id;
}

watch(spacing, () => rebuildMesh());

/** 密度变更:重建网格,图钉重新吸附到新格点(变形复位)。 */
function rebuildMesh() {
  if (!work) return;
  mesh = createMesh(work.width, work.height, spacing.value);
  cells = pins.map(p => {
    const cell = snapToCell(mesh!, p.x, p.y);
    const pos = cellPoint(mesh!, cell);
    p.x = pos.x;
    p.y = pos.y;
    return cell;
  });
  renderNow();
}

function findPin(p: { x: number; y: number }): number {
  const hitR = Math.max(6, 10 / fitScale());
  let best = -1;
  let bestD = hitR * hitR;
  for (let i = 0; i < pins.length; i++) {
    const d = (pins[i].x - p.x) * (pins[i].x - p.x) + (pins[i].y - p.y) * (pins[i].y - p.y);
    if (d <= bestD) { bestD = d; best = i; }
  }
  return best;
}

// ---------- pointer ----------

function toWork(e: PointerEvent): { x: number; y: number } {
  const c = previewCanvas.value!;
  const r = c.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * c.width,
    y: ((e.clientY - r.top) / r.height) * c.height,
  };
}

function onDown(e: PointerEvent) {
  if (!ready.value || !previewCanvas.value || !mesh) return;
  const p = toWork(e);
  try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
  const hit = findPin(p);
  if (e.altKey && hit >= 0) {
    deletePin(hit);
    return;
  }
  if (mode.value === 'del') {
    if (hit >= 0) deletePin(hit);
    scheduleOverlay();
    return;
  }
  if (hit >= 0) {
    dragging = true;
    dragIdx = hit;
    scheduleOverlay();
    return;
  }
  if (mode.value === 'add') addPinAt(p.x, p.y);
}

function onMove(e: PointerEvent) {
  if (!previewCanvas.value) return;
  const p = toWork(e);
  if (dragging && dragIdx >= 0 && pins[dragIdx]) {
    pins[dragIdx] = p;
    touched = true;
    scheduleRender();
    return;
  }
  const h = findPin(p);
  if (h !== hoverIdx) {
    hoverIdx = h;
    scheduleOverlay();
  }
}

function onUp(e: PointerEvent) {
  dragging = false;
  dragIdx = -1;
  try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  scheduleOverlay();
}

function onLeave() {
  if (dragging) return;
  hoverIdx = -1;
  scheduleOverlay();
}

// ---------- rendering ----------

/** solveMesh + renderWarped + overlay(图钉/网格线),拖拽经 rAF 节流调用。 */
function renderNow() {
  if (!work || !mesh || !previewCanvas.value) return;
  const dragged = (dragging && dragIdx >= 0 && pins[dragIdx])
    ? { pin: dragIdx, x: pins[dragIdx].x, y: pins[dragIdx].y }
    : undefined;
  solveMesh(mesh, pins, cells.map((cell, pin) => ({ cell, pin })), dragged);
  const out = renderWarped(work, mesh);
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
  if (!oc || !mesh) return;
  const c = ctx2d(oc);
  c.clearRect(0, 0, oc.width, oc.height);
  const scale = fitScale();
  const cols = mesh.gx + 1;
  const rows = mesh.gy + 1;
  const { sx, sy } = gridStep(mesh);

  // deformed wireframe
  c.strokeStyle = 'rgba(255,255,255,0.16)';
  c.lineWidth = 1 / scale;
  c.beginPath();
  const px = (j: number) => (j % cols) * sx + mesh!.ox[j];
  const py = (j: number) => Math.floor(j / cols) * sy + mesh!.oy[j];
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < mesh!.gx; i++) {
      const j = r * cols + i;
      c.moveTo(px(j), py(j));
      c.lineTo(px(j + 1), py(j + 1));
    }
  }
  for (let i = 0; i < cols; i++) {
    for (let r = 0; r < mesh!.gy; r++) {
      const j = r * cols + i;
      c.moveTo(px(j), py(j));
      c.lineTo(px(j + cols), py(j + cols));
    }
  }
  c.stroke();

  // pins: 黄色圆点 + 深色描边,悬停/拖动放大
  for (let i = 0; i < pins.length; i++) {
    const active = i === dragIdx || i === hoverIdx;
    const rad = (active ? 5.5 : 4);
    c.beginPath();
    c.arc(pins[i].x, pins[i].y, rad, 0, Math.PI * 2);
    c.fillStyle = '#ffd21f';
    c.fill();
    c.lineWidth = 1.5 / scale;
    c.strokeStyle = 'rgba(25,18,0,0.9)';
    c.stroke();
    if (i === dragIdx) {
      c.beginPath();
      c.arc(pins[i].x, pins[i].y, rad + 3, 0, Math.PI * 2);
      c.strokeStyle = 'rgba(255,255,255,0.8)';
      c.lineWidth = 1 / scale;
      c.stroke();
    }
  }
}

function scheduleOverlay() {
  if (overlayRaf) return;
  overlayRaf = requestAnimationFrame(() => { overlayRaf = 0; renderOverlay(); });
}

// ---------- commit ----------

function commit() {
  const layer = activeLayer.value;
  if (!layer || !work || !mesh) { close(); return; }
  if (touched && pins.length) {
    const out = renderWarped(work, mesh);
    // 替换语义:操控变形产出是完整新图
    rasterEdit(layer, '操控变形', b => {
      const c = ctx2dRead(b);
      c.clearRect(0, 0, b.width, b.height);
      c.drawImage(out, 0, 0);
    });
  }
  close();
}

// ---------- dev/test hook ----------

function installDebug() {
  if (!import.meta.env.DEV) return;
  (window as unknown as { __ppDebug?: unknown }).__ppDebug = {
    getMesh: () => mesh,
    getPins: () => pins.map(p => ({ x: p.x, y: p.y })),
    renderNow: () => renderNow(),
    canvasRect: () => previewCanvas.value?.getBoundingClientRect() ?? null,
    addPin: (x: number, y: number) => addPinAt(x, y),
    dragPin: (i: number, x: number, y: number) => {
      if (!pins[i]) return;
      pins[i] = { x, y };
      touched = true;
      syncPinCount();
    },
    commitPreview: () => commit(),
  };
}

function uninstallDebug() {
  if (!import.meta.env.DEV) return;
  delete (window as unknown as { __ppDebug?: unknown }).__ppDebug;
}
</script>

<template>
  <div class="puppet-overlay">
    <div class="puppet-shell">
      <div class="puppet-title">
        <span>操控变形</span>
        <button class="pp-close" title="取消并关闭 (Esc)" @click="close">×</button>
      </div>

      <div v-if="!ready" class="puppet-body pp-empty">
        <div class="pp-empty-box">
          <div class="pp-empty-main">当前没有可变形的栅格图层</div>
          <div class="pp-empty-sub">请先在图层面板选择一个包含位图像素的图层,再打开操控变形工作区。</div>
          <button class="pp-btn primary" @click="close">关闭</button>
        </div>
      </div>

      <template v-else>
        <div class="puppet-body pp-work">
          <div class="pp-tools">
            <button
              v-for="t in TOOLS" :key="t.id"
              class="pp-tool" :class="{ on: mode === t.id }"
              :title="t.title"
              @click="onTool(t.id)"
            >{{ t.label }}</button>
          </div>

          <div ref="stageEl" class="pp-stage">
            <div class="pp-stack" :style="{ width: fit.w + 'px', height: fit.h + 'px' }">
              <canvas
                ref="previewCanvas"
                class="pp-preview"
                @pointerdown="onDown"
                @pointermove="onMove"
                @pointerup="onUp"
                @pointercancel="onUp"
                @pointerleave="onLeave"
              ></canvas>
              <canvas ref="overlayCanvas" class="pp-overlay"></canvas>
            </div>
          </div>

          <div class="pp-params">
            <div class="pp-pgroup">
              <div class="pp-plabel">网格密度 <span class="pp-pval">{{ spacing }}px</span></div>
              <input v-model.number="spacing" type="range" min="8" max="64" step="1" />
            </div>
            <div class="pp-hint">{{ MODE_HINT[mode] }}</div>
            <div class="pp-hint">图钉:{{ pinCount }} 个(拖动即位移,旋转 v1 从简)</div>
            <div class="pp-hint dim">{{ info }}</div>
          </div>
        </div>

        <div class="pp-foot">
          <span class="pp-foot-hint">点击放图钉 · 拖动图钉变形 · Alt+点击删除图钉 · Esc 取消</span>
          <div class="pp-actions">
            <button class="pp-btn" @click="close">取消</button>
            <button class="pp-btn primary" :disabled="pinCount === 0" @click="commit">确定</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.puppet-overlay {
  position: fixed; inset: 0; z-index: 400;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center;
}
.puppet-shell {
  width: min(92vw, 1100px); height: min(90vh, 780px);
  background: #2b2b2b; border: 1px solid #111; border-radius: 6px;
  display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
}
.puppet-title {
  padding: 8px 12px; color: #ddd; font-size: 13px;
  border-bottom: 1px solid #111; display: flex; justify-content: space-between; align-items: center;
}
.pp-close { background: none; border: none; color: #aaa; font-size: 18px; cursor: pointer; }
.pp-close:hover { color: #fff; }
.puppet-body { flex: 1; min-height: 0; display: flex; color: #888; }

/* empty state */
.pp-empty { align-items: center; justify-content: center; }
.pp-empty-box { display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; }
.pp-empty-main { color: #ccc; font-size: 14px; }
.pp-empty-sub { color: #777; font-size: 12px; max-width: 360px; line-height: 1.6; }

/* work layout: tools | stage | params */
.pp-work { flex: 1; }
.pp-tools {
  width: 96px; flex: none; display: flex; flex-direction: column; gap: 4px;
  padding: 10px 8px; border-right: 1px solid #1c1c1c; overflow-y: auto;
}
.pp-tool {
  background: #333; color: #ccc; border: 1px solid #454545; border-radius: 4px;
  padding: 6px 4px; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.pp-tool:hover { background: #3a3a3a; }
.pp-tool.on { background: #0e639c; border-color: #1177bb; color: #fff; }

.pp-stage {
  flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center;
  background-color: #232323; overflow: hidden;
}
.pp-stack {
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
.pp-preview {
  position: absolute; inset: 0; width: 100%; height: 100%;
  cursor: crosshair; touch-action: none; display: block;
}
.pp-overlay {
  position: absolute; inset: 0; width: 100%; height: 100%;
  pointer-events: none; display: block;
}

.pp-params {
  width: 190px; flex: none; display: flex; flex-direction: column; gap: 14px;
  padding: 14px 12px; border-left: 1px solid #1c1c1c; overflow-y: auto;
}
.pp-pgroup { display: flex; flex-direction: column; gap: 6px; }
.pp-plabel { display: flex; justify-content: space-between; font-size: 12px; color: #bbb; }
.pp-pval { color: #8ab4dc; font-variant-numeric: tabular-nums; }
.pp-params input[type='range'] { width: 100%; accent-color: #0e639c; }
.pp-hint { font-size: 11px; color: #777; line-height: 1.6; }
.pp-hint.dim { color: #5c5c5c; }

.pp-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 14px; border-top: 1px solid #1c1c1c;
}
.pp-foot-hint { font-size: 11px; color: #666; }
.pp-actions { display: flex; gap: 8px; }
.pp-btn {
  background: #333; color: #ddd; border: 1px solid #454545; border-radius: 5px;
  padding: 6px 16px; font-size: 12px; cursor: pointer;
}
.pp-btn:hover { background: #3a3a3a; }
.pp-btn.primary { background: #0e639c; border-color: #1177bb; color: #fff; }
.pp-btn.primary:hover { background: #1177bb; }
.pp-btn.primary:disabled { opacity: 0.45; cursor: default; }
.pp-btn.primary:disabled:hover { background: #0e639c; }

.pp-tools::-webkit-scrollbar, .pp-params::-webkit-scrollbar { width: 10px; }
.pp-tools::-webkit-scrollbar-thumb, .pp-params::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 5px; }
.pp-tools::-webkit-scrollbar-track, .pp-params::-webkit-scrollbar-track { background: transparent; }
</style>
