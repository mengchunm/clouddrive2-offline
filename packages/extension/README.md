# CloudDrive2 Browser Extension

Chromium Manifest V3 扩展。它将 `packages/offline` 和 `packages/artplayer` 合并为一个内容脚本，并通过后台 service worker 访问 CloudDrive2、弹幕、视频和字幕资源。

## 构建和安装

```bash
pnpm install
pnpm --filter clouddrive2-browser-extension build
```

构建需要 Node.js 和 pnpm。构建脚本会把 PowerShell Host 嵌入随扩展分发的单个 CMD 文件。

libav、libass Worker/WASM 和 Native Host CMD 会在构建时从依赖或源码自动生成；`public` 中对应生成目录以及 `build` 都不应手工修改。

在 Chrome 或 Edge 中：

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 启用“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本目录下的 `build` 文件夹。
5. 点击扩展图标，再点击“CloudDrive2 设置”。配置会在独立设置页打开，不依赖当前网页是否允许注入内容脚本。

重新构建后，需要在扩展管理页点击一次“重新加载”，并刷新之前已经打开的网页。

`build` 是固定的开发版加载目录，不要改名或移动。`archive` 中的 ZIP 只用于备份和传输，Chrome 不能直接加载 ZIP；需要恢复时先完整解压，再选择包含 `manifest.json` 的目录。

> **固定身份要求：** 扩展 ID 必须为 `pafaiigiceklmpecemghfnpimjhlgmpd`。不要删除或更换 `public/manifest.json` 中的 `key`，也不要让旧 ID 与当前 ID 同时加载同一输出路径，否则 Chrome 重启时可能把该路径判定为无效。完整恢复方法见[故障排查](../../docs/troubleshooting.md#重启-chrome-或电脑后扩展消失)。

离线任务搜索覆盖全部任务分页，支持简体匹配繁体以及用空格分隔多个必须同时命中的关键词。
任务第一页会轻量预取；完整搜索索引仅在用户搜索时建立，并使用有上限、可失效的内存缓存。
搜索需要点击按钮或按 Enter 执行，建立索引时会显示页数、任务数和百分比进度。
缩略悬浮球和展开面板均可拖动并分别保存位置；位置通过扩展存储跨网站保存，并自动限制在可视区域内。
悬浮窗口的展开/收起状态仅在当前标签页会话内保存；刷新同一页面时保持刷新前的状态，新标签页、普通页面跳转、前进后退以及 CloudDrive2 定位打开的页面均默认折叠为悬浮球。位置和尺寸仍会跨页面保存。
任务列表会保存当前页码和该页的纵向滚动位置，刷新或重新展开窗口后继续从原位置浏览。
展开面板可从右边缘、上边缘和右上角缩放。任务表格不提供列分隔线：状态列固定为 90px、操作列固定为 180px 并贴在右侧，名称列占满剩余宽度。
任务列表使用弹性高度布局，窗口缩放时列表原生实时伸缩，分页固定在窗口内容区底部。
窗口宽度变化只改变名称列可显示的内容长度，窗口高度变化只改变可见任务数量；列宽不再经过 JavaScript 联动或持久化。
浏览器视口缩小时，面板会临时适配可视区域但不会覆盖用户设定尺寸；视口恢复后面板自动恢复到缩小前的宽高。

点击已完成任务的名称或名称前方折叠按钮，即可直接在任务列表内按层浏览任务目录，不再使用独立按钮和弹窗。任务主行可直接定位本地任务位置；展开区域显示格式分类与文件大小，视频、音频可交给当前播放器，普通文件可单独下载，并可在 CloudDrive2 或本地文件管理器中定位。

扩展清单内置固定公钥，以便不同电脑加载同一构建时保持扩展身份和存储键一致。

扩展不能在浏览器内部页面、Chrome Web Store 等受保护页面运行。

## 字幕实现

完整架构、关键兼容点和回归要求见 [`docs/browser-extension-subtitles.md`](../../docs/browser-extension-subtitles.md)。后续修改字幕实现时应先阅读该文档。

- 外挂 SRT/VTT/ASS/SSA 由后台读取，转换为 UTF-8 Blob 后交给 ArtPlayer，兼容 UTF-8 和 GB18030。
- ASS/SSA 使用随扩展分发的 libass worker、WASM 和 Noto Sans SC 字体，不依赖远程脚本。
- MKV ASS/SSA/SubRip/WebVTT 字幕由随扩展分发的 libav.js（FFmpeg WebAssembly）通过 HTTP Range 解封装，不需要安装 FFmpeg、Native Host 或注册表组件；MP4 的 tx3g/text 轨道转换为 VTT。
- MKV 首次只读取 Tracks 元数据，用户选择后由 libav.js 读取当前播放位置附近两分钟的 Cluster；播放接近缓存末尾或跳转进度时继续按段读取、合并并缓存字幕。
- SubRip 使用数据包时间戳直接组装为 WebVTT；当前分段没有对白时保留空轨并继续预读，不会回退扫描完整远程视频或误报加载失败。
- ASS/SSA 会等待内置 libass Worker 就绪；渲染器初始化失败或超时时自动降级为无样式 WebVTT，确保字幕仍可见。

CloudDrive2 或云盘返回的视频地址必须支持 Range 请求，MKV/MP4 内嵌字幕提取才能正常工作。

字幕解封装使用 LGPL-2.1 的 libav.js 6.9.8，项目源码位于 <https://github.com/Yahweasel/libav.js>。

## 维护文档

- [项目架构](../../docs/architecture.md)
- [Windows 本地目录功能](../../docs/native-messaging.md)
- [故障排查](../../docs/troubleshooting.md)
- [第三方组件说明](../../THIRD_PARTY_NOTICES.md)

## 播放器偏好

- 任务列表中的“网页播放”会在当前页面右下角打开 ArtPlayer 悬浮窗口，不再用遮罩覆盖整页；视频顶部标题和关闭按钮会随控制栏自动显示或隐藏，拖动标题可移动窗口，四角及上下左右边缘均可自由调整宽高，不再强制吸附到视频比例。位置和大小会自动保存，播放器内部仍可切换为全屏；窗口较小时会自动精简次要控制按钮，避免控制栏被裁切。视频加载期间会在加载图标下方显示实时加载速度，正常播放时不显示。播放器存在且焦点不在输入框时，可按空格切换播放和暂停。
- “弹幕热力图”指进度条上方的弹幕密度波形，默认关闭，可在扩展设置中开启。
- 悬浮播放器会按空间自动收纳控制项，空间恢复后自动重新显示。核心优先级为：播放/暂停、全屏、弹幕开关、字幕、弹幕匹配、弹幕设置；截图、画中画、网页全屏等次要按钮会更早隐藏。
- 弹幕透明度、显示区域、字号、速度、防重叠、同步倍速、显示类型、开关状态及发送样式会跨视频保存。
- 音量、静音、播放速度和画面比例也会跨视频保存。
- 刷新当前页面时，已打开的悬浮播放器会恢复同一视频、窗口位置和大小、画面比例、暂停/播放状态及刷新前的精确进度；新标签页和普通页面跳转不会自动恢复播放器。
- 视频元素继续使用 CloudDrive2 原始 Range 地址。视频默认可通过播放器内的“解码”菜单使用 WebCodecs 软件解码画面；该路径通过 Range Host 普通优先级读取 1 MiB 分块，由 Mediabunny 提供独立 64 MiB 内存缓存和网络预读，首帧确认后才隐藏原生 `<video>`，失败或跳转重建时自动恢复原生画面，也可切换为硬件或浏览器原生解码。不要把扩展包内的静态占位资源当作动态媒体代理；Manifest V3 后台无法可靠接管这类资源请求。
- Chrome 无法原生解码的 MKV AC-3/E-AC-3（包括 Dolby Digital Plus/Atmos）音轨由扩展内置的专用 FFmpeg WebAssembly 解码器按十秒分段解码，并通过 Web Audio 跟随视频的播放、暂停、跳转、倍速、音量和静音状态。音频与 libav 字幕通过非沙箱扩展 Range Host 共享 1 MiB 对齐分块、64 MiB 内存 LRU 和进行中的请求，二进制通过 MessageChannel 转移。该功能不需要本机 FFmpeg 或任何额外安装；其他浏览器原生支持的音轨不经过此兼容层。
- 字幕轨道、音轨、字幕时间偏移和全屏状态与具体视频相关，不作为全局偏好保存。

音频兼容层的 Manifest V3 沙箱约束和维护方法见[浏览器扩展音频兼容](../../docs/browser-extension-audio.md)。
