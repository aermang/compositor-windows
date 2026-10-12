// Undo/redo: closure-based entries. Raster edits snapshot the affected canvas
// before and after; structural edits snapshot the layer array shape.

import { reactive } from 'vue';
import { cloneCanvas } from './canvasUtils';

export interface HistoryEntry {
  label: string;
  undo(): void;
  redo(): void;
}

/** Reactive revision counter bumped on every history mutation (push / undo /
 *  redo / clear / jumpTo). History itself is a plain non-reactive class, so UI
 *  mirrors such as the history panel track this counter to re-render. Purely
 *  additive: existing push/undo/redo semantics and signatures are untouched. */
export const historyRevision = reactive({ n: 0 });

export class History {
  entries: HistoryEntry[] = [];
  index = -1;

  push(entry: HistoryEntry) {
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(entry);
    if (this.entries.length > 100) this.entries.shift();
    this.index = this.entries.length - 1;
    historyRevision.n++;
  }

  get canUndo() { return this.index >= 0 }
  get canRedo() { return this.index < this.entries.length - 1 }
  get undoLabel() { return this.index >= 0 ? this.entries[this.index].label : null }
  get redoLabel() { return this.index < this.entries.length - 1 ? this.entries[this.index + 1].label : null }

  undo(): boolean {
    if (!this.canUndo) return false;
    this.entries[this.index--].undo();
    historyRevision.n++;
    return true;
  }

  redo(): boolean {
    if (!this.canRedo) return false;
    this.entries[++this.index].redo();
    historyRevision.n++;
    return true;
  }

  clear() {
    this.entries = [];
    this.index = -1;
    historyRevision.n++;
  }

  /** Photoshop-style nonlinear jump: replay undo()/redo() step by step until
   *  index === target, reusing the existing closure entries so the document
   *  state stays exactly consistent with Ctrl+Z / Ctrl+Shift+Z. Target -1 is
   *  the document's initial state. Returns true when the index moved. */
  jumpTo(target: number): boolean {
    const clamped = Math.max(-1, Math.min(this.entries.length - 1, target));
    let moved = false;
    while (this.index > clamped && this.undo()) moved = true;
    while (this.index < clamped && this.redo()) moved = true;
    return moved;
  }
}

/** Snapshot a raster canvas so an edit can be reverted. */
export function snapCanvas(c: HTMLCanvasElement | null): HTMLCanvasElement | null {
  return c ? cloneCanvas(c) : null;
}

export function restoreCanvas(target: HTMLCanvasElement | null, snap: HTMLCanvasElement | null): HTMLCanvasElement | null {
  // callers reassign layer.bitmap from the returned snapshot
  return snap ? cloneCanvas(snap) : target;
}
