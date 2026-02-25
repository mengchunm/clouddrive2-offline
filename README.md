# clouddrive2-offline

> 基于 [sqzw-x/clouddrive2-offline](https://github.com/sqzw-x/clouddrive2-offline) 的增强 fork 版本。
> 感谢原作者的开源贡献。

一键将网页上检测到的磁力链接添加到 CloudDrive2 离线下载，支持在线播放和文件管理。

## ✨ 增强特性

- 📂 **文件定位** - 一键跳转 CloudDrive2 网页端定位文件
- ▶️ **在线播放** - 自动穿透文件夹找到最大视频文件直接播放（调用 CloudDrive2 的本地代理流媒体地址）
- ⬇️ **独立下载** - 规避 115 防盗链等限制，直接触发浏览器下载
- 🎨 **UI 优化** - 更加现代化的极简透明悬浮图标，优化了大批量任务展示时的界面布局
- ⚙️ **配置融合** - 面板显隐控制与配置项统一整合入设置面板
- 🔗 **广域获取** - 不再局限于特定网站，通过正则广域适配全部包裹在 `a` 标签、 `input` 或 `data-*` 属性中的磁力链接，并可以实现批量选中离线

## 📦 安装

1. 安装油猴（Tampermonkey）或 ScriptCat 等脚本管理器插件
2. 点击安装本脚本：可以通过发布的 `dist/clouddrive2-offline.user.js` 地址直接安装
3. 在任意包含磁力链接的网页刷新，悬浮图标即会自动出现

## ⚙️ 配置

首次使用请在油猴菜单中找到 `CloudDrive2 配置`，设置您的：
- `地址`: 例如 `http://localhost:19798`
- `API Token`: 如有设置，在此输入
- `离线下载路径`: 保存文件的默认路径，例如 `/115open/离线下载`

## 🔧 开发构建

```bash
# 依赖安装
pnpm install

# 本地调试
pnpm dev

# 构建发布
pnpm build
```

## 📝 致谢

- 原项目作者：[@sqzw-x](https://github.com/sqzw-x)
- [Ant Design](https://ant.design/)
- [Vite](https://vitejs.dev/)
