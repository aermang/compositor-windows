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
        <button :class="{ on: !store.opts.lasso.polygonal && !store.opts.lasso.magnetic }" @click="store.opts.lasso.polygonal = false; store.opts.lasso.magnetic = false">自由套索</button>
        <button :class="{ on: store.opts.lasso.polygonal }" @click="store.opts.lasso.polygonal = true; store.opts.lasso.magnetic = false">多边形套索</button>
        <button :class="{ on: store.opts.lasso.magnetic }" @click="store.opts.lasso.magnetic = true; store.opts.lasso.polygonal = false">磁性套索</button>
      </div>
      <template v-if="store.opts.lasso.magnetic">
        <label class="field">宽度
          <input type="range" min="2" max="40" v-model.number="store.opts.lasso.width" />
          <span class="val">{{ store.opts.lasso.width }} px</span>
        </label>
        <label class="field">对比度
          <input type="range" min="5" max="90" v-model.number="store.opts.lasso.contrast" />
          <span class="val">{{ store.opts.lasso.contrast }}%</span>
        </label>
        <label class="field">频率
          <input type="range" min="10" max="80" v-model.number="store.opts.lasso.frequency" />
          <span class="val">{{ store.opts.lasso.frequency }}</span>
        </label>
      </template>
      <span v-else class="hint">多边形：单击加点，Enter 闭合，Esc 取消</span>
      <span v-if="store.opts.lasso.magnetic" class="hint">磁性：沿边缘自动吸附 · 单击手动加点 · Enter/Esc 结束</span>
    </template>

    <!-- Pen -->
    <template v-else-if="store.tool === 'pen'">
      <span class="lbl">钢笔</span>
      <span class="hint">单击加角点 · 拖动出曲线手柄 · Alt 拖断手柄 · 单击首点/双击/Enter 闭合 · Esc 取消 · 路径面板描边/填充/转选区</span>
    </template>

    <!-- Heal -->
    <template v-else-if="store.tool === 'heal'">
      <span class="lbl">修复画笔</span>
      <div class="seg">
        <button :class="{ on: store.opts.heal.mode === 'spot' }" @click="store.opts.heal.mode = 'spot'">污点修复</button>
        <button :class="{ on: store.opts.heal.mode === 'heal' }" @click="store.opts.heal.mode = 'heal'">修复画笔</button>
      </div>
      <label class="field">大小
        <input type="range" min="4" max="200" v-model.number="store.opts.heal.size" />
        <span class="val">{{ store.opts.heal.size }} px</span>
      </label>
      <label class="field">硬度
        <input type="range" min="0" max="0.95" step="0.05" v-model.number="store.opts.heal.hardness" />
        <span class="val">{{ Math.round(store.opts.heal.hardness * 100) }}%</span>
      </label>
      <span class="hint">污点修复：涂抹污点自动取样 · 修复画笔：Alt 单击设源</span>
    </template>

    <!-- Dodge / Burn / Sponge -->
    <template v-else-if="store.tool === 'dodge'">
      <span class="lbl">减淡</span>
      <div class="seg">
        <button :class="{ on: store.opts.dodge.mode === 'dodge' }" @click="store.opts.dodge.mode = 'dodge'">减淡</button>
        <button :class="{ on: store.opts.dodge.mode === 'burn' }" @click="store.opts.dodge.mode = 'burn'">加深</button>
        <button :class="{ on: store.opts.dodge.mode === 'sponge' }" @click="store.opts.dodge.mode = 'sponge'">海绵</button>
      </div>
      <label class="field">大小
        <input type="range" min="4" max="400" v-model.number="store.opts.dodge.size" />
        <span class="val">{{ store.opts.dodge.size }} px</span>
      </label>
      <label v-if="store.opts.dodge.mode !== 'sponge'" class="field">曝光度
        <input type="range" min="1" max="100" v-model.number="store.opts.dodge.exposure" />
        <span class="val">{{ store.opts.dodge.exposure }}%</span>
      </label>
      <template v-else>
        <label class="field">流量
          <input type="range" min="5" max="100" v-model.number="store.opts.dodge.spongeFlow" />
          <span class="val">{{ store.opts.dodge.spongeFlow }}%</span>
        </label>
        <div class="seg">
          <button :class="{ on: store.opts.dodge.spongeMode === 'saturate' }" @click="store.opts.dodge.spongeMode = 'saturate'">加饱和</button>
          <button :class="{ on: store.opts.dodge.spongeMode === 'desaturate' }" @click="store.opts.dodge.spongeMode = 'desaturate'">去饱和</button>
        </div>
      </template>
      <span class="hint">直接作用于图层像素 · 每笔一条历史</span>
    </template>

    <!-- Patch -->
    <template v-else-if="store.tool === 'patch'">
      <span class="lbl">修补</span>
      <span class="hint">拖出要修补的区域 → 再拖到取样区松开 · 内容自适应填充 + 边缘羽化</span>
    </template>

    <!-- Content-Aware Move -->
    <template v-else-if="store.tool === 'camove'">
      <span class="lbl">感知移动</span>
      <span class="hint">拖出要移动的区域 → 再拖到目标位置松开 · 移动原区+智能填充空洞</span>
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
      <label class="check"><input type="checkbox" v-model="uiFlags.penPressure" /> 压感</label>
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
      <label class="check"><input type="checkbox" v-model="uiFlags.penPressure" /> 压感</label>
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
        <button :class="{ on: store.opts.gradient.type === 'angle' }" @click="store.opts.gradient.type = 'angle'">角度</button>
        <button :class="{ on: store.opts.gradient.type === 'reflected' }" @click="store.opts.gradient.type = 'reflected'">对称</button>
        <button :class="{ on: store.opts.gradient.type === 'diamond' }" @click="store.opts.gradient.type = 'diamond'">菱形</button>
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
        <option value="polygon">多边形</option>
      </select>
      <label v-if="store.opts.shape.kind === 'polygon'" class="field">边数
        <input type="range" min="3" max="12" v-model.number="store.opts.shape.sides" />
        <span class="val">{{ store.opts.shape.sides }}</span>
      </label>
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
