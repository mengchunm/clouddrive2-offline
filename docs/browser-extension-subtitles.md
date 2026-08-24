# 浏览器扩展字幕实现说明

> 当前音频与字幕的联合调度基线见[浏览器扩展媒体播放固定方案](browser-extension-media-pipeline.md)。修改本文件涉及的实现时必须同时遵守该基线。

本文记录 Chromium MV3 扩展中已经验证可用的 CloudDrive2 远程视频字幕方案。后续修改播放器、Worker、构建流程或字幕解析时，应保留本文列出的架构和兼容处理。

## 目标与约束

- 用户只需安装浏览器扩展，不额外安装 FFmpeg、EXE、服务或字幕程序。
- MKV 视频来自 CloudDrive2 HTTP 地址，不要求视频已挂载为本地文件。
- 通过 HTTP Range 按需读取远程 MKV，不能把数 GB 视频完整下载到浏览器内存。
- 支持 MKV 内嵌 ASS/SSA/SubRip/WebVTT、MP4 tx3g/text，以及外挂 SRT/VTT/ASS/SSA。
- ASS 样式渲染失败时必须继续显示无样式基础字幕，不能让字幕完全消失。

## 最终架构

### MKV 解封装

1. `packages/artplayer/src/utils/mkvMetadata.ts` 通过 Range 请求快速读取 MKV Tracks 元数据，只建立字幕选择列表。
2. 用户选择 ASS/SSA/SubRip/WebVTT 轨道后，播放器触发 `cd2-libav-extract-subtitle` 事件。
3. `packages/extension/src/compat/libav-subtitles.ts` 创建扩展内部隐藏宿主页 `libav-host.html`，并使用私有 `MessageChannel` 通信。
4. `packages/extension/src/libav-host.ts` 从扩展源创建 `libav-worker.js`。内容脚本不能直接创建 `chrome-extension://.../libav-worker.js`，否则浏览器会按网页源执行 Worker 入口检查并拒绝加载。
5. `packages/extension/src/libav-worker.ts` 使用随包分发的 libav.js 6.9.8 WebAssembly Matroska demuxer。libav 工厂和 WASM 字节均在构建期内嵌到 `libav-worker.js`，初始化时不再读取任何 `chrome-extension://.../libav/*.wasm` URL。Worker 发出的仅是视频 Range 请求，由扩展后台读取 CloudDrive2 视频并返回数据块。
6. 首次只读取当前时间前后各 1 秒，使低速 CloudDrive2 Range 上的高码率 4K MKV 尽快显示字幕；显示后再以前 3 秒至后 8 秒的重叠窗口后台预读并合并字幕。短窗口也让音频首段与字幕更容易命中 Range Host 中相同的 1 MiB 分块。

libav 实例必须在 Worker 生命周期内单例复用。创建实例会解码 Base64、编译并实例化 WebAssembly；不能在每个字幕分段结束时调用 `terminate()`，否则预读和跳转都会重复承担完整冷启动成本。共享实例上的提取请求必须串行执行，并在每次结束后关闭 format context、释放 packet 和删除对应虚拟设备。

Range Host 以 1 MiB 对齐块共享音频和字幕读取。libav 的小读取可能被放大到一个完整块并跨过文件末尾；此时 CloudDrive2 返回小于 1 MiB 的最后一块是合法 EOF，不是网络截断。`range-host.ts` 必须使用 Content-Range 的文件总长度截断输出，并让 `media-range.ts` 按实际返回长度生成 Content-Range，不能要求调用方在 EOF 仍收到请求的完整长度。

### Matroska SubRip/WebVTT 数据包组装

Matroska 的 `S_TEXT/UTF8` 数据包只有字幕文字，时间来自数据包 PTS 和 duration。`libav-worker.ts` 必须在扩展 Worker 内直接组装标准 WebVTT，再交给浏览器原生字幕层；不要回退到 `@cryguy/mkv-subtitle-extractor` 扫描远程文件，否则大体积 CloudDrive2 MKV 会产生大量 Range 请求并长时间无法完成。

当前时间窗没有字幕包是合法结果，常见于电影片头和 forced 字幕轨。Worker 应返回只有 `WEBVTT` 头的有效空字幕，播放器仍记录该时间窗并在接近末端或跳转后继续预读；不能把空时间窗当作“字幕轨不存在”。分段合并时按开始时间排序并去重，只有内容实际增加时才替换浏览器字幕 Blob，避免无意义刷新。

### 默认选择与持久化

- MKV Tracks 元数据必须解析 `TrackFlagDefault` 与 `TrackFlagForced`，不能只依赖轨道名称。
- 首次播放默认开启字幕：外挂字幕优先，其次按容器默认标志和语言评分选择完整轨；forced、CC/SDH 不应压过同语言的普通完整轨。
- 用户手动选择的 MKV TrackNumber、外挂字幕或“关闭字幕”状态按稳定的 CloudDrive2 文件路径保存。没有文件路径时使用去掉 query/hash 的视频 URL，不能把可能刷新的 token 纳入键值。
- forced 轨只包含必须翻译的外语、标牌等少量内容，当前窗口为空时保留选择并继续预读，不要自动偷换成完整轨；但首次无偏好时应选择普通完整轨。
- 自动恢复或首次选择的字幕在音轨容器元数据探测完成后与首段 PCM 并行加载，避免慢速 CloudDrive2 上两套解封装器同时争抢启动数据；用户手动选择始终立即执行。

libav Worker 必须由扩展源宿主页创建。不要恢复为内容脚本中的以下写法：

```ts
new Worker(chrome.runtime.getURL("libav-worker.js"));
```

该写法会产生 `Failed to construct 'Worker' ... cannot be accessed from origin`。

### Matroska ASS 数据包组装

Matroska ASS 数据包不包含完整 `Dialogue:` 行，只包含：

```text
ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
```

`libav-worker.ts` 使用数据包 PTS 和 duration 生成 Start/End，再组装为完整 ASS：

```text
Dialogue: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
```

生成的事件必须插入 `[Events]` 区段内部，且位于下一个 ASS 区段之前。不能简单追加到文件末尾，因为部分 CodecPrivate 在 `[Events]` 后仍包含其他区段；追加到末尾会导致 libass 和 WebVTT 转换器忽略 Dialogue。

### libass 渲染

- libass Worker、WASM 和 Noto Sans SC 字体均位于扩展包的 `libass/` 目录。
- 内容脚本同样不能直接以扩展 URL 创建 libass Worker。
- `packages/extension/src/compat/libass-plugin.ts` 先读取扩展内 Worker 源码和 WASM，再分别建立 Blob URL。
- Worker Blob 前注入 `Module.locateFile`，将 `.wasm` 固定指向 WASM Blob URL。

必须保留 `Module.locateFile`。当 Worker 入口是 Blob 时，Emscripten 默认会把相对 WASM 地址解析到当前网站，例如 `https://dmhy.anoneko.com/subtitles-octopus-worker.wasm`。此时 libass 可能在 WASM 真正初始化前发出消息，使上层误以为“ASS 字幕已加载”，但 canvas 始终透明。

### WebVTT 可靠兜底

`packages/artplayer/src/utils/assToVtt.ts` 将同一份 ASS 转换为基础 WebVTT。播放器生命周期内，应用第一份 ASS 时先显示 WebVTT，只有监听到 libass Worker 返回包含实际图像的非空 `renderCanvas` 或 `renderFastCanvas` 后，才隐藏 WebVTT。libass 一旦成功绘制过，后续滚动窗口合并和 `setTrack` 更新不得重新显示 WebVTT，否则每次更新都会产生“无样式字幕 → ASS 字幕”的闪烁。

因此：

- libass 正常时显示完整 ASS 样式。
- libass 初始化、字体、WASM 或渲染异常时仍显示基础文字。
- 转换器会兼容错误落在其他区段后的 `Dialogue:`，用于读取旧版本曾生成的不规范缓存内容。

## 构建资源

以下文件必须包含在扩展 `build` 中，并列入 Manifest 的 `web_accessible_resources`：

- `libav-host.html`
- `libav-host.js`
- `libav-worker.js`（已内嵌 libav 工厂与 WASM）
- `libass/subtitles-octopus-worker.js`
- `libass/subtitles-octopus-worker.wasm`
- `libass/NotoSansSC-VF.ttf`

字幕功能不依赖本项目可选的 Windows 本地目录 Native Messaging 功能。

## 回归验证

修改字幕代码后至少运行：

```bash
pnpm run typecheck
pnpm run ci
pnpm --filter clouddrive2-browser-extension run test:libav-mkv
pnpm --filter clouddrive2-artplayer run test:mkv-metadata
pnpm run build:extension
```

人工验证步骤：

1. 在扩展管理页重新加载 `packages/extension/build`。
2. 确认扩展版本与 `manifest.json` 一致。
3. 关闭此前已打开的测试网站标签页，再重新打开。只重新加载扩展而不重开网页，会让旧内容脚本报 `Extension context invalidated`。
4. 播放 CloudDrive2 MKV，分别选择内嵌 ASS 和 SRT 字幕。
5. 验证当前时间字幕可快速显示、拖动进度后字幕可继续加载、接近当前短窗口边界时可以后台预读取下一段；选择当前时间没有对白的轨道不应报错。
6. 控制台不应出现跨源 Worker 错误、`ASS 中没有 Dialogue 字幕内容`，也不应对受支持的 SRT 轨道启动整文件字幕提取。

扩展构建会为 libass 的 Canvas2D 上下文设置 `willReadFrequently`，避免字幕初始化的 `getImageData` 触发重复读回提示。

## 不应回退的实现

- 不要从网页内容脚本直接创建扩展 URL Worker。
- 不要给 libav Worker 恢复 `toImport` 或 `wasmurl`；即使文件在扩展包内并声明为可访问资源，实际 Chrome 仍可能拒绝 Worker 内的 `chrome-extension://` WASM fetch/XHR。
- 不要恢复首次向后读取 120 秒的字幕窗口，也不要在每个窗口结束时销毁 libav 实例；高码率 MKV 会因此等待大量无关音视频数据并重复初始化 WASM。
- 不要让 Blob Worker 使用默认相对 WASM 路径。
- 不要把 Matroska ASS 数据包直接当作完整 ASS 文件。
- 不要让 MKV SubRip/WebVTT 回退到整文件扫描提取器。
- 不要把当前分段没有字幕事件当作字幕加载失败。
- 不要把 `TrackFlagDefault=1` 等同于最佳日常字幕；同一轨若同时为 forced，应优先选择同语言的非 forced 完整轨。
- 不要把跨过文件末尾的最后一个 Range 短响应当作传输失败。
- 不要把生成的 Dialogue 无条件追加到 CodecPrivate 末尾。
- 不要在 libass 仅发出“就绪消息”后立即隐藏 WebVTT；必须等待实际非空字幕帧。
- 不要在每次字幕窗口预读取或 `setTrack` 时重置 libass 已成功绘制的状态。
- 不要为了字幕功能引入外部 FFmpeg、Native Host、注册表或本地服务依赖。
