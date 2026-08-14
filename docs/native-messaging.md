# Windows 本地文件定位

本地助手用于把 CloudDrive2 挂载路径映射为 Windows 路径，并从任务主列表或展开后的文件行打开目录、选中具体文件。

路径映射以挂载点的 `isMounted` 状态和 `mountPoint` 为准，不要求 `localMount=true`。CloudDrive2 的普通 Windows 盘符挂载可能返回 `localMount=false`，例如 `Z: → /115open`，但该盘符仍可由 Windows 文件管理器正常访问。

## 安装与卸载

- 设置页的“下载脚本”会下载扩展包内置的 CMD 安装脚本。
- 用户运行脚本一次后，会在当前用户范围注册 Native Messaging Host，不需要管理员权限。
- “卸载脚本”会注销 Chrome/Edge 当前用户注册项。
- 扩展主功能不依赖本地助手；未安装时只隐藏本地定位按钮。

## 协议

- `ping`：检测助手版本，当前协议版本为 8。
- `openDirectory`：在 Windows 文件管理器中打开目录。
- `revealPath`：打开父目录并选中指定文件。
- `playPotPlayerPlaylist`：校验 HTTP(S) 串流条目，生成临时 DPL 并一次启动 PotPlayer 播放整个列表。
- `uninstall`：注销本地助手。

验证命令：

```bash
pnpm --filter clouddrive2-offline run test:local-mount
pnpm --filter clouddrive2-browser-extension run test:native-host
```
