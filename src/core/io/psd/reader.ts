// PSD/PSB format parser: header, color mode data, image resources, and the
// layer & mask section (records + channel image data). Produces raw layer
// structures; interpretation (groups, canvases, adjustments, text, vector)
// happens in builder.ts. Ported from the Swift implementation.

import { Cursor } from './cursor';
import { decodeRLEPlane, readPascalString, utf16be } from './coder';
import type { PsdChannelInfo, PsdDocument, PsdRawLayer, PsdRawMask } from './types';

// Keys whose additional-info block length grows to u64 in PSB files.
const PSB_LEN_KEYS = new Set([
  'LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph',
  'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD',
]);

export function parsePsd(buffer: ArrayBuffer): PsdDocument {
  const cur = new Cursor(buffer);

  // --- Header ---
  if (cur.ascii(4) !== '8BPS') throw new Error('不是有效的 PSD 文件');
  const version = cur.u16();
  if (version !== 1 && version !== 2) throw new Error('不支持的 PSD 版本');
  const isPsb = version === 2;
  cur.skip(6); // reserved
  cur.u16();   // composite channel count — ignored
  const height = cur.u32();
  const width = cur.u32();
  if (cur.u16() !== 8) throw new Error('仅支持 8 位 RGB');
  if (cur.u16() !== 3) throw new Error('仅支持 RGB 颜色模式');

  const notes: string[] = [];
  const doc: PsdDocument = { width, height, resolution: 72, isPsb, layers: [], notes };

  // --- Color Mode Data ---
  cur.skip(cur.u32());

  // --- Image Resources ---
  const res = readSection(cur, false); // length stays u32 even in PSB
  while (res.remaining >= 12) {
    const sig = res.ascii(4);
    if (sig !== '8BIM') break;
    const id = res.u16();
    readPascalString(res, 2); // padded to even
    const len = res.u32();
    const data = res.slice(len + (len % 2)); // padded to odd
    if (id === 1005 && len >= 4) {
      // Resolution: fixed-point u32 / 65536 (dpi).
      const v = new DataView(data.buffer, data.byteOffset).getUint32(0) / 65536;
      if (v > 0 && isFinite(v)) doc.resolution = v;
    }
    if (id === 1039 && len > 0) {
      // ICC profile: the whole resource; odd lengths carry one pad byte.
      doc.iccProfile = data.subarray(0, len);
    }
  }

  // --- Layer & Mask ---
  const lm = readSection(cur, isPsb);
  if (lm.remaining < 4) return doc; // no layer info → caller falls back to the composite
  const innerLen = Math.min(isPsb ? lm.u64() : lm.u32(), lm.remaining);
  if (innerLen < 4) return doc;
  const li = lm.sub(lm.pos, innerLen);

  const layerCount = Math.abs(li.i16());
  for (let i = 0; i < layerCount; i++) doc.layers.push(readLayerRecord(li, isPsb));
  // Channel image data follows all records, in the same layer/channel order.
  for (const layer of doc.layers) decodeChannelData(li, layer, isPsb, notes);
  // Global layer mask info + remaining tagged blocks are intentionally skipped.

  return doc;
}

function readSection(cur: Cursor, isPsb: boolean): Cursor {
  const len = isPsb ? cur.u64() : cur.u32();
  const avail = Math.min(len, cur.remaining); // clamp advertised lengths to the file
  const s = cur.sub(cur.pos, avail);
  cur.skip(avail);
  return s;
}

function readLayerRecord(cur: Cursor, isPsb: boolean): PsdRawLayer {
  const rect = { top: cur.i32(), left: cur.i32(), bottom: cur.i32(), right: cur.i32() };
  const channelCount = cur.u16();
  const channels: PsdChannelInfo[] = [];
  for (let i = 0; i < channelCount; i++) {
    const id = cur.i16();
    const length = isPsb ? cur.u64() : cur.u32();
    channels.push({ id, length });
  }
  if (cur.ascii(4) !== '8BIM') throw new Error('PSD 图层记录签名错误');
  const blendKey = cur.ascii(4);
  const opacity = cur.u8();
  const clipping = cur.u8();
  const flags = cur.u8();
  cur.skip(1); // filler byte (must be zero)

  const extraLen = cur.u32();
  const extra = cur.sub(cur.pos, extraLen);
  cur.skip(extraLen);

  const layer: PsdRawLayer = {
    pascalName: '',
    luniName: null,
    rect,
    channels,
    blendKey,
    opacity,
    fillOpacity: 255,
    clipping,
    flags,
    mask: null,
    sectionType: null,
    extra: new Map(),
    planes: new Map(),
  };

  // --- Extra data ---
  // Layer mask data
  const maskLen = extra.u32();
  if (maskLen >= 20) {
    const m = extra.sub(extra.pos, maskLen);
    const mrect = { top: m.i32(), left: m.i32(), bottom: m.i32(), right: m.i32() };
    const defaultColor = m.u8();
    const mflags = m.u8();
    const mask: PsdRawMask = { rect: mrect, defaultColor, flags: mflags };
    layer.mask = mask;
  }
  extra.skip(maskLen);
  // Layer blending ranges — skipped
  extra.skip(extra.u32());
  // Pascal name, padded to 4
  layer.pascalName = readPascalString(extra, 4);
  // Additional layer info blocks
  while (extra.remaining >= 12) {
    const sig = extra.ascii(4);
    if (sig !== '8BIM' && sig !== '8B64') break;
    const key = extra.ascii(4);
    const len64 = sig === '8B64' || (isPsb && PSB_LEN_KEYS.has(key));
    const len = len64 ? extra.u64() : extra.u32();
    const data = extra.slice(len + (len % 2)); // odd lengths are padded
    switch (key) {
      case 'luni': {
        // u32 char count + count×u16 UTF-16BE → real name.
        try {
          const c = new Cursor(data);
          layer.luniName = utf16be(c, c.u32());
        } catch {
          /* malformed name — keep the Pascal name */
        }
        break;
      }
      case 'iOPa': {
        // Fill opacity: first byte.
        if (data.length >= 1) layer.fillOpacity = data[0];
        break;
      }
      case 'lsct':
      case 'lsdk': {
        // Section type: 0 any, 1 open folder, 2 closed folder, 3 divider.
        try {
          layer.sectionType = new Cursor(data).u32();
        } catch {
          /* ignore malformed section type */
        }
        break;
      }
      default:
        layer.extra.set(key, data.subarray(0, Math.min(len, data.length)));
    }
  }
  return layer;
}

function decodeChannelData(cur: Cursor, layer: PsdRawLayer, isPsb: boolean, notes: string[]): void {
  const w = layer.rect.right - layer.rect.left;
  const h = layer.rect.bottom - layer.rect.top;
  for (const ch of layer.channels) {
    const dataCur = cur.sub(cur.pos, ch.length);
    cur.skip(ch.length);
    // Only {-2 mask, -1 alpha, 0/1/2 RGB} are decoded; others are skipped by length.
    if (ch.id !== -2 && ch.id !== -1 && ch.id !== 0 && ch.id !== 1 && ch.id !== 2) continue;
    const isMask = ch.id === -2;
    if (isMask && !layer.mask) continue; // mask plane without a mask block cannot be sized
    const pw = isMask ? layer.mask!.rect.right - layer.mask!.rect.left : w;
    const ph = isMask ? layer.mask!.rect.bottom - layer.mask!.rect.top : h;
    if (pw <= 0 || ph <= 0 || dataCur.remaining < 2) continue;
    const compression = dataCur.u16();
    if (compression === 0) {
      layer.planes.set(ch.id, dataCur.slice(pw * ph));
    } else if (compression === 1) {
      layer.planes.set(ch.id, decodeRLEPlane(dataCur, pw, ph, isPsb));
    } else if (compression === 2 || compression === 3) {
      notes.push('ZIP 压缩通道不支持，已用默认值代替');
    }
    // Missing planes keep their defaults at assembly time: RGB = 0, alpha = 255.
  }
}
