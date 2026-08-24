# 代码优化审查报告

> 供后续 AI 进行重构优化时使用。
>
> 审查范围：当前仓库 `main` 分支，初始基线提交 `c4eb789`。
> 审查方式：只读检查源码、构建配置、CI、测试和构建产物；后续实施状态见下表。

## 一、总体结论

项目核心播放链路的复杂度大部分是合理且必要的，尤其是：

- MV3 页面无法直接创建扩展源 Worker，因此需要扩展源 Host 页面。
- 音频宿主必须使用 sandbox 经典 IIFE。
- libav Worker 必须由扩展源页面创建。
- Range Host 需要同时处理 1 MiB 分块、64 MiB LRU、请求合并、四路并发和 `audio > subtitle > normal` 优先级。
- 音频、字幕、弹幕是相互独立的业务流程，不能通过修改字幕流程解决弹幕问题。

因此，不建议为了“减少文件数量”而合并音频、字幕、libav 和 Range 的协议实现。

当前最值得优化的部分是：

1. 离线任务面板的重复目录扫描和重复媒体解析。
2. 播放器弹幕匹配流程的重复代码。
3. 扩展桥接层的重复 iframe、端口和事件监听模板。
4. 页面启动时加载过多重型模块。
5. 存储和网络缓存的生命周期与写入成本。
6. 配置、媒体扩展名和播放 URL 的多处重复定义。

---

## 二、优先级总览

| 优先级 | 位置 | 问题 | 建议 | 状态 |
| --- | --- | --- | --- | --- |
| P0 | `.github/workflows/release.yml:49`、根 `package.json` | Release workflow 调用了不存在的 `validate:release` 脚本 | 补充脚本映射或直接调用脚本，并验证发布流程 | 已完成 |
| P1 | `packages/offline/src/ui/components/OfflineTasksTab.tsx` | 目标文件、播放列表和字幕解析重复扫描目录 | 抽取统一的媒体上下文解析器与目录缓存 | 部分完成：已增加目录缓存并统一媒体分类，尚未抽取完整媒体上下文 |
| P1 | `packages/extension/src/compat/*` | 音频、字幕和 Range Host 重复实现桥接模板 | 抽取通用 Host/Port 生命周期工具，协议保持独立 | 暂未处理 |
| P1 | `packages/artplayer/src/player.ts` | 直连与备用弹幕流程大段重复 | 抽取弹幕源策略和通用匹配执行器 | 暂未处理 |
| P1 | Extension content 启动流程 | 所有网页都加载完整 Offline、ArtPlayer、Ant Design 和播放器依赖 | 延迟挂载 UI、延迟加载播放器及 libass | 暂未处理 |
| P1 | `packages/offline/src/grpc/client.ts` | 每次请求都重新创建普通 CloudDrive Client | 按配置作用域缓存 Client 和 interceptor | 已完成 |
| P2 | `packages/artplayer/src/memory.ts` | 每次进度保存都读写整个历史对象 | 使用内存缓存、合并写入或按键存储 | 暂未处理 |
| P2 | 配置和媒体分类 | `localStorage`、GM/chrome storage 和多套扩展名列表并存 | 统一存储适配器和媒体分类来源 | 部分完成：任务面板已改用偏好存储适配器 |
| P2 | 多处 UI/工具函数 | 格式化、渲染、提交通知等重复 | 抽取纯函数或通用组件 | 部分完成：格式化、字幕 URL 和无效面板缓存已整理 |
| P2 | 测试和文档 | 部分测试未纳入根测试命令，文档索引缺版本 | 补充测试入口和发布文档索引 | 已完成 |

---

> 本次优化遵循“不改变现有功能”的约束，仅处理发布校验、缓存、重复转换、存储读取和静态检查等低风险项；音频、字幕、弹幕和 Range 协议未做结构性改动。

## 三、详细发现与建议

### 3.1 Release workflow 缺少脚本（P0）

**状态：已完成。** 根目录已补充 `validate:release`，并兼容 pnpm 传入的 `--` 参数。

`.github/workflows/release.yml:49` 执行：

```bash
pnpm run validate:release -- "${{ env.RELEASE_TAG }}"
```

此前根目录 `package.json` 没有 `validate:release` script，现已补充，并保留直接执行脚本的兼容性。

当前验证：

```bash
pnpm run validate:release -- v1.6.42
# Release metadata is consistent for v1.6.42.
```

---

### 3.2 OfflineTasksTab 重复目录扫描（P1）

**状态：部分完成。** `packages/offline/src/grpc/client.ts` 已增加按服务端配置和路径区分的短期目录缓存、并发请求合并、强制刷新和变更后的缓存失效；目标文件、播放列表和 UI 文件分类也已改用 `mediaCatalog.ts`。完整的 `resolveMediaContext()` 尚未抽取。

文件：

```text
packages/offline/src/ui/components/OfflineTasksTab.tsx
```

主要问题：

- `resolveTargetFile()` 会解析任务根目录并递归查找目标文件。
- `resolvePlaylist()` 随后再次解析任务根目录并递归扫描播放列表。
- `playFile()` 通常会先调用目标文件解析，再调用播放列表解析。
- `resolveSubtitles()` 仍会查询视频所在目录并为每个字幕文件获取 URL。
- 目标文件和播放列表仍可能重复解析根目录或遍历目录，但底层目录 RPC 现在会复用短期缓存。

完整媒体上下文尚未统一，因此同一个任务在播放时仍可能执行多轮目录遍历；缓存已减少其中的重复 CloudDrive RPC，尤其是 BDMV 或深层目录结构。

建议：

1. 抽取统一的 `resolveMediaContext()` 或类似对象，一次返回：
   - 任务根目录
   - 目标视频文件
   - 播放列表
   - 外挂字幕文件
   - 需要的目录元数据
2. **已完成：** 以服务端配置和路径为 key 增加短生命周期的目录列表缓存。
3. 保留当前 BDMV、深度限制、最大扫描数量和文件优先级规则。
4. 不要简单把所有目录扫描改成无限递归，也不要取消现有上限。

相关逻辑大致位于 `OfflineTasksTab.tsx:2020-2367`。

#### 已发现的分类不一致

初审时 `resolveTargetFile()` 内部维护了局部媒体列表，并遗漏统一集合中的 `webm`。现已让目标文件、播放列表、文件分类和 UI 展示复用 `mediaCatalog.ts` 的来源，并修复 `webm` 识别遗漏。

---

### 3.3 播放/下载 URL 逻辑重复（P1/P2）

**状态：已完成。** 播放、下载和字幕流程已复用 URL 规范化与字幕 URL 解析逻辑。

`OfflineTasksTab.tsx` 中播放流程和下载流程分别构造 CloudDrive URL，存在重复的：

- 文件路径拼接
- `getDownloadUrlPath()` 调用
- `fileName` 推导
- URL 规范化

同时，播放流程中的字幕 URL 解析也在多个位置重复。

初审建议抽取纯数据转换函数；本次已在 `OfflineTasksTab.tsx` 内复用 URL 规范化和 `resolveSubtitleUrls()`，没有扩大跨包 API 范围，以避免改变 userscript/extension 的运行边界。

---

### 3.4 弹幕匹配流程重复（P1）

**状态：暂未处理。** 弹幕仍保持现有 `direct/api/auto` 流程，避免在没有完整回归测试时改变回退顺序。

文件：

```text
packages/artplayer/src/player.ts:2993-3247
packages/artplayer/src/danmu-api.ts:343-368
```

直连弹弹 Play 和备用 API 的流程都包含：

1. 文件名匹配。
2. 无匹配时提取关键词。
3. 搜索番剧/集数。
4. 选择最佳匹配。
5. 获取评论。
6. 转换 ArtPlayer 弹幕格式。
7. 错误处理和 UI 状态更新。

建议定义统一的弹幕源接口，例如：

```text
type DanmuSource = {
  match(fileName): Promise<...>;
  search(keyword): Promise<...>;
  fetchComments(episodeId): Promise<...>;
};
```

然后由一个通用流程执行器负责重试、选集、状态更新和结果转换。必须保留当前 `direct/api/auto` 模式及其回退顺序。

另外，`danmu-api.ts:343` 的 `loadDanmaku()` 当前没有生产调用点，属于候选死代码；删除前应确认没有外部 userscript API 依赖。

---

### 3.5 Extension Host 桥接代码重复（P1）

**状态：暂未处理。** 音频、字幕和 Range Host 的协议及生命周期保持原样。

涉及文件：

```text
packages/extension/src/compat/audio-fallback.ts
packages/extension/src/compat/libav-subtitles.ts
packages/extension/src/compat/media-range.ts
```

重复模式包括：

- 创建 web-accessible iframe。
- 等待宿主 ready/port。
- 设置超时。
- 监听 `window` 自定义事件。
- 按 requestId 匹配响应。
- 清理监听器和 pending 请求。
- 失败后重置 Host Promise。

建议抽取通用的 Host 生命周期辅助函数，例如：

```text
createExtensionHostPort(options)
requestWindowBridge(options)
withHostTimeout(promise, timeout)
```

注意：

- 音频、字幕、Range 的消息类型和生命周期仍应独立。
- 不能把音频 sandbox 宿主改成普通 Worker。
- 不能让网页内容脚本直接创建 `chrome-extension://` Worker。
- 不能移除 Range 请求优先级、请求合并或四路并发。

---

### 3.6 CloudDrive Client 可以缓存（P1）

**状态：已完成。** 普通 Client 已按 `grpcBaseUrl + apiToken` 缓存；流式 Push Client 仍独立创建，以保留重连和 Abort 生命周期。

文件：

```text
packages/offline/src/grpc/client.ts:45-63
```

缓存前普通 Client 每次调用都会重新创建 transport、认证 interceptor 和 Client 实例；现已按如下作用域缓存：

```text
grpcBaseUrl + apiToken
```

配置变化时使缓存失效。流式 Push Client 应继续单独管理，因为它有重连和 Abort 生命周期。

---

### 3.7 Content Script 启动成本偏高（P1）

**状态：暂未处理。** 当前扩展 content script 匹配范围和启动加载策略保持不变。

当前扩展 content script 匹配所有网页，并在启动阶段加载完整 Offline、ArtPlayer、React、Ant Design 和播放器依赖。

近期构建产物大小：

| 文件 | 大小 |
| --- | ---: |
| `packages/extension/build/content.js` | 约 1.90 MB |
| `packages/extension/build/audio-host.js` | 约 1.29 MB |
| `packages/extension/build/libav-worker.js` | 约 4.64 MB |
| Offline userscript | 约 1.39 MB |
| ArtPlayer userscript | 约 519 KB |

建议优先考虑：

1. 轻量磁链扫描器先启动，检测到磁链后再挂载完整 UI。
2. 播放器相关模块延迟到收到播放事件时加载。
3. `libass-plugin.ts:240` 当前在创建插件时立即执行 `init()`，可评估改为首次 ASS 字幕使用时初始化。
4. `preloadExtensionStorage()` 当前使用 `chrome.storage.local.get(null)`，可改为读取明确的键集合。

`libav-worker.js` 中的 WASM 体积是媒体能力的必要成本，不建议为了减小文件而重新引入外部 WASM URL 或 `libav/*` 重复资源。

---

### 3.8 MemoryStore 全量读写（P2）

**状态：暂未处理。** 由于跨 userscript/extension 存储兼容和多实例并发语义，暂不引入可能丢失记录的内存快照或延迟写入。

文件：

```text
packages/artplayer/src/memory.ts:50-83
```

`MemoryStore.set()` 每次都读取和写入整个历史对象。播放器进度大约每 10 秒保存一次，记录数增多后会产生较多序列化和存储开销。

可选方案：

- 在实例中保留内存快照，按需刷新。
- 对短时间内的多次写入做 debounce/batch。
- 使用单条记录 key，而不是一个大对象。
- 保留现有最大记录数和跨 userscript/extension 的存储兼容性。

不要绕过现有 GM/chrome storage 兼容层。

---

### 3.9 配置存储来源不统一（P1/P2）

**状态：部分完成。** 任务面板已通过 `getPreferredPlayer()` / `setPreferredPlayer()` 使用现有 GM/chrome storage 兼容层；options 独立页面继续直接使用 `chrome.storage.local`，旧版 `localStorage` 仅保留迁移逻辑。

初审时任务面板直接访问页面 `localStorage`，会造成扩展设置页写入的默认播放器与任务面板读取的默认播放器不一致。现已移除任务面板中的直接读写，改用 `getPreferredPlayer()` / `setPreferredPlayer()`；`options.js` 的独立扩展页面和 `config.ts` 的兼容层仍分别使用各自适配入口。

建议统一使用：

```text
getPreferredPlayer()
setPreferredPlayer()
```

并让 userscript 与 extension 通过各自的兼容层实现相同语义。

---

### 3.10 UI 小型优化

**状态：部分完成。** 已移除无效的 FloatingPanel `useMemo`、合并文件大小格式化，并复用字幕 URL 解析；字幕 URL 的有限并发、runtime API 检测和其他渲染函数仍未调整。

#### FloatingPanel

初审时 `items = useMemo(..., [addOfflineNode])` 的依赖每次渲染都会变化，现已移除这层无效 memo，保留原有 UI 结构。

#### 无限并发字幕 URL 请求

字幕解析处使用 `Promise.all` 同时解析全部字幕 URL。目录中字幕较多时可能对 CloudDrive 产生瞬时请求压力。

可以使用有限并发，或将 URL 解析延迟到用户实际选择字幕时。

#### 其他可抽取函数

- `formatFileBytes()` 与另一个按 MB 格式化的 `formatBytes()`（已合并）。
- 播放、下载、设置页面重复的通知处理。
- 多个页面重复的 extension runtime API 检测。
- `renderMatches()` 与 `renderAnimes()`。

---

## 四、可清理的死代码

**状态：暂未清理。** 这些代码删除前仍需检查 userscript 外部 API 依赖：

```text
packages/artplayer/src/danmu-api.ts:343
  loadDanmaku()

packages/artplayer/src/player.ts:2376
  _injectAssFonts()

packages/offline/src/userscript.tsx:42
  safeSetInnerHTML()
```

`safeSetInnerHTML()` 当前只在入口处通过 `void safeSetInnerHTML` 引用，没有实际执行。

---

## 五、注释、测试和文档问题

### 注释不一致

**仍待处理：** `packages/extension/src/compat/media-range.ts` 的注释提到 4 MiB chunk，但 `range-host.ts` 实际使用 1 MiB 分块。只需修正注释，不改变实际分块策略。当前架构和媒体管线文档已经使用 1 MiB 表述；`docs/releases/1.6.30.md` 中的 4 MiB 属于历史版本说明，除非确认历史记录错误，否则不应改写。

### Biome 警告

**状态：已完成。** `player.ts` 已使用统一的 DOM 查询断言辅助函数，`pnpm run ci` 当前无相关警告。

### 测试入口不完整

**状态：已完成。** 根目录 `pnpm run test` 现已覆盖：

- `packages/artplayer` 的 `test:player-utils`
- `packages/offline` 的 `test:core`
- 原有离线、字幕、libav 和音频回归测试

Native Host 测试仍通过 Windows 专项命令执行，未并入跨平台根测试。

### 文档索引

**状态：已完成。** `docs/README.md` 已补充 `docs/releases/1.6.42.md`。

---

## 六、实施状态与后续建议

### 本次已完成

1. 修复 `validate:release` 缺失脚本及 pnpm 参数兼容问题。
2. 为普通 CloudDrive Client 和目录列表增加按配置作用域的短期缓存，并在任务变更后失效。
3. 统一媒体分类来源，修复目标文件解析遗漏 `webm` 的问题。
4. 合并播放、下载和字幕 URL 转换逻辑。
5. 统一任务面板的默认播放器偏好存储，合并文件大小格式化逻辑。
6. 修复 FloatingPanel 的无效 memo，并清理播放器 DOM 查询的 Biome 警告。
7. 补充根测试入口和文档索引。

### 后续可选

1. 抽取 `resolveMediaContext()`，进一步减少目标文件、播放列表和字幕扫描之间的重复；必须保留 BDMV、深度和数量上限。
2. 抽取弹幕源策略和 Extension Host 通用生命周期；这两项需要完整回归测试，暂不建议在没有测试覆盖时直接实施。
3. 评估 content script 懒加载、MemoryStore 写入优化和字幕 URL 有限并发；不得破坏 userscript/extension 存储兼容性。
4. 确认死代码没有外部 userscript API 依赖后再删除。
5. 修正 `media-range.ts` 中关于 4 MiB 的过时注释。

后续每项仍应独立修改和验证，便于回滚。

---

## 七、后续 AI 必须遵守的行为约束

- 不改变扩展和 userscript 双构建兼容性。
- 不改变 `audio > subtitle > normal` 优先级。
- 不改变 1 MiB Range 分块、64 MiB LRU、请求合并、四路并发。
- 不重新引入 `media-cache-stream.bin` 或其他占位媒体地址。
- 音频宿主继续使用 sandbox 经典 IIFE。
- libav Worker 继续由扩展源 Host 页面创建。
- 字幕和弹幕保持独立流程。
- 不手工修改 `packages/offline/src/proto` 生成代码。
- 不直接编辑 `dist/` 或构建生成资产。
- 不绕过 GM/chrome storage 兼容层。
- 修改字幕、音频或媒体 Range 链路时，必须阅读对应专题文档并运行全部相关回归测试。
- 保留用户工作区中与当前任务无关的修改。

## 八、本次优化后的验证记录

本次修改后已执行并通过：

```text
pnpm run ci
pnpm run typecheck
pnpm run test
pnpm run validate:release -- v1.6.42
pnpm run build:extension
pnpm --filter clouddrive2-artplayer run build
pnpm --filter clouddrive2-offline run build
```

`pnpm run test` 已包含 `test:player-utils` 和 `test:core`，相关字幕、libav 和音频回归也通过。Native Host 代码未修改，专项测试继续按 Windows 命令单独执行。

`pnpm run ci` 当前无此前报告中的 Biome 警告。
