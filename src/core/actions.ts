// Actions: records runCommand() dispatches into named actions, replays them,
// and batch-runs an action over a folder of images. Actions live OUTSIDE the
// document/history (they are app-level objects) and persist to localStorage
// under 'compositor.actions' (tolerant load, debounced writes).
//
// Recording hook: runCommand() calls recordStep(id) before every dispatch.
// recordStep ignores calls while replaying (internal flag) so a replay never
// re-records itself, and skips 'actions.*' ids so panel-internal commands
// never enter a recording.

import { reactive } from 'vue';
import { commandById } from '../commands';
import { setDoc, flattenDoc, rawCanvas } from './store';
import { makeLayer, defaultTransform } from './types';
import type { Doc } from './types';
import { openImageFile, exportCanvas } from './io/raster';
import { listDir, makeDir } from './io/fs';

export type ActionStep = { commandId: string };

export interface Action {
  id: string;
  name: string;
  steps: ActionStep[];
}

// ---------- module state ----------

const LS_KEY = 'compositor.actions';

/** Tolerant load: malformed/legacy JSON yields an empty list, never a throw. */
function loadActions(): Action[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Action[] = [];
    for (const a of parsed as unknown[]) {
      if (!a || typeof a !== 'object') continue;
      const rec = a as { id?: unknown; name?: unknown; steps?: unknown };
      if (typeof rec.id !== 'string' || typeof rec.name !== 'string' || !Array.isArray(rec.steps)) continue;
      out.push({
        id: rec.id,
        name: rec.name,
        steps: (rec.steps as unknown[])
          .filter((s): s is { commandId: string } => !!s && typeof (s as ActionStep).commandId === 'string')
          .map(s => ({ commandId: s.commandId })),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** 全部动作(reactive — 面板直接渲染这个数组)。 */
export const actions: Action[] = reactive<Action[]>(loadActions());

let recording: Action | null = null;
let replaying = false;

/** 面板订阅的录制/回放 UI 状态(模块内 recording/replaying 是普通变量,
 *  这里放一份 reactive 镜像驱动视图)。 */
export const actionsUi = reactive({
  recordingId: null as string | null,
  playing: false,
  playIndex: 0,
  playTotal: 0,
});

// ---------- persistence (debounced) ----------

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** 立即写盘(debounce 到期或页面卸载时调用)。 */
export function flushActions(): void {
  if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(actions));
  } catch { /* 配额满/隐私模式:静默,不影响编辑 */ }
}

function persist(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; flushActions(); }, 150);
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushActions);
}

// ---------- frozen API ----------

export function isRecording(): boolean {
  return recording !== null;
}

/** runCommand 每次成功派发前调用(热路径,禁止 throw;录制未开时立即返回)。 */
export function recordStep(commandId: string): void {
  if (!recording || replaying) return;         // 未录制 / 回放中:忽略(回放禁止自录制)
  if (commandId.startsWith('actions.')) return; // 面板自身命令不入列
  recording.steps.push({ commandId });
  persist();
}

export function startRecording(name: string): void {
  stopRecording(); // 同时只允许一个录制会话
  const fresh: Action = {
    id: crypto.randomUUID().toUpperCase(),
    name: name.trim() || `动作 ${actions.length + 1}`,
    steps: [],
  };
  actions.push(fresh); // 入列即展示,录制过程中步骤数实时可见
  // recording 保存 reactive 代理(从数组读回),recordStep 经代理 push 才能
  // 触发面板的实时步骤数更新(改原始对象不触发响应式)。
  recording = actions[actions.length - 1] ?? fresh;
  actionsUi.recordingId = recording.id;
  persist();
}

export function stopRecording(): void {
  const cur = recording;
  recording = null;
  actionsUi.recordingId = null;
  if (!cur) return;
  if (cur.steps.length === 0) {
    // 空动作丢弃
    const i = actions.findIndex(a => a.id === cur.id);
    if (i >= 0) actions.splice(i, 1);
  }
  persist();
}

export interface PlayResult { ran: number; skipped: number }

/** 依序回放一个动作的全部步骤(跳过已删除/不可用的命令,单步失败不中断)。 */
export async function playSteps(steps: ActionStep[]): Promise<PlayResult> {
  let ran = 0;
  let skipped = 0;
  replaying = true; // 回放期间的 recordStep 全部忽略
  actionsUi.playing = true;
  actionsUi.playTotal = steps.length;
  try {
    for (let i = 0; i < steps.length; i++) {
      actionsUi.playIndex = i + 1;
      const c = commandById(steps[i].commandId);
      if (!c || (c.enabled && !c.enabled())) { skipped++; continue; }
      try {
        await c.run();
        ran++;
      } catch (err) {
        console.warn(`动作步骤 ${steps[i].commandId} 执行失败,已跳过:`, err);
        skipped++;
      }
    }
  } finally {
    replaying = false;
    actionsUi.playing = false;
  }
  return { ran, skipped };
}

// ---------- query / edit helpers ----------

export function listActions(): Action[] {
  return actions;
}

export function getAction(id: string): Action | null {
  return actions.find(a => a.id === id) ?? null;
}

export function deleteAction(id: string): void {
  const i = actions.findIndex(a => a.id === id);
  if (i >= 0) { actions.splice(i, 1); persist(); }
}

export function renameAction(id: string, name: string): void {
  const a = getAction(id);
  if (a && name.trim()) { a.name = name.trim(); persist(); }
}

/** 当前正在录制的动作(未录制为 null)。 */
export function currentAction(): Action | null {
  return recording;
}

/** 正在录制的步骤列表(未录制为 [])。 */
export function currentSteps(): ActionStep[] {
  return recording ? recording.steps : [];
}

export function recordingName(): string {
  return recording?.name ?? '';
}

export function isReplaying(): boolean {
  return replaying;
}

/** 步骤的菜单 label(命令已删除时给出占位,供悬停提示)。 */
export function stepLabel(commandId: string): string {
  return commandById(commandId)?.label ?? `${commandId}(命令已不存在)`;
}

// ---------- batch (动作 × 文件夹) ----------

const BATCH_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp']);

export interface BatchResult { done: number; total: number }

/** 对 folder 下的 png/jpg/webp/jpeg 逐张:解码 → 建文档 → 回放动作 → 导出
 *  PNG 到 `<folder>/rendered/<原名>.png`。单张失败 console.warn 跳过。 */
export async function runActionBatch(folder: string, action: Action): Promise<BatchResult> {
  const base = folder.replace(/[\\/]+$/, '');
  const entries = await listDir(base);
  const files = entries
    .filter(e => BATCH_EXTS.has(e.toLowerCase().split('.').pop() ?? ''))
    .sort();
  const outDir = `${base}/rendered`;
  if (files.length) await makeDir(outDir);
  let done = 0;
  for (const name of files) {
    try {
      const canvas = await openImageFile(`${base}/${name}`);
      const doc: Doc = {
        id: crypto.randomUUID().toUpperCase(),
        width: canvas.width,
        height: canvas.height,
        resolution: 72,
        layers: [],
        activeLayerId: null,
        fileName: name,
      };
      const layer = makeLayer({ name });
      layer.bitmap = rawCanvas(canvas);
      layer.transform = defaultTransform(canvas.width, canvas.height);
      doc.layers.push(layer);
      doc.activeLayerId = layer.id;
      setDoc(doc);
      await playSteps(action.steps);
      await exportCanvas(flattenDoc(), `${outDir}/${name.replace(/\.[^.]+$/, '')}.png`, 'png');
      done++;
    } catch (err) {
      console.warn(`批处理:跳过 ${name}`, err);
    }
  }
  return { done, total: files.length };
}
