// Quick mask (Q): the selection becomes a paintable rubylith. Entering converts
// store.selection into a doc-size red overlay (alpha carries the mask grayscale);
// brush/eraser paint into that canvas via getQuickMaskCanvas() (see paint.ts);
// leaving thresholds alpha≥128 back into a selection mask. The red veil renders
// through the overlay registry so CanvasView stays quick-mask-agnostic.

import { store } from './store';
import { makeCanvas, ctx2d, ctx2dRead } from './canvasUtils';
import { emptySelection, finalize } from './selection';
import { registerOverlay, unregisterOverlay } from './overlayRegistry';

const OVERLAY_ID = 'quickmask';

// rubylith 固定纯红;alpha 通道承载蒙版灰度。画笔 dab 用同一色(前景色无关)。
export const QUICK_MASK_COLOR = '#ff0000';

let rubylith: HTMLCanvasElement | null = null;

/** 画笔目标:快速蒙版打开时返回 rubylith 画布,否则 null(防止残留画布被误画)。 */
export function getQuickMaskCanvas(): HTMLCanvasElement | null {
  return store.quickMask ? rubylith : null;
}

/** Overlay renderer: 把 rubylith 以 50% 整体 alpha 画在合成图上(文档空间→屏幕)。
 *  幂等:store.quickMask 为 false(setDoc 切文档自动置 false)时直接不画。 */
function drawQuickMaskOverlay(
  ctx: CanvasRenderingContext2D,
  z: number,
  X: (dx: number) => number,
  Y: (dy: number) => number,
): void {
  const rub = rubylith;
  if (!store.quickMask || !rub || !store.doc) return;
  ctx.save();
  ctx.globalAlpha = 0.5; // PS 式半透明红罩,不挡住底下画面
  ctx.drawImage(rub, X(0), Y(0), rub.width * z, rub.height * z);
  ctx.restore();
}

function enterQuickMask(): void {
  const doc = store.doc;
  if (!doc) return;
  const c = makeCanvas(doc.width, doc.height);
  const cx = ctx2d(c);
  const sel = store.selection;
  if (sel && sel.mask.width === doc.width && sel.mask.height === doc.height) {
    // selection → rubylith:红色覆盖,alpha = mask 灰度(G/B 留 0 = 纯红)
    const id = ctx2dRead(sel.mask).getImageData(0, 0, doc.width, doc.height).data;
    const out = cx.createImageData(doc.width, doc.height);
    for (let p = 0; p < doc.width * doc.height; p++) {
      const i = p * 4;
      out.data[i] = 255;
      out.data[i + 3] = id[i + 3];
    }
    cx.putImageData(out, 0, 0);
  }
  rubylith = c;
  store.quickMask = true;
  registerOverlay(OVERLAY_ID, drawQuickMaskOverlay);
  store.tick++;
}

/** rubylith → selection:alpha≥128 → 白(选中),否则黑。阈值化保证"矩形选区进 Q
 *  不画直接出 Q"与原选区逐位一致(选区 alpha 只有 0/255;抗锯齿边缘按阈值归化)。 */
export function exitQuickMask(): void {
  const doc = store.doc;
  const rub = rubylith;
  rubylith = null;
  unregisterOverlay(OVERLAY_ID);
  store.quickMask = false;
  if (doc && rub && rub.width === doc.width && rub.height === doc.height) {
    const w = rub.width, h = rub.height;
    const id = ctx2dRead(rub).getImageData(0, 0, w, h).data;
    const sel = emptySelection(doc);
    const out = ctx2dRead(sel.mask).createImageData(w, h);
    for (let p = 0; p < w * h; p++) {
      const i = p * 4;
      out.data[i] = out.data[i + 1] = out.data[i + 2] = 255;
      out.data[i + 3] = id[i + 3] >= 128 ? 255 : 0;
    }
    ctx2dRead(sel.mask).putImageData(out, 0, 0);
    store.selection = finalize(sel);
  }
  store.tick++;
}

export function toggleQuickMask(): void {
  if (store.quickMask) exitQuickMask();
  else enterQuickMask();
}
