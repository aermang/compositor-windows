// 智能滤镜(非破坏滤镜栈):把一组 SmartFilter 按数组顺序应用到画布上并返回
// 新画布;src 永不被修改(调用方 compositor.prepareLayer 把结果画回工作画布)。
// 词表与 commands.ts 的 Filter 菜单一致;像素类滤镜直接复用 pixels/adjust 的
// 实现,画布类(blur/bloom/vignette/sharpen)在此实现。
//
// 随机稳定性:杂色/颗粒的噪声必须只依赖 filter.id——同一滤镜每次合成、每次
// 会话都产生同一噪声图,否则缓存与逐帧输出都会漂移。addNoiseApply/grainApply
// 本身是按坐标哈希的位置稳定噪声,只需注入确定性 seed。

import { makeCanvas, ctx2d, ctx2dRead, cloneCanvas } from './canvasUtils';
import { invertApply, addNoiseApply, grainApply, motionBlurApply } from './pixels/adjust';
import type { SmartFilter } from './types';

/** FNV-1a:滤镜 id 字符串 → 32 位无符号随机种子。 */
function seedFromId(id: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function num(params: Record<string, number | boolean>, key: string, dflt = 0): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/** 按顺序应用全部 enabled 滤镜;空数组/全禁用零拷贝直接返回 src。 */
export function applySmartFilters(src: HTMLCanvasElement, filters: SmartFilter[]): HTMLCanvasElement {
  let out = src;
  for (const f of filters) {
    if (!f) continue;
    const next = applyOne(out, f);
    if (next !== out) out = next;
  }
  return out;
}

function applyOne(src: HTMLCanvasElement, f: SmartFilter): HTMLCanvasElement {
  if (!f.enabled) return src;
  const w = src.width, h = src.height;
  switch (f.kind) {
    case 'gaussianBlur': {
      const out = makeCanvas(w, h);
      const ox = ctx2d(out);
      ox.filter = `blur(${num(f.params, 'radius')}px)`;
      ox.drawImage(src, 0, 0);
      ox.filter = 'none';
      return out;
    }
    case 'bloom': {
      // 亮部提取 → 模糊 → screen 叠回(阈值与 commands.ts canvasFilter 一致)
      const bright = cloneCanvas(src);
      const bId = ctx2dRead(bright).getImageData(0, 0, w, h);
      const keepScale = num(f.params, 'amount') / 100;
      const d = bId.data;
      for (let i = 0; i < d.length; i += 4) {
        const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
        const keep = Math.max(0, l - 160) / 95 * keepScale;
        d[i] *= keep; d[i + 1] *= keep; d[i + 2] *= keep; d[i + 3] *= keep;
      }
      ctx2dRead(bright).putImageData(bId, 0, 0);
      const out = cloneCanvas(src);
      const ox = ctx2d(out);
      ox.globalCompositeOperation = 'screen';
      ox.filter = `blur(${num(f.params, 'radius')}px)`;
      ox.drawImage(bright, 0, 0);
      ox.filter = 'none';
      ox.globalCompositeOperation = 'source-over';
      return out;
    }
    case 'vignette': {
      // source-atop 限定在已有像素内:非破坏栈叠加在合成结果上,
      // 不能像破坏版那样把渐变画进透明区域(会在图层外也压暗画面)
      const out = cloneCanvas(src);
      const ox = ctx2d(out);
      const g = ox.createRadialGradient(
        w / 2, h / 2, Math.min(w, h) * 0.35,
        w / 2, h / 2, Math.hypot(w, h) / 2,
      );
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${num(f.params, 'amount') / 100})`);
      ox.globalCompositeOperation = 'source-atop';
      ox.fillStyle = g;
      ox.fillRect(0, 0, w, h);
      ox.globalCompositeOperation = 'source-over';
      return out;
    }
    case 'sharpen': {
      // unsharp:src + (src − blur(1px)) × amount,带符号差比破坏版的
      // difference+lighter 技法少一次钳位,视觉等价
      const blurred = makeCanvas(w, h);
      const blx = ctx2d(blurred);
      blx.filter = 'blur(1px)';
      blx.drawImage(src, 0, 0);
      blx.filter = 'none';
      const oId = ctx2dRead(src).getImageData(0, 0, w, h);
      const bId = ctx2dRead(blurred).getImageData(0, 0, w, h);
      const a = num(f.params, 'amount') / 100;
      const od = oId.data, bd = bId.data;
      for (let i = 0; i < od.length; i += 4) {
        od[i] += (od[i] - bd[i]) * a;
        od[i + 1] += (od[i + 1] - bd[i + 1]) * a;
        od[i + 2] += (od[i + 2] - bd[i + 2]) * a;
      }
      const out = makeCanvas(w, h);
      ctx2dRead(out).putImageData(oId, 0, 0);
      return out;
    }
    case 'invert': {
      const out = cloneCanvas(src);
      const ox = ctx2dRead(out);
      const id = ox.getImageData(0, 0, w, h);
      invertApply(id.data);
      ox.putImageData(id, 0, 0);
      return out;
    }
    case 'addNoise': {
      const out = cloneCanvas(src);
      const ox = ctx2dRead(out);
      const id = ox.getImageData(0, 0, w, h);
      addNoiseApply(
        id.data, w, num(f.params, 'amount'),
        f.params.gaussian === true, f.params.monochromatic === true, seedFromId(f.id),
      );
      ox.putImageData(id, 0, 0);
      return out;
    }
    case 'grain': {
      const out = cloneCanvas(src);
      const ox = ctx2dRead(out);
      const id = ox.getImageData(0, 0, w, h);
      grainApply(id.data, w, num(f.params, 'amount'), seedFromId(f.id));
      ox.putImageData(id, 0, 0);
      return out;
    }
    case 'motionBlur': {
      const out = cloneCanvas(src);
      const ox = ctx2dRead(out);
      const id = ox.getImageData(0, 0, w, h);
      motionBlurApply(id.data, w, h, num(f.params, 'angle'), num(f.params, 'distance'));
      ox.putImageData(id, 0, 0);
      return out;
    }
    default:
      // 未知种类:原样透传(旧文档前向兼容,而不是渲染报错)
      return src;
  }
}
