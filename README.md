# CloudDrive2 Extensions

这是一个包含 CloudDrive2 浏览器扩展脚本的 Monorepo 项目，旨在增强 [CloudDrive2](https://github.com/cloud-fs/CloudDrive2) 的网页端体验与离线下载功能。

## 📦 包含的项目 (Packages)

本项目目前包含以下两个核心用户脚本 (Userscript)：

### 1. [CloudDrive2 Offline](packages/offline)

> 基于 [sqzw-x/clouddrive2-offline](https://github.com/sqzw-x/clouddrive2-offline) 的增强 fork 版本。

一键将网页上检测到的磁力链接添加到 CloudDrive2 离线下载，支持在线播放和文件管理。

**✨ 特性**
- 📂 **文件定位** - 一键跳转 CloudDrive2 网页端定位文件
- ▶️ **在线播放** - 自动穿透文件夹找到最大视频文件直接播放
- ⬇️ **独立下载** - 规避 115 防盗链等限制，直接触发浏览器下载
- 🎨 **UI 优化** - 更加现代化的极简透明悬浮图标
- 🔗 **广域增强** - 不再局限于特定网站，通过正则广域检测全部磁力链接并发起批量离线

### ~~2. [CloudDrive2 Artplayer](packages/artplayer)~~申请api中，暂不维护

~~基于 [ArtPlayer](https://artplayer.org/) 的 CloudDrive2 增强型视频播放器脚本。~~

~~**✨ 特性**~~
- ~~📺 将 CloudDrive2 默认的简单播放器替换为功能强大的 ArtPlayer~~
- ~~💬 **弹幕集成** - 自动匹配并加载 [弹弹Play](https://www.dandanplay.com/) 的弹幕资源~~
- ~~⚙️ **多种控制** - 支持倍速、画质调节、截图等完备的播放器功能~~

---

## 🚀 安装指南

由于这两个项目都是 Userscript（用户脚本），你需要先在浏览器中安装一个脚本管理器，比如 [Tampermonkey](https://www.tampermonkey.net/)。

1. 安装好 Tampermonkey 后，前往本仓库的 **[Releases](https://github.com/mengchunm/clouddrive2-offline/releases/latest)** 页面。
2. 找到 `Assets` (资产) 下的对应脚本文件并点击安装：
   - 离线下载增强：[`clouddrive2-offline.user.js`](https://github.com/mengchunm/clouddrive2-offline/releases/latest/download/clouddrive2-offline.user.js)
   - 视频播放器增强：[`clouddrive2-artplayer.user.js`](https://github.com/mengchunm/clouddrive2-offline/releases/latest/download/clouddrive2-artplayer.user.js)

## 🔧 开发说明

本项目使用 `pnpm` 作为包管理器，并使用 `vite-plugin-monkey` 进行构建。

```bash
# 1. 安装项目的所有依赖
pnpm install

# 2. 启动对应包的本地开发调试模式 (Dev)
pnpm -r run dev
# 或分别进入 packages/offline 和 packages/artplayer 执行 pnpm dev

# 3. 编译打包 (Build)
pnpm run build
```

## 📝 致谢

- CloudDrive2 离线增强脚本原作者：[@sqzw-x](https://github.com/sqzw-x)
- [ArtPlayer](https://artplayer.org/)
- [弹弹Play](https://www.dandanplay.com/)
- [Vite](https://vitejs.dev/)
