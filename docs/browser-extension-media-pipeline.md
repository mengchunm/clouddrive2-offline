# 浏览器扩展媒体播放固定方案

本文记录 1.6.42 起固定使用的 CloudDrive2 远程 MKV 播放方案。后续修改音频、字幕、播放器恢复或 Range 缓存时，必须以本文为兼容基线，并同时回归音频与字幕，不能只验证单项功能。视频解码与画面渲染的详细算法见 [浏览器扩展视频解码与渲染固定方案](browser-extension-video-decoding.md)。

## 固定约束

- 用户只安装浏览器扩展，不额外安装 FFmpeg、EXE、服务或解码器。
- 视频来自 CloudDrive2 HTTP 直链，不假设文件已挂载到本地。
- 不完整下载大型 MKV，只通过 HTTP Range 按需读取。
- Windows Chrome 不支持的 AC-3/E-AC-3 由扩展内置解码器处理。
- MKV 内嵌 ASS/SSA/SubRip/WebVTT 由扩展内 libav.js 解封装。
- 视频画面、音频与字幕均通过 Range Host 读取；视频使用普通优先级，音频启动优先，音频与字幕不能互相全局串行。

## 最终数据流

```text
CloudDrive2 视频直链
        │
        ├── 浏览器原生 <video>：画面、时间轴和播放状态
        │
        └── Range Host：1 MiB 分块、64 MiB LRU、进行中请求合并
                 │
                 ├── video-renderer：Mediabunny 顺序 VideoSampleSink
                 │               → WebCodecs 软件/硬件 → OffscreenCanvas/bitmaprenderer
                 │
                 ├── audio-host：Mediabunny + @mediabunny/ac3
                 │               → PCM → Web Audio
                 │
                 └── libav-host / libav-worker
                                 → ASS 或 WebVTT → ArtPlayer/libass
```

原生 `<video>` 继续直接使用 CloudDrive2 URL，负责音频、时间轴和原生回退。扩展播放视频时还可由播放器“解码”菜单启用 Mediabunny/WebCodecs 画面层：它通过 Range Host 的普通优先级读取 1 MiB 分块，使用独立 64 MiB 内存缓存和网络预读，并可请求软件或硬件解码；画面层按视频轨道原始像素尺寸创建 Canvas，不主动降低输出分辨率。首帧确认后才隐藏原生画面，初始化、跳转重建或解码失败时恢复原生画面。Manifest V3 Service Worker 不能可靠地把扩展静态资源替换成动态媒体 Range 响应，不要重新引入 `media-cache-stream.bin` 一类占位播放地址。

## Range Host 固定策略

- 分块大小：1 MiB。
- 内存缓存上限：64 MiB，使用 LRU 淘汰。
- 同一 URL 和分块的并发请求通过 `pendingChunks` 合并，只访问一次 CloudDrive2。
- 最多同时执行四个网络分块请求。
- 调度优先级固定为 `audio > subtitle > normal`。
- 同一分片尚在队列中时，后到的高优先级请求必须提升已有任务的优先级；不能因为字幕先排队就让随后到达的音频继续等待。
- 视频、音频和字幕访问同一区域时必须复用已完成或正在进行的分块；视频使用 `normal` 优先级，不得阻塞音频。
- 文件尾部不足 1 MiB 是合法 EOF；按 Content-Range 总长度截断，不能报“Range 数据提前结束”。

## 音频与字幕启动顺序

自动字幕与兼容音频采用分阶段并行，而不是完全串行：

1. 音轨先取得很短的容器元数据探测优先期。
2. 探测完成后，首段 PCM 解码与默认字幕当前窗口并行执行。
3. 音轨探测屏障最多等待 3 秒；失败或超过上限后字幕仍继续加载。
4. 用户手动选择字幕不经过自动屏障，立即执行。

不要让默认字幕在音轨类型尚未识别前抢占慢速 CloudDrive2 的首批 Range，也不要等完整音频段或首个 PCM 全部完成后才启动字幕。

## 音频固定实现

- `audio-host.html` 是 Manifest V3 sandbox page。
- 宿主入口必须是经典 IIFE：`<script src="audio-host.js">`，不能改回 `type="module"`。
- 只有 sandbox CSP 允许 `worker-src blob:`；普通 extension page 不允许 Blob Worker。
- 宿主页先建立 MessagePort 并返回 `host-ready`，再后台预热 E-AC-3 解码器。
- 首次握手失败必须移除失效 iframe 并重试一次；日志要区分宿主页未加载和脚本加载后未响应。
- `host-ready` 先于 AC-3/E-AC-3 解码器注册返回；注册仍在当前任务内完成，端口中的媒体请求下一任务才会执行。
- 首个解码帧立即发送，后续 PCM 约每 0.5 秒发送一次。
- 视频画面不等待兼容音频；Web Audio 以 `<video>.currentTime` 为主时钟同步。
- 暂停、跳转和销毁引发的“音频解码已取消”属于正常控制流，不作为错误提示。

## 字幕固定实现

- `libav-worker.js` 在构建时直接内嵌 libav 工厂与 WASM 字节。
- 不得恢复运行时 `toImport` 或 `wasmurl`；实际 Chrome 可能拒绝 Worker 内的 `chrome-extension://` WASM fetch/XHR。
- libav Worker 必须由扩展源的 `libav-host.html` 创建，不能由网页内容脚本直接创建扩展 URL Worker。
- libav WebAssembly 实例在 Worker 生命周期内单例复用；各提取任务串行使用该实例并在结束后释放 format context、packet 和虚拟设备。
- 已成功加载字幕后的后台预读在跳转时，必须经扩展桥向 Worker 发送 `cancel-extract`；过期任务释放当前 Range 等待并让最新请求优先执行。
- 首次字幕提取尚未建立活动字幕状态，不能因为播放器初始化或恢复进度产生的 `seeking` 而取消；否则 `seeked` 后没有状态可以重新填充字幕。
- 后台预读必须使用请求代次保护，旧任务结束时不能清除新任务的 `loading` 状态。
- 正常取消使用 `Operation canceled` 控制流，不显示为字幕加载失败通知。
- WASM 已内嵌 `libav-worker.js`，构建包不得再复制或公开独立的 `libav/*` 运行时副本。
- 首次字幕窗口固定为当前位置前后各 1 秒，优先快速显示。
- 后续使用前 3 秒、后 8 秒的短重叠窗口预读。
- 覆盖当前时间的多个窗口应选择结束时间最远者，不能重复提取重叠范围。
- 已读取的重叠覆盖范围必须合并，避免长时间播放时范围数组持续增长。
- ASS 先提供 WebVTT 基础兜底，libass 实际绘制非空帧后再隐藏兜底层，避免闪烁或完全无字。

## 字幕默认选择和记忆

- 首次播放默认开启字幕。
- 外挂字幕优先；内嵌轨按 default、语言和完整性评分。
- 必须解析 MKV 的 `TrackFlagDefault` 与 `TrackFlagForced`。
- forced、CC/SDH 不应压过同语言的普通完整字幕。
- 用户选择使用稳定的 CloudDrive2 文件路径持久保存；没有文件路径时使用去掉 query/hash 的 URL。
- MKV 内嵌轨使用 TrackNumber 作为稳定身份，不能保存临时 Blob URL。
- 用户选择“关闭字幕”也必须记忆。
- forced 轨只在外语、标牌或必要对白处有内容；当前时间窗为空不是解析失败，保持选择并继续预读。

目标测试视频的轨道事实：`English (forced)` 同时标记为 default/forced，普通 `English` 是完整非 forced 轨，因此无历史偏好时应自动选择普通 `English`。

## 禁止回退

- 不要让音频和字幕各自建立无法共享的整文件缓存。
- 不要把音频和字幕改为全局串行。
- 不要让自动字幕在音轨元数据探测前抢占启动 Range。
- 不要为等待音频而阻塞视频首帧。
- 不要恢复 17 秒、120 秒等大字幕首屏窗口。
- 不要在每个字幕窗口结束时销毁 libav 实例。
- 不要只依据 `TrackFlagDefault` 选择字幕而忽略 forced。
- 不要把 CloudDrive2 直链 token 作为字幕记忆键的一部分。
- 不要引入扩展包以外的 FFmpeg、Native Host 或本地服务作为播放依赖。

## 修改后的最低回归

```bash
pnpm --filter clouddrive2-artplayer run ci
pnpm --filter clouddrive2-artplayer run typecheck
pnpm --filter clouddrive2-artplayer run test:mkv-metadata
pnpm --filter clouddrive2-browser-extension run ci
pnpm --filter clouddrive2-browser-extension run typecheck
pnpm --filter clouddrive2-browser-extension run test:audio-fallback
pnpm --filter clouddrive2-browser-extension run test:libav-mkv
pnpm --filter clouddrive2-browser-extension run build
```

实机至少验证：软件解码与硬件解码首帧、连续播放、暂停恢复、跳转后恢复画面、原生回退、首次出声、默认字幕出现、刷新恢复字幕选择、forced 空窗口、普通 English 完整字幕以及关闭播放器。

构建时会为 libass 的 Canvas2D 上下文设置 `willReadFrequently`，避免字幕初始化的 `getImageData` 触发重复读回警告。扩展重新构建后必须在扩展管理页重新加载，并关闭旧播放页面后重新打开，避免旧 Worker、iframe 和内容脚本继续运行。
