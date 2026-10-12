// ICC 配置文件的字节级 IO:从 PNG(iCCP chunk)/ JPEG(APP2 段)提取、导出时
// 注回,以及从 profile 的 desc 标签解析描述名并尽力识别色彩空间。纯字节手术,
// 不依赖解码器与 Tauri;提取失败一律返回 null,绝不阻塞解码主流程。
//
// zlib 口径:PNG iCCP 载荷是 zlib(RFC1950)包装的 deflate 流,与浏览器
// CompressionStream/DecompressionStream 的 'deflate' 格式一致(WebView2 /
// Chromium 已确认可用)。这两个 API 是 Web 流,只能异步消费,因此本模块的
// 提取/注入函数都是 async(平台没有同步 inflate 接口)。

export interface IccExtraction { profile: Uint8Array; name: string }

// ---------- CRC32(表驱动,PNG 多项式 0xEDB88320;apngExport.ts 未导出其
// 同名实现且不许改动,故此处自带一份,两处互不影响) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- zlib deflate / inflate ----------

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const out = await new Response(
    new Blob([data as unknown as BlobPart]).stream().pipeThrough(new CompressionStream('deflate')),
  ).arrayBuffer();
  return new Uint8Array(out);
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const out = await new Response(
    new Blob([data as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate')),
  ).arrayBuffer();
  return new Uint8Array(out);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ---------- PNG:chunk 扫描 / iCCP ----------

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface PngChunk { type: string; data: Uint8Array }

function parsePngChunks(b: Uint8Array): PngChunk[] {
  for (let i = 0; i < 8; i++) {
    if (b[i] !== PNG_SIGNATURE[i]) throw new Error('不是有效的 PNG(签名不符)');
  }
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const chunks: PngChunk[] = [];
  let pos = 8;
  while (pos + 12 <= b.length) {
    const len = v.getUint32(pos); // 长度/类型/数据/CRC 全大端(PNG 规范)
    const type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    if (pos + 12 + len > b.length) throw new Error(`PNG chunk ${type} 长度越界`);
    chunks.push({ type, data: b.subarray(pos + 8, pos + 8 + len) });
    pos += 12 + len; // 长度4 + 类型4 + 数据 + CRC4
  }
  return chunks;
}

/** 长度4 + 类型4 + 数据 + CRC4;CRC 覆盖类型+数据。 */
function chunkBytes(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i) & 0xff;
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** PNG iCCP 提取:载荷 = profile 名(Latin-1)\0 + 压缩方法(1B,仅定义 0)+ zlib profile。 */
export async function extractIccFromPng(u8: Uint8Array): Promise<IccExtraction | null> {
  try {
    for (const c of parsePngChunks(u8)) {
      if (c.type !== 'iCCP' || c.data.length < 4) continue;
      const z = c.data.indexOf(0);
      if (z <= 0 || z + 2 > c.data.length) continue;
      if (c.data[z + 1] !== 0) continue; // 压缩方法 0(zlib deflate)之外的按无 ICC 处理
      const profile = await inflate(c.data.subarray(z + 2));
      const name = latin1Decode(c.data.subarray(0, z));
      if (profile.length) return { profile, name: name || 'ICC Profile' };
    }
  } catch { /* 损坏文件按无 ICC 处理 */ }
  return null;
}

/**
 * PNG iCCP 注入:chunk 流重组 —— 剔除既有 iCCP(规范禁多份),新块插在 IHDR
 * 之后(规范要求 iCCP 先于 PLTE 与 IDAT),其余 chunk 原样保留(含全部 CRC 重算)。
 */
export async function injectIccPng(u8: Uint8Array, profile: Uint8Array): Promise<Uint8Array> {
  if (!profile.length) throw new Error('ICC profile 为空');
  const chunks = parsePngChunks(u8);
  const kept = chunks.filter(c => c.type !== 'iCCP');
  const ihdr = kept.findIndex(c => c.type === 'IHDR');
  const insertAt = ihdr >= 0 ? ihdr + 1 : 0;
  const compressed = await deflate(profile);
  const name = latin1Encode(sanitizeProfileName(iccDescription(profile)));
  const iccpData = new Uint8Array(name.length + 2 + compressed.length);
  iccpData.set(name, 0);
  iccpData[name.length] = 0;     // 名字 NUL 结尾
  iccpData[name.length + 1] = 0; // 压缩方法 0 = zlib
  iccpData.set(compressed, name.length + 2);
  kept.splice(insertAt, 0, { type: 'iCCP', data: iccpData });
  return concat([PNG_SIGNATURE, ...kept.map(c => chunkBytes(c.type, c.data))]);
}

// ---------- JPEG:APP2 'ICC_PROFILE' 多段 ----------

// 'ICC_PROFILE\0' 12 字节签名(ICC.1:2010 附录 B)。
const ICC_HEAD = new Uint8Array([
  0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00,
]);
// 每段 ICC 数据上限:65535(段长字段上限)− 2(长度字段)− 12(签名)− 2(序号/总数)。
const JPEG_MAX_DATA = 65519;

/**
 * JPEG APP2 提取:扫段(marker 0xFF + 长度),收集全部 'ICC_PROFILE\0' 段按
 * 序号拼回;序号/总数在签名后两字节。缺段或总数对不上按 spec 放弃(不给半截
 * profile);段顺序错乱无妨(按序号重排)。
 */
export async function extractIccFromJpeg(u8: Uint8Array): Promise<IccExtraction | null> {
  try {
    if (u8.length < 4 || u8[0] !== 0xff || u8[1] !== 0xd8) return null;
    const segs = new Map<number, { total: number; data: Uint8Array }>();
    let pos = 2;
    while (pos + 2 <= u8.length) {
      if (u8[pos] !== 0xff || u8[pos + 1] === 0xff) { pos++; continue; } // 填充字节容错
      const marker = u8[pos + 1];
      if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS:APPn 必在其前
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; } // 独立标记无长度字段
      if (pos + 4 > u8.length) break;
      const segLen = (u8[pos + 2] << 8) | u8[pos + 3];
      if (segLen < 2) break; // 长度字段损坏
      const head = pos + 4;
      if (head + segLen - 2 > u8.length) break;
      if (marker === 0xe2 && segLen >= 18 && startsWith(u8, head, ICC_HEAD)) {
        const seq = u8[head + 12];
        const total = u8[head + 13];
        if (seq >= 1 && total >= 1 && seq <= total) {
          segs.set(seq, { total, data: u8.slice(head + 14, head + segLen - 2) });
        }
      }
      pos = head + segLen - 2;
    }
    if (!segs.size) return null;
    let total = 0;
    for (const s of segs.values()) total = Math.max(total, s.total);
    if (segs.size !== total) return null; // 缺段/重号
    const parts: Uint8Array[] = [];
    for (let s = 1; s <= total; s++) {
      const seg = segs.get(s);
      if (!seg) return null;
      parts.push(seg.data);
    }
    const profile = concat(parts);
    return profile.length ? { profile, name: iccDescription(profile) } : null;
  } catch {
    return null;
  }
}

/**
 * JPEG APP2 注入:SOI(FFD8)后插一段或多段 APP2(>65519 字节按 spec 分段)。
 * 先剥掉源里既有的 ICC APP2 段(文件里只该有一份 ICC;Chrome canvas 编码的
 * JPEG 会自带一段),其余段与 SOS 之后的熵编码数据原样保留。
 */
export async function injectIccJpeg(u8: Uint8Array, profile: Uint8Array): Promise<Uint8Array> {
  if (!profile.length) throw new Error('ICC profile 为空');
  if (u8.length < 2 || u8[0] !== 0xff || u8[1] !== 0xd8) throw new Error('不是有效的 JPEG(缺少 SOI)');
  const kept: Uint8Array[] = [];
  let pos = 2;
  let tailStart = u8.length; // SOS/EOI 起(含)原样保留
  while (pos + 2 <= u8.length) {
    if (u8[pos] !== 0xff || u8[pos + 1] === 0xff) { // 填充字节原样保留
      kept.push(u8.subarray(pos, pos + 1));
      pos++;
      continue;
    }
    const marker = u8[pos + 1];
    if (marker === 0xda || marker === 0xd9) { tailStart = pos; break; } // SOS / EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { // 独立标记无长度字段
      kept.push(u8.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }
    if (pos + 4 > u8.length) break;
    const segLen = (u8[pos + 2] << 8) | u8[pos + 3];
    if (segLen < 2) break; // 长度字段损坏:余下原样保留
    const head = pos + 4;
    if (head + segLen - 2 > u8.length) break;
    const isIcc = marker === 0xe2 && segLen >= 18 && startsWith(u8, head, ICC_HEAD);
    if (!isIcc) kept.push(u8.subarray(pos, head + segLen - 2)); // ICC APP2 剔除,其余保留
    pos = head + segLen - 2;
  }
  const total = Math.ceil(profile.length / JPEG_MAX_DATA);
  const segs: Uint8Array[] = [];
  for (let seq = 1; seq <= total; seq++) {
    const from = (seq - 1) * JPEG_MAX_DATA;
    const data = profile.subarray(from, Math.min(from + JPEG_MAX_DATA, profile.length));
    const seg = new Uint8Array(4 + 12 + 2 + data.length); // 标记2 + 长度2 + 签名12 + 序号/总数2 + 数据
    seg[0] = 0xff;
    seg[1] = 0xe2; // APP2
    new DataView(seg.buffer).setUint16(2, seg.length - 2); // 长度字段自计(不含标记)
    seg.set(ICC_HEAD, 4);
    seg[16] = seq;
    seg[17] = total;
    seg.set(data, 18);
    segs.push(seg);
  }
  return concat([u8.subarray(0, 2), ...segs, ...kept, u8.subarray(tailStart)]);
}

// ---------- profile 识别 ----------

const SIG_ACSP = 0x61637370; // 'acsp':profile 头部魔数(offset 36)

/**
 * 解析 desc 标签拿描述名(如 'sRGB IEC61966-2.1'、'Display P3')。v2 profile
 * 的 desc 是 textDescriptionType('desc'),v4 是 multiLocalizedUnicodeType
 * ('mluc'),两种都读;任何失败回退 'ICC Profile'。
 */
export function iccDescription(profile: Uint8Array): string {
  try {
    if (profile.length < 132 + 4) return 'ICC Profile';
    const v = new DataView(profile.buffer, profile.byteOffset, profile.byteLength);
    if (v.getUint32(36) !== SIG_ACSP) return 'ICC Profile';
    const tagCount = v.getUint32(128);
    if (tagCount === 0 || tagCount > 1024) return 'ICC Profile';
    for (let i = 0; i < tagCount; i++) {
      const e = 132 + i * 12;
      if (e + 12 > profile.length) break;
      if (sig4(profile, e) !== 'desc') continue;
      const off = v.getUint32(e + 4);
      const size = v.getUint32(e + 8);
      if (size === 0 || off + 12 > profile.length || off + 12 > off + size) break;
      const type = sig4(profile, off);
      const name = type === 'desc' ? readTextDescription(profile, v, off)
        : type === 'mluc' ? readMlucDescription(profile, v, off)
        : null;
      if (name) return name;
    }
  } catch { /* 落到回退名 */ }
  return 'ICC Profile';
}

/** 尽力识别色彩空间:只看描述名(sRGB / Display P3 及各厂叫法),其余归 'other'。 */
export function identifySpace(profile: Uint8Array): 'srgb' | 'display-p3' | 'other' {
  const d = iccDescription(profile).toLowerCase();
  if (d.includes('p3')) return 'display-p3';
  if (d.includes('srgb')) return 'srgb';
  return 'other';
}

/** textDescriptionType:'desc' + 保留4 + ASCII 数量 u32 + ASCII(含结尾 NUL)+ … */
function readTextDescription(p: Uint8Array, v: DataView, off: number): string | null {
  const count = v.getUint32(off + 8);
  const max = Math.min(count, p.length - (off + 12));
  let s = '';
  for (let i = 0; i < max; i++) {
    const c = p[off + 12 + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s !== '' ? s : null;
}

/** multiLocalizedUnicodeType:'mluc' + 保留4 + 记录数 + 记录长度,记录 0 的 UTF-16BE。 */
function readMlucDescription(p: Uint8Array, v: DataView, off: number): string | null {
  const count = v.getUint32(off + 8);
  if (count < 1) return null;
  const rec = off + 16; // 记录 0:语言2 + 国家2 + 长度 u32 + 偏移 u32
  const len = v.getUint32(rec + 4);
  const strOff = v.getUint32(rec + 8);
  const base = off + strOff;
  if (len < 2 || base + len > p.length) return null;
  let s = '';
  for (let i = 0; i + 1 < len; i += 2) {
    const code = v.getUint16(base + i);
    if (code === 0) break;
    s += String.fromCharCode(code);
  }
  return s !== '' ? s : null;
}

// ---------- 小工具 ----------

function sig4(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
}

function latin1Decode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

function latin1Encode(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** iCCP 的 profile 名须为 Latin-1 可打印:非 ASCII 降级 '?',限 79 字符。 */
function sanitizeProfileName(s: string): string {
  let t = '';
  for (let i = 0; i < s.length && i < 79; i++) {
    const c = s.charCodeAt(i);
    t += c >= 32 && c <= 126 ? s[i] : '?';
  }
  return t || 'ICC Profile';
}

function startsWith(b: Uint8Array, at: number, head: Uint8Array): boolean {
  if (at + head.length > b.length) return false;
  for (let i = 0; i < head.length; i++) if (b[at + i] !== head[i]) return false;
  return true;
}
