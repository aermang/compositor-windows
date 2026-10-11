<script setup lang="ts">
// RAW 开发对话框:store.dialog === 'raw' 时挂载,payload 为 { path, meta }。
// 左侧为 900px 长边预览(150ms 防抖 + 序号防串台),右侧为曝光/色温/色调/提升
// 滑杆与自动白平衡;确定动作走全分辨率 developRaw。

import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { store, newDoc, addRasterLayer, rawCanvas } from '../core/store';
import { developRaw } from '../core/io/raw';
import type { RawSettings } from '../core/io/raw';
import { autoWhiteBalance } from '../core/cameraRaw';
import { ensureTab, tabDidLoad } from '../core/workspace';
import { basename } from '../core/recent';
import { ctx2dRead } from '../core/canvasUtils';

const NAME = 'raw';
const isOpen = computed(() => store.dialog === NAME);

interface RawMeta { width: number; height: number; asShotTemperature: number; asShotTint: number }
const payload = computed<{ path: string; meta: RawMeta } | null>(() =>
  store.dialog === NAME ? store.dialogPayload as { path: string; meta: RawMeta } : null);

const settings = reactive<RawSettings>({
  exposure: 0,
  temperature: 5500,
  tint: 0,
  boost: 50,
});
const developing = ref(false); // 预览开发中
const busy = ref(false);       // 全分辨率开发中(按钮防重入)
const error = ref('');
const previewRef = ref<HTMLCanvasElement | null>(null);
let seq = 0;
let timer: number | undefined;

const title = computed(() => payload.value ? `RAW 开发 — ${basename(payload.value.path)}` : 'RAW 开发');
const dims = computed(() => {
  const p = payload.value;
  return p ? `${p.meta.width} × ${p.meta.height}` : '';
});
const docName = computed(() => {
  const p = payload.value;
  return p ? basename(p.path).replace(/\.[^.]+$/, '') : 'RAW';
});
const hasDoc = computed(() => !!store.doc);

function close() { store.dialog = null; store.dialogPayload = null; }
function cancel() { close(); }

function drawPreview(c: HTMLCanvasElement) {
  const cv = previewRef.value;
  if (!cv) return;
  if (cv.width !== c.width || cv.height !== c.height) {
    cv.width = c.width;
    cv.height = c.height;
  }
  const cx = cv.getContext('2d');
  if (!cx) return;
  cx.clearRect(0, 0, cv.width, cv.height);
  cx.drawImage(c, 0, 0);
}

async function renderPreview() {
  const p = payload.value;
  if (!p) return;
  const my = ++seq;
  developing.value = true;
  error.value = '';
  try {
    const c = await developRaw(p.path, { ...settings }, 900);
    if (my !== seq) return; // 过期响应,丢弃
    drawPreview(c);
  } catch (err) {
    if (my === seq) error.value = `预览失败：${(err as Error).message}`;
  } finally {
    if (my === seq) developing.value = false;
  }
}

function schedulePreview() {
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(() => void renderPreview(), 150);
}

/** 自动白平衡:用 300px 小图采样,把结果写回色温/色调滑杆。 */
async function autoWB() {
  const p = payload.value;
  if (!p) return;
  developing.value = true;
  try {
    const small = await developRaw(p.path, { ...settings }, 300);
    const id = ctx2dRead(small).getImageData(0, 0, small.width, small.height);
    const wb = autoWhiteBalance(id);
    settings.temperature = Math.round(Math.min(12000, Math.max(2000, wb.temperature)));
    settings.tint = Math.round(Math.min(100, Math.max(-100, wb.tint)));
  } catch (err) {
    error.value = `自动白平衡失败：${(err as Error).message}`;
  } finally {
    developing.value = false;
  }
}

/** 全分辨率开发 → 新文档(镜像 commands.ts 的 openImage 流程)。 */
async function openAsDocument() {
  const p = payload.value;
  if (!p || busy.value) return;
  busy.value = true;
  try {
    const canvas = await developRaw(p.path, { ...settings });
    const name = docName.value;
    newDoc(canvas.width, canvas.height, 'transparent', name);
    const doc = store.doc!;
    doc.layers[0].bitmap = rawCanvas(canvas);
    doc.layers[0].name = name;
    store.tick++;
    ensureTab();
    tabDidLoad(p.path, name);
    close();
  } catch (err) {
    window.alert(`RAW 开发失败：${(err as Error).message}`);
  } finally {
    busy.value = false;
  }
}

/** 全分辨率开发 → 作为新图层加入当前文档。 */
async function importAsLayer() {
  const p = payload.value;
  if (!p || busy.value || !store.doc) return;
  busy.value = true;
  try {
    const canvas = await developRaw(p.path, { ...settings });
    const layer = addRasterLayer(docName.value, rawCanvas(canvas));
    if (layer) layer.transform.size = [canvas.width, canvas.height];
    store.tick++;
    close();
  } catch (err) {
    window.alert(`RAW 导入失败：${(err as Error).message}`);
  } finally {
    busy.value = false;
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && store.dialog === NAME) cancel();
}

function teardown() {
  if (timer) { window.clearTimeout(timer); timer = undefined; }
  seq++;
  developing.value = false;
  busy.value = false;
  window.removeEventListener('keydown', onKey);
}

watch(isOpen, open => {
  if (open) {
    const meta = payload.value?.meta;
    settings.exposure = 0;
    settings.temperature = meta?.asShotTemperature ?? 5500;
    settings.tint = meta?.asShotTint ?? 0;
    settings.boost = 50;
    error.value = '';
    window.addEventListener('keydown', onKey);
    void renderPreview();
  } else {
    teardown();
  }
}, { immediate: true });
watch(settings, schedulePreview); // 深监听:滑杆变化 → 防抖重绘
onBeforeUnmount(teardown);
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="backdrop" @click="cancel"></div>
    <div v-if="isOpen" class="dialog wide">
      <h3>{{ title }}</h3>
      <div class="sub">{{ dims }}</div>
      <div class="body">
        <div class="preview-box">
          <canvas ref="previewRef" class="preview"></canvas>
          <div v-if="developing" class="loading">开发中…</div>
          <div v-if="error" class="err">{{ error }}</div>
        </div>
        <div class="controls">
          <label class="row">曝光
            <input type="range" min="-3" max="3" step="0.05" v-model.number="settings.exposure" />
            <span class="v">{{ settings.exposure.toFixed(2) }}</span>
          </label>
          <label class="row">色温
            <input type="range" min="2000" max="12000" step="50" v-model.number="settings.temperature" />
            <span class="v">{{ settings.temperature }}K</span>
          </label>
          <label class="row">色调
            <input type="range" min="-100" max="100" step="1" v-model.number="settings.tint" />
            <span class="v">{{ settings.tint }}</span>
          </label>
          <label class="row">提升
            <input type="range" min="0" max="100" step="1" v-model.number="settings.boost" />
            <span class="v">{{ settings.boost }}</span>
          </label>
          <button class="btn" :disabled="developing || busy" @click="autoWB">自动白平衡</button>
        </div>
      </div>
      <div class="actions">
        <button class="btn" :disabled="busy" @click="cancel">取消</button>
        <button class="btn" :disabled="!hasDoc || busy" @click="importAsLayer">作为图层导入</button>
        <button class="btn primary" :disabled="busy" @click="openAsDocument">作为新文档打开</button>
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
  max-width: 640px;
  max-height: 82vh;
  overflow-y: auto;
  color: #ddd;
  box-shadow: 0 16px 48px rgba(0,0,0,0.6);
  z-index: 201;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dialog.wide { min-width: 700px; }
h3 { margin: 0; font-size: 14px; color: #fff; }
.sub { font-size: 11px; color: #777; margin-top: -6px; }
.body { display: grid; grid-template-columns: 432px 1fr; gap: 14px; }
.preview-box {
  position: relative;
  width: 432px;
  height: 332px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: conic-gradient(#3a3a3a 0 25%, #2e2e2e 0 50%, #3a3a3a 0 75%, #2e2e2e 0) 0 0 / 16px 16px;
  border: 1px solid #444;
  border-radius: 4px;
}
canvas.preview { max-width: 420px; max-height: 320px; display: block; }
.loading, .err {
  position: absolute;
  left: 0; right: 0; bottom: 8px;
  text-align: center;
  font-size: 11px;
}
.loading { color: #bbb; }
.err { color: #e06c60; }
.controls { display: flex; flex-direction: column; gap: 10px; justify-content: center; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; color: #aaa; }
.row input[type='range'] { flex: 1; min-width: 110px; accent-color: #0e639c; }
.row .v { min-width: 56px; text-align: right; color: #999; font-size: 11px; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
.btn {
  background: #333; color: #ddd; border: 1px solid #454545;
  border-radius: 5px; padding: 6px 14px; font-size: 12px; cursor: pointer;
}
.btn:hover { background: #3a3a3a; }
.btn.primary { background: #0e639c; border-color: #1177bb; color: #fff; }
.btn.primary:hover { background: #1177bb; }
.btn:disabled { opacity: 0.5; cursor: default; }
</style>
