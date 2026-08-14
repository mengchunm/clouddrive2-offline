# Userscript 兼容版本

浏览器扩展是当前主要发布形态。以下 userscript 继续构建，用于已有 Tampermonkey/ScriptCat 用户和兼容性回退：

- `packages/offline` → `clouddrive2-offline.user.js`
- `packages/artplayer` → `clouddrive2-artplayer.user.js`

userscript 不具备 MV3 后台代理、扩展源 Worker 和 Native Messaging 等完整能力。远程内嵌字幕、本地目录和跨域稳定性以浏览器扩展为准。

维护共享业务代码时仍需保证 userscript 可以完成类型检查和构建，但新功能应优先按浏览器扩展架构设计。
