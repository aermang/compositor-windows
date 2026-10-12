<!-- 动作面板(录制/回放/批处理)。 -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { store } from '../core/store';
import {
  actions, actionsUi, startRecording, stopRecording,
  playSteps, deleteAction, stepLabel, runActionBatch,
} from '../core/actions';
import type { Action } from '../core/actions';

const folded = ref(false);
const nameInput = ref('');
const selectedId = ref<string | null>(null);
const busy = ref(false);

const selected = computed(() => actions.find(a => a.id === selectedId.value) ?? null);
// 录制状态走 actionsUi(reactive 镜像)— isRecording()/recordingName() 读模块
// 普通变量,computed 无依赖不会重算,不能直接用于渲染。
const recActive = computed(() => actionsUi.recordingId !== null);
const recName = computed(() =>
  actions.find(a => a.id === actionsUi.recordingId)?.name ?? '');

/** 悬停提示:逐步展示命令 label(已删除命令给占位)。 */
function tooltip(a: Action): string {
  return a.steps.length ? a.steps.map(s => stepLabel(s.commandId)).join(' → ') : '空动作(录制后停止即丢弃)';
}

function newAction() {
  if (busy.value) return;
  startRecording(nameInput.value);
  nameInput.value = '';
}

async function replay() {
  const action = selected.value;
  if (!action || busy.value) return;
  busy.value = true;
  try {
    await playSteps(action.steps);
  } finally {
    busy.value = false;
  }
}

function remove() {
  const action = selected.value;
  if (!action || busy.value) return;
  deleteAction(action.id);
  if (selectedId.value === action.id) selectedId.value = null;
}

async function batch() {
  const action = selected.value;
  if (!action || busy.value) return;
  busy.value = true;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const folder = await open({ directory: true, multiple: false, title: '选择批处理文件夹' });
    if (typeof folder !== 'string' || !folder) return;
    const r = await runActionBatch(folder, action);
    alert(`批处理完成 ${r.done}/${r.total}`);
  } catch (err) {
    alert(`批处理失败：${(err as Error).message}`);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="actions-panel" v-if="store.doc">
    <button class="panel-title" @click="folded = !folded">动作 {{ folded ? '▸' : '▾' }}</button>
    <div v-if="!folded" class="actions-body">
      <div v-if="recActive" class="rec-line"><span class="rec-dot"></span>录制中：{{ recName }}</div>
      <div v-else-if="actionsUi.playing" class="play-line">回放中 {{ actionsUi.playIndex }}/{{ actionsUi.playTotal }}</div>

      <div v-if="!actions.length" class="empty">无动作</div>
      <div
        v-for="a in actions"
        :key="a.id"
        class="action-row"
        :class="{ sel: a.id === selectedId }"
        :title="tooltip(a)"
        @click="selectedId = a.id"
      >
        <span v-if="actionsUi.recordingId === a.id" class="rec-dot"></span>
        <span class="a-name">{{ a.name }}</span>
        <span class="a-count">{{ a.steps.length }} 步</span>
      </div>

      <div class="new-row">
        <input v-model="nameInput" placeholder="动作名" @keydown.enter.prevent="newAction" />
        <button :disabled="recActive || busy" @click="newAction">新建动作</button>
      </div>
      <div class="btns">
        <button v-if="recActive" class="stop" @click="stopRecording">停止录制</button>
        <button :disabled="!selected || busy || recActive || actionsUi.playing" @click="replay">回放</button>
        <button :disabled="!selected || busy || recActive" @click="remove">删除</button>
        <button :disabled="!selected || busy || recActive" @click="batch">批处理</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.actions-panel { display: flex; flex-direction: column; min-height: 0; border-top: 1px solid #111; }
.panel-title { text-align: left; padding: 6px 10px; background: #232323; color: #ccc; border: none; font-size: 12px; cursor: pointer; }
.actions-body { flex: 1; min-height: 48px; max-height: 220px; overflow: auto; color: #bbb; font-size: 12px; padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }
.empty { color: #777; padding: 2px 0; }
.rec-line, .play-line { display: flex; align-items: center; gap: 6px; color: #e5c07b; }
.rec-dot { width: 8px; height: 8px; border-radius: 50%; background: #e5484d; display: inline-block; flex: none; }
.action-row { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 3px; cursor: pointer; }
.action-row:hover { background: #2c2c2c; }
.action-row.sel { background: #0e639c; color: #fff; }
.a-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.a-count { color: #888; flex: none; }
.action-row.sel .a-count { color: #cde5ff; }
.new-row { display: flex; gap: 4px; margin-top: 2px; }
.new-row input { flex: 1; min-width: 0; background: #1b1b1b; border: 1px solid #3c3c3c; color: #ddd; font-size: 12px; padding: 3px 6px; border-radius: 3px; }
.btns { display: flex; gap: 4px; flex-wrap: wrap; }
.btns button, .new-row button {
  background: #333; color: #ccc; border: 1px solid #444; font-size: 12px;
  padding: 3px 8px; border-radius: 3px; cursor: pointer;
}
.btns button:hover:not(:disabled), .new-row button:hover:not(:disabled) { background: #3d3d3d; color: #fff; }
.btns button:disabled, .new-row button:disabled { opacity: 0.45; cursor: default; }
.btns .stop { border-color: #e5484d; color: #ff8a8d; }
</style>
