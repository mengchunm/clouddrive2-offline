# CloudDrive2 Extensions

这是一个 CloudDrive2 浏览器扩展 Monorepo，旨在增强 [CloudDrive2](https://github.com/cloud-fs/CloudDrive2) 的网页端体验、离线下载和视频播放能力。当前主发布形态为 Chromium Manifest V3 扩展，原 Tampermonkey userscript 构建继续保留用于过渡。

## 📦 包含的项目 (Packages)

本项目包含一个浏览器扩展以及两个兼容 userscript：

### 1. [CloudDrive2 Browser Extension](packages/extension)

将离线任务面板与 ArtPlayer 合并到同一个扩展中，支持：

- 自动检测页面磁力链接并提交到 CloudDrive2
- 离线任务、简繁体多关键词搜索、任务内文件浏览、文件定位、播放与下载管理
- ArtPlayer、弹幕、外挂字幕和 MKV/MP4 内嵌字幕
- 扩展后台跨域访问 CloudDrive2、视频和字幕资源
- 本地打包的 libass worker/WASM，支持 ASS/SSA 字幕

浏览器扩展的远程 MKV/ASS 字幕实现和维护约束记录在 [`docs/browser-extension-subtitles.md`](docs/browser-extension-subtitles.md)。

### 2. [CloudDrive2 Offline Userscript](packages/offline)

> 基于 [sqzw-x/clouddrive2-offline](https://github.com/sqzw-x/clouddrive2-offline) 的增强 fork 版本。

一键将网页上检测到的磁力链接添加到 CloudDrive2 离线下载，支持在线播放和文件管理。

**✨ 特性**
- 📂 **文件定位** - 一键跳转 CloudDrive2 网页端定位文件
- ▶️ **在线播放** - 自动穿透文件夹找到最大视频文件直接播放
- ⬇️ **独立下载** - 规避 115 防盗链等限制，直接触发浏览器下载
- 🎨 **UI 优化** - 更加现代化的极简透明悬浮图标
- 🔗 **广域增强** - 不再局限于特定网站，通过正则广域检测全部磁力链接并发起批量离线

### 3. [CloudDrive2 Artplayer Userscript](packages/artplayer)

基于 [ArtPlayer](https://artplayer.org/) 的 CloudDrive2 增强型视频播放器脚本。

**✨ 特性**
- 📺 将 CloudDrive2 默认的简单播放器替换为功能强大的 ArtPlayer
- 💬 **弹幕集成** - 自动匹配并加载 [弹弹Play](https://www.dandanplay.com/) 的弹幕资源
- ⚙️ **多种控制** - 支持倍速、画质调节、截图等完备的播放器功能

---

## 🚀 安装指南

### 浏览器扩展（推荐）

```bash
pnpm install
pnpm run build:extension
```

打开 Chrome/Edge 的扩展管理页，启用“开发者模式”，选择“加载已解压的扩展程序”，然后选中 `packages/extension/build`。

该目录是唯一正式加载目录，扩展 ID 应固定为 `pafaiigiceklmpecemghfnpimjhlgmpd`。不要加载旧 `dist`、临时副本或 ZIP，也不要修改清单公钥；更换目录前应先删除旧扩展记录。详见[重启后扩展消失的排查说明](docs/troubleshooting.md#重启-chrome-或电脑后扩展消失)。

首次使用时点击扩展图标，进入独立的“CloudDrive2 设置”页面，填写服务地址、API Token 和离线下载路径。扩展后台负责跨域请求；如果 CloudDrive2 在其他设备上，请使用浏览器所在设备能访问的局域网地址，不能使用远端设备的 `localhost`。重新构建扩展后，需要在扩展管理页点击“重新加载”并刷新旧网页。

若要从任务主列表或展开后的文件列表直接打开本地目录、选中文件，可在设置页下载并运行扩展内置的本地文件定位脚本。不安装 EXE、服务或驱动，也不要求管理员权限。

### Userscript（兼容方式）

需要先安装 [Tampermonkey](https://www.tampermonkey.net/)，然后从 Releases 安装对应脚本。

1. 安装好 Tampermonkey 后，前往本仓库的 **[Releases](https://github.com/mengchunm/clouddrive2-offline/releases/latest)** 页面。
2. 找到 `Assets` (资产) 下的对应脚本文件并点击安装：
   - 离线下载增强：[`clouddrive2-offline.user.js`](https://github.com/mengchunm/clouddrive2-offline/releases/latest/download/clouddrive2-offline.user.js)
   - 视频播放器增强：[`clouddrive2-artplayer.user.js`](https://github.com/mengchunm/clouddrive2-offline/releases/latest/download/clouddrive2-artplayer.user.js)

## 🔧 开发说明

本项目使用 `pnpm` workspace 和 Vite 构建；兼容 userscript 使用 `vite-plugin-monkey`。

```bash
# 1. 安装项目的所有依赖
pnpm install

# 2. 启动对应包的本地开发调试模式 (Dev)
pnpm -r run dev
# 或分别进入 packages/offline 和 packages/artplayer 执行 pnpm dev

# 3. 编译打包 (Build)
pnpm run build

# 仅构建浏览器扩展
pnpm run build:extension

# TypeScript 检查
pnpm run typecheck

# 字幕与媒体解析回归测试
pnpm run test
```

扩展构建会从已安装依赖自动生成 libav、libass Worker/WASM 和 Native Host CMD 资源。不要直接修改 `packages/extension/build` 或这些生成文件。

## 📚 项目文档

- [文档索引](docs/README.md)
- [项目架构](docs/architecture.md)
- [浏览器扩展字幕实现](docs/browser-extension-subtitles.md)
- [Windows 本地目录功能](docs/native-messaging.md)
- [故障排查](docs/troubleshooting.md)
- [变更记录](CHANGELOG.md)
- [第三方组件说明](THIRD_PARTY_NOTICES.md)

## 📝 致谢

- CloudDrive2 离线增强脚本原作者：[@sqzw-x](https://github.com/sqzw-x)
- [ArtPlayer](https://artplayer.org/)
- [弹弹Play](https://www.dandanplay.com/)
- [Vite](https://vitejs.dev/)
