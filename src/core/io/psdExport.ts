// PSD 导出器(Adobe PSD Specification version 1,RGB mode 3,含图层)。
// 位深:doc.bitDepth === 16 时全文件按 16bit/通道写出(采样 v<<8|v,大端);
// 注意本项目读取器只认 8bit——16bit 导出的 PSD 无法被自己读回(设计稿已标注)。
// ICC:doc.iccProfile 非空时写入 Image Resources '8BIM' ID 1039(空 Pascal 名+补偶)。
// 文件结构:26B 文件头 → Color Mode Data(长度 0)→ Image Resources(仅 ICC)→
// Layer and Mask Information(图层记录自底向上,第一条 = 最底层;随后按同序跟
// 各层通道数据)→ 合并图像数据(RGBA 平面分离,行序自底向上)。
//
// 输出对齐本项目的读取器(io/psd/reader.ts),可被其读回:
// - 图层数写负值:规范原文为 negative number = 第一个 alpha 通道携带合并图像
//   的透明度(合并图恒为 4 通道 RGBA,故有层时写 -N;无层写 0);
// - 图层矩形 top,left,bottom,right;通道 id 0=R,1=G,2=B,-1=A;压缩 0(raw)
//   且平面分离:先整层 R,再 G、B、A;
// - 行序陷阱:图层通道数据自顶向下,合并图像数据自底向上——两者相反,勿混;
// - 图层名:Pascal ASCII 名(非 ASCII 降级为 '?',4 字节对齐)+ 'luni'
//   UTF-16BE 真名块,中文名不丢失;混合模式写规范签名(含 'mul '/'div ' 补
//   空格与 sLit/hLit/vLit/lLit/pLit/hMix 的大小写)。
//
// 已知限制:
// - 组图层整组合并为一张位图导出(不生成 PSD 分组/分隔符记录):组的透明度、
//   混合模式与蒙版挂在合并后的单层上;透传组「逐层乘透明度」与「合并后整体
//   乘透明度」在子层互相重叠时存在细微差异;
// - 调整图层自身无像素,不产生图层记录,其效果只体现在合并图像里;
// - 文字/形状图层按其合成位图(经变换/效果/蒙版烘焙后的像素)导出;
// - 隐藏图层不导出(所见即所得);剪贴蒙版、图层效果、蒙版全部烘焙进像素;
// - Image Resources 只写 ICC(1039),其余元数据不保留;边长超 30000px 需 PSB,
//   本导出器不处理。

import { makeCanvas, ctx2d, ctx2dRead, drawThroughTransform } from '../canvasUtils';
import { composite, prepareLayer } from '../compositor';
import type { BlendMode, Doc, Layer } from '../types';

// 本项目 BlendMode → Photoshop 混合模式签名(4 字节,不足补空格)。
const BLEND_KEYS: Record<BlendMode, string> = {
  Normal: 'norm',
  Darken: 'dark',
  Multiply: 'mul ',
  'Color Burn': 'idiv',
  'Linear Burn': 'lbrn',
  Lighten: 'lite',
  Screen: 'scrn',
  'Color Dodge': 'div ',
  'Linear Dodge (Add)': 'lddg',
  Overlay: 'over',
  'Soft Light': 'sLit',
  'Hard Light': 'hLit',
  'Vivid Light': 'vLit',
  'Linear Light': 'lLit',
  'Pin Light': 'pLit',
  'Hard Mix': 'hMix',
  Difference: 'diff',
  Exclusion: 'smud',
  Subtract: 'fsub',
  Divide: 'fdiv',
  Hue: 'hue ',
  Saturation: 'sat ',
  Color: 'colr',
  Luminosity: 'lum ',
};

/** 一个待写图层的最终数据:已裁出矩形、平面分离的 RGBA。 */
interface ExportedLayer {
  name: string;
  opacityByte: number;
  blendKey: string;
  w: number;
  h: number;
  left: number;   // 图层矩形在文档空间的位置(=PSD 矩形的 left/top)
  top: number;
  planes: Uint8Array[]; // R,G,B,A 四张 w*h 平面,行序自顶向下
}

/** 大端序写入小工具(DataView 默认即大端),PSD 全部字段为大端。 */
class BeWriter {
  private readonly buf: ArrayBuffer;
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  private pos = 0;

  constructor(size: number) {
    this.buf = new ArrayBuffer(size);
    this.bytes = new Uint8Array(this.buf);
    this.view = new DataView(this.buf);
  }

  u8(v: number): void { this.view.setUint8(this.pos, v); this.pos += 1; }
  i16(v: number): void { this.view.setInt16(this.pos, v); this.pos += 2; }
  u16(v: number): void { this.view.setUint16(this.pos, v); this.pos += 2; }
  i32(v: number): void { this.view.setInt32(this.pos, v); this.pos += 4; }
  u32(v: number): void { this.view.setUint32(this.pos, v); this.pos += 4; }

  ascii(s: string): void {
    for (let i = 0; i < s.length; i++) this.view.setUint8(this.pos + i, s.charCodeAt(i) & 0xff);
    this.pos += s.length;
  }

  copy(src: Uint8Array): void {
    this.bytes.set(src, this.pos);
    this.pos += src.length;
  }

  finish(): ArrayBuffer { return this.buf; }
}

/** 导出为 PSD(version 1,RGB mode 3;位深/ICC 取 doc 口径)。纯函数:只依赖传入的 Doc 与 DOM canvas。 */
export function exportPsd(doc: Doc): ArrayBuffer {
  const w = Math.max(1, Math.round(doc.width));
  const h = Math.max(1, Math.round(doc.height));
  const layers = collectExportLayers(doc);
  const pixelBytes = w * h;
  const bpp = doc.bitDepth === 16 ? 2 : 1; // 每样本字节数(16bit 大端 v<<8|v)
  const icc = doc.iccProfile?.length ? doc.iccProfile : null;

  // ---- 尺寸预算:先精确算总长,一次分配,通道平面用 set() 整块拷贝 ----
  let recordsLen = 0;
  let channelDataLen = 0;
  for (const l of layers) {
    const extraLen = 4 + 4 + pascalFieldLen(l.name) + luniBlockLen(l.name);
    // 矩形16 + 通道数2 + 4×通道信息6(id2+长度4) + 签名/键8 + 透明度/剪贴/标志/填充4
    // + extra长度字段4 + extra
    recordsLen += 16 + 2 + 4 * 6 + 8 + 4 + 4 + extraLen;
    channelDataLen += 4 * (2 + l.w * l.h * bpp); // 每通道:2B 压缩标记 + w*h*样本字节数 raw
  }
  const liContent = 2 + recordsLen + channelDataLen;
  const layerInfoLen = liContent + (liContent % 2); // 规范:layer info 长度向上取偶
  const lmContent = 4 + layerInfoLen + 4;           // 内层长度字段 + 图层信息 + 全局蒙版长度(0)
  const lmLen = lmContent + (lmContent % 2);        // 规范:Layer & Mask 段长度向上取偶
  // Image Resources:'8BIM'4 + ID2 + 空名 Pascal2 + 长度4 + 数据(+补偶)
  // 末尾 4 = Layer&Mask 段自身的长度字段(lmLen 只描述段体,不含该字段)
  const resLen = icc ? 4 + 2 + 2 + 4 + icc.length + (icc.length % 2) : 0;
  const total = 26 + 4 + 4 + resLen + 4 + lmLen + 2 + 4 * pixelBytes * bpp;

  const wtr = new BeWriter(total);

  // ---- 文件头 ----
  wtr.ascii('8BPS');
  wtr.u16(1);        // version 1(PSD;PSB 才是 2)
  wtr.u16(0); wtr.u32(0); // 6 字节保留
  wtr.u16(4);        // 通道数:合并图为 RGBA
  wtr.u32(h);        // 高度在前
  wtr.u32(w);
  wtr.u16(bpp === 2 ? 16 : 8); // 深度
  wtr.u16(3);        // RGB

  wtr.u32(0);        // Color Mode Data 长度 0
  wtr.u32(resLen);   // Image Resources(仅 ICC 1039,无则 0)
  if (icc) writeIccResource(wtr, icc);

  // ---- Layer and Mask Information ----
  wtr.u32(lmLen);
  wtr.u32(layerInfoLen);
  // 图层数:合并图带 alpha → 按规范写负值(无层写 0)
  wtr.i16(layers.length > 0 ? -Math.min(layers.length, 0x7fff) : 0);
  // 图层记录:自底向上,第一条 = 最底层(doc.layers 本就自底向顶,顺序直通)
  for (const l of layers) writeLayerRecord(wtr, l, bpp);
  // 通道数据:与记录同序;平面分离,行序自顶向下(与合并图像相反!)
  for (const l of layers) {
    for (const plane of l.planes) {
      wtr.u16(0);    // 压缩 0:raw
      wtr.copy(bpp === 2 ? widenPlane(plane) : plane);
    }
  }
  if (liContent % 2) wtr.u8(0); // 取偶填充
  wtr.u32(0);        // Global layer mask info 长度 0
  if (lmContent % 2) wtr.u8(0);

  // ---- 合并图像数据:压缩 0,RGBA 平面分离,行序自底向上 ----
  wtr.u16(0);
  const merged = ctx2dRead(composite(doc)).getImageData(0, 0, w, h);
  for (const plane of planesFromImageData(merged, true)) {
    wtr.copy(bpp === 2 ? widenPlane(plane) : plane);
  }

  return wtr.finish();
}

// ---------- 图层收集 ----------

/** 遍历文档产出待写图层:普通层走 prepareLayer(烘焙变换/效果/蒙版/剪贴),
 *  组整组合并为一张位图;顺序保持 doc.layers 的自底向顶。 */
function collectExportLayers(doc: Doc): ExportedLayer[] {
  const out: ExportedLayer[] = [];
  const nested = idsWithGroupAncestor(doc);
  // 与 composite() 相同的 prepared 语义:供下方图层的剪贴蒙版(destination-in)引用
  const prepared = new Map<string, HTMLCanvasElement>();
  for (const layer of doc.layers) {
    if (layer.isGroup) {
      if (layer.isVisible && !nested.has(layer.id)) emitGroupLayer(doc, layer, out);
      continue;
    }
    if (!layer.isVisible || layer.adjustment) continue; // 隐藏层不导出;调整层无像素
    const content = prepareLayer(doc, layer, prepared);
    if (!content) continue; // 无位图(如未渲染的文字)→ 跳过
    prepared.set(layer.id, content);
    if (!nested.has(layer.id)) emitLayer(layer, content, out);
  }
  return out;
}

function emitLayer(layer: Layer, content: HTMLCanvasElement, out: ExportedLayer[]): void {
  const crop = cropToAlphaBounds(content);
  if (!crop) return; // 全透明:无内容,跳过
  const id = ctx2dRead(crop.canvas).getImageData(0, 0, crop.canvas.width, crop.canvas.height);
  out.push({
    name: layer.name,
    opacityByte: clampByte(Math.round(layer.opacity * 255)),
    blendKey: BLEND_KEYS[layer.blendMode],
    w: crop.canvas.width,
    h: crop.canvas.height,
    left: crop.x,
    top: crop.y,
    planes: planesFromImageData(id, false), // 图层通道行序自顶向下
  });
}

/** 组 → 单张合并位图(本版限制:不生成 PSD 分组结构)。组的透明度/混合模式/
 *  蒙版挂在合并层上,与透传组「逐层乘」在子层重叠时有细微差异。 */
function emitGroupLayer(doc: Doc, group: Layer, out: ExportedLayer[]): void {
  const sub: Doc = { ...doc, layers: descendantsOf(group, doc) };
  const flat = composite(sub); // 子文档合成:嵌套组的透明度/蒙版由 composite 处理
  if (group.mask && group.maskEnabled) applyMaskLuminance(flat, group);
  emitLayer(group, flat, out);
}

/** 组的全部后代(含嵌套组),保持 doc.layers 的自底向顶顺序;guard 防脏数据父子环。 */
function descendantsOf(group: Layer, doc: Doc): Layer[] {
  const byId = new Map(doc.layers.map(l => [l.id, l] as const));
  return doc.layers.filter(l => {
    let p = l.parentId;
    let guard = 0;
    while (p && guard++ <= doc.layers.length) {
      if (p === group.id) return true;
      const parent = byId.get(p);
      if (!parent) return false;
      p = parent.parentId;
    }
    return false;
  });
}

function idsWithGroupAncestor(doc: Doc): Set<string> {
  const byId = new Map(doc.layers.map(l => [l.id, l] as const));
  const nested = new Set<string>();
  for (const l of doc.layers) {
    let p = l.parentId;
    let guard = 0;
    while (p && guard++ <= doc.layers.length) {
      const parent = byId.get(p);
      if (!parent) break;
      if (parent.isGroup) { nested.add(l.id); break; }
      p = parent.parentId;
    }
  }
  return nested;
}

/** 组蒙版:蒙版灰度 → alpha,经蒙版变换绘制后 destination-in
 *  (镜像 compositor 的 drawMaskThroughTransform,那边未导出)。 */
function applyMaskLuminance(target: HTMLCanvasElement, group: Layer): void {
  const mask = group.mask!;
  const tinted = makeCanvas(mask.width, mask.height);
  const tx = ctx2dRead(tinted);
  tx.drawImage(mask, 0, 0);
  const id = tx.getImageData(0, 0, tinted.width, tinted.height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i + 3] = d[i]; // 白=显示,黑=隐藏
    d[i] = d[i + 1] = d[i + 2] = 255;
  }
  tx.putImageData(id, 0, 0);
  const mt = group.maskLinked || !group.maskPlacement ? group.transform : group.maskPlacement;
  const cx = ctx2d(target);
  cx.globalCompositeOperation = 'destination-in';
  drawThroughTransform(cx, tinted, tinted.width, tinted.height, mt);
  cx.globalCompositeOperation = 'source-over';
}

/** 按 alpha 边界裁出图层矩形(与 commands.alphaBounds 同逻辑;不反向依赖
 *  commands.ts 以避免 core→ui 层的循环引用)。 */
function cropToAlphaBounds(c: HTMLCanvasElement): { canvas: HTMLCanvasElement; x: number; y: number } | null {
  const d = ctx2dRead(c).getImageData(0, 0, c.width, c.height).data;
  let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const x = minX, y = minY;
  const out = makeCanvas(maxX - minX + 1, maxY - minY + 1);
  ctx2d(out).drawImage(c, -x, -y);
  return { canvas: out, x, y };
}

/** RGBA 交错像素 → 4 张单色平面;flipRows=true 用于合并图像的自底向上行序。 */
function planesFromImageData(id: ImageData, flipRows: boolean): Uint8Array[] {
  const w = id.width, h = id.height, d = id.data;
  const planes: Uint8Array[] = [
    new Uint8Array(w * h), new Uint8Array(w * h), new Uint8Array(w * h), new Uint8Array(w * h),
  ];
  for (let y = 0; y < h; y++) {
    const s = (flipRows ? h - 1 - y : y) * w * 4;
    const o = y * w;
    for (let x = 0; x < w; x++) {
      planes[0][o + x] = d[s + x * 4];
      planes[1][o + x] = d[s + x * 4 + 1];
      planes[2][o + x] = d[s + x * 4 + 2];
      planes[3][o + x] = d[s + x * 4 + 3];
    }
  }
  return planes;
}

// ---------- 图层记录序列化 ----------

/** 8bit 平面 → 16bit 大端采样字节:v<<8|v 的对称结构即每样本 [v,v](低位复制)。 */
function widenPlane(p: Uint8Array): Uint8Array {
  const out = new Uint8Array(p.length * 2);
  for (let i = 0; i < p.length; i++) {
    out[i * 2] = p[i];
    out[i * 2 + 1] = p[i];
  }
  return out;
}

/** Image Resource '8BIM' + ID 1039(ICC profile):空 Pascal 名补偶 + u32 长度 + 数据补偶。 */
function writeIccResource(wtr: BeWriter, icc: Uint8Array): void {
  wtr.ascii('8BIM');
  wtr.u16(1039);
  wtr.u8(0);
  wtr.u8(0); // 空 Pascal 名(长度 0),补偶到 2 字节
  wtr.u32(icc.length);
  wtr.copy(icc);
  if (icc.length % 2) wtr.u8(0);
}

function writeLayerRecord(wtr: BeWriter, l: ExportedLayer, bpp: number): void {
  const extraLen = 4 + 4 + pascalFieldLen(l.name) + luniBlockLen(l.name);
  wtr.i32(l.top);           // 矩形:top, left, bottom, right
  wtr.i32(l.left);
  wtr.i32(l.top + l.h);
  wtr.i32(l.left + l.w);
  wtr.u16(4);               // 通道数 RGBA
  for (const id of [0, 1, 2, -1]) {
    wtr.i16(id);            // 0=R, 1=G, 2=B, -1=A
    wtr.u32(2 + l.w * l.h * bpp); // 压缩标记 2B + raw 平面
  }
  wtr.ascii('8BIM');
  wtr.ascii(l.blendKey);
  wtr.u8(l.opacityByte);    // 0-255
  wtr.u8(0);                // clipping:剪贴蒙版已烘焙进像素 → 0
  wtr.u8(0);                // flags:bit1 = 隐藏;导出层均可见 → 0
  wtr.u8(0);                // filler(必须为 0)
  wtr.u32(extraLen);
  wtr.u32(0);               // 图层蒙版数据长度 0
  wtr.u32(0);               // 混合范围长度 0
  writePascalName(wtr, l.name);
  writeLuni(wtr, l.name);
}

/** Pascal 名:ASCII 化(中文等降级为 '?'),整字段 4 字节对齐;真名在 luni。 */
function writePascalName(wtr: BeWriter, name: string): void {
  const bytes = asciiNameBytes(name);
  wtr.u8(bytes.length);
  wtr.copy(bytes);
  const rem = (bytes.length + 1) % 4;
  if (rem !== 0) for (let i = rem; i < 4; i++) wtr.u8(0);
}

function asciiNameBytes(name: string): Uint8Array {
  let s = '';
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    s += c >= 32 && c <= 126 ? name[i] : '?';
  }
  if (s.length > 255) s = s.slice(0, 255);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function pascalFieldLen(name: string): number {
  return Math.ceil((Math.min(name.length, 255) + 1) / 4) * 4;
}

/** 'luni' 附加信息:'8BIM'+'luni'+u32 长度+(u32 字符数 + UTF-16BE),数据补偶。 */
function writeLuni(wtr: BeWriter, name: string): void {
  const dataLen = 4 + name.length * 2;
  wtr.ascii('8BIM');
  wtr.ascii('luni');
  wtr.u32(dataLen);
  wtr.u32(name.length);
  for (let i = 0; i < name.length; i++) wtr.u16(name.charCodeAt(i));
  if (dataLen % 2) wtr.u8(0);
}

function luniBlockLen(name: string): number {
  const dataLen = 4 + name.length * 2;
  return 12 + dataLen + (dataLen % 2); // 签名4 + 键4 + 长度4 + 数据(+偶填充)
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
