// TIFF baseline import/export (pure TS, no dependencies): decode
// uncompressed / PackBits / LZW strips into a canvas, encode single-strip
// uncompressed RGBA back. importTiff feeds openPathByKind (commands.ts);
// exportTiffCommand is the File-menu entry.
//
// 解码范围 v1:II/MM 两种字节序;Compression 1(无压缩)/ 32773(PackBits)/
// 5(TIFF LZW,MSB 打包,earlyChange=1,与 libtiff 一致);Photometric 2(RGB,
// spp 3→补不透明 alpha / 4→直接用)与 1(灰度→RGB 复制);BitsPerSample 8 必做、
// 16 取高字节。tag 34675(ICC Profile)原样取出挂到 Doc.iccProfile/iccName。
// 多页 TIFF 只读第一页;分平面(PlanarConfiguration=2)、调色板
// (Photometric=3)、1/2/4 位灰阶均不支持(中文报错)。
// 导出:flattenDoc → 单条带无压缩 RGBA(ExtraSamples=2 unassociated);
// doc.bitDepth===16 时 BitsPerSample [16×4]、采样 v<<8|v;doc.iccProfile 回写
// tag 34675。导出可被本文件 importTiff 读回(16bit 取高字节即原值)。

import type { Doc } from '../types';
import { makeLayer, defaultTransform } from '../types';
import { makeCanvas, ctx2dRead } from '../canvasUtils';
import { readFile, writeFile } from './fs';
import { store, flattenDoc } from '../store';
import { iccDescription } from './icc';

// ---------- IFD 读取 ----------

// 1=BYTE 3=SHORT 4=LONG 7=UNDEFINED(ICC tag 34675 用 type 7,每项 1 字节)
const TYPE_SIZE: Record<number, number> = { 1: 1, 3: 2, 4: 4, 7: 1 };

interface IfdEntry { type: number; count: number; pos: number }

function readValues(v: DataView, le: boolean, e: IfdEntry): number[] {
  const out: number[] = [];
  for (let i = 0; i < e.count; i++) {
    if (e.type === 3) out.push(v.getUint16(e.pos + i * 2, le));
    else if (e.type === 4) out.push(v.getUint32(e.pos + i * 4, le));
    else if (e.type === 1) out.push(v.getUint8(e.pos + i));
    else throw new Error(`TIFF 字段类型不支持(type=${e.type})`);
  }
  return out;
}

// ---------- PackBits(TIFF 32773):n>=0 字面量 n+1 字节,n<0 复制下一字节 1-n 次 ----------

function unpackBits(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let ip = 0, op = 0;
  while (ip < src.length && op < expected) {
    const n = (src[ip++] << 24) >> 24; // 有符号字节
    if (n >= 0) {
      const count = Math.min(n + 1, expected - op, src.length - ip);
      out.set(src.subarray(ip, ip + count), op);
      ip += count; op += count;
    } else if (n !== -128) { // -128 是历史 no-op
      const count = Math.min(1 - n, expected - op);
      out.fill(src[ip++] ?? 0, op, op + count);
      op += count;
    }
  }
  return out;
}

// ---------- TIFF LZW:MSB 打包,CLEAR=256 / EOI=257,码长提前 1 位增长 ----------

function lzwDecode(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let op = 0;
  let bitPos = 0;
  const totalBits = src.length * 8;
  let width = 9, next = 258;
  let prev: number[] | null = null;
  const dict = new Map<number, number[]>();

  const readCode = (): number => {
    if (bitPos + width > totalBits) return 257; // 码流截断按 EOI 处理
    let code = 0;
    for (let i = 0; i < width; i++) {
      code = (code << 1) | ((src[bitPos >>> 3] >>> (7 - (bitPos & 7))) & 1);
      bitPos++;
    }
    return code;
  };

  for (;;) {
    const code = readCode();
    if (code === 257) break; // EOI
    if (code === 256) { // CLEAR
      dict.clear(); next = 258; width = 9; prev = null;
      continue;
    }
    let entry: number[];
    if (code < 256) entry = [code];
    else if (dict.has(code)) entry = dict.get(code)!;
    else if (code === next && prev) entry = [...prev, prev[0]]; // KwKwK
    else throw new Error('TIFF LZW 码流损坏');
    for (let i = 0; i < entry.length && op < expected; i++) out[op++] = entry[i];
    if (prev && next < 4095) dict.set(next++, [...prev, entry[0]]);
    prev = entry;
    // earlyChange=1:自由码到 511/1023/2047 就升位(libtiff 行为)
    if (next + 1 >= (1 << width) && width < 12) width++;
    if (op >= expected) break;
  }
  return out;
}

// ---------- 解码主流程 ----------

export async function importTiff(path: string): Promise<Doc> {
  const bytes = await readFile(path);
  if (bytes.length < 8) throw new Error('不是有效的 TIFF 文件(太短)');
  const b0 = bytes[0], b1 = bytes[1];
  const le = b0 === 0x49 && b1 === 0x49 ? true
    : b0 === 0x4d && b1 === 0x4d ? false
    : null;
  if (le === null) throw new Error('不是有效的 TIFF 文件(缺少 II/MM 字节序标记)');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, le) !== 42) throw new Error('不是有效的 TIFF 文件(magic≠42)');
  const ifdOffset = view.getUint32(4, le);
  if (ifdOffset + 2 > bytes.length) throw new Error('TIFF IFD 偏移越界');

  const entryCount = view.getUint16(ifdOffset, le);
  const tags = new Map<number, IfdEntry>();
  let p = ifdOffset + 2;
  for (let i = 0; i < entryCount; i++, p += 12) {
    if (p + 12 > bytes.length) throw new Error('TIFF IFD 条目越界');
    const tag = view.getUint16(p, le);
    const type = view.getUint16(p + 2, le);
    const count = view.getUint32(p + 4, le);
    const size = (TYPE_SIZE[type] ?? 0) * count;
    const pos = size > 0 && size <= 4 ? p + 8 : view.getUint32(p + 8, le);
    tags.set(tag, { type, count, pos });
  }
  const scalar = (tag: number): number | null => {
    const e = tags.get(tag);
    return e && e.count >= 1 ? readValues(view, le, e)[0] : null;
  };
  const array = (tag: number): number[] | null => {
    const e = tags.get(tag);
    return e ? readValues(view, le, e) : null;
  };

  const width = scalar(256), height = scalar(257);
  if (!width || !height || width > 65535 || height > 65535) throw new Error('TIFF 尺寸无效或过大');
  const bpsArr = array(258) ?? [1];
  const bps = bpsArr[0];
  if (bps !== 8 && bps !== 16) throw new Error(`仅支持 8/16 位 TIFF(当前 ${bps} 位)`);
  const compression = scalar(259) ?? 1;
  if (compression !== 1 && compression !== 32773 && compression !== 5) {
    throw new Error(`暂不支持该 TIFF 压缩方式(${compression})`);
  }
  const photometric = scalar(262);
  if (photometric !== 1 && photometric !== 2) {
    throw new Error(`暂不支持该 TIFF 色彩模式(Photometric=${photometric})`);
  }
  if ((scalar(284) ?? 1) !== 1) throw new Error('暂不支持分平面(Planar)TIFF');
  const spp = scalar(277) ?? (photometric === 2 ? 3 : 1);
  const channels = photometric === 2 ? (spp === 4 ? 4 : 3) : 1;
  if (photometric === 2 && spp !== 3 && spp !== 4) {
    throw new Error(`RGB TIFF 的 SamplesPerPixel=${spp} 不受支持`);
  }
  const stripOffsets = array(273);
  if (!stripOffsets?.length) throw new Error('TIFF 缺少条带数据(StripOffsets)');
  const stripCounts = array(279);
  const rowsPerStrip = Math.max(1, scalar(278) ?? height);

  // tag 34675(ICC Profile,type 7 UNDEFINED 或 1 BYTE):原样取出,导出时回写
  let iccProfile: Uint8Array | undefined;
  const iccEntry = tags.get(34675);
  if (iccEntry) {
    const size = (TYPE_SIZE[iccEntry.type] ?? 0) * iccEntry.count;
    if (size > 0 && iccEntry.pos >= 0 && iccEntry.pos + size <= bytes.length) {
      iccProfile = bytes.slice(iccEntry.pos, iccEntry.pos + size);
    }
  }

  const bpsBytes = bps / 8;
  const rowStride = width * channels * bpsBytes;
  const stripCount = Math.ceil(height / rowsPerStrip);
  const full = new Uint8Array(height * rowStride);
  let dstRow = 0;
  for (let s = 0; s < stripCount && dstRow < height; s++) {
    if (s >= stripOffsets.length) throw new Error('TIFF 条带数量不足');
    const off = stripOffsets[s];
    const cnt = stripCounts?.[s] ?? (bytes.length - off);
    if (off < 0 || off + cnt > bytes.length) throw new Error('TIFF 条带数据越界');
    const rows = Math.min(rowsPerStrip, height - dstRow);
    const expected = rows * rowStride;
    const raw = bytes.subarray(off, off + cnt);
    let decoded: Uint8Array;
    if (compression === 1) decoded = raw;
    else if (compression === 32773) decoded = unpackBits(raw, expected);
    else decoded = lzwDecode(raw, expected);
    if (decoded.length < expected) throw new Error('TIFF 条带数据不完整');
    full.set(decoded.subarray(0, expected), dstRow * rowStride);
    dstRow += rows;
  }

  // 样本 → RGBA:16 位取高字节(按字节序定位)
  const sampleAt = (o: number): number => (bps === 8 ? full[o] : full[o + (le ? 1 : 0)]);
  const image = new ImageData(width, height);
  const px = image.data;
  let si = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++, si += channels * bpsBytes) {
      let r: number, g: number, b: number, a = 255;
      r = sampleAt(si);
      g = sampleAt(si + bpsBytes);
      b = sampleAt(si + 2 * bpsBytes);
      if (channels === 4) a = sampleAt(si + 3 * bpsBytes);
      if (photometric === 1) { // 灰度:RGB 复制
        g = r; b = r;
      }
      const di = (y * width + x) * 4;
      px[di] = r; px[di + 1] = g; px[di + 2] = b; px[di + 3] = a;
    }
  }
  const canvas = makeCanvas(width, height);
  ctx2dRead(canvas).putImageData(image, 0, 0);
  const layer = makeLayer({ name: 'TIFF', bitmap: canvas, transform: defaultTransform(width, height) });
  const doc: Doc = {
    id: crypto.randomUUID(),
    width,
    height,
    resolution: 72,
    layers: [layer],
    activeLayerId: layer.id,
    fileName: path.split(/[\\/]/).pop() ?? path,
  };
  if (bps === 16) doc.bitDepth = 16; // 来源口径:内部合成仍为 8-bit
  if (iccProfile) {
    doc.iccProfile = iccProfile;
    doc.iccName = iccDescription(iccProfile);
  }
  return doc;
}

// ---------- 导出:单条带无压缩 RGBA(8bit)或 RGBA(16bit 采样 v<<8|v) ----------

interface TiffEncodeOpts {
  bit16?: boolean;        // 16 位采样:BitsPerSample [16×4],每样本 v<<8|v(读回取高字节即原值)
  icc?: Uint8Array | null; // 回写 tag 34675(type 7 UNDEFINED)
}

function encodeTiff(img: ImageData, opts: TiffEncodeOpts = {}): Uint8Array {
  const { width, height, data } = img;
  const bit16 = !!opts.bit16;
  const icc = opts.icc && opts.icc.length > 0 ? opts.icc : null;
  const entryCount = icc ? 12 : 11;
  const ifdSize = 2 + entryCount * 12 + 4;
  const bpsOffset = 8 + ifdSize;          // BitsPerSample 数组 [8,8,8,8] / [16,16,16,16]
  const iccOffset = bpsOffset + 8;        // ICC 原始字节(紧随 BitsPerSample)
  const stripOffset = iccOffset + (icc ? icc.length : 0);
  const stripBytes = width * height * 4 * (bit16 ? 2 : 1);
  const out = new Uint8Array(stripOffset + stripBytes);
  const v = new DataView(out.buffer);
  out[0] = 0x49; out[1] = 0x49; // 'II' 小端
  v.setUint16(2, 42, true);
  v.setUint32(4, 8, true); // 首个 IFD 紧跟头部
  v.setUint16(8, entryCount, true);
  let e = 10;
  const entry = (tag: number, type: number, count: number, num: number) => {
    v.setUint16(e, tag, true);
    v.setUint16(e + 2, type, true);
    v.setUint32(e + 4, count, true);
    if (type === 3 && count === 1) { v.setUint16(e + 8, num, true); v.setUint16(e + 10, 0, true); }
    else v.setUint32(e + 8, num, true);
    e += 12;
  };
  entry(256, 4, 1, width);          // ImageWidth
  entry(257, 4, 1, height);         // ImageLength
  entry(258, 3, 4, bpsOffset);      // BitsPerSample → 外置数组
  entry(259, 3, 1, 1);              // Compression = 无压缩
  entry(262, 3, 1, 2);              // Photometric = RGB
  entry(273, 4, 1, stripOffset);    // StripOffsets
  entry(277, 3, 1, 4);              // SamplesPerPixel = RGBA
  entry(278, 4, 1, height);         // RowsPerStrip = 全高(单条带)
  entry(279, 4, 1, stripBytes);     // StripByteCounts
  entry(284, 3, 1, 1);              // PlanarConfiguration = chunky
  entry(338, 3, 1, 2);              // ExtraSamples = unassociated alpha
  if (icc) entry(34675, 7, icc.length, iccOffset); // ICC Profile(type 7 UNDEFINED)
  v.setUint32(e, 0, true);          // 无后续 IFD(多页不支持)
  for (let i = 0; i < 4; i++) v.setUint16(bpsOffset + i * 2, bit16 ? 16 : 8, true);
  if (icc) out.set(icc, iccOffset);
  if (bit16) {
    // v<<8|v 的小端字节即 [v, v]:高位字节与低位相同,读回取高字节无损还原 8bit 值
    for (let i = 0, n = width * height * 4; i < n; i++) {
      out[stripOffset + i * 2] = data[i];
      out[stripOffset + i * 2 + 1] = data[i];
    }
  } else {
    out.set(data, stripOffset);
  }
  return out;
}

/** File → 导出 TIFF…:composite → uncompressed RGBA/16bit TIFF → save dialog. */
export async function exportTiffCommand(): Promise<void> {
  if (!store.doc) {
    alert('没有可导出的文档');
    return;
  }
  const { save } = await import('@tauri-apps/plugin-dialog');
  const picked = await save({ defaultPath: 'Untitled.tif' });
  if (!picked) return;
  const path = /\.tiff?$/i.test(picked) ? picked : `${picked}.tif`;
  try {
    const flat = flattenDoc();
    const img = ctx2dRead(flat).getImageData(0, 0, flat.width, flat.height);
    await writeFile(path, encodeTiff(img, {
      bit16: store.doc.bitDepth === 16,
      icc: store.doc.iccProfile,
    }));
  } catch (err) {
    alert(`无法导出 TIFF:${(err as Error).message}`);
  }
}
