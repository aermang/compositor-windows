// Raster image import/export. WebView2 (Chromium) decodes PNG/JPEG/WebP/GIF/BMP
// natively; SVG goes through an <img> element so it rasterizes at full size.
// openImageWithMeta additionally byte-scans PNG (iCCP) / JPEG (APP2) for the
// embedded ICC profile; decode itself is unchanged.

import { makeCanvas, ctx2d } from '../canvasUtils';
import { readFile, writeFile } from './fs';
import { extractIccFromPng, extractIccFromJpeg, injectIccPng, injectIccJpeg, iccDescription } from './icc';

export interface OpenedImage {
  canvas: HTMLCanvasElement;
  icc?: Uint8Array;   // 原始 ICC 字节(仅 PNG/JPEG 容器可取;WebP 等无字节接口不取)
  iccName?: string;   // 描述名,如 'sRGB IEC61966-2.1'
}

export async function openImageWithMeta(path: string): Promise<OpenedImage> {
  const bytes = await readFile(path);
  // ICC 提取是纯字节扫描,失败不影响解码;WebP/GIF/BMP/SVG 浏览器无 ICC 容器接口。
  let icc: Uint8Array | undefined;
  const lower = path.toLowerCase();
  try {
    if (lower.endsWith('.png')) icc = (await extractIccFromPng(bytes))?.profile;
    else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) icc = (await extractIccFromJpeg(bytes))?.profile;
  } catch { /* ICC 提取失败不拦解码 */ }
  const blob = new Blob([bytes as unknown as BlobPart], { type: guessMime(path) });
  const canvas = lower.endsWith('.svg')
    ? await decodeViaImage(blob)
    : await decodeViaBitmap(blob);
  return icc ? { canvas, icc, iccName: iccDescription(icc) } : { canvas };
}

/** 旧入口:只要画布。薄包装,行为与原先完全一致。 */
export async function openImageFile(path: string): Promise<HTMLCanvasElement> {
  return (await openImageWithMeta(path)).canvas;
}

async function decodeViaBitmap(blob: Blob): Promise<HTMLCanvasElement> {
  try {
    const bmp = await createImageBitmap(blob);
    const c = makeCanvas(bmp.width, bmp.height);
    ctx2d(c).drawImage(bmp, 0, 0);
    bmp.close();
    return c;
  } catch {
    return decodeViaImage(blob); // exotic formats the fast path rejected
  }
}

async function decodeViaImage(blob: Blob): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('image decode failed'));
      img.src = url;
    });
    const w = img.naturalWidth || 1024, h = img.naturalHeight || 1024;
    const c = makeCanvas(w, h);
    ctx2d(c).drawImage(img, 0, 0, w, h);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function guessMime(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  };
  return map[ext] ?? 'application/octet-stream';
}

export function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((res, rej) => {
    canvas.toBlob(b => (b ? res(b) : rej(new Error('encode failed'))), type, quality);
  });
}

export async function exportCanvas(
  canvas: HTMLCanvasElement, path: string, format: 'png' | 'jpeg' | 'webp', quality = 0.92,
  meta?: { icc?: Uint8Array }, // ICC 回写(仅 PNG/JPEG 有容器位);不传与旧行为完全一致
): Promise<void> {
  const blob = await canvasToBlob(canvas, `image/${format}`, format === 'jpeg' ? quality : undefined);
  let bytes: Uint8Array = new Uint8Array(await blob.arrayBuffer());
  const icc = meta?.icc;
  if (icc && icc.length > 0 && format === 'png') bytes = await injectIccPng(bytes, icc);
  else if (icc && icc.length > 0 && format === 'jpeg') bytes = await injectIccJpeg(bytes, icc);
  await writeFile(path, bytes);
}
