// Chinese display names for UI text only. The map KEYS are the canonical
// English values that get stored in .comp files and drive logic — never
// localize those; only render through these maps.

import type { BlendMode, AdjustmentKind, EffectsData } from './types';
import type { ToolId } from './store';

export const MENU_ZH: Record<string, string> = {
  File: '文件', Edit: '编辑', Image: '图像', Layer: '图层',
  Select: '选择', Filter: '滤镜', View: '视图',
};

export const BLEND_MODE_ZH: Record<BlendMode, string> = {
  'Normal': '正常',
  'Darken': '变暗', 'Multiply': '正片叠底', 'Color Burn': '颜色加深', 'Linear Burn': '线性加深',
  'Lighten': '变亮', 'Screen': '滤色', 'Color Dodge': '颜色减淡', 'Linear Dodge (Add)': '线性减淡(添加)',
  'Overlay': '叠加', 'Soft Light': '柔光', 'Hard Light': '强光', 'Vivid Light': '亮光',
  'Linear Light': '线性光', 'Pin Light': '点光', 'Hard Mix': '实色混合',
  'Difference': '差值', 'Exclusion': '排除', 'Subtract': '减去', 'Divide': '划分',
  'Hue': '色相', 'Saturation': '饱和度', 'Color': '颜色', 'Luminosity': '明度',
};

export const ADJUSTMENT_ZH: Record<AdjustmentKind, string> = {
  'Hue/Saturation': '色相/饱和度',
  'Levels': '色阶',
  'Curves': '曲线',
  'Exposure': '曝光度',
  'Gradient Map': '渐变映射',
  'Grain': '颗粒',
  'Invert': '反相',
  'Black & White': '黑白',
  'Color Balance': '色彩平衡',
  'Gaussian Blur': '高斯模糊',
  'Motion Blur': '动感模糊',
  'Add Noise': '添加杂色',
};

export const EFFECT_ZH: Record<keyof EffectsData, string> = {
  stroke: '描边',
  shadow: '投影',
  colorOverlay: '颜色叠加',
  innerShadow: '内阴影',
  outerGlow: '外发光',
  innerGlow: '内发光',
};

export const TOOL_ZH: Record<ToolId, string> = {
  move: '移动',
  marquee: '选框',
  lasso: '套索',
  wand: '魔棒',
  crop: '裁剪',
  brush: '画笔',
  eraser: '橡皮擦',
  clone: '仿制图章',
  smear: '涂抹',
  gradient: '渐变',
  shape: '形状',
  type: '文字',
  eyedropper: '吸管',
  hand: '抓手',
  zoom: '缩放',
  pen: '钢笔',
  heal: '修复画笔',
  dodge: '减淡',
  patch: '修补', camove: '感知移动',
};
