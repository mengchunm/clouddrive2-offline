# 故障排查

## 重启 Chrome 或电脑后扩展消失

本项目的 Chromium 扩展清单包含固定公钥，正常安装 ID 必须始终为 `pafaiigiceklmpecemghfnpimjhlgmpd`。修改业务代码、重新构建或更新版本号不会改变 ID；只有删除、更换清单中的 `key`，或者加载了不含该公钥的旧构建，才会生成不同 ID。

曾出现过两个不同 ID 的“已解压扩展”记录同时指向同一个输出目录。Chrome 启动时会重新读取清单并计算 ID；旧记录的 ID 与当前清单不一致时，该目录可能被判定为无效，进而让正确的扩展也无法加载。为避免再次发生：

1. 始终通过 `pnpm --filter clouddrive2-browser-extension build` 构建，并且只从 `packages/extension/build` 加载扩展。
2. 不要删除或修改 `packages/extension/public/manifest.json` 中的 `key`。
3. 不要把 `dist`、临时测试副本、源码目录或 ZIP 归档加载到 Chrome；`packages/extension/archive` 仅用于备份。
4. 如需更换加载目录，先在扩展管理页删除旧目录对应的扩展记录，再加载新目录。不要让多个不同 ID 同时指向同一路径。
5. 加载后核对扩展 ID。若不是 `pafaiigiceklmpecemghfnpimjhlgmpd`，立即删除该记录并检查所加载目录的 `manifest.json`。

恢复流程：在扩展管理页删除所有旧 ID 或旧路径对应的条目，确认旧输出目录不再使用，重新构建，然后仅加载 `packages/extension/build` 并重启 Chrome 验证。卸载后 Chrome 的 `Secure Preferences` 中可能保留一个没有路径和属性的空记录，这是正常的卸载痕迹，不会参与加载；不要手工编辑 `Secure Preferences`。

## 扩展无法在当前页面运行

浏览器内部页面、扩展商店和部分受保护页面禁止内容脚本注入。通过扩展图标打开独立设置页；功能测试应切换到普通 HTTP/HTTPS 网页。

## `Extension context invalidated`

扩展重新加载后，旧标签页仍保留已经失效的内容脚本。关闭并重新打开旧标签页，或完整刷新页面。仅在扩展管理页点击“重新加载”不够。

## 无法连接 CloudDrive2

- 默认地址是 `http://localhost:19798`。
- 如果 CloudDrive2 运行在另一台电脑，`localhost` 指向浏览器所在电脑，必须填写可访问的局域网地址。
- 检查 API Token、离线下载路径以及 CloudDrive2 的监听和防火墙设置。

## 字幕轨道存在但画面没有字幕

先确认视频地址支持 HTTP Range。控制台不应出现跨源 Worker 错误或 `ASS 中没有 Dialogue 字幕内容`。字幕实现的必需资源和回归步骤见 [浏览器扩展字幕实现](browser-extension-subtitles.md)。

重新构建后必须重新加载扩展并重开测试网页，避免旧 Worker 或旧内容脚本继续运行。

## 弹幕匹配成功但为 0 条

字幕和弹幕是独立能力。默认弹幕模式为直连；应检查弹弹Play响应和匹配结果，不要通过修改字幕解析来修复弹幕问题。
