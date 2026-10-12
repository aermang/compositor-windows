// Alpha channels (选区存储): the Channels panel lists stored selections plus
// the composite RGB view. Signatures are frozen (commands.ts already routes to
// them). Channel canvases share the selection-mask encoding: doc-sized, white
// RGB, selection coverage in alpha (255 = fully selected).

import { toRaw } from 'vue';
import { store, history, rawCanvas } from './store';
import { makeCanvas, ctx2d } from './canvasUtils';
import { emptySelection, finalize } from './selection';
import type { AlphaChannel } from './types';

/** 选择 → 存储选区: copy store.selection.mask into a new doc.alphaChannels
 *  entry named 「Alpha N」 (history-tracked). No-op without a selection. */
export function storeSelectionAsChannel(): void {
  const doc = store.doc;
  const sel = store.selection;
  if (!doc || !sel) return;
  doc.alphaChannels ??= [];
  const beforeLen = doc.alphaChannels.length;
  const canvas = rawCanvas(makeCanvas(doc.width, doc.height));
  ctx2d(canvas).drawImage(sel.mask, 0, 0);
  doc.alphaChannels.push({
    id: crypto.randomUUID(),
    name: `Alpha ${doc.alphaChannels.length + 1}`,
    canvas,
  });
  // 浅拷贝闭包即可:v1 通道 canvas 内容不会被改动,undo/redo 只恢复数组形状。
  const after = doc.alphaChannels.slice();
  history.push({
    label: '存储选区为通道',
    undo: () => {
      if (!store.doc?.alphaChannels) return;
      store.doc.alphaChannels = store.doc.alphaChannels.slice(0, beforeLen);
      store.tick++;
    },
    redo: () => {
      if (!store.doc) return;
      store.doc.alphaChannels = after.slice();
      store.tick++;
    },
  });
  store.dirty = true;
  store.tick++;
}

/** Channels panel → 载入为选区: replace store.selection with the channel's
 *  canvas (fresh SelectionState via finalize). Not history-tracked, like the
 *  other selection-making operations. */
export function loadChannelAsSelection(ch: AlphaChannel): void {
  const doc = store.doc;
  if (!doc) return;
  const sel = emptySelection(doc);
  ctx2d(sel.mask).drawImage(toRaw(ch).canvas, 0, 0);
  store.selection = finalize(sel);
  store.tick++; // marching ants repaint
}

/** Channels panel → 删除通道 (history-tracked). */
export function deleteChannel(ch: AlphaChannel): void {
  const doc = store.doc;
  if (!doc?.alphaChannels) return;
  const channel = toRaw(ch);
  const idx = doc.alphaChannels.indexOf(channel);
  if (idx < 0) return;
  doc.alphaChannels.splice(idx, 1);
  history.push({
    label: '删除通道',
    undo: () => {
      if (!store.doc?.alphaChannels) return;
      // 回到删除前的位置;数组被并发改动过时退化为追加到末尾
      store.doc.alphaChannels.splice(Math.min(idx, store.doc.alphaChannels.length), 0, channel);
      store.tick++;
    },
    redo: () => {
      if (!store.doc?.alphaChannels) return;
      const i = store.doc.alphaChannels.indexOf(channel);
      if (i >= 0) store.doc.alphaChannels.splice(i, 1);
      store.tick++;
    },
  });
  store.dirty = true;
  store.tick++;
}
