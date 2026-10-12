// .comp project packages: manifest.json + images/<uuid>.png, exactly as the macOS
// app writes them (ProjectStore.swift). Opening validates format/version/blend
// spellings; saving writes PNGs first, then the manifest atomically so a concurrent
// reader never sees a partial project.

import { makeCanvas, ctx2dRead } from '../canvasUtils';
import { readTextFile, readFile, writeFile, writeFileAtomic, makeDir, pathExists, listDir, removeFile } from './fs';
import { canvasToBlob, openImageFile } from './raster';
import {
  makeLayer, defaultAdjustment, BLEND_MODES,
} from '../types';
import type {
  AdjustmentData, AdjustmentKind, BlendMode, Doc, Layer, LayerTransform, EffectsData, TextMeta,
  TextStyleRange,
  SmartFilter, DocPath, AnimFrame, AlphaChannel,
} from '../types';

const FORMAT = 'com.compositor.project';
const CURRENT_VERSION = 11;

interface RawTransform {
  origin: number[]; size: number[]; rotation: number; flipX: boolean; flipY: boolean;
  sampling?: string;
}

interface RawLayer {
  id: string; name: string; isVisible: boolean; transform: RawTransform;
  imageFile?: string | null; parentID?: string | null; isGroup?: boolean | null;
  opacity?: number | null; blendMode?: string | null;
  maskFile?: string | null; maskEnabled?: boolean | null; maskSourceID?: string | null;
  adjustment?: Record<string, unknown> | null;
  maskPlacement?: RawTransform | null; maskLinked?: boolean | null;
  shape?: Record<string, unknown> | null; effects?: Record<string, unknown> | null;
  text?: Record<string, unknown> | null;
  smartFilters?: SmartFilter[];
  smartObjectId?: string;
}

interface RawManifest {
  format: string; version: number; colorSpace: string; documentID: string;
  width: number; height: number; resolution?: number;
  activeLayerID?: string | null; layers: RawLayer[];
  paths?: DocPath[]; frames?: AnimFrame[];
  alphaChannels?: { id: string; name: string; file: string }[];
  smartObjects?: { id: string; name: string; width: number; height: number; layers: RawLayer[] }[];
  bitDepth?: number;      // 导出口径位深(内部合成恒 8bit);缺省 = 8
  iccName?: string;       // images/doc.icc 存在时的描述名(兼作存在标志)
}

function toTransform(rt: RawTransform): LayerTransform {
  return {
    origin: [rt.origin?.[0] ?? 0, rt.origin?.[1] ?? 0],
    size: [rt.size?.[0] ?? 0, rt.size?.[1] ?? 0],
    rotation: rt.rotation ?? 0,
    flipX: !!rt.flipX,
    flipY: !!rt.flipY,
    sampling: rt.sampling === 'Smooth' || rt.sampling === 'Nearest' ? rt.sampling : 'High quality',
  };
}

export async function openComp(path: string): Promise<Doc> {
  const manifestPath = path.replace(/[\\/]+$/, '') + '/manifest.json';
  if (!(await pathExists(manifestPath))) throw new Error('Not a Compositor project (no manifest.json)');
  const raw: RawManifest = JSON.parse(await readTextFile(manifestPath));
  if (raw.format !== FORMAT) throw new Error('Not a Compositor project');
  if (raw.version < 1 || raw.version > CURRENT_VERSION) {
    throw new Error(`Format version ${raw.version} is not supported (1–${CURRENT_VERSION})`);
  }
  if (raw.colorSpace !== 'sRGB') throw new Error('Only sRGB projects are supported');

  const imagesDir = path.replace(/[\\/]+$/, '') + '/images';
  const doc: Doc = {
    id: raw.documentID,
    width: raw.width,
    height: raw.height,
    resolution: raw.resolution ?? 72,
    layers: [],
    activeLayerId: raw.activeLayerID ?? null,
    fileName: path,
  };

  for (const rl of raw.layers) {
    doc.layers.push(await rawLayerToLayer(rl, imagesDir));
  }
  if (!doc.activeLayerId && doc.layers.length) {
    doc.activeLayerId = doc.layers[doc.layers.length - 1].id;
  }
  // 顶层 paths/frames 是本版本新增字段:旧 manifest 没有就落到空数组(纯 JSON
  // 结构,面板全部用可选链读取)。逐项做最浅结构校验,防手改文件炸面板。
  doc.paths = Array.isArray(raw.paths)
    ? raw.paths.filter(p => !!p && typeof p.id === 'string' && Array.isArray(p.subpaths))
    : [];
  doc.frames = Array.isArray(raw.frames)
    ? raw.frames.filter(f => !!f && typeof f.id === 'string'
      && typeof f.durationMs === 'number' && !!f.states && typeof f.states === 'object')
    : [];
  // alpha 通道:PNG 本体在 images/,manifest 只存 id/名称/文件名。单个文件缺失
  // (手删/损坏)只跳过该通道,不让整个工程打不开。
  doc.alphaChannels = [];
  if (Array.isArray(raw.alphaChannels)) {
    for (const ra of raw.alphaChannels) {
      if (!ra || typeof ra.id !== 'string' || typeof ra.file !== 'string') continue;
      try {
        const canvas: HTMLCanvasElement = await openImageFile(`${imagesDir}/${ra.file}`);
        doc.alphaChannels.push({
          id: ra.id, name: typeof ra.name === 'string' && ra.name ? ra.name : 'Alpha', canvas,
        });
      } catch { /* 缺图跳过 */ }
    }
  }
  // 智能对象子文档:manifest 内联嵌套层结构,位图以 so<refId>- 前缀共享 images/。
  // 单个子文档损坏只跳过该项,不影响主文档打开。
  doc.smartObjects = [];
  if (Array.isArray(raw.smartObjects)) {
    for (const rs of raw.smartObjects) {
      if (!rs || typeof rs.id !== 'string' || !Array.isArray(rs.layers)) continue;
      try {
        const subDoc: Doc = {
          id: crypto.randomUUID(),
          width: Number(rs.width) || 1, height: Number(rs.height) || 1,
          resolution: raw.resolution ?? 72,
          layers: [], activeLayerId: null, fileName: null,
        };
        for (const rsl of rs.layers) {
          if (rsl && typeof rsl.id === 'string' && typeof rsl.name === 'string') {
            subDoc.layers.push(await rawLayerToLayer(rsl, imagesDir));
          }
        }
        if (!subDoc.layers.length) continue;
        subDoc.activeLayerId = subDoc.layers[subDoc.layers.length - 1].id;
        doc.smartObjects.push({
          id: rs.id, name: typeof rs.name === 'string' && rs.name ? rs.name : '智能对象', doc: subDoc,
        });
      } catch { /* 子文档损坏跳过 */ }
    }
  }
  // 位深/ICC:manifest 记口径标志与描述名,ICC 原始字节在 images/doc.icc。
  // 旧工程两字段都没有 → 保持 8bit 无 ICC;doc.icc 被手删只丢 ICC,不影响打开。
  if (raw.bitDepth === 16) doc.bitDepth = 16;
  if (raw.iccName) {
    try {
      doc.iccProfile = await readFile(`${imagesDir}/doc.icc`);
      doc.iccName = raw.iccName;
    } catch { /* 缺文件跳过 */ }
  }
  return doc;
}

/** RawLayer → Layer(主文档与智能对象子文档共用)。 */
async function rawLayerToLayer(rl: RawLayer, imagesDir: string): Promise<Layer> {
  const layer = makeLayer({ name: rl.name, id: rl.id.toUpperCase() });
  layer.isVisible = rl.isVisible ?? true;
  layer.transform = toTransform(rl.transform);
  layer.parentId = rl.parentID?.toUpperCase() ?? null;
  layer.isGroup = rl.isGroup ?? false;
  layer.opacity = typeof rl.opacity === 'number' ? rl.opacity : 1;
  const blend = rl.blendMode ?? 'Normal';
  layer.blendMode = (BLEND_MODES as readonly string[]).includes(blend) ? blend as BlendMode : 'Normal';
  layer.maskSourceId = rl.maskSourceID?.toUpperCase() ?? null;
  layer.maskLinked = rl.maskLinked ?? true;
  layer.maskEnabled = rl.maskEnabled ?? true;
  if (rl.maskPlacement) layer.maskPlacement = toTransform(rl.maskPlacement);

  if (rl.imageFile) {
    layer.bitmap = await openImageFile(`${imagesDir}/${rl.imageFile}`);
  }
  if (rl.maskFile) {
    layer.mask = await openImageFile(`${imagesDir}/${rl.maskFile}`);
  }
  if (rl.adjustment) layer.adjustment = parseAdjustment(rl.adjustment);
  if (rl.text) layer.text = parseText(rl.text);
  if (rl.effects) layer.effects = parseEffects(rl.effects);
  if (rl.smartFilters?.length) {
    const filters = rl.smartFilters.map(parseSmartFilter).filter((f): f is SmartFilter => !!f);
    if (filters.length) layer.smartFilters = filters;
  }
  if (rl.smartObjectId) layer.smartObjectId = rl.smartObjectId;
  if (rl.shape) {
    const sides = Number(rl.shape.sides);
    layer.shape = {
      kind: (rl.shape.kind as 'rectangle') ?? 'rectangle',
      color: [Number(rl.shape.red) || 0, Number(rl.shape.green) || 0, Number(rl.shape.blue) || 0],
      cornerRadius: Number(rl.shape.cornerRadius) || 0,
      lineWidth: Number(rl.shape.lineWidth) || 0,
      start: Array.isArray(rl.shape.start) ? rl.shape.start as [number, number] : [0, 0.5],
      end: Array.isArray(rl.shape.end) ? rl.shape.end as [number, number] : [1, 0.5],
      ...(Number.isFinite(sides) && sides >= 3 ? { sides } : {}),
    };
  }
  return layer;
}

function parseAdjustment(ra: Record<string, unknown>): AdjustmentData {
  const kind = String(ra.kind) as AdjustmentKind;
  const adj = defaultAdjustment(kind);
  adj.hueSat = {
    hue: num(ra.hue), saturation: num(ra.saturation), lightness: num(ra.lightness),
    colorize: !!ra.colorize, colorizeHue: adj.hueSat.colorizeHue, colorizeSat: adj.hueSat.colorizeSat,
  };
  const levels = ra.levels as { channel?: string; ranges?: Record<string, number>[] } | undefined;
  if (levels?.ranges?.length === 4) {
    adj.levels = {
      channel: (levels.channel as 'RGB') ?? 'RGB',
      ranges: levels.ranges.map(r => ({
        black: num(r.black), gamma: num(r.gamma, 1), white: num(r.white, 255),
        outputBlack: num(r.outputBlack), outputWhite: num(r.outputWhite, 255),
      })),
    };
  }
  const curves = ra.curves as { channel?: string; channels?: { x: number; y: number }[][] } | undefined;
  if (curves?.channels?.length === 4) {
    adj.curves = {
      channel: (curves.channel as 'RGB') ?? 'RGB',
      channels: curves.channels.map(ch => ch.map(p => ({ x: num(p.x), y: num(p.y) }))),
    };
  }
  const exp = ra.exposureSettings as Record<string, number> | undefined;
  if (exp) adj.exposure = { exposure: num(exp.exposure), offset: num(exp.offset), gamma: num(exp.gamma, 1) };
  const gm = ra.gradientMapSettings as Record<string, unknown> | undefined;
  if (gm) {
    adj.gradientMap = {
      shadows: rgbTriplet(gm.shadows), highlights: rgbTriplet(gm.highlights), reversed: !!gm.reversed,
    };
  }
  const gr = ra.grainSettings as Record<string, number> | undefined;
  if (gr) adj.grain = {
    amount: num(gr.amount, 25), size: num(gr.size, 1.5), roughness: num(gr.roughness, 50), seed: num(gr.seed),
  };
  const bw = ra.blackWhiteSettings as Record<string, number> | undefined;
  if (bw) adj.blackWhite = {
    reds: num(bw.reds, 40), yellows: num(bw.yellows, 60), greens: num(bw.greens, 40),
    cyans: num(bw.cyans, 60), blues: num(bw.blues, 20), magentas: num(bw.magentas, 80), tint: null,
  };
  const cb = ra.colorBalanceSettings as Record<string, number | boolean> | undefined;
  if (cb) adj.colorBalance = {
    shadowCyanRed: num(cb.shadowCyanRed), shadowMagentaGreen: num(cb.shadowMagentaGreen), shadowYellowBlue: num(cb.shadowYellowBlue),
    midCyanRed: num(cb.midCyanRed), midMagentaGreen: num(cb.midMagentaGreen), midYellowBlue: num(cb.midYellowBlue),
    highlightCyanRed: num(cb.highlightCyanRed), highlightMagentaGreen: num(cb.highlightMagentaGreen), highlightYellowBlue: num(cb.highlightYellowBlue),
    preserveLuminosity: cb.preserveLuminosity !== false,
  };
  adj.blurRadius = num(ra.blurRadius, 10);
  adj.motionAngle = num(ra.motionAngle);
  adj.motionDistance = num(ra.motionDistance, 10);
  adj.noiseAmount = num(ra.noiseAmount, 10);
  adj.noiseGaussian = !!ra.noiseGaussian;
  adj.noiseMonochromatic = !!ra.noiseMonochromatic;
  adj.noiseSeed = num(ra.noiseSeed);
  return adj;
}

function rgbTriplet(v: unknown): [number, number, number] {
  if (!v || typeof v !== 'object') return [0, 0, 0];
  const o = v as Record<string, number>;
  return [num(o.red), num(o.green), num(o.blue)];
}

function parseText(rt: Record<string, unknown>): TextMeta {
  const align = String(rt.alignment ?? 'Left').toLowerCase() as 'left' | 'center' | 'right';
  const box = rt.boxSize as { width?: number; height?: number } | null | undefined;
  const fontSize = num(rt.fontSize, 72);
  const leading = num(rt.leading, 0);
  return {
    content: String(rt.content ?? 'Text'),
    fontName: String(rt.fontName ?? 'Helvetica'),
    fontSize,
    color: rgbTriplet({ red: rt.red, green: rt.green, blue: rt.blue }),
    align,
    tracking: num(rt.tracking),
    lineSpacing: leading > 0 ? leading : fontSize * 1.2,
    boxSize: box?.width && box?.height ? [box.width, box.height] : null,
    ranges: parseTextRanges(rt.ranges),
  };
}

/** 逐范围样式:最浅结构校验(防手改文件炸渲染),坏项跳过。 */
function parseTextRanges(v: unknown): TextStyleRange[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: TextStyleRange[] = [];
  for (const r of v) {
    const rr = r as Record<string, unknown>;
    if (!rr || typeof rr.start !== 'number' || typeof rr.end !== 'number') continue;
    out.push({ ...rr, start: rr.start, end: rr.end } as TextStyleRange);
  }
  return out.length ? out : undefined;
}

function parseEffects(re: Record<string, unknown>): EffectsData {
  const out: EffectsData = {};
  const stroke = re.stroke as Record<string, number | boolean> | undefined;
  if (stroke) out.stroke = {
    enabled: stroke.enabled !== false, size: num(stroke.size, 4),
    color: rgbTriplet(stroke), opacity: num(stroke.opacity, 1), inside: !!stroke.inside,
  };
  const shadow = re.shadow as Record<string, number | boolean> | undefined;
  if (shadow) out.shadow = {
    enabled: shadow.enabled !== false, angle: num(shadow.angle, 90), distance: num(shadow.distance, 20),
    blur: num(shadow.blur, 20), color: rgbTriplet(shadow), opacity: num(shadow.opacity, 0.5),
  };
  const overlay = re.colorOverlay as Record<string, number | boolean> | undefined;
  if (overlay) out.colorOverlay = {
    enabled: overlay.enabled !== false, color: rgbTriplet(overlay), opacity: num(overlay.opacity, 1),
  };
  const inner = re.innerShadow as Record<string, number | boolean> | undefined;
  if (inner) out.innerShadow = {
    enabled: inner.enabled !== false, angle: num(inner.angle, 90), distance: num(inner.distance, 10),
    blur: num(inner.blur, 10), color: rgbTriplet(inner), opacity: num(inner.opacity, 0.5),
  };
  const og = re.outerGlow as Record<string, number | boolean> | undefined;
  if (og) out.outerGlow = {
    enabled: og.enabled !== false, size: num(og.size, 20),
    color: rgbTriplet(og), opacity: num(og.opacity, 0.75),
  };
  const ig = re.innerGlow as Record<string, number | boolean> | undefined;
  if (ig) out.innerGlow = {
    enabled: ig.enabled !== false, size: num(ig.size, 10),
    color: rgbTriplet(ig), opacity: num(ig.opacity, 0.75),
  };
  return out;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 智能滤镜逐条校验:未知 kind 留给合成器透传(前向兼容),只挡结构坏项。 */
function parseSmartFilter(v: unknown): SmartFilter | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.kind !== 'string' || !o.params || typeof o.params !== 'object') {
    return null;
  }
  const params: Record<string, number | boolean> = {};
  for (const [k, val] of Object.entries(o.params as Record<string, unknown>)) {
    if (typeof val === 'number' || typeof val === 'boolean') params[k] = val;
  }
  return { id: o.id, kind: o.kind, params, enabled: o.enabled !== false };
}

// ---------- saving ----------

export async function saveComp(doc: Doc, path: string): Promise<void> {
  const pkg = path.replace(/[\\/]+$/, '');
  const imagesDir = `${pkg}/images`;
  await makeDir(imagesDir);

  const records: RawLayer[] = [];
  for (const layer of doc.layers) {
    records.push(await layerToRaw(layer, imagesDir));
  }

  // 智能对象子文档:位图带 so<refId>- 前缀写同一 images/,manifest 内联嵌套层
  const smartRecs: { id: string; name: string; width: number; height: number; layers: RawLayer[] }[] = [];
  for (const ref of doc.smartObjects ?? []) {
    const subLayers: RawLayer[] = [];
    for (const sl of ref.doc.layers) subLayers.push(await layerToRaw(sl, imagesDir, `so${ref.id}-`));
    smartRecs.push({ id: ref.id, name: ref.name, width: ref.doc.width, height: ref.doc.height, layers: subLayers });
  }

  // alpha 通道画布存为独立 PNG(alpha 分量即选区覆盖度,载入时 drawImage 直取)
  const alphaFiles: (AlphaChannel & { file: string })[] = [];
  for (const ch of doc.alphaChannels ?? []) {
    const file = `${ch.id}.alpha.png`;
    await writeCanvasPng(ch.canvas, `${imagesDir}/${file}`);
    alphaFiles.push({ id: ch.id, name: ch.name, canvas: ch.canvas, file });
  }

  // ICC 配置文件:原始 bin 存 images/doc.icc(manifest 记 iccName 兼作存在标志)
  let hasIcc = false;
  if (doc.iccProfile?.length) {
    await writeFile(`${imagesDir}/doc.icc`, doc.iccProfile);
    hasIcc = true;
  }

  // prune images no longer referenced
  const keep = new Set([
    ...records.flatMap(r => [r.imageFile, r.maskFile].filter(Boolean) as string[]),
    ...alphaFiles.map(a => a.file),
    ...smartRecs.flatMap(s => s.layers.flatMap(l => [l.imageFile, l.maskFile].filter(Boolean) as string[])),
  ]);
  if (hasIcc) keep.add('doc.icc'); // ICC 撤掉后旧 doc.icc 由 prune 正常回收
  for (const name of await listDir(imagesDir)) {
    if (!keep.has(name)) {
      await removeFile(`${imagesDir}/${name.replace(/\\/g, '/')}`).catch(() => {});
    }
  }

  const manifest: RawManifest & { guides: unknown[] } = {
    format: FORMAT,
    version: CURRENT_VERSION,
    colorSpace: 'sRGB',
    resolution: doc.resolution,
    documentID: doc.id,
    width: doc.width,
    height: doc.height,
    activeLayerID: doc.activeLayerId,
    layers: records,
    guides: [],
  };
  // 路径/帧/alpha 通道只在非空时写入(可选字段,旧版本与旧文件双向兼容)
  if (doc.paths?.length) manifest.paths = doc.paths;
  if (doc.frames?.length) manifest.frames = doc.frames;
  if (alphaFiles.length) {
    manifest.alphaChannels = alphaFiles.map(a => ({ id: a.id, name: a.name, file: a.file }));
  }
  if (smartRecs.length) manifest.smartObjects = smartRecs;
  // 位深/ICC 只在非默认时写入(旧版本打开新工程:未知字段被忽略,双向兼容)
  if (doc.bitDepth === 16) manifest.bitDepth = 16;
  if (hasIcc) manifest.iccName = doc.iccName ?? 'ICC Profile';
  const json = JSON.stringify(manifest, null, 2);
  await writeFileAtomic(`${pkg}/manifest.json`, new TextEncoder().encode(json));
}

function buildAdjustment(adj: AdjustmentData): Record<string, unknown> {
  const rec: Record<string, unknown> = { kind: adj.kind };
  rec.hue = adj.hueSat.hue;
  rec.saturation = adj.hueSat.saturation;
  rec.lightness = adj.hueSat.lightness;
  rec.colorize = adj.hueSat.colorize;
  rec.levels = {
    channel: adj.levels.channel,
    ranges: adj.levels.ranges.map(r => ({
      black: r.black, gamma: r.gamma, white: r.white, outputBlack: r.outputBlack, outputWhite: r.outputWhite,
    })),
  };
  rec.curves = {
    channel: adj.curves.channel,
    channels: adj.curves.channels.map(ch => ch.map(p => ({ x: p.x, y: p.y }))),
  };
  rec.exposureSettings = { ...adj.exposure };
  rec.gradientMapSettings = {
    shadows: triplet(adj.gradientMap.shadows), highlights: triplet(adj.gradientMap.highlights),
    reversed: adj.gradientMap.reversed,
  };
  rec.grainSettings = { ...adj.grain };
  rec.blackWhiteSettings = {
    reds: adj.blackWhite.reds, yellows: adj.blackWhite.yellows, greens: adj.blackWhite.greens,
    cyans: adj.blackWhite.cyans, blues: adj.blackWhite.blues, magentas: adj.blackWhite.magentas,
    tint: false, tintHue: 40, tintSaturation: 20,
  };
  rec.colorBalanceSettings = { ...adj.colorBalance };
  rec.blurRadius = adj.blurRadius;
  rec.motionAngle = adj.motionAngle;
  rec.motionDistance = adj.motionDistance;
  rec.noiseAmount = adj.noiseAmount;
  rec.noiseGaussian = adj.noiseGaussian;
  rec.noiseMonochromatic = adj.noiseMonochromatic;
  rec.noiseSeed = adj.noiseSeed;
  return rec;
}

function triplet(rgb: [number, number, number]): { red: number; green: number; blue: number } {
  return { red: rgb[0], green: rgb[1], blue: rgb[2] };
}

function buildText(t: TextMeta): Record<string, unknown> {
  const align = t.align === 'center' ? 'Center' : t.align === 'right' ? 'Right' : 'Left';
  return {
    content: t.content, fontName: t.fontName, fontSize: t.fontSize,
    red: t.color[0], green: t.color[1], blue: t.color[2],
    alignment: align, tracking: t.tracking, leading: Math.round(t.lineSpacing),
    boxSize: t.boxSize ? { width: t.boxSize[0], height: t.boxSize[1] } : null,
    ...(t.ranges?.length ? { ranges: t.ranges } : {}),
  };
}

function buildEffects(fx: EffectsData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (fx.stroke) out.stroke = {
    enabled: fx.stroke.enabled, size: fx.stroke.size, ...triplet(fx.stroke.color),
    opacity: fx.stroke.opacity, inside: fx.stroke.inside,
  };
  if (fx.shadow) out.shadow = {
    enabled: fx.shadow.enabled, angle: fx.shadow.angle, distance: fx.shadow.distance,
    blur: fx.shadow.blur, ...triplet(fx.shadow.color), opacity: fx.shadow.opacity,
  };
  if (fx.colorOverlay) out.colorOverlay = {
    enabled: fx.colorOverlay.enabled, ...triplet(fx.colorOverlay.color), opacity: fx.colorOverlay.opacity,
  };
  if (fx.innerShadow) out.innerShadow = {
    enabled: fx.innerShadow.enabled, angle: fx.innerShadow.angle, distance: fx.innerShadow.distance,
    blur: fx.innerShadow.blur, ...triplet(fx.innerShadow.color), opacity: fx.innerShadow.opacity,
  };
  if (fx.outerGlow) out.outerGlow = {
    enabled: fx.outerGlow.enabled, size: fx.outerGlow.size, ...triplet(fx.outerGlow.color),
    opacity: fx.outerGlow.opacity,
  };
  if (fx.innerGlow) out.innerGlow = {
    enabled: fx.innerGlow.enabled, size: fx.innerGlow.size, ...triplet(fx.innerGlow.color),
    opacity: fx.innerGlow.opacity,
  };
  return out;
}

/** Layer → RawLayer(主文档与智能对象子文档共用;prefix 区分子文档位图文件名)。 */
async function layerToRaw(layer: Layer, imagesDir: string, prefix = ''): Promise<RawLayer> {
  const rec: RawLayer = {
    id: layer.id,
    name: layer.name,
    isVisible: layer.isVisible,
    transform: {
      origin: layer.transform.origin, size: layer.transform.size,
      rotation: layer.transform.rotation, flipX: layer.transform.flipX, flipY: layer.transform.flipY,
      sampling: layer.transform.sampling,
    },
    imageFile: null,
  };
  if (layer.isGroup) rec.isGroup = true;
  if (layer.parentId) rec.parentID = layer.parentId;
  if (layer.opacity !== 1) rec.opacity = layer.opacity;
  if (layer.blendMode !== 'Normal') rec.blendMode = layer.blendMode;
  if (layer.maskSourceId) rec.maskSourceID = layer.maskSourceId;
  if (layer.mask && !layer.maskLinked && layer.maskPlacement) {
    rec.maskPlacement = {
      origin: layer.maskPlacement.origin, size: layer.maskPlacement.size,
      rotation: layer.maskPlacement.rotation, flipX: layer.maskPlacement.flipX, flipY: layer.maskPlacement.flipY,
    };
    rec.maskLinked = false;
  }
  if (layer.bitmap) {
    const file = `${prefix}${layer.id}.png`;
    await writeCanvasPng(layer.bitmap, `${imagesDir}/${file}`);
    rec.imageFile = file;
  }
  if (layer.mask) {
    const file = `${prefix}${layer.id}.mask.png`;
    await writeMaskPng(layer.mask, `${imagesDir}/${file}`);
    rec.maskFile = file;
    rec.maskEnabled = layer.maskEnabled;
  }
  if (layer.adjustment) rec.adjustment = buildAdjustment(layer.adjustment);
  if (layer.text) rec.text = buildText(layer.text);
  if (layer.effects) rec.effects = buildEffects(layer.effects);
  // 智能滤镜纯 JSON,浅拷贝脱掉 reactive 代理再进 manifest
  if (layer.smartFilters?.length) {
    rec.smartFilters = layer.smartFilters.map(f => ({
      id: f.id, kind: f.kind, params: { ...f.params }, enabled: f.enabled,
    }));
  }
  if (layer.smartObjectId) rec.smartObjectId = layer.smartObjectId;
  if (layer.shape) rec.shape = {
    kind: layer.shape.kind, red: layer.shape.color[0], green: layer.shape.color[1], blue: layer.shape.color[2],
    cornerRadius: layer.shape.cornerRadius, lineWidth: layer.shape.lineWidth,
    sides: layer.shape.sides,
    start: layer.shape.start, end: layer.shape.end,
  } as unknown as Record<string, unknown>;
  return rec;
}

async function writeCanvasPng(c: HTMLCanvasElement, path: string) {
  const blob = await canvasToBlob(c, 'image/png');
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
}

/** Masks save as 8-bit grayscale: gray in RGB, opaque alpha. */
async function writeMaskPng(mask: HTMLCanvasElement, path: string) {
  const gray = makeCanvas(mask.width, mask.height);
  const gx = ctx2dRead(gray);
  gx.drawImage(mask, 0, 0);
  const id = gx.getImageData(0, 0, gray.width, gray.height);
  for (let i = 0; i < id.data.length; i += 4) {
    const g = id.data[i]; // masks were loaded/drawn as gray RGB
    id.data[i] = id.data[i + 1] = id.data[i + 2] = g;
    id.data[i + 3] = 255;
  }
  gx.putImageData(id, 0, 0);
  await writeCanvasPng(gray, path);
}
