# 浏览器扩展视频解码与渲染固定方案

本文固定浏览器扩展的视频软件/硬件解码实现。目标是在不安装本地 FFmpeg、不整文件下载的前提下，尽量减少黑屏、闪烁、卡顿、跳帧和 Canvas 资源泄漏。媒体总管线见 [浏览器扩展媒体播放固定方案](browser-extension-media-pipeline.md)。

## 1. 方案选择

当前采用 **Mediabunny + WebCodecs + 浏览器 Canvas 合成**，不再引入另一个媒体框架。

- Mediabunny 已经负责 MP4、MKV、MPEG-TS、WebM 等容器的 Range 读取、索引、关键帧定位和 WebCodecs 解码队列。
- WebCodecs 的 `hardwareAcceleration` 可以表达软件优先、硬件优先和无偏好三种请求。
- 原生 `<video>` 仍保留，负责音频、播放状态、`currentTime` 主时钟和最终故障保护。
- 自定义解码器只负责视频画面，不接管音频，避免同时维护两套音视频时钟。
- `OffscreenCanvas` 和 `bitmaprenderer` 是浏览器原生的低开销画面交换方法，比增加一个第三方播放器或在多个 HTML Canvas 之间切换更适合当前扩展。

### 不采用的替代方案

- **整文件 Blob/ArrayBuffer 播放**：大型 MKV 会造成首屏等待和内存峰值，违反 Range 播放约束。
- **重新引入 FFmpeg/Native Host**：增加安装、权限和跨平台维护成本，不符合扩展免安装目标。
- **仅切换原生 `<video>` 的硬件开关**：浏览器没有稳定的网页 API 可以强制原生元素使用软件解码，因此软件优先必须通过 WebCodecs 请求。
- **每个 `requestAnimationFrame` 请求一个稀疏样本**：会反复执行关键帧定位和解码队列调度，播放时容易抖动；顺序播放必须使用 `VideoSampleSink.samples()`。
- **双 HTML Canvas 轮换 opacity**：CSS opacity 交换可能与合成时序交错，出现闪烁；当前改为单一显示 Canvas 的原子画面交换。

## 2. 源码位置

| 责任 | 文件 |
| --- | --- |
| 内容脚本注册桥接 | `packages/extension/src/content.ts` |
| 视频解码和画面调度 | `packages/extension/src/compat/video-renderer.ts` |
| Range 读取和优先级 | `packages/extension/src/compat/media-range.ts`、`range-host.html` |
| 播放器模式菜单和事件 | `packages/artplayer/src/player.ts` |
| libass Canvas 构建补丁 | `packages/extension/vite.content.config.ts` |
| 总体媒体约束 | `docs/browser-extension-media-pipeline.md` |

## 3. 数据流

```text
CloudDrive2 HTTP URL
        │
        ├── 原生 <video>
        │      ├── 音频/播放状态/currentTime
        │      └── 自定义解码失败时的画面保护
        │
        └── Mediabunny UrlSource
               └── fetchFn → Range Host
                              ├── 1 MiB 分块
                              ├── 64 MiB LRU
                              ├── pending 请求合并
                              └── normal 优先级
                                      │
                                      ▼
                            Input → InputVideoTrack
                                      │
                                      ▼
                              VideoSampleSink.samples()
                                      │
                                      ▼
                         WebCodecs VideoDecoder
                                      │
                                      ▼
                        VideoSample → Canvas 画面交换
```

视频 Range 请求使用 `normal` 优先级；音频和字幕分别使用更高优先级。相同 URL、相同分块的进行中请求和已完成缓存必须复用，视频不能阻塞音频启动。

## 4. 解码器选择

播放器菜单提供：

- **软件解码**：候选顺序为 `prefer-software` → `no-preference` → `prefer-hardware`。
- **硬件解码**：候选顺序为 `prefer-hardware` → `no-preference` → `prefer-software`。
- **浏览器原生**：不创建 WebCodecs 画面层。

每次候选启动前：

1. 检查浏览器是否存在 `VideoDecoder`。
2. 用 `Input.canRead()` 确认容器可以由 Mediabunny 识别。
3. 获取主视频轨道和 `VideoDecoderConfig`。
4. 用 `VideoDecoder.isConfigSupported()` 检查当前硬件加速偏好。
5. 候选失败才尝试下一个偏好；不能因为首选不可用就直接显示黑屏。

`hardwareAcceleration` 是浏览器提示，不是所有显卡/编解码器都能严格遵守。实际生效值通过状态事件记录，不能把“硬件优先”误报成“硬件一定生效”。

## 5. 顺序解码和时钟调度

### 5.1 为什么使用 `VideoSampleSink.samples()`

播放是连续时间轴，不是随机截图。`VideoSampleSink.samples(startTimestamp)` 会从当前位置的关键帧开始，持续输出 presentation order 的 `VideoSample`，并由 Mediabunny 控制解码队列大小。

不要在播放循环中使用 `samplesAtTimestamps()` 或 `CanvasSink.canvasesAtTimestamps()` 请求每一个动画帧；那会把播放变成大量稀疏定位操作，尤其对远程 MKV 和 B 帧视频不稳定。

### 5.2 当前时间规则

- 自定义画面以原生 `<video>.currentTime` 为主时钟。
- 解码流水线开始时从当前时间附近开始，不从文件 0 秒重新追赶。
- 当前视频暂停时，最多保留一个待显示样本，并等待 `play` 或下一次跳转。
- 播放中使用约 16 ms 的短定时器检查时钟，不依赖原生视频的 `requestVideoFrameCallback` 或页面 `requestAnimationFrame`。
- 样本时间戳早于当前时间超过约 250 ms 时，在绘制前直接关闭并丢弃；不能先画一遍无效的过期帧再丢弃。
- 样本时间戳尚未到达时等待当前时钟；等待期间只持有当前一个 `VideoSample`。
- 跳转、销毁或切换模式会增加 `pipelineGeneration`，旧代次不得再提交画面。

这样可以避免两类常见抖动：

1. 解码落后时反复绘制大量过期帧，主线程和 GPU 一起追赶。
2. 解码提前时连续提交未来帧，画面与原生音频时钟脱节。

## 6. 画面交换

### 6.1 首选路径：OffscreenCanvas + bitmaprenderer

每条解码流水线创建：

- 一个按视频轨道原始 square-pixel 尺寸创建的 `OffscreenCanvas` 作为后台绘制面。
- 一个 HTML `<canvas>` 作为唯一显示面。
- 后台 Canvas 使用 2D context 绘制完整样本。
- 绘制完成后调用 `transferToImageBitmap()`，再用显示面的 `bitmaprenderer.transferFromImageBitmap()` 一次性提交。

显示面只在首帧成功后显示，之后不再在多个 HTML Canvas 之间切换 opacity。这样可以让浏览器在完整帧准备好后交换画面，避免 `clearRect`、CSS opacity 和合成时序造成的黑闪。

### 6.2 兼容路径

如果浏览器没有 `OffscreenCanvas` 或 `bitmaprenderer`：

- 使用一个未挂载的 HTML Canvas 作为后台绘制面。
- 使用一个已挂载的 HTML Canvas 作为显示面。
- 后台绘制完成后用显示面的 2D context 一次性 `drawImage()`。

兼容路径仍然保持单一显示面和原始输出尺寸，不得恢复双 Canvas opacity 轮换，也不得为了性能偷偷限制到固定 1080p/1920p。

### 6.3 原始尺寸约束

Canvas 宽高来自轨道的 square-pixel 宽高，旋转 90/270 度时交换宽高。当前实现不设置 1920、3840 或其他固定像素上限。性能优化应通过顺序解码、过期帧丢弃、原子画面交换和合理的 Range 调度完成，不能改变用户看到的分辨率。

## 7. `VideoSample` 资源生命周期

`VideoSample` 持有 WebCodecs `VideoFrame`，必须在最后一次使用后立刻关闭。

固定规则：

```ts
let rendered = false;
try {
	// 等待时钟、绘制和提交画面
	present(sample);
	rendered = true;
} finally {
	if (!rendered) sample.close();
}
```

当前 `renderSample()` 无论绘制成功、Canvas 创建失败、流水线取消还是跳转，都在 `finally` 中调用 `sample.close()`。在进入等待前丢弃的样本也必须显式 `close()`。

停止流水线时还必须：

1. 递增代次，阻止旧循环提交画面。
2. 唤醒所有时钟等待者。
3. `Input.dispose()`，让 Mediabunny 关闭读取和解码器。
4. 移除显示 Canvas 和后台 Canvas 引用。
5. 让 `for await` 迭代器执行 `return()`，关闭队列中尚未取出的样本。

控制台出现 `A VideoSample was garbage collected without first being closed`，说明上述生命周期有路径遗漏，不能用提高 GC 阈值或忽略日志解决。

## 8. 首帧、跳转和故障保护

### 首帧

- 原生 `<video>` 在自定义画面准备期间保持可见，继续负责声音和时钟。
- 自定义画面真正提交第一帧后，才隐藏原生视频。
- 容器解析、关键帧读取或解码候选失败时，保留原生视频，不创建黑色覆盖层。

### 跳转

- `seeking`：立即停止自定义流水线、显示原生视频、取消旧 Range/解码等待。
- `seeked`：从新的 `currentTime` 创建新顺序样本迭代器。
- 旧代次即使稍后返回样本，也不能重新显示旧画面。

### 停滞监测

停滞监测同时检查：

- 原生播放时钟是否继续前进。
- 距离上一帧真实提交是否已经超过阈值。

不能只用“当前时间 - 样本 PTS”判断，因为初始化或跳转时 PTS 可能暂时落后，但流水线仍在追赶。确实长时间没有画面提交时，最后才触发原生保护回退；回退是安全网，不是正常播放路径。

## 9. Canvas2D `willReadFrequently`

该提示来自 `libass-wasm` 的字幕 Canvas 初始化：libass 会调用两次 `getImageData()` 检查透明像素行为。扩展不直接修改 `node_modules` 或生成的 `public` 文件，而是在 `vite.content.config.ts` 的构建插件中为 `libass-wasm/dist/js/subtitles-octopus.js` 的 2D context 创建调用补充：

```js
getContext("2d", { willReadFrequently: true })
```

构建后应在 `packages/extension/build/content.js` 中确认该属性存在。该修复只针对字幕 Canvas，不给视频渲染 Canvas 设置 `willReadFrequently`，避免把视频绘制强制到不利于播放的读回路径。

## 10. 禁止事项

- 不要把自定义视频改成整文件下载或 Blob URL。
- 不要在连续播放中按 rAF 逐帧调用稀疏样本 API。
- 不要在样本过期后才绘制再丢弃。
- 不要忘记关闭 `VideoSample`、`VideoFrame` 或 `ImageBitmap` 的所有权资源。
- 不要用多个 HTML Canvas 的 opacity 轮换代替原子画面交换。
- 不要给视频 Canvas 添加固定 1080p/1920p/3840p 上限。
- 不要把 `willReadFrequently` 加到视频绘制 Canvas；它是读回优化，不是视频绘制优化。
- 不要为了隐藏闪烁而永久显示原生视频并让 WebCodecs 继续重复解码。
- 不要让视频普通优先级 Range 请求阻塞音频和字幕的高优先级请求。
- 不要把一次暂时解码延迟直接当成失败；先丢弃过期帧并观察真实提交时间。

## 11. 回归验证

代码验证：

```bash
pnpm run ci
pnpm run typecheck
pnpm run test
pnpm --filter clouddrive2-browser-extension build
```

浏览器验证：

1. 在扩展管理页重新加载 `packages/extension/build`。
2. 关闭旧播放页面后重新打开，避免旧内容脚本和旧 Worker 继续运行。
3. 分别测试软件解码、硬件解码和浏览器原生解码。
4. 观察首帧、连续播放 5 分钟、暂停/恢复、拖动跳转和多次连续跳转。
5. 检查画面是否有黑闪、亮暗抖动、重复帧、明显追赶或突然回退。
6. 同时验证音频、ASS/SRT 字幕、字幕偏移、弹幕和播放器销毁。
7. 控制台不应出现未关闭 `VideoSample`、跨源 Worker、`willReadFrequently` 重复读回提示或连续的自定义解码停滞日志。

如需进一步定位，记录：解码菜单选择、状态事件中的 `effectiveAcceleration`、视频容器/编码、当前时间、是否正在跳转、Range 请求状态以及最后一帧提交时间；不要只凭“黑屏”现象更换解码库。
