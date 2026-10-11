<script setup lang="ts">
// In-canvas text editor: a contenteditable div positioned/scaled/rotated to sit
// exactly on the text layer's box on screen. While it is mounted the layer's
// own rendered bitmap is hidden (isVisible=false) so only the live caret text
// shows; typing re-renders the bitmap through upsertTextBitmap (the type
// tool's path) debounced 120ms. Esc cancels back to the original content,
// Ctrl+Enter commits, clicking outside commits.

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { store, upsertTextBitmap, invalidate } from '../core/store';
import { uiFlags } from '../core/uiFlags';
import type { CSSProperties } from 'vue';

const props = defineProps<{ layerId: string }>();

const root = ref<HTMLDivElement | null>(null);

const layer = computed(() => store.doc?.layers.find(l => l.id === props.layerId) ?? null);

let originalContent = '';
let wasVisible = true;
let debounceTimer: number | undefined;
let finished = false;

// PostScript font name → CSS family, mirroring the compositor's mapping so the
// editor's glyphs match the rendered bitmap.
function cssFamily(postScriptName: string): string {
  const m = postScriptName.match(/^(.*?)-(Regular|Bold|Italic|BoldItalic|Light|Semibold|Medium)$/);
  if (!m) return `"${postScriptName}", system-ui, sans-serif`;
  const map: Record<string, string> = {
    Regular: '', Bold: 'bold', Italic: 'italic', BoldItalic: 'bold italic',
    Light: '300', Semibold: '600', Medium: '500',
  };
  return `${map[m[2]] || ''} "${m[1]}", system-ui, sans-serif`.trim();
}

function rgbCss(rgb: [number, number, number]): string {
  return `rgb(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)})`;
}

// Halo that keeps the text readable over the checkerboard regardless of color.
function contrastHalo(rgb: [number, number, number]): string {
  const l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const c = l > 0.5 ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.6)';
  return `0 0 1px ${c}, 0 0 2px ${c}, 1px 0 1px ${c}, -1px 0 1px ${c}, 0 1px 1px ${c}, 0 -1px 1px ${c}`;
}

const style = computed<CSSProperties>(() => {
  const l = layer.value;
  const t = l?.text;
  if (!l || !t) return { display: 'none' };
  const z = store.zoom;
  const fontSize = Math.max(8, t.fontSize * z);
  return {
    left: `${store.panX + l.transform.origin[0] * z}px`,
    top: `${store.panY + l.transform.origin[1] * z}px`,
    width: t.boxSize ? `${Math.max(80, t.boxSize[0] * z)}px` : 'max-content',
    minWidth: '80px',
    transform: l.transform.rotation ? `rotate(${l.transform.rotation}deg)` : undefined,
    fontSize: `${fontSize}px`,
    fontFamily: cssFamily(t.fontName),
    lineHeight: `${t.lineSpacing * z}px`,
    letterSpacing: t.tracking ? `${t.tracking * z}px` : undefined,
    color: rgbCss(t.color),
    caretColor: rgbCss(t.color),
    textAlign: t.align,
    textShadow: contrastHalo(t.color),
    whiteSpace: t.boxSize ? 'pre-wrap' : 'pre',
  };
});

function currentText(): string {
  const el = root.value;
  if (!el) return originalContent;
  return el.innerText.replace(/\n$/, '');
}

function syncNow() {
  const l = layer.value;
  if (!l?.text || finished) return;
  upsertTextBitmap(l, { ...l.text, content: currentText() });
}

function onInput() {
  if (finished) return;
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(syncNow, 120);
}

function finish() {
  if (finished) return;
  finished = true;
  window.clearTimeout(debounceTimer);
  // reveal the layer's own render again while it is still resolvable
  const l = layer.value;
  if (l && l.isVisible === false) {
    l.isVisible = wasVisible;
    invalidate();
  }
  store.editingTextId = null;
  uiFlags.editingTextLayerId = null;
}

function commit() {
  if (finished) return;
  syncNow();
  finish();
}

function cancel() {
  if (finished) return;
  window.clearTimeout(debounceTimer);
  const l = layer.value;
  if (l?.text) upsertTextBitmap(l, { ...l.text, content: originalContent });
  finish();
}

function onKeydown(e: KeyboardEvent) {
  e.stopPropagation();
  if (e.key === 'Escape') {
    e.preventDefault();
    cancel();
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    commit();
  } else if (e.key === 'Enter') {
    // plain newlines only, no block formatting
    e.preventDefault();
    document.execCommand('insertLineBreak');
    onInput();
  } else if (e.key === 'Tab') {
    e.preventDefault();
  }
}

function onBlur() {
  commit();
}

// Click outside commits and swallows the click so the canvas underneath does
// not start a tool stroke in the same gesture.
function onDocPointerDown(e: PointerEvent) {
  const el = root.value;
  if (!el || finished) return;
  if (e.target instanceof Node && el.contains(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
  commit();
}

watch(layer, l => { if (!l) finish(); });

onMounted(async () => {
  const l = layer.value;
  if (!l?.text) { finish(); return; }
  originalContent = l.text.content;
  wasVisible = l.isVisible;
  // hide the layer's own render; the live caret text replaces it
  l.isVisible = false;
  invalidate();
  const el = root.value!;
  el.textContent = originalContent;
  await nextTick();
  el.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  if (originalContent === 'Text') {
    sel?.removeAllRanges();
    sel?.addRange(range);            // placeholder: select all, first typing replaces
  } else {
    range.collapse(false);           // caret at end
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
  document.addEventListener('pointerdown', onDocPointerDown, true);
});

onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  window.clearTimeout(debounceTimer);
  const l = layer.value;
  if (l && l.isVisible === false) {
    l.isVisible = wasVisible;
    invalidate();
  }
});
</script>

<template>
  <div
    ref="root"
    class="inline-text-editor"
    contenteditable="true"
    spellcheck="false"
    :style="style"
    @input="onInput"
    @keydown="onKeydown"
    @blur="onBlur"
  ></div>
</template>

<style scoped>
.inline-text-editor {
  position: absolute;
  margin: 0;
  padding: 0;
  background: transparent;
  border: none;
  outline: none;
  overflow: visible;
  word-break: break-word;
  z-index: 6;
  transform-origin: 50% 50%;
  -webkit-user-modify: read-write-plaintext-only;
}
</style>
