# 第三方组件说明

浏览器扩展会将以下第三方组件或其运行时文件打包到发布产物中。版本以 `pnpm-lock.yaml` 为准，升级依赖时应同步检查并更新本文件。

| 组件 | 当前版本 | 用途 | 许可证 |
| --- | --- | --- | --- |
| ArtPlayer | 5.3.0 | 浏览器视频播放器 | MIT |
| artplayer-plugin-danmuku | 5.2.0 | 弹幕渲染 | MIT |
| artplayer-plugin-libass | 1.0.0 | ASS/libass 播放器适配 | MIT |
| libass-wasm | 4.1.0 | ASS/SSA WebAssembly 渲染 | LGPL-2.1-or-later 及其声明的第三方许可证 |
| libav.js variant-default | 6.9.8 | 远程媒体容器解封装 | LGPL-2.1 |
| Mediabunny | 1.51.0 | 远程 MKV 音轨解析和分段音频解码管线 | MPL-2.0 |
| @mediabunny/ac3 | 1.51.0 | 浏览器内 AC-3/E-AC-3 WebAssembly 解码 | MPL-2.0；内嵌 FFmpeg 组件为 LGPL-2.1-or-later |
| MP4Box.js | 2.3.0 | MP4 字幕轨道解析 | BSD-3-Clause |
| opencc-js | 1.4.1 | 任务名称简繁体搜索归一化 | MIT AND Apache-2.0 |
| Noto Sans CJK / Source Han Sans | 随包字体 | 中文字幕回退字体 | SIL Open Font License 1.1 |

Noto Sans CJK 的字体版权说明随扩展位于 `libass/FONT-LICENSE.txt`。libass-wasm、libav.js 和 Mediabunny 的源码、完整许可证及构建信息分别见：

- <https://github.com/libass/JavascriptSubtitlesOctopus>
- <https://github.com/Yahweasel/libav.js>
- <https://github.com/Vanilagy/mediabunny>

本文件用于汇总分发内容，不替代各第三方项目随附的完整许可证文本。
