<script setup lang="ts">
// Contextual header: controls for the active tool, Photoshop-style.

import { store, activeLayer } from '../core/store';
import { TOOL_ZH } from '../core/labels';
import { wandMode } from '../tools/select';
import { uiFlags } from '../core/uiFlags';

const brushTarget = store.opts.brush;
const FONTS = ['Segoe UI', 'Arial', 'Times New Roman', 'Georgia', 'Courier New', 'Verdana', 'Impact', 'Comic Sans MS'];
</script>

<template>
  <div class="tool-options" v-if="store.doc">
    <!-- Move -->
    <template v-if="store.tool === 'move'">
      <span class="lbl">{{ activeLayer?.name ?? '无图层' }}</span>
      <span class="hint">拖动移动 · Alt 拖动复制 · 方向键微调</span>
      <label class="check"><input type="checkbox" v-model="uiFlags.transformHandles" /> 显示变换手柄 (Ctrl+T)</label>
    </template>

    <!-- Marquee -->
    <template v-else-if="store.tool === 'marquee'">
      <span class="lbl">选框</span>
      <div class="seg">
        <button :class="{ on: store.opts.marquee.shape === 'rectangle' }" @click="store.opts.marquee.shape = 'rectangle'">▭ 矩形</button>
        <button :class="{ on: store.opts.marquee.shape === 'ellipse' }" @click="store.opts.marquee.shape = 'ellipse'">◯ 椭圆</button>
      </div>
      <span class="hint">Shift 加选 · Alt 减选</span>
    </template>

    <!-- Lasso -->
    <template v-else-if="store.tool === 'lasso'">
      <span class="lbl">套索</span>
      <div class="seg">
        <button :class="{ on: !store.opts.lasso.polygonal }" @click="store.opts.lasso.polygonal = false">自由套索</button>
        <button :class="{ on: store.opts.lasso.polygonal }" @click="store.opts.lasso.polygonal = true">多边形套索</button>
      </div>
      <span class="hint">多边形：单击加点，Enter 闭合，Esc 取消</span>
    </template>

    <!-- Wand -->
    <template v-else-if="store.tool === 'wand'">
      <span class="lbl">魔棒</span>
      <div class="seg">
        <button :class="{ on: wandMode.mode === 'pixel' }" @click="wandMode.mode = 'pixel'">像素</button>
        <button :class="{ on: wandMode.mode === 'object' }" @click="wandMode.mode = 'object'">对象</button>
      </div>
      <template v-if="wandMode.mode === 'pixel'">
        <label class="field">容差
          <input type="range" min="0" max="128" v-model.number="store.opts.wand.tolerance" />
          <span class="val">{{ store.opts.wand.tolerance }}</span>
        </label>
        <label class="check"><input type="checkbox" v-model="store.opts.wand.contiguous" /> 连续</label>
        <label class="field">样本半径
          <input type="range" min="1" max="5" step="1" v-model.number="store.opts.wand.sampleRadius" />
          <span class="val">{{ store.opts.wand.sampleRadius }}</span>
        </label>
      </template>
      <span v-else class="hint">点击画面中的对象，自动选取（近似算法）</span>
    </template>

    <!-- Crop -->
    <template v-else-if="store.tool === 'crop'">
      <span class="lbl">裁剪</span>
      <select class="select" v-model="store.opts.crop.ratio">
        <option value="free">自由</option>
        <option value="1:1">1:1</option>
        <option value="4:3">4:3</option>
        <option value="3:2">3:2</option>
        <option value="16:9">16:9</option>
        <option value="9:16">9:16</option>
      </select>
      <span class="hint">Enter 或双击应用 · Esc 取消</span>
    </template>

    <!-- Brush / Eraser -->
    <template v-else-if="store.tool === 'brush' || store.tool === 'eraser'">
      <span class="lbl">{{ store.tool === 'brush' ? '画笔' : '橡皮擦' }}</span>
      <label class="field">大小
        <input type="range" min="1" max="300" v-model.number="brushTarget.size" />
        <span class="val">{{ brushTarget.size }} px</span>
      </label>
      <label class="field">硬度
        <input type="range" min="0" max="1" step="0.05" v-model.number="brushTarget.hardness" />
        <span class="val">{{ Math.round(brushTarget.hardness * 100) }}%</span>
      </label>
      <label class="field">不透明度
        <input type="range" min="0.05" max="1" step="0.05" v-model.number="brushTarget.opacity" />
        <span class="val">{{ Math.round(brushTarget.opacity * 100) }}%</span>
      </label>
      <template v-if="activeLayer?.mask">
        <div class="seg">
          <button :class="{ on: store.paintingTarget === 'image' }" @click="store.paintingTarget = 'image'">图像</button>
          <button :class="{ on: store.paintingTarget === 'mask' }" @click="store.paintingTarget = 'mask'">蒙版</button>
        </div>
      </template>
    </template>

    <!-- Clone -->
    <template v-else-if="store.tool === 'clone'">
      <span class="lbl">仿制图章</span>
      <label class="field">大小
        <input type="range" min="1" max="300" v-model.number="store.opts.clone.size" />
        <span class="val">{{ store.opts.clone.size }} px</span>
      </label>
      <label class="field">硬度
        <input type="range" min="0" max="1" step="0.05" v-model.number="store.opts.clone.hardness" />
        <span class="val">{{ Math.round(store.opts.clone.hardness * 100) }}%</span>
      </label>
      <label class="check"><input type="checkbox" v-model="store.opts.clone.aligned" /> 对齐</label>
      <span class="hint">Alt 单击设置源</span>
    </template>

    <!-- Smear -->
    <template v-else-if="store.tool === 'smear'">
      <span class="lbl">涂抹</span>
      <div class="seg">
        <button :class="{ on: store.opts.smear.mode === 'liquify' }" @click="store.opts.smear.mode = 'liquify'">液化</button>
        <button :class="{ on: store.opts.smear.mode === 'smudge' }" @click="store.opts.smear.mode = 'smudge'">涂抹</button>
        <button :class="{ on: store.opts.smear.mode === 'blur' }" @click="store.opts.smear.mode = 'blur'">模糊</button>
      </div>
      <label class="field">大小
        <input type="range" min="4" max="500" v-model.number="store.opts.smear.diameter" />
        <span class="val">{{ store.opts.smear.diameter }} px</span>
      </label>
      <label class="field">硬度
        <input type="range" min="0" max="0.98" step="0.02" v-model.number="store.opts.smear.hardness" />
        <span class="val">{{ Math.round(store.opts.smear.hardness * 100) }}%</span>
      </label>
      <label v-if="store.opts.smear.mode !== 'blur'" class="field">强度
        <input type="range" min="0.05" max="1" step="0.05" v-model.number="store.opts.smear.strength" />
        <span class="val">{{ Math.round(store.opts.smear.strength * 100) }}%</span>
      </label>
      <template v-if="activeLayer?.mask">
        <div class="seg">
          <button :class="{ on: store.paintingTarget === 'image' }" @click="store.paintingTarget = 'image'">图像</button>
          <button :class="{ on: store.paintingTarget === 'mask' }" @click="store.paintingTarget = 'mask'">蒙版</button>
        </div>
      </template>
      <span class="hint">液化：推移像素 · 涂抹：拖动颜色 · 模糊：模糊笔刷</span>
    </template>

    <!-- Gradient -->
    <template v-else-if="store.tool === 'gradient'">
      <span class="lbl">渐变</span>
      <div class="seg">
        <button :class="{ on: store.opts.gradient.type === 'linear' }" @click="store.opts.gradient.type = 'linear'">线性</button>
        <button :class="{ on: store.opts.gradient.type === 'radial' }" @click="store.opts.gradient.type = 'radial'">径向</button>
      </div>
      <div class="seg">
        <button :class="{ on: store.opts.gradient.mode === 'fg-bg' }" @click="store.opts.gradient.mode = 'fg-bg'">前景→背景</button>
        <button :class="{ on: store.opts.gradient.mode === 'fg-transparent' }" @click="store.opts.gradient.mode = 'fg-transparent'">前景→透明</button>
      </div>
    </template>

    <!-- Shape -->
    <template v-else-if="store.tool === 'shape'">
      <span class="lbl">形状</span>
      <select class="select" v-model="store.opts.shape.kind">
        <option value="rectangle">矩形</option>
        <option value="roundedRectangle">圆角矩形</option>
        <option value="ellipse">椭圆</option>
        <option value="line">线条</option>
      </select>
      <label v-if="store.opts.shape.kind === 'roundedRectangle'" class="field">圆角
        <input type="range" min="0" max="100" v-model.number="store.opts.shape.cornerRadius" />
        <span class="val">{{ store.opts.shape.cornerRadius }}</span>
      </label>
      <label v-if="store.opts.shape.kind === 'line'" class="field">线宽
        <input type="range" min="1" max="40" v-model.number="store.opts.shape.lineWidth" />
        <span class="val">{{ store.opts.shape.lineWidth }}</span>
      </label>
      <span class="hint">颜色 = 前景色 · Shift 约束比例</span>
    </template>

    <!-- Type -->
    <template v-else-if="store.tool === 'type'">
      <span class="lbl">文字</span>
      <select class="select" v-model="store.opts.type.fontFamily">
        <option v-for="f in FONTS" :key="f" :value="f">{{ f }}</option>
      </select>
      <label class="field">大小
        <input type="number" min="6" max="512" v-model.number="store.opts.type.fontSize" />
      </label>
      <button class="toggle" :class="{ on: store.opts.type.bold }" @click="store.opts.type.bold = !store.opts.type.bold"><b>B</b></button>
      <button class="toggle" :class="{ on: store.opts.type.italic }" @click="store.opts.type.italic = !store.opts.type.italic"><i>I</i></button>
      <div class="seg">
        <button :class="{ on: store.opts.type.align === 'left' }" @click="store.opts.type.align = 'left'">⬅</button>
        <button :class="{ on: store.opts.type.align === 'center' }" @click="store.opts.type.align = 'center'">⬌</button>
        <button :class="{ on: store.opts.type.align === 'right' }" @click="store.opts.type.align = 'right'">➡</button>
      </div>
      <span class="hint">颜色 = 前景色 · Esc 或 Ctrl+Enter 提交</span>
    </template>

    <!-- Eyedropper / Hand / Zoom / fallback -->
    <template v-else>
      <span class="lbl">{{ TOOL_ZH[store.tool] }}</span>
      <span v-if="store.tool === 'eyedropper'" class="hint">吸管：单击取前景色 · Alt 单击取背景色</span>
      <span v-else-if="store.tool === 'zoom'" class="hint">单击放大 · Alt 单击缩小</span>
      <span v-else class="hint">按住空格临时使用</span>
    </template>
  </div>
</template>

<style scoped>
.tool-options {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 36px;
  padding: 0 12px;
  background: #2a2a2a;
  border-bottom: 1px solid #111;
  color: #ccc;
  font-size: 12px;
  white-space: nowrap;
  overflow-x: auto;
}
.lbl { color: #fff; font-weight: 600; }
.hint { color: #777; font-size: 11px; }
.field { display: flex; align-items: center; gap: 6px; }
.field .val { min-width: 34px; color: #aaa; }
.check { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.seg { display: flex; border: 1px solid #444; border-radius: 5px; overflow: hidden; }
.seg button, .toggle {
  background: #333; color: #bbb; border: none; padding: 3px 10px;
  font-size: 11px; cursor: pointer;
}
.seg button + button { border-left: 1px solid #444; }
.seg button.on, .toggle.on { background: #0e639c; color: #fff; }
.select {
  background: #333; color: #ddd; border: 1px solid #444;
  border-radius: 5px; padding: 3px 6px; font-size: 11px;
}
input[type='range'] { width: 90px; accent-color: #0e639c; }
input[type='number'] {
  width: 56px; background: #333; color: #ddd; border: 1px solid #444;
  border-radius: 5px; padding: 3px 6px; font-size: 11px;
}
</style>
