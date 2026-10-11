// Undo/redo: closure-based entries. Raster edits snapshot the affected canvas
// before and after; structural edits snapshot the layer array shape.

import { cloneCanvas } from './canvasUtils';

export interface HistoryEntry {
  label: string;
  undo(): void;
  redo(): void;
}

export class History {
  entries: HistoryEntry[] = [];
  index = -1;

  push(entry: HistoryEntry) {
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(entry);
    if (this.entries.length > 100) this.entries.shift();
    this.index = this.entries.length - 1;
  }

  get canUndo() { return this.index >= 0 }
  get canRedo() { return this.index < this.entries.length - 1 }
  get undoLabel() { return this.index >= 0 ? this.entries[this.index].label : null }
  get redoLabel() { return this.index < this.entries.length - 1 ? this.entries[this.index + 1].label : null }

  undo(): boolean {
    if (!this.canUndo) return false;
    this.entries[this.index--].undo();
    return true;
  }

  redo(): boolean {
    if (!this.canRedo) return false;
    this.entries[++this.index].redo();
    return true;
  }

  clear() {
    this.entries = [];
    this.index = -1;
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
