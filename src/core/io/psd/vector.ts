// Vector mask parsing: vmsk/vsms path records, vogk origination data and SoCo
// solid fills. Produces a parametric PsdShapeDraft for rectangles/rounded
// rectangles/ellipses with a solid fill; anything else is rasterized through
// Path2D. Ported from the Swift implementation.

import { Cursor } from './cursor';
import { readDescriptor, descNumber } from './coder';
import type { DescValue } from './coder';
import { makeCanvas, ctx2d } from '../../canvasUtils';
import type { PsdShapeDraft } from './types';

export interface PsdPathPoint { x: number; y: number } // document pixels
export interface PsdKnot { pre: PsdPathPoint; anchor: PsdPathPoint; post: PsdPathPoint }
export interface PsdSubpath { closed: boolean; knots: PsdKnot[] }

/**
 * vmsk/vsms: 8-byte header + records of 26 bytes. Type i16: 0/3 = subpath
 * length (0 closed, 3 open); 1/2/4/5 = Bezier knots with 3 points (preceding
 * control, anchor, following control), each 2×i32 fixed-point /0x1000000,
 * stored y-then-x and normalized by the document size. Types 6/7/8 (fill rule
 * etc.) are ignored.
 */
export function parseVectorMask(data: Uint8Array, docWidth: number, docHeight: number): PsdSubpath[] {
  const cur = new Cursor(data);
  if (cur.remaining < 8) return [];
  cur.skip(8);
  const subpaths: PsdSubpath[] = [];
  let current: PsdSubpath | null = null;
  const readPoint = (c: Cursor): PsdPathPoint => {
    const y = (c.i32() / 0x1000000) * docHeight; // y first
    const x = (c.i32() / 0x1000000) * docWidth;
    return { x, y };
  };
  while (cur.remaining >= 26) {
    const type = cur.i16();
    const rest = cur.sub(cur.pos, 24);
    cur.skip(24);
    if (type === 0 || type === 3) {
      current = { closed: type === 0, knots: [] };
      subpaths.push(current);
    } else if (type === 1 || type === 2 || type === 4 || type === 5) {
      if (!current) {
        current = { closed: true, knots: [] };
        subpaths.push(current);
      }
      current.knots.push({ pre: readPoint(rest), anchor: readPoint(rest), post: readPoint(rest) });
    }
  }
  return subpaths;
}

export interface PsdSolidFill {
  rgb: [number, number, number]; // 0..255
  css: string;
}

/** SoCo: u32 version + descriptor whose 'Clr ' object holds Rd/Grn/Blu doubles. */
export function parseSoCo(data: Uint8Array): PsdSolidFill | null {
  try {
    const cur = new Cursor(data);
    cur.u32(); // version (16)
    const desc = readDescriptor(cur);
    const clr = desc.fields.get('Clr ');
    if (!clr || !isObjc(clr)) return null;
    const r = descNumber(clr.fields.get('Rd '));
    const g = descNumber(clr.fields.get('Grn'));
    const b = descNumber(clr.fields.get('Blu'));
    if (r === null || g === null || b === null) return null;
    const rgb: [number, number, number] = [clamp255(r), clamp255(g), clamp255(b)];
    return { rgb, css: `rgb(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])})` };
  } catch {
    return null;
  }
}

export interface PsdVogk {
  shapeType: string | null; // keyOriginShapeType enum value
  radii: number[] | null;   // keyOriginRRectRadii: TL, TR, BL, BR in px
}

/** vogk: u32 version + descriptor with the shape's origination settings. */
export function parseVogk(data: Uint8Array): PsdVogk | null {
  try {
    const cur = new Cursor(data);
    cur.u32(); // version
    const desc = readDescriptor(cur);
    const st = desc.fields.get('keyOriginShapeType');
    const shapeType = st && st.osType === 'enum' ? st.value : null;
    const rr = desc.fields.get('keyOriginRRectRadii');
    let radii: number[] | null = null;
    if (rr && isObjc(rr)) {
      const vals: (number | null)[] = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight']
        .map(k => descNumber(rr.fields.get(k)));
      if (vals.every(v => v !== null)) radii = vals as number[];
    }
    return { shapeType, radii };
  } catch {
    return null;
  }
}

/**
 * Shape-draft detection: vogk origination says rectangle (enum like 'Rct ' /
 * 'Rrnd', or numeric type 1/2) or ellipse ('Elps' / numeric 5), or the path is
 * one closed subpath of four sharp-corner anchors. A solid SoCo fill must
 * exist; rounded rectangles additionally need near-equal corner radii.
 */
export function buildShapeDraft(
  subpaths: PsdSubpath[],
  vogk: PsdVogk | null,
  fill: PsdSolidFill | null,
): PsdShapeDraft | null {
  if (!fill) return null;
  const shapeType = vogk?.shapeType ?? null;
  const numeric = shapeType !== null && shapeType !== '' ? parseInt(shapeType, 10) : NaN;
  const isRect = (shapeType !== null && /rct|rect/i.test(shapeType)) || numeric === 1 || numeric === 2;
  const isEllipse = (shapeType !== null && /elps|ellipse|oval/i.test(shapeType)) || numeric === 5;
  if (isEllipse) return { kind: 'ellipse', radius: 0, fillCss: fill.css, fillRgb: fill.rgb };
  if (isRect) {
    const radii = vogk?.radii ?? null;
    if (radii && radii.length === 4) {
      const max = Math.max(...radii);
      const min = Math.min(...radii);
      const avg = radii.reduce((a, b) => a + b, 0) / 4;
      if (max > 0.5 && max - min <= Math.max(1, avg * 0.1)) {
        return { kind: 'roundedRectangle', radius: Math.round(avg), fillCss: fill.css, fillRgb: fill.rgb };
      }
    }
    return { kind: 'rectangle', radius: 0, fillCss: fill.css, fillRgb: fill.rgb };
  }
  if (subpaths.length === 1 && subpaths[0].closed && subpaths[0].knots.length === 4) {
    const sharp = subpaths[0].knots.every(k =>
      Math.hypot(k.pre.x - k.anchor.x, k.pre.y - k.anchor.y) <= 0.75 &&
      Math.hypot(k.post.x - k.anchor.x, k.post.y - k.anchor.y) <= 0.75);
    if (sharp) return { kind: 'rectangle', radius: 0, fillCss: fill.css, fillRgb: fill.rgb };
  }
  return null;
}

/** Fills the generic bezier path (document coords) into a layer-local raster. */
export function rasterizeSubpaths(
  subpaths: PsdSubpath[],
  origin: { x: number; y: number; w: number; h: number },
  fillCss: string | null,
): HTMLCanvasElement | null {
  if (origin.w <= 0 || origin.h <= 0) return null;
  const canvas = makeCanvas(origin.w, origin.h);
  const ctx = ctx2d(canvas);
  const path = new Path2D();
  for (const sp of subpaths) {
    const ks = sp.knots;
    if (ks.length === 0) continue;
    path.moveTo(ks[0].anchor.x - origin.x, ks[0].anchor.y - origin.y);
    const last = sp.closed ? ks.length : ks.length - 1;
    for (let i = 0; i < last; i++) {
      const a = ks[i];
      const b = ks[(i + 1) % ks.length];
      path.bezierCurveTo(
        a.post.x - origin.x, a.post.y - origin.y,
        b.pre.x - origin.x, b.pre.y - origin.y,
        b.anchor.x - origin.x, b.anchor.y - origin.y,
      );
    }
    if (sp.closed) path.closePath();
  }
  ctx.fillStyle = fillCss ?? 'rgb(0,0,0)';
  ctx.fill(path);
  return canvas;
}

function isObjc(v: DescValue): v is Extract<DescValue, { fields: Map<string, DescValue> }> {
  return v.osType === 'Objc' || v.osType === 'GlbO' || v.osType === 'type';
}

function clamp255(v: number): number {
  return Math.min(Math.max(Math.round(v), 0), 255);
}
