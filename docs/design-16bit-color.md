# 设计:16-bit 与 ICC 色彩管理落地(Wave 3 关键路径)

日期:2026-10-12 · 状态:定稿待实施 · 关联:T1-T5 差距清单「色彩深度与色彩管理」项

## 现状盘点

- 全管线 Canvas2D 8-bit sRGB:`makeCanvas/ImageData` 均为 8bit,合成器、滤镜、导出无一例外。
- 导入:PNG/JPEG/WebP 走浏览器解码(自动降到 8bit);TIFF 自研解码(16bit 取高字节);PSD 自研 reader。
- ICC:完全没有处理 —— PNG iCCP/JPEG APP2/TIFF tag34675 全部丢弃;非 sRGB 文件被当作 sRGB 解释。
- 结论:**内部合成升 16-bit 在 Canvas2D 下不可行**(整条渲染管线重写,属无底洞);可行且诚实的口径是
  「16-bit 文件正确读写 + ICC 配置文件保留与标注」,即 IO 层工程。

## 目标口径(v1)

| 能力 | v1 承诺 |
|---|---|
| 16-bit 导入 | TIFF/PSD 16bit 正确解码(高位提取 + 可选误差扩散抖动降到内部 8bit),文档标记来源位深 |
| 16-bit 导出 | TIFF(16bit 采样,8→16 左移+低位抖动)、PSD(mode 判定后 16bit 通道写出) |
| ICC 读取 | PNG iCCP / JPEG APP2 / TIFF tag34675 / PSD ICC block 提取,识别 sRGB / Display-P3 / 其他 |
| ICC 回写 | 导出时原样回嵌(Preserve),PNG 用 CompressionStream('deflate') 压 iCCP,JPEG 在 SOI 后手插 APP2 段 |
| UI | 状态栏/图像信息显示 位深+ICC;导出对话框加「位深 8/16」选项(仅 TIFF/PSD 生效) |
| 不做 | 内部 16bit 合成、非 sRGB→sRGB 像素转换、P3 广色域合成、软打样 |

## 数据模型(types.ts)

```ts
Doc.bitDepth?: 8 | 16        // 来源/导出口径,默认 8;内部始终 8bit
Doc.iccProfile?: Uint8Array  // 原始 ICC 字节(读取所得,导出回写)
Doc.iccName?: string         // 如 'sRGB IEC61966-2.1'、'Display P3'(描述性)
```

`.comp` 序列化:manifest 加 `bitDepth`、`icc.iccName`;ICC 字节存 `images/doc.icc`(原始 bin),载入回填。

## IO 改动点

1. **raster.ts**:`openImageFile` 旁新增 `openImageWithMeta(path): { canvas; icc?: Uint8Array; iccName?: string }`
   - PNG:手扫 chunk(8 字节签名 → 长度/类型循环),取 iCCP(zlib deflate,`DecompressionStream('deflate')` 解包,注意 iCCP 是 profile 名\0 压缩方法\0 数据)。
   - JPEG:扫段(marker 0xFF+len),APP2 'ICC_PROFILE\0' 多段拼接(段号/总数在头两字节)。
   - WebP:暂不取(浏览器无接口,报告局限)。
   - 现有 `openImageFile` 改为薄包装,零行为变化。
2. **tiff.ts**:解码加 tag 34675(ICC)、tag 258=16 时按目标 policy 取高字节(+可选手抖动);导出加「16bit」分支(SHORT BitsPerSample=[16,16,16,16],采样值 = v<<8|v)与 tag34675 回写;exportTiffCommand 读 store.doc.bitDepth/iccProfile。
3. **psd/**:reader 确认 16bit 图层解码现状(不足则补);builder 加 16bit 通道写出路径与 ICC block(资源 '8BIM' ID 1039)。
4. **导出管线**:exportCanvas 加可选 `{ icc?: Uint8Array }`;PNG 导出手动重组 chunk 注入 iCCP(需要把 canvas PNG 的 chunk 流拆开插入 —— 现成 reassemble 逻辑在 apngExport.ts 已有,CRC32 复用);JPEG 在 SOI(FFD8)后插 APP2 段。
5. **色彩信息 UI**:图像→图像信息对话框(doc 尺寸/位深/ICC 名称),导出对话框加位深 select(仅 tif/psd 启用)。

## 抖动策略(8bit 化)

16bit→8bit 取高字节已足够(误差 ≤1/256,无 banding 风险来源);可选项不做,保持实现简单。**导入端不做抖动**写进局限。

## 分期(Wave 3)

- **3a** Doc 模型 + openImageWithMeta + PNG/JPEG ICC 提取回写 + .comp 序列化(1 agent,IO 层)
- **3b** TIFF 16bit/ICC 导出导入完善 + PSD 16bit + ICC block(1 agent,依赖 3a 的类型)
- **3c** 图像信息对话框 + 导出位深选项(随 3b 合入,共享文件由集成者预接)
- 验收:e2e 往返(带 ICC 的 PNG→读→导出→字节级验证 iCCP/APP2 存在且可解;16bit TIFF 导出→导入像素一致)。

## 风险

- PSD 16bit reader 现状未知,3b 需先读码评估;若 reader 不支持 16bit,导出 16bit 优先、导入继续 8bit 化(标注)。
- JPEG APP2 拼段规则(序号非 1 起始/乱序)按 spec 容错。
- CompressionStream 在 Tauri WebView(WebView2/Chromium)可用,已确认 Chromium 内核。
