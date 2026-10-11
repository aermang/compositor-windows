<script setup lang="ts">
// PSD 导入对话框:store.dialog === 'psd' 时挂载,payload 为 { path }。
// 读取文件 → isPsd 校验 → readPsd → psdToDoc → setDoc → ensureTab + tabDidLoad,
// 然后列出导入说明;没有说明时导入完成即自动关闭。

import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { store, setDoc } from '../core/store';
import { readFile } from '../core/io/fs';
import { isPsd, readPsd } from '../core/io/psd/builder';
import { psdToDoc, psdNotes } from '../core/io/psdImport';
import { ensureTab, tabDidLoad } from '../core/workspace';
import { basename } from '../core/recent';

const NAME = 'psd';
const isOpen = computed(() => store.dialog === NAME);

const notes = ref<string[]>([]);
const importing = ref(false);

function close() { store.dialog = null; store.dialogPayload = null; }

async function run() {
  const payload = store.dialogPayload as { path: string } | null;
  const path = payload?.path;
  if (!path) { close(); return; }
  importing.value = true;
  try {
    const bytes = await readFile(path);
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    if (!isPsd(buf)) {
      window.alert('不是有效的 PSD 文件');
      close();
      return;
    }
    const result = readPsd(buf);
    setDoc(psdToDoc(result));
    ensureTab();
    tabDidLoad(path, basename(path));
    const list = psdNotes(result);
    if (list.length === 0) {
      close(); // 干净导入:无说明可展示
      return;
    }
    notes.value = list;
  } catch (err) {
    window.alert(`无法导入 PSD：${(err as Error).message}`);
    close();
  } finally {
    importing.value = false;
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && store.dialog === NAME) close();
}

watch(isOpen, open => {
  if (open) {
    notes.value = [];
    window.addEventListener('keydown', onKey);
    void run();
  } else {
    window.removeEventListener('keydown', onKey);
  }
}, { immediate: true });
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="backdrop" @click="close"></div>
    <div v-if="isOpen" class="dialog">
      <h3>PSD 导入</h3>
      <div v-if="notes.length" class="notes">
        <div class="notes-title">导入说明</div>
        <div v-for="(n, i) in notes" :key="i" class="note">{{ n }}</div>
      </div>
      <div v-else class="hint">正在导入…</div>
      <div class="actions">
        <button class="btn primary" :disabled="importing || !notes.length" @click="close">关闭</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.45);
  z-index: 200;
}
.dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: #2b2b2b;
  border: 1px solid #000;
  border-radius: 10px;
  padding: 18px 20px;
  min-width: 340px;
  max-width: 520px;
  max-height: 82vh;
  overflow-y: auto;
  color: #ddd;
  box-shadow: 0 16px 48px rgba(0,0,0,0.6);
  z-index: 201;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
h3 { margin: 0 0 4px; font-size: 14px; color: #fff; }
.hint { font-size: 12px; color: #777; line-height: 1.5; }
.notes { display: flex; flex-direction: column; gap: 4px; }
.notes-title { font-size: 12px; color: #aaa; margin-bottom: 2px; }
.note { font-size: 12px; color: #999; line-height: 1.5; padding-left: 12px; position: relative; }
.note::before { content: '·'; position: absolute; left: 2px; color: #666; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
.btn {
  background: #333; color: #ddd; border: 1px solid #454545;
  border-radius: 5px; padding: 6px 14px; font-size: 12px; cursor: pointer;
}
.btn:hover { background: #3a3a3a; }
.btn.primary { background: #0e639c; border-color: #1177bb; color: #fff; }
.btn.primary:hover { background: #1177bb; }
.btn.primary:disabled { opacity: 0.5; cursor: default; }
</style>
