// Recent-projects list persisted in localStorage under 'compositor.recents':
// { path, name } entries, newest first, capped at 10. getRecents() filters out
// dead paths via the Tauri path_exists command (invoke failure keeps the entry
// so running in a plain browser never wipes the list).

import { pathExists } from './io/fs';

export interface RecentEntry {
  path: string;
  name: string;
}

const KEY = 'compositor.recents';
const MAX = 10;

export function basename(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  return base || p;
}

function readRaw(): RecentEntry[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(v)) return [];
    return v.filter(
      (e): e is RecentEntry =>
        !!e && typeof e === 'object'
        && typeof (e as RecentEntry).path === 'string'
        && typeof (e as RecentEntry).name === 'string',
    ).map(e => ({ path: e.path, name: e.name }));
  } catch {
    return [];
  }
}

function write(entries: RecentEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX)));
  } catch {
    // quota exceeded / private mode: recents are best-effort
  }
}

/** Record (or re-front) a project path. */
export function touchRecent(path: string) {
  if (!path) return;
  const rest = readRaw().filter(e => e.path !== path);
  rest.unshift({ path, name: basename(path) });
  write(rest);
}

/** Drop one entry (e.g. user removed it from the welcome list). */
export function removeRecent(path: string) {
  write(readRaw().filter(e => e.path !== path));
}

/** Recents whose files still exist; dead entries are pruned along the way. */
export async function getRecents(): Promise<RecentEntry[]> {
  const alive: RecentEntry[] = [];
  for (const e of readRaw()) {
    let exists = true;
    try {
      exists = await pathExists(e.path);
    } catch {
      exists = true; // invoke unavailable (non-Tauri context) — keep the entry
    }
    if (exists) alive.push(e);
    else removeRecent(e.path);
  }
  return alive;
}
