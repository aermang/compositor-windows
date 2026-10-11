// Text layer parsing (TySh/tySh). The descriptor is walked with the generic
// reader in coder.ts; 'Txt ' gives the string, style comes from the EngineData
// blob (a UTF-8 PostScript-ish structure). The 2×3 matrix is decomposed into
// uniform scale + rotation + flipY; sheared/non-uniform text is left as raster.
// Ported from the Swift implementation.

import { Cursor } from './cursor';
import { readDescriptor } from './coder';
import type { DescValue } from './coder';
import type { PsdTextDraft } from './types';

const MAX_TEXT_BLOCK = 8 * 1024 * 1024; // 8 MB

export function parseTextLayer(data: Uint8Array, note: (msg: string) => void): PsdTextDraft | null {
  if (data.length > MAX_TEXT_BLOCK) {
    note('文字数据超过 8MB，已按栅格导入');
    return null;
  }
  const cur = new Cursor(data);
  if (cur.u16() !== 1) {
    note('不支持的文字图层版本，已按栅格导入');
    return null;
  }
  // Transform: 6×f64 — XX XY YX YY TX TY (glyph space → document space).
  const xx = cur.f64(), xy = cur.f64(), yx = cur.f64(), yy = cur.f64();
  cur.f64(); // TX — position comes from the layer bounds
  cur.f64(); // TY
  if (cur.u16() !== 50) {
    note('文字描述符版本不正确，已按栅格导入');
    return null;
  }
  let fields: Map<string, DescValue> | null = null;
  try {
    fields = readDescriptor(cur).fields;
  } catch {
    note('文字描述符解析失败，已按栅格导入');
    return null;
  }

  const txtVal = fields.get('Txt ') ?? fields.get('Txt');
  const descriptorText = txtVal && txtVal.osType === 'TEXT' ? txtVal.value : null;
  const engineVal = fields.get('EngineData');
  const engineBytes = engineVal && engineVal.osType === 'tdta' ? engineVal.value : null;
  const engineString = engineVal && engineVal.osType === 'TEXT' ? engineVal.value : null;

  const ed = engineBytes
    ? parseEngineData(engineBytes)
    : engineString !== null
      ? parseEngineData(new TextEncoder().encode(engineString))
      : null;
  const text = descriptorText ?? asStr(edGet(ed, 'EngineDict', 'Editor', 'Text'));
  if (text === null) {
    note('未找到文字内容，已按栅格导入');
    return null;
  }

  // Style: RunArray[0].StyleSheet(→).StyleSheetData
  const run0 = asList(edGet(ed, 'EngineDict', 'RunArray'))?.[0] ?? null;
  const style = asMap(edGet(run0, 'StyleSheetData')) ?? asMap(edGet(run0, 'StyleSheet', 'StyleSheetData'));
  const fontSize = style ? asNum(style.get('FontSize')) : null;
  if (style === null || fontSize === null) {
    note('文字样式信息缺失，已按栅格导入');
    return null;
  }
  const fillValues = asList(edGet(style, 'FillColor', 'Values'));
  const rgb: [number, number, number] = [
    clamp255(asNum(fillValues?.[0]) ?? 0),
    clamp255(asNum(fillValues?.[1]) ?? 0),
    clamp255(asNum(fillValues?.[2]) ?? 0),
  ];
  const fontIndex = Math.max(0, Math.round(asNum(style.get('Font')) ?? 0));
  const fontSet = asList(edGet(ed, 'ResourceDict', 'FontSet'));
  const fontEntry = fontSet ? asMap(fontSet[Math.min(fontIndex, fontSet.length - 1)]) : null;
  const font = asStr(fontEntry?.get('Name')) ?? 'sans-serif';
  const tracking = asNum(style.get('Tracking')) ?? 0;

  // Matrix decomposition: uniform scale + rotation + flipY.
  const scale = Math.hypot(xx, xy);
  const scaleY = Math.hypot(yx, yy);
  if (!(scale > 0) || !(scaleY > 0)) {
    note('文字变换矩阵无效，已按栅格导入');
    return null;
  }
  const nonUniform = Math.abs(scaleY - scale) / scale;
  const shear = Math.abs(xx * yx + xy * yy) / (scale * scaleY);
  if (nonUniform > 0.02 || shear > 0.02) {
    note('文字含非均匀/斜切变换，已按栅格导入');
    return null;
  }
  const rotation = (Math.atan2(xy, xx) * 180) / Math.PI;
  const det = xx * yy - xy * yx;
  // Glyph space is Y-up: normal horizontal text has a negative determinant.
  // flipY is true only for mirrored/vertically flipped text (det > 0).
  const flipY = det > 0;

  return {
    text,
    font,
    sizePx: fontSize * scale,
    colorCss: `rgb(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])})`,
    rotation,
    flipY,
    trackingPx: (fontSize * scale * tracking) / 1000,
  };
}

// ---------------------------------------------------------------------------
// EngineData: UTF-8 PostScript-ish tokenizer. Dicts (<< /Key value >>),
// arrays, (...) strings with octal escapes, <hex> strings, /names, numbers,
// bare true/false, % comments. Strings may be UTF-16BE with BOM or Latin-1.
// ---------------------------------------------------------------------------

function parseEngineData(bytes: Uint8Array): Map<string, unknown> | null {
  const n = bytes.length;
  let pos = 0;

  function isDelim(b: number): boolean {
    return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0c || b === 0x00 ||
      b === 0x25 /* % */ || b === 0x28 /* ( */ || b === 0x29 /* ) */ ||
      b === 0x3c /* < */ || b === 0x3e /* > */ || b === 0x5b /* [ */ || b === 0x5d /* ] */ || b === 0x2f /* / */;
  }

  function skipWs(): void {
    while (pos < n) {
      const b = bytes[pos];
      if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0c || b === 0x00) {
        pos++;
      } else if (b === 0x25 /* % */) {
        while (pos < n && bytes[pos] !== 0x0a && bytes[pos] !== 0x0d) pos++;
      } else {
        break;
      }
    }
  }

  function latin1(raw: Uint8Array): string {
    let s = '';
    for (let i = 0; i < raw.length; i++) s += String.fromCharCode(raw[i]);
    return s;
  }

  function decodeBytes(raw: number[]): string {
    if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
      let s = '';
      for (let i = 2; i + 1 < raw.length; i += 2) s += String.fromCharCode((raw[i] << 8) | raw[i + 1]);
      return s;
    }
    const utf8 = new TextDecoder('utf-8').decode(new Uint8Array(raw));
    return utf8.includes('�') ? latin1(new Uint8Array(raw)) : utf8;
  }

  function parseString(): string {
    pos++; // consume '('
    const out: number[] = [];
    let depth = 1;
    while (pos < n) {
      const b = bytes[pos++];
      if (b === 0x5c /* \ */) {
        if (pos >= n) break;
        const e = bytes[pos++];
        if (e === 0x6e) out.push(0x0a);        // \n
        else if (e === 0x72) out.push(0x0d);   // \r
        else if (e === 0x74) out.push(0x09);   // \t
        else if (e === 0x62) out.push(0x08);   // \b
        else if (e === 0x66) out.push(0x0c);   // \f
        else if (e >= 0x30 && e <= 0x37) {     // octal escape, up to 3 digits
          let v = e - 0x30, count = 1;
          while (count < 3 && pos < n && bytes[pos] >= 0x30 && bytes[pos] <= 0x37) {
            v = v * 8 + (bytes[pos++] - 0x30);
            count++;
          }
          out.push(v & 0xff);
        } else if (e === 0x0a || e === 0x0d) {
          // line continuation — nothing
        } else {
          out.push(e); // \( \) \\ and anything else literal
        }
      } else if (b === 0x28 /* ( */) {
        depth++;
        out.push(b);
      } else if (b === 0x29 /* ) */) {
        if (--depth === 0) break;
        out.push(b);
      } else {
        out.push(b);
      }
    }
    return decodeBytes(out);
  }

  function parseHexString(): string {
    pos++; // consume '<'
    const out: number[] = [];
    let hi = -1;
    while (pos < n) {
      const b = bytes[pos++];
      if (b === 0x3e /* > */) break;
      const c = String.fromCharCode(b);
      let v = -1;
      if (c >= '0' && c <= '9') v = b - 0x30;
      else if (c >= 'a' && c <= 'f') v = b - 0x57;
      else if (c >= 'A' && c <= 'F') v = b - 0x37;
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out.push((hi << 4) | v);
        hi = -1;
      }
    }
    return decodeBytes(out);
  }

  function parseName(): string {
    pos++; // consume '/'
    const start = pos;
    while (pos < n && !isDelim(bytes[pos])) pos++;
    return latin1(bytes.subarray(start, pos));
  }

  function parseNumber(first: number): number {
    let s = String.fromCharCode(first);
    while (pos < n) {
      const c = String.fromCharCode(bytes[pos]);
      if ((c >= '0' && c <= '9') || c === '.' || c === 'e' || c === 'E' || c === '+' || c === '-') {
        s += c;
        pos++;
      } else {
        break;
      }
    }
    return parseFloat(s);
  }

  function parseWord(first: number): unknown {
    let s = String.fromCharCode(first);
    while (pos < n) {
      const c = String.fromCharCode(bytes[pos]);
      if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '-' || c === '.' || c === '*' || c === '#') {
        s += c;
        pos++;
      } else {
        break;
      }
    }
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null') return null;
    const v = parseFloat(s);
    return isNaN(v) ? s : v;
  }

  function parseValue(): unknown {
    skipWs();
    if (pos >= n) return null;
    const b = bytes[pos];
    if (b === 0x3c /* < */) {
      if (pos + 1 < n && bytes[pos + 1] === 0x3c) return parseDict();
      return parseHexString();
    }
    if (b === 0x28 /* ( */) return parseString();
    if (b === 0x2f /* / */) return parseName();
    if (b === 0x5b /* [ */) return parseArray();
    if (b === 0x2d || b === 0x2b || (b >= 0x30 && b <= 0x39) || b === 0x2e) {
      pos++;
      return parseNumber(b);
    }
    if ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)) {
      pos++;
      return parseWord(b);
    }
    pos++; // unknown byte — tolerate
    return null;
  }

  function parseDict(): Map<string, unknown> {
    pos += 2; // <<
    const map = new Map<string, unknown>();
    for (;;) {
      skipWs();
      if (pos >= n) break;
      if (bytes[pos] === 0x3e /* > */) {
        pos += pos + 1 < n && bytes[pos + 1] === 0x3e ? 2 : 1;
        break;
      }
      if (bytes[pos] !== 0x2f /* / */) {
        pos++;
        continue;
      }
      const key = parseName();
      map.set(key, parseValue());
    }
    return map;
  }

  function parseArray(): unknown[] {
    pos++; // [
    const arr: unknown[] = [];
    for (;;) {
      skipWs();
      if (pos >= n) break;
      if (bytes[pos] === 0x5d /* ] */) {
        pos++;
        break;
      }
      arr.push(parseValue());
    }
    return arr;
  }

  skipWs();
  const root = parseValue();
  return root instanceof Map ? root : null;
}

// --- EngineData value accessors --------------------------------------------

function asMap(v: unknown): Map<string, unknown> | null {
  return v instanceof Map ? v : null;
}

function asList(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

function asNum(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function asStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function edGet(v: unknown, ...path: string[]): unknown {
  let cur: unknown = v;
  for (const key of path) {
    if (!(cur instanceof Map)) return null;
    cur = cur.get(key);
  }
  return cur ?? null;
}

function clamp255(v: number): number {
  return Math.min(Math.max(Math.round(v), 0), 255);
}
