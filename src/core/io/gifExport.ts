// GIF animation export: hand-rolled LZW + 256-color palette quantization, the
// same layering as apngExport.ts — encodeGif is the pure, Tauri-free part,
// exportGifCommand walks the timeline frames (与 APNG 导出同一条流程).
//
// 结构:GIF89a 头 → LSD(全局色表=首帧 median-cut 256 色)→ NETSCAPE2.0 无限
// 循环 → 每帧 GCE(disposal=1,无透明,delay 厘秒)+ Image Descriptor(局部色表
// =本帧自己的 256 色)+ LZW 索引数据(minCodeSize=8,LSB 打包)→ 0x3B。
// 量化:median-cut 采样建 256 盒取均色,全像素最近邻映射(带精确色缓存)。
// v1 局限:帧数上限 64;不支持透明(像素 alpha 被忽略,直接取 RGB);每帧独立
// 调色板(全帧替换,不用差帧)。

import { store, invalidate } from '../store';
import { composite } from '../compositor';
import {
  applyStatesToLayers, captureLayerStates, restoreLayerStates, syncFrameFromLayers, anim,
  type LayerSnapshot,
} from '../animation';
import { makeCanvas, ctx2dRead } from '../canvasUtils';
import { writeFile } from './fs';

export interface GifFrame {
  canvas: HTMLCanvasElement;
  delayMs: number;
}

const MAX_FRAMES = 64;

// ---------- median-cut 量化 ----------

/** 步进采样至约 1 万点,返回 [r,g,b] 样本。 */
function samplePixels(img: ImageData): number[][] {
  const { data, width, height } = img;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 10000)));
  const out: number[][] = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      out.push([data[i], data[i + 1], data[i + 2]]);
    }
  }
  return out;
}

/** 盒内最宽通道:返回 [宽度, 通道号]。 */
function widestChannel(box: number[][]): [number, number] {
  let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
  for (const p of box) {
    if (p[0] < rmin) rmin = p[0]; if (p[0] > rmax) rmax = p[0];
    if (p[1] < gmin) gmin = p[1]; if (p[1] > gmax) gmax = p[1];
    if (p[2] < bmin) bmin = p[2]; if (p[2] > bmax) bmax = p[2];
  }
  const dr = rmax - rmin, dg = gmax - gmin, db = bmax - bmin;
  if (dr >= dg && dr >= db) return [dr, 0];
  if (dg >= db) return [dg, 1];
  return [db, 2];
}

/** median-cut:反复把样本盒按最宽通道的中位分裂,每盒均色 → ≤want 个调色板项。 */
function medianCut(samples: number[][], want: number): number[][] {
  const boxes: number[][][] = [samples];
  while (boxes.length < want) {
    let best = -1, bestScore = 0, bestChannel = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const [range, ch] = widestChannel(boxes[i]);
      if (range <= 0) continue; // 单色盒不可再分
      const score = range * boxes[i].length;
      if (score > bestScore) { bestScore = score; best = i; bestChannel = ch; }
    }
    if (best < 0) break; // 所有盒都已单色
    const box = boxes[best];
    box.sort((p, q) => p[bestChannel] - q[bestChannel]);
    const mid = box.length >> 1;
    boxes.splice(best, 1, box.slice(0, mid), box.slice(mid));
  }
  return boxes.map(box => {
    let r = 0, g = 0, b = 0;
    for (const p of box) { r += p[0]; g += p[1]; b += p[2]; }
    const n = box.length || 1;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });
}

/** 全像素最近邻映射(精确色缓存把重复色摊成 O(1))→ 索引数组。 */
function mapToPalette(img: ImageData, palette: number[][]): Uint8Array {
  const { data, width, height } = img;
  const k = palette.length;
  const idx = new Uint8Array(width * height);
  const cache = new Map<number, number>();
  for (let p = 0, n = width * height; p < n; p++) {
    const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
    const key = (r << 16) | (g << 8) | b;
    let best = cache.get(key);
    if (best === undefined) {
      let bd = Infinity;
      best = 0;
      for (let i = 0; i < k; i++) {
        const dr = r - palette[i][0], dg = g - palette[i][1], db = b - palette[i][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = i; }
      }
      cache.set(key, best);
    }
    idx[p] = best;
  }
  return idx;
}

// ---------- GIF LZW(minCodeSize=8,LSB 打包,变长码宽) ----------

function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;  // 256
  const eoi = clear + 1;           // 257
  let next = eoi + 1;              // 258
  let width = minCodeSize + 1;     // 9
  const dict = new Map<string, number>();
  const out: number[] = [];
  let bitBuf = 0, bitCnt = 0;
  const put = (code: number) => {
    bitBuf |= code << bitCnt;
    bitCnt += width;
    while (bitCnt >= 8) { out.push(bitBuf & 0xff); bitBuf >>>= 8; bitCnt -= 8; }
  };
  const reset = () => { dict.clear(); next = eoi + 1; width = minCodeSize + 1; };

  put(clear);
  let w = String(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const wc = w + ',' + indices[i];
    if (dict.has(wc)) {
      w = wc;
    } else {
      put(dict.get(w) ?? Number(w));
      if (next < 4096) {
        dict.set(wc, next++);
        if (next === (1 << width) && width < 12) width++;
      } else { // 字典满:发 CLEAR 重置
        put(clear);
        reset();
      }
      w = String(indices[i]);
    }
  }
  put(dict.get(w) ?? Number(w));
  put(eoi);
  if (bitCnt > 0) out.push(bitBuf & 0xff);
  return Uint8Array.from(out);
}

// ---------- 组装 ----------

/** 调色板 → 768 字节(不足 256 色补黑,GIF 色表必须 2 的幂)。 */
function paletteBytes(palette: number[][]): Uint8Array {
  const out = new Uint8Array(768);
  for (let i = 0; i < 256 && i < palette.length; i++) {
    out[i * 3] = palette[i][0];
    out[i * 3 + 1] = palette[i][1];
    out[i * 3 + 2] = palette[i][2];
  }
  return out;
}

/** Frames → GIF89a byte stream (header / LSD / global palette / GCE+LZW per
 *  frame / NETSCAPE2.0 loop / trailer). */
export async function encodeGif(frames: GifFrame[]): Promise<ArrayBuffer> {
  if (!frames.length) throw new Error('没有可编码的帧');
  if (frames.length > MAX_FRAMES) {
    throw new Error(`GIF 最多支持 ${MAX_FRAMES} 帧(当前 ${frames.length} 帧)`);
  }
  const width = frames[0].canvas.width;
  const height = frames[0].canvas.height;

  const palettes: number[][][] = [];
  const indicesList: Uint8Array[] = [];
  for (const f of frames) {
    let c = f.canvas;
    if (c.width !== width || c.height !== height) {
      const u = makeCanvas(width, height);
      ctx2dRead(u).drawImage(c, 0, 0);
      c = u;
    }
    const img = ctx2dRead(c).getImageData(0, 0, width, height);
    const palette = medianCut(samplePixels(img), 256);
    palettes.push(palette);
    indicesList.push(mapToPalette(img, palette));
  }

  const parts: Uint8Array[] = [];
  const push = (bytes: ArrayLike<number>) => parts.push(Uint8Array.from(bytes));

  // 头 + 逻辑屏幕描述符(GCT flag + 256 色表尺寸位)
  push([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // 'GIF89a'
  const lsd = new Uint8Array(7);
  const lv = new DataView(lsd.buffer);
  lv.setUint16(0, width, true);
  lv.setUint16(2, height, true);
  lsd[4] = 0xf7; // 全局色表存在,颜色分辨率 8,色表尺寸 2^(7+1)=256
  push(lsd);
  push(paletteBytes(palettes[0])); // 全局色表 = 首帧调色板

  // NETSCAPE2.0 应用扩展:无限循环
  push([
    0x21, 0xff, 0x0b,
    0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, // "NETSCAPE2.0"
    0x03, 0x01, 0x00, 0x00, 0x00,
  ]);

  for (let i = 0; i < frames.length; i++) {
    // 图形控制扩展:disposal=1(do not dispose),无透明
    const ms = Number.isFinite(frames[i].delayMs) ? frames[i].delayMs : 0;
    const delay = Math.min(0xffff, Math.max(0, Math.round(ms / 10)));
    push([0x21, 0xf9, 0x04, 0x04, delay & 0xff, (delay >> 8) & 0xff, 0x00, 0x00]);

    // 图像描述符:左上 (0,0),局部色表 256 色
    const id = new Uint8Array(10);
    id[0] = 0x2c;
    const iv = new DataView(id.buffer);
    iv.setUint16(1, 0, true);
    iv.setUint16(3, 0, true);
    iv.setUint16(5, width, true);
    iv.setUint16(7, height, true);
    id[9] = 0x87; // 局部色表存在,尺寸 256
    push(id);
    push(paletteBytes(palettes[i]));

    // LZW 索引数据 → ≤255 字节子块
    push([8]); // LZW minCodeSize
    const comp = lzwEncode(indicesList[i], 8);
    for (let o = 0; o < comp.length; o += 255) {
      const chunk = comp.subarray(o, Math.min(o + 255, comp.length));
      push([chunk.length]);
      push(chunk);
    }
    push([0x00]); // 块终结符
  }

  push([0x3b]); // trailer

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out.buffer;
}

/** File → 导出 GIF 动画…:timeline frames → composite per frame → encodeGif →
 *  save dialog → write file. */
export async function exportGifCommand(): Promise<void> {
  const doc = store.doc;
  if (!doc) {
    alert('没有可导出的文档');
    return;
  }
  const { save } = await import('@tauri-apps/plugin-dialog');
  const picked = await save({ defaultPath: 'Untitled.gif' });
  if (!picked) return;
  const path = picked.toLowerCase().endsWith('.gif') ? picked : `${picked}.gif`;
  try {
    const out: GifFrame[] = [];
    if (doc.frames?.length) {
      const frames = doc.frames;
      // 视图帧先吸收图层面板里的直接编辑,再进入逐帧应用(与 APNG 导出一致)
      syncFrameFromLayers(frames[Math.min(anim.current, frames.length - 1)]);
      const snap: LayerSnapshot[] = captureLayerStates(doc);
      for (const f of frames) {
        applyStatesToLayers(doc, f.states);
        out.push({ canvas: composite(doc), delayMs: f.durationMs });
      }
      restoreLayerStates(doc, snap);
      invalidate(); // 重绘回快照状态
    } else {
      out.push({ canvas: composite(doc), delayMs: 100 });
    }
    const buf = await encodeGif(out);
    await writeFile(path, new Uint8Array(buf));
  } catch (err) {
    alert(`无法导出 GIF:${(err as Error).message}`);
  }
}
