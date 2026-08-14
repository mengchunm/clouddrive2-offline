# CLAUDE.md

This file provides repository guidance for Claude Code and other coding agents.

## 仓库概览

- pnpm workspace Monorepo，workspace 为 `packages/*`。
- 主要发布形态是 `packages/extension` 的 Chromium Manifest V3 扩展。
- `packages/offline` 和 `packages/artplayer` 是扩展共享的业务包，同时保留 userscript 兼容构建。
- 扩展当前版本以 `packages/extension/package.json` 和 `packages/extension/public/manifest.json` 为准，两处必须一致。

开始修改前先阅读 [`docs/README.md`](docs/README.md) 和对应专题文档。

## 常用命令

```bash
pnpm install
pnpm run ci
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run build:extension
```

专项测试：

```bash
pnpm --filter clouddrive2-artplayer run test:mkv-metadata
pnpm --filter clouddrive2-browser-extension run test:libav-mkv
# 仅 Windows
pnpm --filter clouddrive2-browser-extension run test:native-host
```

## 包职责

### `packages/extension`

- `src/content.ts`：合并并启动 offline/artplayer 内容脚本。
- `src/background.ts`：CloudDrive2、视频、字幕和弹幕请求代理，以及 Native Messaging 桥接。
- `src/compat`：GM API、libass、libav 和页面运行环境兼容层。
- `src/libav-host.ts` / `src/libav-worker.ts`：扩展源 Worker 宿主与远程媒体解封装。
- `public/options.*` / `public/popup.*`：扩展设置与入口。
- `native-host/host.ps1`：Windows 本地目录 Host 源码。

### `packages/offline`

- `src/userscript.tsx`：磁链扫描、按钮注入和主入口。
- `src/ui/components/OfflineTasksTab.tsx`：任务、文件解析、播放列表、下载和本地目录入口。
- `src/grpc/client.ts`：CloudDrive2 gRPC-Web API。
- `src/config.ts` / `src/memory.ts`：配置与存储。
- `src/proto`：生成代码，不要手工修改。

### `packages/artplayer`

- `src/main.ts`：播放器入口和跨模块事件。
- `src/player.ts`：播放器、字幕、弹幕、选集、偏好和进度。
- `src/danmu-api.ts`：弹弹Play直连和 danmu_api 请求。
- `src/utils/mkvMetadata.ts` / `mp4Parser.ts` / `assToVtt.ts`：字幕轨道和格式处理。

## 关键约束

### 扩展运行环境

- 网页内容脚本不能直接创建 `chrome-extension://` Worker。libav Worker 必须由扩展源 `libav-host.html` 创建；libass 使用 Blob Worker/WASM URL。
- 扩展重载后旧标签页会产生 `Extension context invalidated`，人工验证必须重开或刷新网页。
- 浏览器内部页和扩展商店不允许注入内容脚本，设置必须通过独立 options 页面打开。

### 字幕与弹幕

- 字幕和弹幕是两套独立流程，不要通过修改字幕解析解决弹幕问题。
- MKV ASS 数据包不是完整 `Dialogue:` 行，必须结合 PTS/duration 重组并插入 `[Events]`。
- libass 实际绘制非空字幕帧前不能隐藏 WebVTT 兜底；后续字幕窗口更新不能重置已绘制状态。
- 修改字幕链路前必须完整阅读 `docs/browser-extension-subtitles.md` 并运行所有字幕回归测试。
- 弹幕默认模式为直连，既有匹配规则未经明确要求不要改变。

### 偏好与存储

- 弹幕透明度、字号、区域等设置以及音量、倍速、画面比例属于全局播放器偏好。
- 字幕轨道、音轨、字幕偏移和全屏状态属于视频级状态，不应全局保存。
- 扩展使用 `chrome.storage.local` 兼容层；userscript 使用 GM storage。不要绕过兼容层直接合并存储实现。

### Native Messaging

- 本地目录功能必须保持可选，关闭时按钮隐藏且不影响其他能力。
- Host 只能打开已经存在的 Windows 绝对目录。
- 固定扩展 ID、Host 名称和注册表路径不可单独修改；变更前阅读 `docs/native-messaging.md`。

## 生成文件

- `dist/` 均为生成目录，不要直接编辑。
- `packages/extension/public/libav/`、`public/native-host/` 和 libass Worker/WASM 由 `build:assets` 生成。
- `packages/extension/public/libass/NotoSansSC-VF.ttf` 及字体许可证是需要保留的源码资产。
- 仓库只保留根目录 `pnpm-lock.yaml`；不要新增 npm lockfile 或包级 pnpm lockfile。

## 格式与提交前验证

- 使用 Biome，不使用 ESLint/Prettier。
- 保留用户工作区中与当前任务无关的修改。
- 至少运行 `pnpm run ci`、`pnpm run typecheck`、`pnpm run test` 和相关构建。
- 版本发布前同步扩展 package/manifest 版本、`CHANGELOG.md` 和对应发布说明。
