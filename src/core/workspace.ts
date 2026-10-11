// Multi-document tabs layered over the single-doc store: each DocTab holds the
// live store.doc reference captured on switch-away, its dirty flag and a
// viewport snapshot (zoom + doc-px left/top). Switching back restores the doc
// via setDoc and the view via navSetView from the navigator bus. The active
// tab's .doc may lag the store until a capture; tabDidSave / tabDidLoad sync
// it so external open/save wiring keeps tab metadata current.

import { reactive, computed } from 'vue';
import type { Doc } from './types';
import { store, setDoc } from './store';
import { viewport } from './viewport';
import { navSetView } from './navBus';
import { touchRecent, basename } from './recent';

export interface DocTab {
  id: string;
  name: string;
  doc: Doc | null;
  dirty: boolean;
  view: { zoom: number; left: number; top: number };
}

export const workspace = reactive<{ tabs: DocTab[]; activeIndex: number }>({
  tabs: [],
  activeIndex: 0,
});

export const activeTab = computed<DocTab | null>(
  () => workspace.tabs[workspace.activeIndex] ?? null,
);

/** Display title: the active tab prefers the live store's fileName. */
export function tabTitle(t: DocTab): string {
  const isActive = workspace.tabs[workspace.activeIndex] === t;
  const fileName = isActive ? store.doc?.fileName : t.doc?.fileName;
  return fileName ? basename(fileName) : t.name;
}

// ---------- capture / restore ----------

function snapView(): DocTab['view'] {
  const zoom = store.zoom || 1;
  if (!store.doc) return { zoom, left: 0, top: 0 };
  // prefer the published viewport (doc-px left/top) when live
  const live = viewport.width > 0 && viewport.scale > 0;
  return {
    zoom: live ? viewport.scale : zoom,
    left: live ? viewport.left : -store.panX / zoom,
    top: live ? viewport.top : -store.panY / zoom,
  };
}

/** Sync the active tab from the live store before switching away / dropping tabs. */
function captureCurrent() {
  const cur = workspace.tabs[workspace.activeIndex];
  if (!cur) return;
  cur.doc = store.doc;
  cur.dirty = store.dirty;
  if (store.doc?.fileName) cur.name = basename(store.doc.fileName);
  cur.view = snapView();
}

function loadTab(tab: DocTab) {
  if (tab.doc) {
    setDoc(tab.doc);                              // wraps layers, resets history, fits view
    navSetView(tab.view.zoom, tab.view.left, tab.view.top); // restore this tab's view
    store.dirty = tab.dirty;
  } else {
    store.doc = null;                             // no doc → WelcomeView
    store.selection = null;
    store.preview = null;
    store.dirty = false;
  }
}

// ---------- naming ----------

/** Lowest free 未命名 number; 1 renders without a suffix. */
function blankName(): string {
  const used = new Set<number>();
  for (const t of workspace.tabs) {
    const m = /^未命名(?:\s(\d+))?$/.exec(t.name);
    if (m) used.add(m[1] ? Number(m[1]) : 1);
  }
  let n = 1;
  while (used.has(n)) n++;
  return n === 1 ? '未命名' : `未命名 ${n}`;
}

function makeBlankTab(): DocTab {
  return {
    id: crypto.randomUUID(),
    name: blankName(),
    doc: null,
    dirty: false,
    view: { zoom: 1, left: 0, top: 0 },
  };
}

// ---------- public API ----------

/** Lazily create the first tab, adopting whatever doc the store currently holds. */
export function ensureTab(): DocTab {
  if (workspace.tabs.length) {
    return workspace.tabs[workspace.activeIndex] ?? workspace.tabs[0];
  }
  const first: DocTab = {
    id: crypto.randomUUID(),
    name: store.doc?.fileName ? basename(store.doc.fileName) : '未命名',
    doc: store.doc,
    dirty: store.dirty,
    view: snapView(),
  };
  workspace.tabs.push(first);
  workspace.activeIndex = 0;
  return first;
}

export function switchTab(i: number) {
  if (i < 0 || i >= workspace.tabs.length || i === workspace.activeIndex) return;
  captureCurrent();
  workspace.activeIndex = i;
  loadTab(workspace.tabs[i]);
}

export function newTab() {
  ensureTab();
  // sole blank tab: just select it instead of stacking a second blank
  if (workspace.tabs.length === 1) {
    const sole = workspace.tabs[0];
    if (!sole.doc && !sole.dirty) {
      workspace.activeIndex = 0;
      return;
    }
  }
  captureCurrent();
  const t = makeBlankTab();
  workspace.tabs.push(t);
  workspace.activeIndex = workspace.tabs.length - 1;
  loadTab(t);
}

export function closeTab(i: number) {
  const t = workspace.tabs[i];
  if (!t) return;
  if (t.dirty && !window.confirm('此文档有未保存修改，确定关闭？')) return;
  const wasActive = i === workspace.activeIndex;
  workspace.tabs.splice(i, 1);
  if (!workspace.tabs.length) {
    const blank = makeBlankTab();   // last tab closed → fresh blank tab
    workspace.tabs.push(blank);
    workspace.activeIndex = 0;
    loadTab(blank);
    return;
  }
  if (wasActive) {
    workspace.activeIndex = Math.min(i, workspace.tabs.length - 1);
    loadTab(workspace.tabs[workspace.activeIndex]);
  } else if (i < workspace.activeIndex) {
    workspace.activeIndex--;
  }
}

export function closeOthers(i: number) {
  const keep = workspace.tabs[i];
  if (!keep || workspace.tabs.length <= 1) return;
  const others = workspace.tabs.filter((_, j) => j !== i);
  if (others.some(t => t.dirty)
      && !window.confirm('其他文档有未保存修改，确定全部关闭？')) return;
  const wasActive = i === workspace.activeIndex;
  if (wasActive) captureCurrent();  // keep is active: sync before dropping the rest
  workspace.tabs = [keep];
  workspace.activeIndex = 0;
  if (!wasActive) loadTab(keep);
}

/** Wire-in for commands.ts after a successful save: rename tab, clear dirty, record recent. */
export function tabDidSave(path: string) {
  const t = workspace.tabs[workspace.activeIndex];
  if (!t) return;
  t.doc = store.doc;
  if (store.doc) store.doc.fileName = path;
  t.name = basename(path);
  t.dirty = false;
  touchRecent(path);
}

/** Wire-in for commands.ts after opening a file: adopt doc, rename tab, record recent. */
export function tabDidLoad(path: string, name: string) {
  const t = workspace.tabs[workspace.activeIndex];
  if (!t) return;
  t.doc = store.doc;
  if (store.doc && !store.doc.fileName) store.doc.fileName = path;
  t.name = name || basename(path);
  t.dirty = store.dirty;
  touchRecent(path);
}
