// 文本位图渲染器(活字排版智能体独占)。自 compositor.ts 原样搬移;
// 契约:renderTextBitmap(width, height, text: TextMeta) → HTMLCanvasElement。
// store.upsertTextBitmap 是唯一调用方。
// ranges(逐范围样式):content 按 TextStyleRange 切成样式 run 逐 run 排版,
// 换行 run 感知(跨 run 单词保持各自样式),tracking/baselineShift 逐 run 生效;
// ranges 缺省/空时走 legacy 路径,输出与搬移前基线逐字节一致(回归基线)。
import { makeCanvas, ctx2d } from './canvasUtils';
import { rgbToCss } from './types';
import type { TextMeta, TextStyleRange } from './types';

export function renderTextBitmap(
  width: number, height: number, text: TextMeta,
): HTMLCanvasElement {
  const c = makeCanvas(Math.max(1, width), Math.max(1, height));
  const cx = ctx2d(c);
  const len = cpLength(text.content);
  // 边界钳制:start<0→0,end>len→len,start>=end 忽略
  const ranges = (text.ranges ?? [])
    .map(r => ({ ...r, start: Math.max(0, Math.floor(r.start)), end: Math.min(len, Math.ceil(r.end)) }))
    .filter(r => r.end > r.start);
  if (!ranges.length) {
    renderLegacy(cx, width, text);
  } else {
    renderRanged(cx, width, text, ranges);
  }
  return c;
}

/** content 的 Unicode 码点数(ranges 索引口径)。 */
function cpLength(s: string): number {
  let n = 0;
  for (const it of s) { void it; n++; }
  return n;
}

// ---------- legacy 路径(无 ranges:与搬移前基线逐字节一致,勿动) ----------

function renderLegacy(cx: CanvasRenderingContext2D, width: number, text: TextMeta): void {
  cx.font = `${text.fontSize}px ${cssFontFamily(text.fontName)}`;
  cx.textBaseline = 'top';
  cx.fillStyle = rgbToCss(text.color);
  const wrapWidth = text.boxSize ? text.boxSize[0] : width;
  const lines = wrapText(cx, text.content, wrapWidth, text.tracking);
  lines.forEach((line, i) => {
    const lw = measuredWidth(cx, line, text.tracking);
    const x = text.align === 'center' ? (wrapWidth - lw) / 2
      : text.align === 'right' ? (wrapWidth - lw) : 0;
    drawTracked(cx, line, x, i * text.lineSpacing, text.tracking);
  });
}

function cssFontFamily(postScriptName: string): string {
  // PostScript names like "Helvetica-Bold" → CSS family with weight heuristic
  const m = postScriptName.match(/^(.*?)-(Regular|Bold|Italic|BoldItalic|Light|Semibold|Medium)$/);
  if (!m) return `"${postScriptName}", system-ui, sans-serif`;
  const map: Record<string, string> = {
    Regular: '', Bold: 'bold', Italic: 'italic', BoldItalic: 'bold italic',
    Light: '300', Semibold: '600', Medium: '500',
  };
  return `${map[m[2]] || ''} "${m[1]}", system-ui, sans-serif`.trim();
}

function wrapText(cx: CanvasRenderingContext2D, content: string, maxWidth: number, tracking: number): string[] {
  const out: string[] = [];
  for (const para of content.split('\n')) {
    const words = para.split(' ');
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (measuredWidth(cx, test, tracking) > maxWidth && line) {
        out.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    out.push(line);
  }
  return out;
}

function measuredWidth(cx: CanvasRenderingContext2D, text: string, tracking: number): number {
  return cx.measureText(text).width + tracking * Math.max(0, text.length - 1);
}

function drawTracked(cx: CanvasRenderingContext2D, text: string, x: number, y: number, tracking: number) {
  if (!tracking) { cx.fillText(text, x, y); return; }
  let cur = x;
  for (const ch of text) {
    cx.fillText(ch, cur, y);
    cur += cx.measureText(ch).width + tracking;
  }
}

// ---------- ranged 路径(逐范围字符样式) ----------

/** 单个字符解析后的完整样式(顶层 meta + 命中的第一个定义该字段的 range)。 */
interface ResolvedStyle {
  fontName: string;
  fontSize: number;
  color: [number, number, number];
  bold: boolean;
  italic: boolean;
  tracking: number;
  baselineShift: number;
}

interface Char { ch: string; st: ResolvedStyle }
interface Seg { st: ResolvedStyle; text: string; len: number }

const RANGE_FIELDS = [
  'fontName', 'fontSize', 'color', 'bold', 'italic', 'tracking', 'baselineShift',
] as const;

function resolveStyle(text: TextMeta, ranges: TextStyleRange[], cpIndex: number): ResolvedStyle {
  const st: ResolvedStyle = {
    fontName: text.fontName,
    fontSize: text.fontSize,
    color: text.color,
    bold: false,
    italic: false,
    tracking: text.tracking,
    baselineShift: 0,
  };
  const done: Partial<Record<(typeof RANGE_FIELDS)[number], boolean>> = {};
  for (const r of ranges) {
    if (cpIndex < r.start || cpIndex >= r.end) continue; // [start, end)
    for (const f of RANGE_FIELDS) {
      if (done[f]) continue;               // 重叠范围先到先得(数组序)
      const v: unknown = r[f];
      if (v !== undefined) {
        (st as unknown as Record<string, unknown>)[f] = v;
        done[f] = true;
      }
    }
  }
  return st;
}

/** 仿粗斜体:bold → 权重 700,italic → italic;可叠加。 */
function fontString(st: ResolvedStyle): string {
  const pre = `${st.italic ? 'italic ' : ''}${st.bold ? 'bold ' : ''}`;
  return `${pre}${st.fontSize}px ${cssFontFamily(st.fontName)}`;
}

function styleKey(st: ResolvedStyle): string {
  return `${st.fontName}|${st.fontSize}|${st.color[0]},${st.color[1]},${st.color[2]}`
    + `|${st.bold ? 1 : 0}${st.italic ? 1 : 0}|${st.tracking}|${st.baselineShift}`;
}

/** 相邻同样式字符合并为 run(段)。 */
function segChars(chars: Char[]): Seg[] {
  const out: Seg[] = [];
  let key = '';
  for (const c of chars) {
    const k = styleKey(c.st);
    const last = out[out.length - 1];
    if (last && k === key) { last.text += c.ch; last.len++; }
    else { out.push({ st: c.st, text: c.ch, len: 1 }); key = k; }
  }
  return out;
}

/** 一行宽度:逐 run 度量累加(各 run 字体不同,不能整行一次 measure);
 *  run 内部 = measureText(run) + tracking×(len-1),run 交界补前段末字符的 tracking。 */
function segLineWidth(cx: CanvasRenderingContext2D, chars: Char[]): number {
  const segs = segChars(chars);
  let w = 0;
  for (const s of segs) {
    cx.font = fontString(s.st);
    w += cx.measureText(s.text).width + s.st.tracking * Math.max(0, s.len - 1);
  }
  for (let i = 1; i < segs.length; i++) w += segs[i - 1].st.tracking;
  return w;
}

/** 逐 run 绘制一行:每 run 设 font/fillStyle,baselineShift 用 y 偏移(正上负下)。 */
function segDrawLine(cx: CanvasRenderingContext2D, chars: Char[], x: number, y: number): void {
  let cur = x;
  for (const s of segChars(chars)) {
    cx.font = fontString(s.st);
    cx.fillStyle = rgbToCss(s.st.color);
    const dy = y - s.st.baselineShift;
    if (s.st.tracking) {
      let cxr = cur;
      for (const ch of s.text) {
        cx.fillText(ch, cxr, dy);
        cxr += cx.measureText(ch).width + s.st.tracking;
      }
    } else {
      cx.fillText(s.text, cur, dy);
    }
    // 前进量含每个字符后的 tracking(行末多余的一个不影响布局,只影响下一段起点的一致性)
    cur += cx.measureText(s.text).width + s.st.tracking * s.len;
  }
}

function renderRanged(cx: CanvasRenderingContext2D, width: number, text: TextMeta, ranges: TextStyleRange[]): void {
  cx.textBaseline = 'top';
  const chars: Char[] = [];
  let i = 0;
  for (const ch of text.content) {
    chars.push({ ch, st: resolveStyle(text, ranges, i) });
    i++;
  }
  const wrapWidth = text.boxSize ? text.boxSize[0] : width;

  // 按 '\n' 切段落(保留换行结构),段内 run 感知换行:空白分隔单词,
  // 单词可跨 run(逐字符携带各自样式),换行时丢弃行首空白。
  const paras: Char[][] = [];
  {
    let cur: Char[] = [];
    for (const c of chars) {
      if (c.ch === '\n') { paras.push(cur); cur = []; }
      else cur.push(c);
    }
    paras.push(cur);
  }

  const lines: Char[][] = [];
  for (const para of paras) {
    let line: Char[] = [];
    let sep: Char[] = []; // 待并入下一单词前的空白 run
    let k = 0;
    while (k < para.length) {
      const word: Char[] = [];
      while (k < para.length && para[k].ch !== ' ') { word.push(para[k]); k++; }
      const sp: Char[] = [];
      while (k < para.length && para[k].ch === ' ') { sp.push(para[k]); k++; }
      if (!word.length) { sep = sep.concat(sp); continue; } // 段首空白挂起
      const candidate = line.length ? line.concat(sep, word) : word;
      if (segLineWidth(cx, candidate) > wrapWidth && line.length) {
        lines.push(line);
        line = word; // 换行:行首空白丢弃
      } else {
        line = candidate;
      }
      sep = sp;
    }
    lines.push(line);
  }

  lines.forEach((line, li) => {
    const lw = segLineWidth(cx, line);
    const x = text.align === 'center' ? (wrapWidth - lw) / 2
      : text.align === 'right' ? (wrapWidth - lw) : 0;
    segDrawLine(cx, line, x, li * text.lineSpacing);
  });
}
