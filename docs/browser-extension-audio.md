# 浏览器扩展 AC-3/E-AC-3 音频兼容

> 当前音频与字幕的联合调度基线见[浏览器扩展媒体播放固定方案](browser-extension-media-pipeline.md)。修改本文件涉及的实现时必须同时遵守该基线。

## 目的

Windows 版 Chrome 无法原生解码 MKV 中常见的 AC-3 和 E-AC-3（Dolby Digital / Dolby Digital Plus，可能携带 Atmos 元数据）。这类文件会出现画面正常、播放器未静音、但完全没有声音的现象。

本项目必须只安装浏览器扩展即可工作，因此不调用系统 FFmpeg、PotPlayer、VLC、Native Messaging 或额外服务。扩展随包分发 Mediabunny 及 `@mediabunny/ac3`，后者包含基于 FFmpeg 的 AC-3/E-AC-3 WebAssembly 解码器。

## 数据流

1. ArtPlayer 打开 MKV 后派发 `cd2-audio-fallback-open`。
2. `packages/extension/src/compat/audio-fallback.ts` 创建隐藏的 `audio-host.html`，并以 `MessageChannel` 建立私有通信。
3. 非沙箱扩展页 `range-host.html` 凭扩展 Host 权限直接读取 CloudDrive2。音频和 libav 字幕共享 1 MiB 对齐分块、64 MiB 内存 LRU 以及进行中的请求，ArrayBuffer 经 MessageChannel 转移；Range Host 不可用时通过后台 `cd2-fetch` 回退。
4. `packages/extension/src/audio-host.ts` 使用 Mediabunny 解析 Matroska。只有主音轨为 `ac3` 或 `eac3` 时才启用兼容层。
5. 解码器仍按十秒区间连续工作；首个解码帧立即输出，后续 PCM 每积累约 0.5 秒输出一次。多声道音频在沙箱页下混为双声道，ArrayBuffer 通过 MessagePort 转移回播放器。共享缓存热路径不进行 Base64 编解码。
6. `packages/artplayer/src/audioFallback.ts` 使用 Web Audio 播放 PCM，并以原始 `<video>` 的 `currentTime` 为主时钟。

为消除 AC-3/E-AC-3 解码器的冷启动等待，用户展开任务悬浮窗时会创建沙箱页，并用扩展包内置的极小静音 E-AC-3 样本提前创建 Blob Worker、编译 WebAssembly 和初始化解码器。该样本不访问网络，也不依赖本机程序。选择 MKV 后先取得媒体缓存地址，再立即并行启动音轨探测和 ArtPlayer；已知文件大小时媒体注册不发送网络探测。

沙箱页必须先注册 `cd2-audio-host-init` 监听器、建立 MessagePort 并返回 `host-ready`，之后才能通过定时任务启动解码器预热。不要在模块顶层直接开始有效样本解码：首次 Blob Worker 创建和 WebAssembly 编译可能阻塞模块执行，使父页面在宿主页尚未注册监听器时超时。如果真实媒体已先开始打开，应跳过独立预热，避免同时初始化两条解码路径。

`audio-host.html` 必须以经典 `<script src="audio-host.js">` 加载 IIFE 构建产物，不能使用 `type="module"`。该页被 Manifest 声明为沙箱页后具有 opaque origin，模块入口在部分 Chrome 环境中可能未执行到消息监听器，父页最终只会看到“浏览器音频兼容环境启动超时”。

从任务列表播放时，一旦 CloudDrive2 返回视频直链，就应立即派发音频预加载事件；不能等待播放列表和外挂字幕扫描完成。任务文件对象已有的字节大小必须直接传给沙箱输入源，避免再发送 `bytes=0-0` 请求探测长度。

远程 MKV 不会被完整下载。Mediabunny 的读取缓存有固定上限，解码只请求当前播放位置附近的容器数据。

Range Host 收到完整网络分块后会立即放入内存并唤醒音频和字幕消费者。原生 `<video>` 当前继续直接使用 CloudDrive2 URL：Manifest V3 后台 Service Worker 的 FetchEvent 不能把扩展包内静态资源可靠地替换成动态 Range 响应，禁止再把 `media-cache-stream.bin` 之类的占位文件作为播放或音频地址。

音频与自动字幕采用分阶段并行：音轨容器元数据探测拥有很短的启动优先期，完成后音频 PCM 与字幕窗口同时解封装。Range Host 最多并发四个网络分块并按 `audio > subtitle > normal` 调度；同一 URL/分块继续通过 `pendingChunks` 合并。不要把字幕推迟到完整音频分段结束，也不要让字幕在音轨类型尚未识别前抢占慢速 CloudDrive2 的首批 Range。用户手动选择字幕不受该自动屏障限制。

## 为什么不使用通用 ffmpeg.wasm CLI

`@mediabunny/ac3` 本身已经包含基于 FFmpeg 的专用 WebAssembly 解码器。当前瓶颈主要是远程 Range、重复读取和跨边界数据复制，而不是 AC-3 算法吞吐。通用 ffmpeg.wasm CLI 会额外引入大型核心初始化及虚拟文件系统输入输出，不应用于播放热路径。

若以后增加 DTS、TrueHD/MLP 等音轨，应构建只包含 Matroska 解封装、所需音频解码器和重采样器的定制 Libav/FFmpeg WASM 核心，并继续接入本章的共享 Range 通道；不要改为完整文件写入 MEMFS，也不要替换浏览器原生视频解码。

## Manifest V3 约束

`@mediabunny/ac3` 将完整 Worker 和 WASM 封装在本地 Blob 中。Chrome Manifest V3 不允许普通扩展页的 `worker-src` 使用 `blob:`，不要把它加回 `extension_pages` CSP。

正确做法是：

- 在清单的 `sandbox.pages` 中声明 `audio-host.html`；
- 只在 `content_security_policy.sandbox` 中允许 `worker-src blob:`；
- 沙箱页没有扩展 API 权限，必须经 MessageChannel 请求内容脚本代理 Range；
- 沙箱页是 opaque origin，父页初始化它时 `postMessage` 的 target origin 必须为 `*`，安全边界由 `event.source === window.parent` 和私有 MessagePort 保证。

普通字幕 libav Worker 不使用 Blob，仍应保持由非沙箱扩展页 `libav-host.html` 创建，二者不要合并。

## 同步规则

- 视频负责画面、播放状态和时间轴，Web Audio 只负责兼容音轨。
- 播放开始、跳转结束和倍速改变时，丢弃已排程 PCM 并从 `video.currentTime` 重新解码/排程；跳转、暂停时还必须主动取消沙箱内尚未完成的旧位置解码，不能只在播放器侧忽略结果。
- 暂停和拖动中立即停止已排程的 Web Audio source。
- 音量与静音实时读取 `<video>` 属性，不修改用户已有的播放器偏好。
- 连续播放会提前预取下一段；检测到音画时钟偏差超过阈值时自动重新同步。
- 不得等完整十秒区间或首个聚合块完成后才返回 PCM；首次播放和跳转恢复都应在首个音频帧解码后立即排程，后续块沿同一解码任务连续追加。
- 视频暂停时允许后台预解码当前位置并暂存 PCM，以便恢复播放时立即出声；禁止为了等待兼容音频而暂停、延后或阻塞视频画面。
- 解码器冷启动应在任务面板展开后提前完成；当前视频的容器探测与首段解码应尽早并行开始，但不得作为创建播放器或显示首帧的前置条件。
- Web Audio 使用交互式低延迟模式；首秒 PCM 按解码帧持续发送，稳定播放后再恢复约 0.5 秒聚合，以兼顾启动速度和消息开销。
- 首段或断流后的 Range 解码仍在进行时，定时器必须等待，不能用尚未建立的时钟锚点执行漂移校正或递增播放代次，否则远程解码结果会被永久丢弃。
- 解码失败不得影响视频、字幕或弹幕，播放器应保留原生播放并给出可读错误。

## 构建与回归

```bash
pnpm --filter clouddrive2-browser-extension run ci
pnpm --filter clouddrive2-browser-extension typecheck
pnpm --filter clouddrive2-browser-extension build
```

构建产物必须包含：

- `audio-host.html`
- `audio-host.js`（经典 IIFE 构建产物）
- 清单中的 `sandbox.pages` 声明
- 清单沙箱 CSP 的 `worker-src blob:`

实机回归至少覆盖：首次播放出声、暂停/恢复、拖动进度、切换倍速、音量、静音、关闭播放器和刷新恢复。重新构建后必须先在扩展管理页点击“重新加载”，再刷新测试网页。
