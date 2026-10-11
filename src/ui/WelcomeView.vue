<script setup lang="ts">
// No-document landing page: big actions + recents list.

import { onMounted, ref } from 'vue';
import { store } from '../core/store';
import { runCommand, openPathByKind } from '../commands';
import { getRecents, removeRecent } from '../core/recent';
import type { RecentEntry } from '../core/recent';

const recents = ref<RecentEntry[]>([]);

async function refreshRecents() {
  try {
    recents.value = (await getRecents()).slice(0, 6);
  } catch {
    recents.value = [];
  }
}

function openRecent(path: string) {
  void openPathByKind(path);
}

async function removeEntry(path: string) {
  await removeRecent(path);
  await refreshRecents();
}

function openShortcuts() { store.dialog = 'shortcuts'; }
function about() { store.dialog = 'about'; }

onMounted(refreshRecents);
</script>

<template>
  <div class="welcome" v-if="!store.doc">
    <div class="card">
      <h1>Compositor</h1>
      <p class="sub">基于 Windows 的图层式图像编辑器</p>
      <div class="actions">
        <button class="big" @click="runCommand('file.new')">新建…</button>
        <button class="big" @click="runCommand('file.openImage')">打开图像…</button>
        <button class="big ghost" @click="runCommand('file.openComp')">打开项目…</button>
      </div>
      <div class="tips">
        <div>一切皆图层 —— 调整、渐变、文字都可随时修改。</div>
        <div>保存为 <code>.comp</code> 可与 macOS 版互相打开。</div>
        <div>随时按 <kbd>Ctrl+F</kbd> 搜索所有命令。</div>
      </div>
      <div class="foot">
        <button class="link" @click="openShortcuts">键盘快捷键</button>
        <span>·</span>
        <button class="link" @click="about">关于</button>
      </div>
      <div class="recents">
        <div class="recents-title">最近打开</div>
        <div v-if="recents.length" class="recents-list">
          <div
            v-for="r in recents"
            :key="r.path"
            class="recent-row"
            :title="r.path"
            @click="openRecent(r.path)"
          >
            <span class="recent-name">{{ r.name }}</span>
            <span class="recent-path">{{ r.path }}</span>
            <button class="recent-x" title="从列表移除" @click.stop="removeEntry(r.path)">✕</button>
          </div>
        </div>
        <div v-else class="recents-empty">暂无最近项目</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.welcome {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: #1e1e1e;
  z-index: 10;
}
.card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
  color: #aaa;
  max-width: 520px;
  padding: 40px;
}
h1 {
  font-size: 44px;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: #fff;
  margin: 0;
}
.sub { margin: 0; font-size: 14px; color: #777; }
.actions { display: flex; gap: 10px; margin-top: 18px; }
.big {
  background: #0e639c;
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 12px 22px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.big:hover { background: #1177bb; }
.big.ghost { background: #333; border: 1px solid #454545; }
.big.ghost:hover { background: #3a3a3a; }
.tips {
  margin-top: 26px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: #666;
  line-height: 1.5;
}
kbd, code {
  background: #111;
  border: 1px solid #333;
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11px;
  color: #999;
}
.foot { margin-top: 20px; display: flex; gap: 8px; align-items: center; font-size: 11px; }
.link {
  background: none;
  border: none;
  color: #4da3ff;
  cursor: pointer;
  font-size: 11px;
  padding: 0;
}
.link:hover { text-decoration: underline; }
.recents {
  margin-top: 26px;
  width: 100%;
  max-width: 440px;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.recents-title { font-size: 11px; color: #666; letter-spacing: 0.04em; }
.recents-list { display: flex; flex-direction: column; gap: 2px; }
.recent-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 6px;
  border-radius: 6px;
  cursor: pointer;
  min-width: 0;
}
.recent-row:hover { background: #262626; }
.recent-name {
  font-size: 12px;
  color: #eee;
  white-space: nowrap;
  flex-shrink: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.recent-path {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: #666;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.recent-x {
  background: none;
  border: none;
  color: #666;
  font-size: 11px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
}
.recent-x:hover { color: #eee; background: #3a3a3a; }
.recents-empty { font-size: 12px; color: #555; padding: 2px 6px; }
</style>
