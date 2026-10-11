// Thin typed wrappers over the Rust file commands (see src-tauri/src/lib.rs).

import { invoke } from '@tauri-apps/api/core';

export function readFile(path: string): Promise<Uint8Array> {
  return invoke< number[]>('read_file', { path }).then(a => new Uint8Array(a));
}

export function readTextFile(path: string): Promise<string> {
  return invoke<string>('read_text_file', { path });
}

export function writeFile(path: string, bytes: Uint8Array): Promise<void> {
  // serde expects a JSON array of numbers; chunk to keep payloads manageable
  return invoke<void>('write_file', { path, bytes: Array.from(bytes) });
}

export function writeFileAtomic(path: string, bytes: Uint8Array): Promise<void> {
  return invoke<void>('write_file_atomic', { path, bytes: Array.from(bytes) });
}

export function listDir(path: string): Promise<string[]> {
  return invoke<string[]>('list_dir', { path });
}

export function pathExists(path: string): Promise<boolean> {
  return invoke<boolean>('path_exists', { path });
}

export function makeDir(path: string): Promise<void> {
  return invoke<void>('make_dir', { path });
}

export function removeFile(path: string): Promise<void> {
  return invoke<void>('remove_file', { path });
}

export function renamePath(from: string, to: string): Promise<void> {
  return invoke<void>('rename_path', { from, to });
}
