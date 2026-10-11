// Raster image import/export. WebView2 (Chromium) decodes PNG/JPEG/WebP/GIF/BMP
// natively; SVG goes through an <img> element so it rasterizes at full size.

import { makeCanvas, ctx2d } from '../canvasUtils';
import { readFile, writeFile } from './fs';

export async function openImageFile(path: string): Promise<HTMLCanvasElement> {
  const bytes = await readFile(path);
  const blob = new Blob([bytes as unknown as BlobPart], { type: guessMime(path) });
  if (path.toLowerCase().endsWith('.svg')) {
    return decodeViaImage(blob);
  }
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
): Promise<void> {
  const blob = await canvasToBlob(canvas, `image/${format}`, format === 'jpeg' ? quality : undefined);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await writeFile(path, bytes);
}
