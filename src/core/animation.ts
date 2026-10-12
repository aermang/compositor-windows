// Frame-animation timeline. Lives OUTSIDE the store/history on purpose:
// Photoshop's timeline is likewise independent of undo, so frame ops don't push
// history entries (v1 trade-off — undo won't revert frame edits). A frame is a
// set of per-layer visibility/opacity overrides; applying a frame writes those
// values straight onto the reactive layers (the same properties the layers
// panel edits), so frame editing IS layer-property editing — PS semantics.
// Playback snapshots every layer first and restores on stop, so stopping
// mid-animation can never lose the user's pre-play layer state.

import { reactive } from 'vue';
import type { AnimFrame, AnimFrameState, Doc } from './types';
import { store, invalidate } from './store';
import { composite } from './compositor';
import { registerOverlay } from './overlayRegistry';

/** Flat layer appearance snapshot (id-keyed; layers may come and go). */
export interface LayerSnapshot { id: string; visible: boolean; opacity: number }

// Module-level reactive (not in store): timeline UI state belongs to this
// feature, and the panel binds to it directly.
export const anim = reactive({
  current: 0,
  playing: false,
  onion: false,
});

function framesOf(doc: Doc | null): AnimFrame[] {
  return doc?.frames ?? [];
}

function statesFromLayers(doc: Doc): Record<string, AnimFrameState> {
  const out: Record<string, AnimFrameState> = {};
  for (const l of doc.layers) out[l.id] = { visible: l.isVisible, opacity: l.opacity };
  return out;
}

function makeFrame(states: Record<string, AnimFrameState>): AnimFrame {
  // deep-copy: a frame must freeze the values it was created from
  return {
    id: crypto.randomUUID().toUpperCase(),
    durationMs: 100,
    states: JSON.parse(JSON.stringify(states)) as Record<string, AnimFrameState>,
  };
}

export function captureLayerStates(doc: Doc): LayerSnapshot[] {
  return doc.layers.map(l => ({ id: l.id, visible: l.isVisible, opacity: l.opacity }));
}

export function restoreLayerStates(doc: Doc, snap: LayerSnapshot[]): void {
  const byId = new Map(doc.layers.map(l => [l.id, l] as const));
  for (const s of snap) {
    const l = byId.get(s.id);
    if (l) { l.isVisible = s.visible; l.opacity = s.opacity; }
  }
}

/** Write a frame's overrides onto the live layers; layers missing from
 *  `states` keep their own values (per the type contract in types.ts). */
export function applyStatesToLayers(doc: Doc, states: Record<string, AnimFrameState>): void {
  for (const l of doc.layers) {
    const s = states[l.id];
    if (s) { l.isVisible = s.visible; l.opacity = s.opacity; }
  }
}

/** Initialize an empty timeline to a single frame capturing the current layer
 *  values. Returns true when it created the timeline (caller decides whether
 *  an extra frame is wanted — the panel's first 新建帧 click must yield exactly
 *  one frame). */
export function ensureFrames(doc: Doc): boolean {
  if (doc.frames && doc.frames.length) return false;
  doc.frames = [makeFrame(statesFromLayers(doc))];
  invalidate();
  return true;
}

/** Absorb direct layer edits into a frame — call before duplicating/exporting
 *  so changes made in the layers panel aren't silently dropped. */
export function syncFrameFromLayers(frame: AnimFrame): void {
  const doc = store.doc;
  if (!doc) return;
  frame.states = statesFromLayers(doc);
}

/** New frame: first click births the timeline (single frame = current look);
 *  afterwards it duplicates the current frame and selects the copy. */
export function addFrame(): void {
  const doc = store.doc;
  if (!doc) return;
  if (ensureFrames(doc)) return;
  const frames = doc.frames!;
  syncFrameFromLayers(frames[anim.current]); // absorb direct layer edits before copying
  frames.splice(anim.current + 1, 0, makeFrame(frames[anim.current].states));
  anim.current += 1;
  invalidate();
}

export function duplicateFrame(i: number): void {
  const doc = store.doc;
  const frames = framesOf(doc);
  if (!doc || !frames.length) return;
  const at = Math.max(0, Math.min(i, frames.length - 1));
  const copy = makeFrame(frames[at].states);
  copy.durationMs = frames[at].durationMs;
  frames.splice(at + 1, 0, copy);
  anim.current = at + 1;
  invalidate();
}

export function deleteFrame(i: number): void {
  const doc = store.doc;
  const frames = framesOf(doc);
  if (!doc || frames.length <= 1) return; // PS keeps at least one frame on the timeline
  frames.splice(i, 1);
  anim.current = Math.max(0, Math.min(anim.current, frames.length - 1));
  invalidate();
}

/** Apply a frame's states to the layers without touching playback state
 *  (filmstrip click preview). */
export function applyFrame(frame: AnimFrame): void {
  const doc = store.doc;
  if (!doc) return;
  applyStatesToLayers(doc, frame.states);
  invalidate();
}

export function gotoFrame(i: number): void {
  const frames = framesOf(store.doc);
  if (!frames.length) return;
  const at = Math.max(0, Math.min(i, frames.length - 1));
  anim.current = at;
  applyFrame(frames[at]);
}

// ---------- playback ----------

let playTimer: number | null = null;
// Snapshot taken when play() starts; restored by stop() so a user who stops
// mid-animation gets their pre-play layer state back instead of whichever
// frame the timer happened to be on.
let prePlay: { docId: string; layers: LayerSnapshot[] } | null = null;

export function play(): void {
  const doc = store.doc;
  const frames = framesOf(doc);
  if (!doc || !frames.length || anim.playing) return;
  prePlay = { docId: doc.id, layers: captureLayerStates(doc) };
  anim.playing = true;
  applyFrame(frames[anim.current]);
  scheduleNext();
}

function scheduleNext(): void {
  const frames = framesOf(store.doc);
  if (!anim.playing || !frames.length) { stop(); return; }
  const delay = Math.max(1, frames[anim.current].durationMs || 1);
  playTimer = window.setTimeout(() => {
    if (!anim.playing) return;
    const fs = framesOf(store.doc);
    if (!fs.length) { stop(); return; }
    anim.current = (anim.current + 1) % fs.length;
    applyFrame(fs[anim.current]);
    scheduleNext();
  }, delay);
}

export function stop(): void {
  if (playTimer !== null) { clearTimeout(playTimer); playTimer = null; }
  anim.playing = false;
  const doc = store.doc;
  // Restore only into the doc we snapshotted: switching docs mid-play must not
  // smear the old doc's layer state onto the new one.
  if (prePlay && doc && doc.id === prePlay.docId) {
    restoreLayerStates(doc, prePlay.layers);
    invalidate();
  }
  prePlay = null;
}

// ---------- onion skin ----------

// Ghosting re-composites the whole document, which is expensive on large docs,
// so the memo rebuilds only when the frame selection / doc / frame count
// changes — pixel edits (tick bumps) reuse the cached ghosts.
interface OnionMemo { key: string; prev: HTMLCanvasElement | null; next: HTMLCanvasElement | null }
let onionMemo: OnionMemo | null = null;

function onionKey(doc: Doc): string {
  return `${doc.id}|${anim.current}|${doc.frames?.length ?? 0}`;
}

/** Composite one frame's look WITHOUT letting the temporary states escape:
 *  apply → composite → restore, all synchronous (composite is sync). */
function ghostComposite(doc: Doc, idx: number): HTMLCanvasElement | null {
  const frames = doc.frames!;
  const at = ((idx % frames.length) + frames.length) % frames.length;
  const snap = captureLayerStates(doc);
  applyStatesToLayers(doc, frames[at].states);
  const out = composite(doc);
  restoreLayerStates(doc, snap);
  return out;
}

function onionFor(doc: Doc): OnionMemo {
  const key = onionKey(doc);
  if (onionMemo && onionMemo.key === key) return onionMemo;
  const frames = doc.frames!;
  const memo: OnionMemo = { key, prev: null, next: null };
  if (frames.length >= 2) {
    memo.prev = ghostComposite(doc, anim.current - 1);
    // with only 2 frames prev and next are the same frame — draw it once
    memo.next = frames.length > 2 ? ghostComposite(doc, anim.current + 1) : null;
  }
  onionMemo = memo;
  return memo;
}

export function setOnion(b: boolean): void {
  if (anim.onion === b) return;
  anim.onion = b;
  onionMemo = null;
  invalidate(); // the overlay pass runs on every tick — force one
}

// Ghost overlay: previous frame at 0.3, next at 0.2, drawn in screen space via
// the doc→screen mappers. Idempotent — returns immediately when disabled or
// during playback (playing already shows the real frame).
registerOverlay('onion', (ctx, z, X, Y) => {
  const doc = store.doc;
  if (!doc || !anim.onion || anim.playing) return;
  const frames = doc.frames;
  if (!frames || frames.length < 2) return;
  const memo = onionFor(doc);
  const w = doc.width * z;
  const h = doc.height * z;
  ctx.save();
  if (memo.prev) {
    ctx.globalAlpha = 0.3;
    ctx.drawImage(memo.prev, X(0), Y(0), w, h);
  }
  if (memo.next) {
    ctx.globalAlpha = 0.2;
    ctx.drawImage(memo.next, X(0), Y(0), w, h);
  }
  ctx.restore();
});

// The memo keys on doc id, so doc switches self-invalidate; nothing else to
// reset there (the panel's doc watch calls stop() for the timer).

// Dev/test hook: Playwright drives gotoFrame/applyFrame through the same live
// module instance the app uses (same URL ⇒ same Vite module).
if (import.meta.env.DEV) {
  (window as unknown as { __animDebug: unknown }).__animDebug = {
    anim, ensureFrames, addFrame, duplicateFrame, deleteFrame, gotoFrame,
    applyFrame, applyStatesToLayers, syncFrameFromLayers, play, stop, setOnion,
  };
}
