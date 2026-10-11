// RAW camera-file import. The Rust side (src-tauri/src/raw.rs) decodes with
// rawloader and runs the develop pipeline; develop_raw answers with a binary
// payload (24-byte header + RGBA8) that invoke() resolves as an ArrayBuffer.

import { invoke } from '@tauri-apps/api/core';
import { makeCanvas, ctx2d } from '../canvasUtils';

export interface RawSettings {
  exposure: number;
  temperature: number;
  tint: number;
  boost: number;
}

const RAW_EXTENSIONS = new Set([
  'cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw',
  'erf', '3fr', 'iiq', 'mos', 'mrw', 'x3f',
]);

export function isRawPath(path: string): boolean {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  return RAW_EXTENSIONS.has(ext);
}

export async function rawMetadata(path: string): Promise<{
  width: number;
  height: number;
  asShotTemperature: number;
  asShotTint: number;
}> {
  return invoke('raw_metadata', { path });
}

// Memoize the last developed canvas: repeated identical requests (common
// while a preview re-renders) skip the round trip entirely.
let lastKey = '';
let lastCanvas: HTMLCanvasElement | null = null;

export async function developRaw(
  path: string,
  s: RawSettings,
  limit?: number,
): Promise<HTMLCanvasElement> {
  const key = JSON.stringify([path, s, limit ?? 0]);
  if (lastCanvas && key === lastKey) return lastCanvas;

  const buf = await invoke<ArrayBuffer>('develop_raw', {
    path,
    settings: s,
    limit: limit ?? null,
  });
  const dv = new DataView(buf);
  const w = Number(dv.getBigUint64(0, true));
  const h = Number(dv.getBigUint64(8, true));
  if (w <= 0 || h <= 0 || buf.byteLength < 24 + w * h * 4) {
    throw new Error('malformed develop_raw payload');
  }
  const rgba = new Uint8ClampedArray(buf, 24, w * h * 4);
  const img = new ImageData(rgba, w, h);
  const canvas = makeCanvas(w, h);
  ctx2d(canvas).putImageData(img, 0, 0);
  lastKey = key;
  lastCanvas = canvas;
  return canvas;
}
