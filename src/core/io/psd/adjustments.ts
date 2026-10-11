// Adjustment-layer data parsing: 'levl', 'curv', 'hue2'/'hue ' are mapped onto
// the app's live adjustment settings; other adjustment keys are recognised so
// the builder can note that they were skipped. Ported from the Swift
// implementation.

import { Cursor } from './cursor';
import type { CurvePoint, CurvesSettings, HueSatSettings, LevelsRange, LevelsSettings } from '../../types';

export interface PsdAdjustmentDraft {
  kind: string; // app AdjustmentKind name
  data: unknown; // the matching settings interface from core/types.ts
}

export function parseAdjustment(key: string, data: Uint8Array): PsdAdjustmentDraft | null {
  switch (key) {
    case 'levl': return parseLevels(data);
    case 'curv': return parseCurves(data);
    case 'hue2':
    case 'hue ': return parseHueSat(data);
    default: return null;
  }
}

// Human-readable labels for detected-but-unsupported adjustment keys.
const SKIPPED_KEYS: Record<string, string> = {
  brit: '亮度/对比度',
  expA: '曝光度',
  nvrt: '反相',
  blwh: '黑白',
  vibA: '自然饱和度',
  mixr: '通道混合器',
  grdm: '渐变映射',
  selc: '可选颜色',
  phfl: '照片滤镜',
  thrs: '阈值',
};

export function skippedAdjustmentLabel(key: string): string | null {
  return SKIPPED_KEYS[key] ?? null;
}

/**
 * 'levl': 2-byte version + 4×10-byte records (RGB first, then R/G/B).
 * Record layout as read by the ported implementation:
 * bytes 0-1 black, 2-3 gamma (BE u16 / 256), 4-5 white, 6-7 output black,
 * 8-9 output white.
 */
function parseLevels(data: Uint8Array): PsdAdjustmentDraft | null {
  const cur = new Cursor(data);
  cur.u16(); // version
  const ranges: LevelsRange[] = [];
  for (let i = 0; i < 4; i++) {
    let black = cur.u16();
    let gamma = cur.u16() / 256;
    let white = cur.u16();
    const outputBlack = Math.min(cur.u16(), 255);
    const outputWhite = Math.min(cur.u16(), 255);
    black = Math.min(black, 255);
    white = Math.min(white, 255);
    if (white < black) { const t = white; white = black; black = t; }
    if (!(gamma > 0) || !isFinite(gamma)) gamma = 1;
    ranges.push({ black, gamma, white, outputBlack, outputWhite });
  }
  const settings: LevelsSettings = { channel: 'RGB', ranges };
  return { kind: 'Levels', data: settings };
}

/**
 * 'curv': version byte 1 (single composite curve: u16 point count + points)
 * or version 4 (u32 channel count, then per channel u32 point count + points).
 * Points are stored vertical(output) first, then horizontal(input). Channel
 * index 0 is the RGB composite and is copied to all four of our channels.
 */
function parseCurves(data: Uint8Array): PsdAdjustmentDraft | null {
  const cur = new Cursor(data);
  const parsed: CurvePoint[][] = [];
  const v = cur.u8();
  if (v === 1) {
    parsed.push(readCurvePoints(cur, cur.u16()));
  } else if (v === 4) {
    cur.skip(3);
    const channelCount = cur.u32();
    for (let c = 0; c < channelCount && c <= 4; c++) parsed.push(readCurvePoints(cur, cur.u32()));
  } else {
    return null;
  }
  const channels: CurvePoint[][] = Array.from({ length: 4 }, () => [{ x: 0, y: 0 }, { x: 255, y: 255 }]);
  if (parsed.length > 0 && parsed[0].length >= 2) {
    for (let i = 0; i < 4; i++) channels[i] = parsed[0];
  } else {
    for (let i = 1; i <= 3; i++) if (parsed[i] && parsed[i].length >= 2) channels[i] = parsed[i];
  }
  const settings: CurvesSettings = { channel: 'RGB', channels };
  return { kind: 'Curves', data: settings };
}

function readCurvePoints(cur: Cursor, count: number): CurvePoint[] {
  if (count > 2048) throw new Error('curv 数据损坏');
  const points: CurvePoint[] = [];
  for (let i = 0; i < count; i++) {
    const y = cur.i16(); // output (vertical) first
    const x = cur.i16(); // input (horizontal) second
    points.push({ x: Math.min(Math.max(x, 0), 255), y: Math.min(Math.max(y, 0), 255) });
  }
  return points;
}

/**
 * 'hue2'/'hue ': 2-byte version + hue/saturation/lightness i16 BE + colorize
 * flag + 6 range bands. The flag is read as u16 so both the 1-byte and 2-byte
 * layouts stay aligned (the bands are skipped by discarding the cursor). PSD
 * stores percent values on the same -100..100 scale our Hue/Saturation uses;
 * hue is degrees.
 */
function parseHueSat(data: Uint8Array): PsdAdjustmentDraft | null {
  const cur = new Cursor(data);
  cur.u16(); // version
  const hue = Math.min(Math.max(cur.i16(), -180), 180);
  const saturation = Math.min(Math.max(cur.i16(), -100), 100);
  const lightness = Math.min(Math.max(cur.i16(), -100), 100);
  const colorize = cur.u16() !== 0;
  const settings: HueSatSettings = { hue, saturation, lightness, colorize, colorizeHue: 0, colorizeSat: 25 };
  return { kind: 'Hue/Saturation', data: settings };
}
