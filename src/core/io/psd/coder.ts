// Low-level PSD coders: Pascal strings, UTF-16BE, the Photoshop blend-mode
// signature table, PackBits RLE decoding, and the generic descriptor reader
// shared by TySh (text) and SoCo/vogk (vector) blocks.

import { Cursor } from './cursor';

/** Pascal string; `pad` is the alignment of the whole field (2 = even, 4 for layer names). */
export function readPascalString(cur: Cursor, pad: number): string {
  const len = cur.u8();
  const s = cur.ascii(len);
  const rem = (len + 1) % pad;
  if (rem !== 0) cur.skip(pad - rem);
  return s;
}

/** Reads `charCount` big-endian UTF-16 code units; strips a leading BOM. */
export function utf16be(cur: Cursor, charCount: number): string {
  let s = '';
  for (let i = 0; i < charCount; i++) s += String.fromCharCode(cur.u16());
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// Standard Photoshop blend signature table. All values are the app's BlendMode names.
const BLEND_KEY_MAP: Record<string, string> = {
  'norm': 'Normal',
  'dark': 'Darken',
  'mul ': 'Multiply',
  'idiv': 'Color Burn',
  'lbrn': 'Linear Burn',
  'lite': 'Lighten',
  'scrn': 'Screen',
  'div ': 'Color Dodge',
  'lddg': 'Linear Dodge (Add)',
  'over': 'Overlay',
  'slit': 'Soft Light',
  'hlit': 'Hard Light',
  'vlit': 'Vivid Light',
  'llit': 'Linear Light',
  'plit': 'Pin Light',
  'hmix': 'Hard Mix',
  'diff': 'Difference',
  'smud': 'Exclusion',
  'fsub': 'Subtract',
  'fdiv': 'Divide',
  'hue ': 'Hue',
  'sat ': 'Saturation',
  'colr': 'Color',
  'lum ': 'Luminosity',
  'pass': 'Normal', // pass-through (group default)
};

export function blendModeFromKey(key: string): { mode: string; known: boolean } {
  const mode = BLEND_KEY_MAP[key];
  return mode !== undefined ? { mode, known: true } : { mode: 'Normal', known: false };
}

/**
 * PackBits RLE plane decode: per-plane row-count table (BE u16, u32 when PSB),
 * then per row: i8 n; n >= 0 → n+1 literals; -1..-127 → repeat next byte 1-n
 * times; -128 → no-op. Every write is bounds-checked and the cursor snaps to
 * the advertised row end after each row.
 */
export function decodeRLEPlane(cur: Cursor, width: number, height: number, isPsb: boolean): Uint8Array {
  const out = new Uint8Array(width * height);
  const rowLens: number[] = [];
  for (let y = 0; y < height; y++) rowLens.push(isPsb ? cur.u32() : cur.u16());
  for (let y = 0; y < height; y++) {
    const rowStart = cur.pos;
    const rowEnd = rowStart + rowLens[y];
    const rowCur = cur.sub(rowStart, rowLens[y]);
    const rowLimit = (y + 1) * width;
    let o = y * width;
    while (rowCur.remaining > 0 && o < rowLimit) {
      const n = rowCur.i8();
      if (n >= 0) {
        const count = n + 1;
        if (o + count > rowLimit) throw new Error('RLE 解压数据损坏');
        for (let i = 0; i < count; i++) out[o++] = rowCur.u8();
      } else if (n >= -127) {
        const count = 1 - n;
        if (o + count > rowLimit) throw new Error('RLE 解压数据损坏');
        out.fill(rowCur.u8(), o, o + count);
        o += count;
      } // -128: no-op
    }
    cur.seekTo(rowEnd); // snap to the row end advertised by the table
  }
  return out;
}

// ---------------------------------------------------------------------------
// Descriptor reading (Adobe "Objc" structures). Used for TySh text blocks,
// SoCo solid fills and vogk origination data. Full skip logic for every value
// type so unknown layouts cannot desync the parse.
// ---------------------------------------------------------------------------

export type DescValue =
  | { osType: 'doub'; value: number }
  | { osType: 'UntF'; unit: string; value: number }
  | { osType: 'long' | 'comp' | 'Idnt' | 'indx'; value: number }
  | { osType: 'bool'; value: boolean }
  | { osType: 'TEXT'; value: string }
  | { osType: 'enum'; enumType: string; value: string }
  | { osType: 'tdta' | 'alis'; value: Uint8Array }
  | { osType: 'Objc' | 'GlbO' | 'type'; name: string; id: string; fields: Map<string, DescValue> }
  | { osType: 'VlLs' | 'obj'; items: DescValue[] };

export interface PsdDescriptor {
  name: string;
  id: string;
  fields: Map<string, DescValue>;
}

/** Unicode string: u32 char count + count×u16 big-endian. */
export function readUnicodeString(cur: Cursor): string {
  const count = cur.u32();
  return count === 0 ? '' : utf16be(cur, count);
}

/** String ID: u32 length + ASCII bytes (empty when the length is 0). */
export function readId(cur: Cursor): string {
  const len = cur.u32();
  return len === 0 ? '' : cur.ascii(len);
}

/** Number from the numeric descriptor flavours; null for anything else. */
export function descNumber(v: DescValue | undefined): number | null {
  if (!v) return null;
  if (v.osType === 'doub' || v.osType === 'UntF' || v.osType === 'long' || v.osType === 'comp' || v.osType === 'Idnt' || v.osType === 'indx') return v.value;
  return null;
}

function readDescriptorItems(cur: Cursor, count: number, depth: number): Map<string, DescValue> {
  if (depth > 32) throw new Error('描述符嵌套过深');
  const fields = new Map<string, DescValue>();
  for (let i = 0; i < count; i++) {
    const key = readId(cur);
    fields.set(key === '' ? `#${i}` : key, readDescValue(cur, depth));
  }
  return fields;
}

/** Full descriptor: u32 magic (== 16) + 16-char Unicode class string + id + items. */
export function readDescriptor(cur: Cursor): PsdDescriptor {
  const magic = cur.u32();
  if (magic !== 16) throw new Error('描述符格式错误');
  const name = utf16be(cur, 16);
  const id = readId(cur);
  const count = cur.u32();
  return { name, id, fields: readDescriptorItems(cur, count, 0) };
}

function readObjcBody(cur: Cursor, depth: number): { name: string; id: string; fields: Map<string, DescValue> } {
  const name = readUnicodeString(cur);
  const id = readId(cur);
  const count = cur.u32();
  return { name, id, fields: readDescriptorItems(cur, count, depth + 1) };
}

function readDescValue(cur: Cursor, depth: number): DescValue {
  const osType = cur.ascii(4);
  switch (osType) {
    case 'doub':
      return { osType: 'doub', value: cur.f64() };
    case 'UntF': {
      const unit = cur.ascii(4);
      return { osType: 'UntF', unit, value: cur.f64() };
    }
    case 'long':
      return { osType: 'long', value: cur.i32() };
    case 'comp': // 64-bit long; never seen in practice in TySh/SoCo/vogk
      cur.skip(4);
      return { osType: 'comp', value: cur.i32() };
    case 'bool':
      return { osType: 'bool', value: cur.u8() !== 0 };
    case 'TEXT':
      return { osType: 'TEXT', value: readUnicodeString(cur) };
    case 'enum': {
      const enumType = readId(cur);
      const value = readId(cur);
      return { osType: 'enum', enumType, value };
    }
    case 'tdta': {
      const len = cur.u32();
      return { osType: 'tdta', value: cur.slice(len) };
    }
    case 'alis': {
      const len = cur.u32();
      return { osType: 'alis', value: cur.slice(len) };
    }
    case 'Objc':
    case 'GlbO':
    case 'type':
      return { osType: 'Objc', ...readObjcBody(cur, depth) };
    case 'VlLs': {
      const count = cur.u32();
      const items: DescValue[] = [];
      for (let i = 0; i < count; i++) items.push(readDescValue(cur, depth + 1));
      return { osType: 'VlLs', items };
    }
    case 'obj ': {
      // Reference: list of typed items (prop/clss/enmr/rele/Idnt/indx/name).
      const count = cur.u32();
      const items: DescValue[] = [];
      for (let i = 0; i < count; i++) {
        const ref = cur.ascii(4);
        switch (ref) {
          case 'prop':
          case 'clss':
            readUnicodeString(cur);
            readId(cur);
            items.push({ osType: 'TEXT', value: '' });
            break;
          case 'enmr': {
            readUnicodeString(cur);
            readId(cur);
            const et = readId(cur);
            const ev = readId(cur);
            items.push({ osType: 'enum', enumType: et, value: ev });
            break;
          }
          case 'rele':
            cur.skip(4);
            readId(cur);
            items.push({ osType: 'long', value: 0 });
            break;
          case 'Idnt':
          case 'indx':
            items.push({ osType: 'long', value: cur.i32() });
            break;
          case 'name': {
            const cls = readUnicodeString(cur);
            const nm = readUnicodeString(cur);
            items.push({ osType: 'TEXT', value: nm || cls });
            break;
          }
          default:
            throw new Error(`未知引用类型: ${ref}`);
        }
      }
      return { osType: 'obj', items };
    }
    default:
      // Cannot skip an unknown value type safely.
      throw new Error(`未知描述符类型: ${osType}`);
  }
}
