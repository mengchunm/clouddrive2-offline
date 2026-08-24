# 项目架构

## 仓库结构

这是一个由 pnpm workspace 管理的 Monorepo：

- `packages/extension`：主要发布形态，负责 MV3 清单、后台代理、内容脚本、设置页、扩展 Worker 和可选 Native Messaging。
- `packages/offline`：磁力链接检测、CloudDrive2 API、离线任务面板、文件解析和播放入口；同时保留独立 userscript 构建。
- `packages/artplayer`：ArtPlayer、弹幕、字幕、播放列表和播放器偏好；同时保留独立 userscript 构建。

扩展构建会把 `offline` 和 `artplayer` 的入口合并进内容脚本。两个业务包继续保持 userscript 兼容层，因此修改共享逻辑时必须同时验证扩展和 userscript 构建。

## 运行时边界

1. 内容脚本扫描普通网页中的磁力链接并挂载任务面板。
2. CloudDrive2、弹幕、视频 Range 和字幕请求通过 MV3 后台转发，避免页面 CSP/CORS 限制。
3. 播放器运行在页面 overlay 中，通过扩展兼容层访问存储和后台能力。
4. libav Worker 必须由扩展源的 `libav-host.html` 创建，不能由网页源直接创建扩展 URL Worker。
5. AC-3/E-AC-3 解码 Worker 使用 Blob URL，只能运行在清单声明的 `audio-host.html` 沙箱页；远程字节仍由内容脚本和后台 Range 代理提供。
6. Windows 文件资源管理器功能是可选能力，通过 Native Messaging 调用随扩展提供的 PowerShell Host。

## 关键数据流

### 离线任务

网页磁链 → `submitOffline` → CloudDrive2 gRPC-Web → 任务列表刷新 → 文件/目录解析 → 播放、下载或本地路径映射。

### 播放与字幕

任务面板派发 `cd2-play-video` → ArtPlayer 使用 CloudDrive2 原始直链打开视频 → Range Host 按需读取远程容器 → 扫描外挂和内嵌字幕 → libav.js 解封装 → libass 或 WebVTT 渲染。

视频元素直接使用 CloudDrive2 原始 URL。音频兼容层与 libav 字幕通过非沙箱扩展页 `range-host.html` 读取 Range：该页面具有扩展 Host 权限，并用 MessageChannel 将 ArrayBuffer 转移给内容脚本。二者共享 1 MiB 对齐分块、64 MiB 内存 LRU 与进行中的请求。Manifest V3 后台 Service Worker 不能可靠地把扩展包内静态资源替换为动态媒体响应，因此禁止再使用 `media-cache-stream.bin` 一类占位文件作为视频、音频或字幕地址。

字幕的详细兼容约束见 [浏览器扩展字幕实现](browser-extension-subtitles.md)。

### 浏览器音频兼容

ArtPlayer 先使用浏览器原生 `<video>` 播放。扩展仅对 MKV 做音轨探测；检测到 AC-3/E-AC-3 时，`audio-host.html` 沙箱页中的 Mediabunny 和内嵌 FFmpeg WebAssembly 解码器按时间段读取远程音轨、下混为立体声，再由播放器使用 Web Audio 输出。视频始终是主时钟，暂停、跳转、倍速或漂移超过阈值时会重新对齐。其他音频编码继续走浏览器原生路径。

详细约束见 [浏览器扩展音频兼容](browser-extension-audio.md)。

### 弹幕

播放器默认使用弹弹Play直连模式进行匹配和加载；弹幕匹配与字幕轨道是两套独立流程。弹幕透明度、字号、显示区域等偏好跨视频保存。

## 存储

- 扩展设置和全局播放器偏好：`chrome.storage.local` 兼容层。
- userscript 配置：GM storage。
- 播放进度、播放列表等运行记忆：播放器 memory 层。
- 扩展音频和字幕 Range 分片：`range-host.html` 中的 64 MiB 内存 LRU；关闭页面后自然释放，不持久化整段媒体。

不要把视频特定状态错误提升为全局偏好。字幕轨道、音轨、字幕时间偏移和全屏状态应保持视频级生命周期。

## 构建资源

`packages/extension/public/libav`、`public/native-host` 以及 libass Worker/WASM 均由 `build:assets` 生成，不作为源码维护。字体及其许可证属于扩展离线运行所需的源码资产，应保留。
