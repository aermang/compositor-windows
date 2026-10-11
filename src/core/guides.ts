// Canvas guides (cyan reference lines dragged out of the rulers) + grid
// settings persisted to localStorage. Guides live OUTSIDE the document: they
// are view helpers, never saved into .comp and not part of undo history.

import { reactive } from 'vue';
import { store } from './store';
import { viewport, docToScreen } from './viewport';
import { clamp } from './canvasUtils';

export interface CanvasGuide {
  id: string;
  axis: 'h' | 'v';   // h: horizontal line at y = position; v: vertical line at x = position
  position: number;  // document px
}

export const guides = reactive<CanvasGuide[]>([]);

// ---------- grid settings (persisted) ----------

export interface GridSettings {
  spacing: number;                                  // doc px between major lines, 2..4096
  subdivisions: number;                             // minor lines per major, 1..64 (≤ spacing)
  color: string;                                    // #rrggbb, preset or custom
  style: 'lines' | 'dashed' | 'dots';
  opacity: number;                                  // major-line alpha, 1..100 (%)
}

const GRID_KEY = 'compositor.grid';
const GRID_DEFAULTS: GridSettings = {
  spacing: 64, subdivisions: 8, color: '#c8c8c8', style: 'lines', opacity: 45,
};

/** 10 swatch presets shown in 网格设置; anything else counts as 自定义. */
export const GRID_PRESETS: { label: string; value: string }[] = [
  { label: '浅灰', value: '#c8c8c8' },
  { label: '灰色', value: '#808080' },
  { label: '深灰', value: '#3a3a3a' },
  { label: '白色', value: '#ffffff' },
  { label: '黑色', value: '#000000' },
  { label: '红色', value: '#ff5b5b' },
  { label: '橙色', value: '#ff9f0a' },
  { label: '黄色', value: '#ffd60a' },
  { label: '绿色', value: '#30d158' },
  { label: '蓝色', value: '#4da3ff' },
];

export const gridSettings = reactive<GridSettings>({ ...GRID_DEFAULTS });

function sanitize(raw: Partial<GridSettings> | null): GridSettings {
  const s = { ...GRID_DEFAULTS, ...(raw ?? {}) };
  const spacing = Math.round(clamp(Number(s.spacing) || GRID_DEFAULTS.spacing, 2, 4096));
  const subdivisions = Math.round(
    clamp(Number(s.subdivisions) || GRID_DEFAULTS.subdivisions, 1, Math.min(64, spacing)),
  );
  const opacity = Math.round(clamp(Number(s.opacity) || GRID_DEFAULTS.opacity, 1, 100));
  const style: GridSettings['style'] =
    s.style === 'dashed' || s.style === 'dots' || s.style === 'lines' ? s.style : 'lines';
  const color = /^#[0-9a-fA-F]{6}$/.test(String(s.color)) ? String(s.color).toLowerCase()
    : GRID_DEFAULTS.color;
  return { spacing, subdivisions, color, style, opacity };
}

export function loadGrid(): void {
  let raw: Partial<GridSettings> | null = null;
  try {
    raw = JSON.parse(localStorage.getItem(GRID_KEY) ?? 'null') as Partial<GridSettings> | null;
  } catch { /* corrupted entry — fall back to defaults */ }
  Object.assign(gridSettings, sanitize(raw));
}

export function saveGrid(): void {
  Object.assign(gridSettings, sanitize({ ...gridSettings }));
  try {
    localStorage.setItem(GRID_KEY, JSON.stringify({ ...gridSettings }));
  } catch { /* storage unavailable (private mode) — settings stay in-memory */ }
}

loadGrid();

/** Minor-line alpha derived from the major alpha (45% → 28%). */
export function subdivisionAlpha(): number {
  return clamp((gridSettings.opacity / 100) * (28 / 45), 0, 1);
}

function gridStep(): number {
  return gridSettings.spacing / Math.max(1, gridSettings.subdivisions);
}

/** Document-px positions of every grid line covering the visible viewport. */
export function gridLines(): number[] {
  const step = gridStep();
  const out: number[] = [];
  if (!(step > 0)) return out;
  const lo = Math.min(viewport.left, viewport.top);
  const hi = Math.max(viewport.left + viewport.width, viewport.top + viewport.height);
  const k0 = Math.floor(lo / step);
  const k1 = Math.ceil(hi / step);
  if (k1 - k0 > 10000) return out; // safety valve for pathological zoom-outs
  for (let k = k0; k <= k1; k++) out.push(Math.round(k * step));
  return out;
}

// ---------- snapping ----------

export interface SnapOptions {
  snapDoc: boolean;      // document edges + center
  snapGrid: boolean;     // grid lines
  snapGuides: boolean;   // other guides on the same axis
  layerBox?: { x: number; y: number; w: number; h: number }; // active layer edges + center
}

/** Nearest snap target for a doc-px coordinate, or null when nothing is within tolerance. */
export function snapValue(v: number, axis: 'x' | 'y', opts: SnapOptions): number | null {
  const tol = 10 / viewport.scale; // 10 screen px, expressed in doc px
  let best: number | null = null;
  let bestDist = tol;

  const consider = (target: number): void => {
    const d = Math.abs(target - v);
    if (d <= bestDist) { best = target; bestDist = d; }
  };

  if (opts.snapDoc && store.doc) {
    const size = axis === 'x' ? store.doc.width : store.doc.height;
    consider(0);
    consider(size / 2);
    consider(size);
  }
  if (opts.snapGrid) {
    const step = gridStep();
    if (step > 0) consider(Math.round(v / step) * step);
  }
  if (opts.snapGuides) {
    for (const g of guides) {
      if ((axis === 'x') === (g.axis === 'v')) consider(g.position);
    }
  }
  if (opts.layerBox) {
    const b = opts.layerBox;
    if (axis === 'x') { consider(b.x); consider(b.x + b.w / 2); consider(b.x + b.w); }
    else { consider(b.y); consider(b.y + b.h / 2); consider(b.y + b.h); }
  }
  return best;
}

/** Guide under a document point within 5 screen px, or null. */
export function hitGuide(docX: number, docY: number): CanvasGuide | null {
  const tol = 5 / viewport.scale;
  for (const g of guides) {
    if (g.axis === 'v' && Math.abs(docX - g.position) <= tol) return g;
    if (g.axis === 'h' && Math.abs(docY - g.position) <= tol) return g;
  }
  return null;
}

// ---------- guide mutations (no history — guides are view state) ----------

export function addGuide(axis: 'h' | 'v', position: number): CanvasGuide {
  const g: CanvasGuide = { id: crypto.randomUUID(), axis, position };
  guides.push(g);
  return g;
}

export function moveGuide(id: string, position: number): void {
  const g = guides.find(x => x.id === id);
  if (g) g.position = position;
}

export function removeGuide(id: string): void {
  const i = guides.findIndex(g => g.id === id);
  if (i >= 0) guides.splice(i, 1);
}

// ---------- painting ----------

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha.toFixed(3)})`;
}

/**
 * Paint grid + guides into a screen-space overlay context of size w×h.
 * `drawGrid` honors store.showGrid at the caller's discretion.
 */
export function drawGuidesAndGrid(
  ctx: CanvasRenderingContext2D, w: number, h: number, drawGrid: boolean,
): void {
  ctx.save();

  if (drawGrid) {
    const step = gridStep();
    const subs = Math.max(1, gridSettings.subdivisions);
    const majorAlpha = gridSettings.opacity / 100;
    const subAlpha = subdivisionAlpha();
    // When minor lines collapse below ~3 screen px, draw majors only.
    const lines = step * viewport.scale < 3
      ? gridLines().filter(p => Math.round(p / step) % subs === 0)
      : gridLines();
    for (const p of lines) {
      const k = Math.round(p / step);
      const isMajor = ((k % subs) + subs) % subs === 0;
      ctx.strokeStyle = rgba(gridSettings.color, isMajor ? majorAlpha : subAlpha);
      ctx.setLineDash(
        gridSettings.style === 'dashed' ? [4, 3]
          : gridSettings.style === 'dots' ? [1, 2]
            : [],
      );
      ctx.lineWidth = isMajor ? 1 : 0.5;
      if (gridSettings.style === 'dots') ctx.lineWidth = 1;
      const y = Math.round(docToScreen(0, p)[1]) + 0.5;
      if (y >= -1 && y <= h + 1) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      const x = Math.round(docToScreen(p, 0)[0]) + 0.5;
      if (x >= -1 && x <= w + 1) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
    }
  }

  // Guides: cyan, α 0.9, 1 px, full span.
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,229,255,0.9)';
  for (const g of guides) {
    if (g.axis === 'v') {
      const x = Math.round(docToScreen(g.position, 0)[0]) + 0.5;
      if (x < -1 || x > w + 1) continue;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    } else {
      const y = Math.round(docToScreen(0, g.position)[1]) + 0.5;
      if (y < -1 || y > h + 1) continue;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }

  ctx.restore();
}
