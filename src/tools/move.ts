// Move tool: drags the active layer's transform origin (non-destructive), with
// arrow-key nudging handled by the command layer. Alt-drag duplicates first.

import { store, history, activeLayer, duplicateLayer } from '../core/store';
import type { Layer } from '../core/types';
import type { Tool } from './index';

interface MoveSession {
  layer: Layer;
  startOrigin: [number, number];
  start: { x: number; y: number };
  moved: boolean;
}

let session: MoveSession | null = null;

export const moveTool: Tool = {
  id: 'move',
  cursor: 'move',
  onDown(e) {
    const layer = activeLayer.value;
    if (!layer || layer.adjustment) return;
    let target = layer;
    if (e.alt) {
      const copy = duplicateLayer(layer);
      if (copy) target = copy;
    }
    session = {
      layer: target,
      startOrigin: [...target.transform.origin],
      start: { x: e.doc.x, y: e.doc.y },
      moved: false,
    };
  },
  onDrag(e) {
    if (!session) return;
    const dx = e.doc.x - session.start.x, dy = e.doc.y - session.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 0.5) session.moved = true;
    if (!session.moved) return;
    session.layer.transform.origin = [session.startOrigin[0] + dx, session.startOrigin[1] + dy];
    store.dirty = true;
    store.tick++;
  },
  onUp() {
    if (!session) return;
    const s = session;
    session = null;
    if (!s.moved) return;
    const end: [number, number] = [...s.layer.transform.origin];
    const before: [number, number] = [...s.startOrigin];
    const layer = s.layer;
    history.push({
      label: 'Move Layer',
      undo: () => { layer.transform.origin = [...before]; store.tick++; },
      redo: () => { layer.transform.origin = [...end]; store.tick++; },
    });
  },
};
