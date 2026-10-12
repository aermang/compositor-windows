# WebGPU 性能评估报告

> 评估任务(非接入任务)。产出:独立探针原型 `src/core/webgpuProbe.ts`(不被任何生产代码 import)、
> 基准测试 `tests/webgpuPerf.mjs`、本报告。生产代码(compositor.ts / store.ts / canvasUtils.ts 等)零改动。
>
- 日期: 2026-10-12
- 测试机: Windows 11(本机 Chrome 稳定通道,`channel: 'chrome'`),adapter `intel/gen-12lp`(12 代酷睿核显),`maxTexture2D=8192`,支持 `timestamp-query`
- 复现: 启动 vite dev(localhost:1420)后执行
  `NODE_PATH="<playwright 所在 node_modules>" node tests/webgpuPerf.mjs`
- 类型检查: `npx vue-tsc --noEmit` → 0 错误(含探针文件)

---

## 1. 结论先行

**不值得做"Canvas2D → WebGPU 全管线替换"。值得做的只有两个窄子集,且都应以小步原型先行:**

| 子集 | 值不值得 | 一句话依据 |
|---|---|---|
| 全量合成管线替换(逐层 source-over) | **不值得** | 层数 ≥16 才有 ×1.6~3.0 收益,且前提是结果**留在 GPU 侧**;4 层场景反而慢 ×0.8。换来的是双管线一致性维护(24 混合模式、globalAlpha、clip、滤镜语义) |
| `isExoticBlend` 走 JS 逐像素 `pixelBlend` 的图层 → WGSL 化 | **值得评估(优先候选)** | 这是合成器里现存的纯 CPU 逐像素热点,WebGPU 恰好最擅长;但本次未实测 pixelBlend 基线,需补测后再立项 |
| 大文档导出路径(GPU 渲染 → 编码,避免 CPU 读回) | **有条件值得** | 4000² 纯 GPU 渲染 7.9~10.8ms vs Canvas2D 16.7~55.5ms;但只要发生 `mapAsync`+`putImageData` 读回,收益即被吃掉(见 §3) |
| 高斯模糊(`ctx.filter='blur'` → WGSL) | **不值得** | Canvas2D 的 blur 由 Skia 实现,在 Chrome/WebView2 上已 GPU 加速且重度优化:4.3ms vs 朴素 6-pass 盒式 WGSL 的 12.45ms(×0.345)。**Canvas2D 在本平台不是纯 CPU**——这是本次评估最重要的反直觉发现 |

**核心架构约束(比速度数字更重要):迁移后结果必须留在 GPU 侧直达屏幕或导出;任何"每帧读回 CPU"的设计都不可行。**

---

## 2. 数据表

口径:均为 20 次测量取中位数,预热 5 次。倍率 = ms2d / msGpu,**>1 表示 WebGPU 更快**。

- **Canvas2D**:performance.now 端到端(编码 + 光栅化完成),每轮末尾 `getImageData(0,0,1,1)` 强制 flush(见 §5 局限⑤)
- **WebGPU 端到端**:编码 + submit + 结果 `drawImage` 回传 2D canvas + `onSubmittedWorkDone` 排空(保守口径,含回传)
- **纯 GPU 渲染**:timestamp-query(GPU 时间戳)只计渲染本身,不含编码/提交/回传

### GPU 初始化(问题④)

| 项 | 值 |
|---|---|
| `navigator.gpu` 可用性 | 本机 Chrome 稳定通道可用,无需任何 flag |
| adapter | `intel/gen-12lp` |
| requestAdapter | 185.0 ms(首次;之后命中缓存) |
| requestDevice | 10.7 ms |
| timestamp-query | 支持 |
| maxTexture2D | 8192(4000² 画布安全;旧设备可能仅 4096,见 §4) |

### 合成吞吐(问题①)与回读成本(问题②)

| 场景 | Canvas2D (ms) | WebGPU 端到端 (ms) | 纯 GPU 渲染 (ms) | 倍率 | 备注(一次性上传 / CPU 读回) |
|---|---:|---:|---:|---:|---|
| composite 1000² ×4 层 | 2.900 | 3.650 | 0.328 | ×0.795 | upload 62.6ms/4 源*;readback 3.7ms;putImageData 2.6ms |
| composite 1000² ×16 层 | 6.250 | 3.800 | 0.950 | **×1.645** | upload 12.1ms/4 源*;readback 5.4ms;putImageData 1.1ms |
| composite 1000² ×64 层 | 8.150 | 4.100 | 0.393 | **×1.988** | upload 11.3ms/4 源*;readback 4.3ms;putImageData 1.7ms |
| composite 4000² ×4 层 | 16.700 | 13.650 | 7.930 | ×1.223 | upload 84.4ms/4 源*;readback 28.6ms;putImageData 87.9ms |
| composite 4000² ×16 层 | 55.500 | 18.650 | 10.846 | **×2.976** | upload 210.8ms/4 源*;readback 36.5ms;putImageData 30.2ms |

\* 上传是**每源一次性**成本(`copyExternalImageToTexture`),不是每帧成本;基准用 4 张源轮转(控制内存),首个基准的上传数字含驱动/JIT 首触开销,不代表稳态。热态量级:1000²≈3ms/源,4000²≈21~53ms/源——**4000² 每帧重传源画布不可行,源必须常驻显存**。

注:readback 与 putImageData 是**独立附加测量**,未计入端到端数字;它们回答"把 GPU 结果拿回 CPU 要多少钱"(§3)。

### 卷积滤镜代表:高斯模糊(问题③)

| 场景 | Canvas2D `ctx.filter='blur(8px)'` | WebGPU 两趟盒式 ×3 迭代 | 倍率 |
|---|---:|---:|---:|
| blur 1024² r=8 | 4.300 | 12.450 | ×0.345(GPU 慢 2.9 倍) |

公平口径说明:GPU 侧为 6 pass(H/V 各 3 次单盒,ping-pong,纯渲染 timestamp 8.847ms)。这是"得到可比视觉结果的最快朴素实现",并非 WebGPU 理论上限(compute shader / 线性采样双纹理技巧可再优化);但即便打平 Skia,也只是不输——**没有净收益**。

### 跨运行方差

同机两次完整运行对比(第 3 次为报告数据,第 2 次为对照):

| 场景 | run2 | run3(报告) |
|---|---|---|
| composite 1000²×64 | 15.3 / 4.25(×3.600) | 8.15 / 4.10(×1.988) |
| composite 4000²×16 | 56.3 / 14.1(×3.993) | 55.5 / 18.65(×2.976) |
| blur 1024² | 4.3 / 9.95(×0.432) | 4.3 / 12.45(×0.345) |

**倍率结论按区间读,不按单点读**:层数收益真实存在(×1.6~3.0 量级),但端到端绝对值有 ~±30% 跨运行波动(桌面 GPU 频率/后台负载),单次 20 样本中位数不足以更精确。

---

## 3. 回读成本分析(迁移最大的隐藏成本)

这是本次评估最重要的工程发现,分三点:

### 3.1 两个读回通道的价格差一个数量级

| 通道 | 1000² | 4000² | 说明 |
|---|---:|---:|---|
| GPU 渲染本体(纯 GPU) | 0.3~1.0 ms | 7.9~10.8 ms | 基线 |
| A:GPU canvas → `drawImage` 回传 2D | ≈+3 ms | ≈+8 ms | 端到端 − 纯渲染;留 GPU 合成链,零拷贝语义 |
| B:`copyTextureToBuffer` + `mapAsync` 读回 | 3.7~5.4 ms | **28.6~36.5 ms** | 含渲染一帧到自有纹理 + 拷贝 + map;约为纯渲染的 **3 倍** |
| B 之后:`putImageData` 上 2D canvas | 1.1~2.6 ms | **30.2~87.9 ms** | 还要再加这一刀才回到 Canvas2D 世界 |

**结论**:通道 B(标准"读像素"路径)在 4000² 一次就要 60~125ms,而通道 A 只加 3~8ms。任何 WebGPU 化设计里:
- 交互预览:GPU 结果经 `drawImage(gpuCanvas, …)` 直送可见 2D canvas(或 WebGPU 直接呈现到屏);
- 导出:在 GPU 侧完成合成后走一次读回(一次性成本可接受),或 GPU→编码器;
- **禁止**:每帧 `mapAsync`+`putImageData` 回 Canvas2D 再走原管线——这会把 ×3 的加速直接变成 ×0.3 的减速。

### 3.2 swapchain 纹理没有 COPY_SRC(实测踩坑)

Chrome(D3D 后端)中 `getCurrentTexture()` 返回的 swapchain 纹理 usage 不含 `COPY_SRC`
(实测 validation error:`[Texture "D3DImageBacking_D3DSharedImage_WebGPUSwapBufferProvider"] usage (RenderAttachment) doesn't include CopySrc`)。
**直接从画布 swapchain `copyTextureToBuffer` 是非法的**;要读回必须把同一帧渲染到一块自建 `COPY_SRC` 纹理再拷贝(基准即如此实现,note 中 `readback=…(自有纹理)`)。这既加代码也加一帧渲染成本,是"读回很贵"的又一成因。该行为属 Chrome 实现细节,跨版本可能漂移。

### 3.3 2D 侧"看不见的 flush"

分离(detached)2D canvas 的栅格化被 Chrome 无限延迟:连 `drawImage` 到下游画布都不触发光栅化,
基准中唯一可靠的 flush 是 `getImageData(0,0,1,1)`。含义有二:
1. Canvas2D 基准必须强制 flush,否则测的是"记录命令的时间"(首版基准因此测出 0.000ms);
2. 生产代码若依赖离屏 2D canvas 合成,读回(`getImageData`)同样有全图通道 B 级别的成本——Canvas2D 与 WebGPU 在这一点上口径对称,**真正该避免的是"像素过 CPU"本身**。

---

## 4. 高风险项

1. **设备丢失与错误链**:`device.lost`(驱动更新、GPU reset、系统休眠)随时发生,必须能整体重建 device/管线/纹理;`uncapturederror` 后续会产出毒化连锁错误(实测 `[Invalid CommandBuffer]` 刷屏),日志必须保留第一条根因;`mapAsync` 可能永久挂起,必须加超时(基准用 2~5s)。
2. **双管线一致性**:Canvas2D 与 WebGPU 并存期间,同一文档两种渲染路径的像素必须可对齐。 premultiplied alpha 的舍入路径不同(Canvas2D 内部 premultiplied,WebGPU 我们显式 `premultipliedAlpha: true` + `one / one-minus-src-alpha` 混合),探针的 sanity 检查(中心 alpha ≈ 1−0.5^N)通过,但**未做逐位对比**;16bit 文档(见 `design-16bit-color.md`)经 rgba8unorm 会丢精度,需 rgba16float 评估。
3. **Canvas2D 语义面的 WGSL 移植面**:`globalAlpha`、`globalCompositeOperation` 的 **24 种混合模式**(其中 css 原生 15 种目前走 Canvas2D 合成,exotic 走 `pixelBlend` JS 逐像素)、clip/蒙版、`shadowBlur`、`ctx.filter` 链——每种都要 WGSL 重写 + 视觉回归。24 种混合模式是最大的移植面,也是全管线替换**不划算**的主因。
4. **显存压力**:4000² rgba8 = 64MB/纹理。`LAYER_CACHE_CAP=64` 若映射成常驻纹理理论上限 4GB;核显共享内存但配额有限,必须有 LRU + `destroy()` 纪律(基准已有 disposables 统一销毁)。旧设备 `maxTexture2D=4096` 时 4000² 直接不可用,需能力探测降级。
5. **版本行为漂移**:swapchain COPY_SRC 限制(§3.2)、分离 canvas flush 行为(§3.3)都是引擎实现细节;基准脚本对这类变化做了"null+原因"的软失败,生产化后需定期在目标 WebView2 版本上回归。

---

## 5. v1 局限(读数据前必读)

1. 单机单 GPU(Intel 12 代核显),无独显/AMD 数据;核显共享内存带宽,回读与上传的绝对值不可外推。
2. ~±30% 跨运行方差(§2);无 CPU 隔热门/固定频率控制;每格仅 20 样本中位数。
3. 模糊对比是"朴素 6-pass 盒式 vs Skia 优化实现"的**算法不对等**比较;WebGPU 调优上限未探,但结论"无净收益"稳健。
4. `pixelBlend`(exotic blend 现行 CPU 路径)未进基准——头号候选子集缺乏直接对比,立项前必测。
5. Canvas2D 基准的 flush(`getImageData(1×1)`)只保证光栅化完成,不含全图像素回传;与 GPU 端到端口径对称(都不含读回),但两条路径的"显示到屏幕"成本均未计入。
6. 合成基准用 4 张源轮转(distinct = min(layers,4))控制内存,缓存局部性与生产 `prepareLayer` 缓存(LAYER_CACHE_CAP=64)不同;层数语义一致(draw 次数 = N)。
7. 上传数字含首次触达开销(§2 注\*),putImageData 为单次测量非中位数。
8. 端到端用 CPU 排空口径(`onSubmittedWorkDone`),timestamp-query 只用于纯渲染基线;encode/submit/GPU 三段未细分。
9. 4000²×64 未测(maxTexture 允许,但 64×64MB 显存风险 + 时间预算裁剪)。
10. 全部测量在 Chrome 稳定通道;**未在真实 WebView2 运行时验证**(任务范围:WebView2 只查文档,见 §6)。

---

## 6. WebView2 启用条件(问题④,文档调研,未真机测)

- **默认即用(前提:Evergreen Runtime 够新)**:Chromium 113(2023-05)起 WebGPU 在 Windows(D3D 后端)默认启用;WebView2 与 Edge/Chrome 同引擎,较新的稳定通道 Runtime 无需任何开关。Microsoft 的 WebView2 反馈线程(MicrosoftEdge/WebView2Feedback #2233,tauri #6381 正文引用)表示 WebView2 的 WebGPU 支持与 Windows 上 Edge 保持同步。tauri #6381 中"webgpu flag 仅非稳定 webview2 channel"的评论是 **2023-03** 时点,早于 113 默认启用,对现代 Runtime 已过时(此评论内容来自搜索摘要,未逐字核实原文)。
- **传开关的机制**(旧 Runtime / 被策略禁用时):`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量,或 `CoreWebView2EnvironmentOptions.AdditionalBrowserArguments`,Tauri 对应 `windows` 配置的 `additionalBrowserArgs`。**警告**:Tauri 的 `additionalBrowserArgs` 会**整体覆盖**默认参数而非追加(社区有卡死先例,tauri #12819),非必要不要设置;确需设置时应带上官方默认值全集。
- **唯一可靠的运行时判定是探针,不是版本表**:`navigator.gpu` 是否存在 + `requestAdapter()` 是否成功,受 Runtime 版本、企业策略、驱动白名单、硬件五重影响。`gpuAvailable()` / `gpuInfo()` 已实现该探测,不可用时返回 `null + 中文原因`,生产接入时按同样模式降级回 Canvas2D 即可,**不需要写任何 WebView2 专属开关代码**。
- 本机 Chrome 稳定通道实测可用(adapter `intel/gen-12lp`,§2);WebView2 Runtime 真机验证列为接入前置项。

---

## 7. 建议路线(若做,按此顺序)

1. **不做**:全量合成管线替换、高斯模糊迁移。收益不足或为负,维护成本(§4.3)最高。
2. **第一步(前置调研)**:给 `pixelBlend` 现行 JS 逐像素路径补基准(本次未测)。若其在典型文档上 >10ms/次,则 exotic blend 的 WGSL 化是收益最确定、语义面最小的切入点——只移植那几个 exotic 算子,结果 `drawImage` 回 2D(通道 A,§3.1),Canvas2D 管线整体不动。
3. **第二步(可选)**:4000² 级大文档导出路径评估——GPU 合成 + 一次性读回(或 GPU→编码器),把 §3.1 的通道 B 成本从"每帧"摊薄成"每次导出"。导出编码器(WWebCodecs/toBlob 路径)本次未评估,需单独立项。
4. **全程红线**:结果不落 CPU(§3);每基准/每接入点带能力探测降级(§6);纹理显存 LRU + `destroy()`(§4.4)。

## 8. 交付物清单

| 文件 | 说明 |
|---|---|
| `src/core/webgpuProbe.ts` | 独立探针原型:GPU 探测/初始化缓存、合成与模糊基准、timestamp-query 装置、回读与 sanity 检查;不被生产代码 import;vue-tsc 0 错误 |
| `tests/webgpuPerf.mjs` | Playwright(chrome 通道)驱动 6 个基准,人类可读对比表 + 13 项断言;HMR 抖动自动原样重跑一次 |
| `docs/webgpu-eval.md` | 本报告 |

生产代码改动:**无**。
