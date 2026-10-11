<script setup lang="ts">
// 标尺：画布区域顶边（18px）与左边（18px）的自包含覆盖层，左上角为 ↘ 角块。
// 刻度按 [1,2,5,10,…] 阶梯选取首个 ≥70 屏幕px 的主步长，次刻度 = 主/10；
// 中刻度长 5、主刻度长 8、次刻度长 3；标签为 8px 等宽字体的文档像素整数
// （左标尺文字经 −90° 旋转绘制）。
// 交互：在标尺上按下即从该处拖出参考线（guides.ts）；拖拽中实时更新，
// 松手时若仍位于标尺条内 → 新线取消 / 已有线删除，否则落定。
// 假定本组件覆盖的容器与画布视口区域完全重合（坐标系一致）。

import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { viewport, screenToDoc } from '../core/viewport';
import { guides, addGuide, moveGuide, removeGuide } from '../core/guides';

const THICK = 18;
const LADDER = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500,
  1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000];

const root = ref<HTMLDivElement | null>(null);
const topC = ref<HTMLCanvasElement | null>(null);
const leftC = ref<HTMLCanvasElement | null>(null);

function ladderStep(scale: number): number {
  return LADDER.find(s => s * scale >= 70) ?? LADDER[LADDER.length - 1];
}

interface Tick { p: number; len: number; label: boolean }

/** Doc-px tick positions for the visible range along one axis. */
function ticksFor(startDoc: number, spanDoc: number, scale: number): Tick[] {
  const major = ladderStep(scale);
  const minor = major / 10;
  const i0 = Math.ceil(startDoc / minor);
  const i1 = Math.floor((startDoc + spanDoc) / minor);
  if (i1 - i0 > 4000) return []; // safety valve
  const out: Tick[] = [];
  for (let i = i0; i <= i1; i++) {
    const m = ((i % 10) + 10) % 10;
    out.push({
      p: i * minor,
      len: m === 0 ? 8 : m === 5 ? 5 : 3,
      label: m === 0,
    });
  }
  return out;
}

function setupCanvas(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  c.style.width = `${Math.max(0, Math.round(w))}px`;
  c.style.height = `${Math.max(0, Math.round(h))}px`;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function drawTop(): void {
  const c = topC.value;
  if (!c || viewport.canvasW <= 0) return;
  const w = viewport.canvasW;
  const ctx = setupCanvas(c, w, THICK);
  if (!ctx) return;
  ctx.clearRect(0, 0, w, THICK);
  ctx.fillStyle = '#232323';
  ctx.fillRect(0, 0, w, THICK);
  ctx.strokeStyle = '#7d7d7d';
  ctx.fillStyle = '#9a9a9a';
  ctx.lineWidth = 1;
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of ticksFor(viewport.left, viewport.width, viewport.scale)) {
    const sx = Math.round((t.p - viewport.left) * viewport.scale) + 0.5;
    ctx.beginPath();
    ctx.moveTo(sx, THICK - t.len);
    ctx.lineTo(sx, THICK);
    ctx.stroke();
    if (t.label) ctx.fillText(String(Math.round(t.p)), sx, 1);
  }
  // 参考线标记（垂直线的 x 位置显示在顶标尺）
  ctx.fillStyle = '#00e5ff';
  for (const g of guides) {
    if (g.axis !== 'v') continue;
    const sx = Math.round((g.position - viewport.left) * viewport.scale);
    if (sx >= 0 && sx <= w) ctx.fillRect(sx - 1, THICK - 6, 2, 6);
  }
  ctx.fillStyle = '#000';
  ctx.fillRect(0, THICK - 1, w, 1);
}

function drawLeft(): void {
  const c = leftC.value;
  if (!c || viewport.canvasH <= 0) return;
  const h = viewport.canvasH;
  const ctx = setupCanvas(c, THICK, h);
  if (!ctx) return;
  ctx.clearRect(0, 0, THICK, h);
  ctx.fillStyle = '#232323';
  ctx.fillRect(0, 0, THICK, h);
  ctx.strokeStyle = '#7d7d7d';
  ctx.fillStyle = '#9a9a9a';
  ctx.lineWidth = 1;
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (const t of ticksFor(viewport.top, viewport.height, viewport.scale)) {
    const sy = Math.round((t.p - viewport.top) * viewport.scale) + 0.5;
    ctx.beginPath();
    ctx.moveTo(THICK - t.len, sy);
    ctx.lineTo(THICK, sy);
    ctx.stroke();
    if (t.label) {
      // −90° 旋转：文字沿标尺向上，位于基点左侧
      ctx.save();
      ctx.translate(THICK - 2, sy);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(String(Math.round(t.p)), 0, 0);
      ctx.restore();
    }
  }
  // 参考线标记（水平线的 y 位置显示在左标尺）
  ctx.fillStyle = '#00e5ff';
  for (const g of guides) {
    if (g.axis !== 'h') continue;
    const sy = Math.round((g.position - viewport.top) * viewport.scale);
    if (sy >= 0 && sy <= h) ctx.fillRect(THICK - 6, sy - 1, 6, 2);
  }
  ctx.fillStyle = '#000';
  ctx.fillRect(THICK - 1, 0, 1, h);
}

function redraw(): void {
  drawTop();
  drawLeft();
}

watch(viewport, redraw);
watch(guides, redraw);
onMounted(redraw);

// ---- 从标尺拖出 / 拖动 / 删除参考线 ----

let drag: { id: string; axis: 'v' | 'h'; isNew: boolean } | null = null;

function startDrag(axis: 'v' | 'h', e: PointerEvent): void {
  e.preventDefault();
  const r = root.value?.getBoundingClientRect();
  if (!r) return;
  const px = e.clientX - r.left;
  const py = e.clientY - r.top;
  const doc = screenToDoc(px, py);
  const along = axis === 'v' ? doc[0] : doc[1];
  const tol = 8 / viewport.scale;
  const existing = guides.find(g => g.axis === axis && Math.abs(g.position - along) <= tol);
  const g = existing ?? addGuide(axis, along);
  drag = { id: g.id, axis, isNew: !existing };
  document.body.style.cursor = axis === 'v' ? 'col-resize' : 'row-resize';
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
}

function onDragMove(e: PointerEvent): void {
  if (!drag) return;
  const r = root.value?.getBoundingClientRect();
  if (!r) return;
  const doc = screenToDoc(e.clientX - r.left, e.clientY - r.top);
  moveGuide(drag.id, drag.axis === 'v' ? doc[0] : doc[1]);
}

function onDragEnd(e: PointerEvent): void {
  if (!drag) return;
  const r = root.value?.getBoundingClientRect();
  const inRoot = !!r
    && e.clientX >= r.left && e.clientX <= r.right
    && e.clientY >= r.top && e.clientY <= r.bottom;
  const overRuler = inRoot && (drag.axis === 'v'
    ? e.clientY - r!.top < THICK
    : e.clientX - r!.left < THICK);
  if (overRuler) removeGuide(drag.id); // 新线取消 / 已有线删除
  drag = null;
  document.body.style.cursor = '';
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  document.body.style.cursor = '';
});
</script>

<template>
  <div ref="root" class="rulers">
    <canvas
      ref="topC"
      class="ruler-top"
      @pointerdown="startDrag('v', $event)"
    ></canvas>
    <canvas
      ref="leftC"
      class="ruler-left"
      @pointerdown="startDrag('h', $event)"
    ></canvas>
    <div class="ruler-corner">↘</div>
  </div>
</template>

<style scoped>
.rulers {
  position: absolute;
  inset: 0;
  pointer-events: none; /* 中间区域透传给画布 */
  z-index: 30;
  user-select: none;
}
.ruler-top {
  position: absolute;
  top: 0;
  left: 0;
  height: 18px;
  pointer-events: auto;
  cursor: col-resize;
  touch-action: none;
}
.ruler-left {
  position: absolute;
  top: 0;
  left: 0;
  width: 18px;
  pointer-events: auto;
  cursor: row-resize;
  touch-action: none;
}
.ruler-corner {
  position: absolute;
  top: 0;
  left: 0;
  width: 18px;
  height: 18px;
  background: #232323;
  border-right: 1px solid #000;
  border-bottom: 1px solid #000;
  color: #9a9a9a;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
  pointer-events: auto;
  cursor: default;
}
</style>
