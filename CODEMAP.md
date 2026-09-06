# 便利贴项目架构与代码地图

> 用途：新对话接到开发任务时，先用本文件定位最可能相关的文件和函数，再定向阅读源码。
> 维护规则：新增模块、移动职责或改变持久化格式时同步更新；函数内部的小改动无需更新。

## 1. 项目概览

这是一个仅面向 Windows 的 Electron 桌面便利贴应用。生产应用采用原生 HTML、CSS、JavaScript，没有前端框架和构建转译层。

```text
renderer/index.html + renderer/styles.css + renderer/renderer.js
                         │ window.electronAPI
                         ▼
                     preload.js
                         │ Electron IPC
                         ▼
                       main.js
       ┌─────────────────┼──────────────────┐
       ▼                 ▼                  ▼
本地文件 / safeStorage   DeepSeek / OCR     Harness 子进程
```

生产代码的核心特征：

- `renderer/renderer.js` 是渲染进程的单文件 UI 与状态中心。
- `main.js` 是 Electron 主进程的单文件业务与系统能力中心。
- `preload.js` 是唯一公开给页面的 IPC 桥；渲染层不能直接访问 Node.js。
- `atomic-write.js`、`window-bounds.js` 是从主进程抽出的纯工具模块。
- `harness/` 是生产应用中的 DeepSeek Harness 集成。
- `assistant-prototype/` 是独立的“小智桌面助手”实验项目，当前不属于生产应用启动链路。

## 2. 启动链路与运行边界

### 生产应用

```text
package.json (`main: main.js`)
  → main.js / app.whenReady()
  → 注册 note-image://、IPC、托盘、快捷键、提醒与 Harness
  → 用户唤出窗口时 createWindow()
  → renderer/index.html
  → preload.js 注入 window.electronAPI
  → renderer/renderer.js / init()
```

- 开发启动：`npm start`
- 打包：`npm run build`
- 打包配置：根目录 `package.json` 的 `build` 字段
- Windows 快捷启动：`启动便利贴.bat`
- Windows 重启：`重启便利贴.bat`

### 独立助手原型

`assistant-prototype/` 有自己的 `package.json`、依赖、Electron 入口和测试命令。只有需求明确提到“小智、语音助手、计划校验、动作执行器、沙盒宿主”时才进入该目录；普通便利贴需求不要读取它。

## 3. 顶层文件职责

| 文件或目录 | 职责 | 何时修改 |
|---|---|---|
| `main.js` | Electron 生命周期、窗口、托盘、快捷键、配置、任务/笔记文件、AI、OCR、提醒、IPC、Harness 接入 | 系统能力、文件存储、IPC、AI/OCR、安全校验 |
| `preload.js` | 将允许的 IPC 方法暴露为 `window.electronAPI` | 新增或改变渲染层与主进程通信 |
| `renderer/index.html` | 三个页面与设置遮罩的静态 DOM 骨架 | 新增控件、页面区域、设置项 |
| `renderer/renderer.js` | 全局前端状态、事件绑定、渲染、任务/日历/笔记/工具箱交互 | 几乎所有产品交互与前端逻辑 |
| `renderer/styles.css` | 全局变量、布局、组件状态、动画、三个页面样式 | 视觉、动效、响应状态、可访问性样式 |
| `atomic-write.js` | 同目录临时文件 + 刷盘 + 替换的原子写入 | 可靠写盘策略 |
| `window-bounds.js` | 将窗口位置限制在显示器工作区 | 多屏与窗口定位 |
| `harness/` | DeepSeek Harness 的配置、子进程桥、会话解析和网页版启动支持 | 工具箱 Harness 功能 |
| `tests/` | 生产应用的纯逻辑、DOM 仿真、回归和历史里程碑测试 | 修改对应行为时补充或运行测试 |
| `assets/` | 应用图标、OCR 语言包 | 图标或 OCR 资源 |
| `scripts/` | 打包清理、内存检查 | 构建或诊断流程 |
| `assistant-prototype/` | 独立助手原型，不被根应用导入 | 仅助手原型任务 |
| `PRODUCT.md` | 产品定位、设计原则和交互约束 | 判断 UI/UX 方向时先读 |
| `README_zh.md` / `README.md` | 用户向说明；部分版本信息可能滞后 | 发布、安装说明或功能清单变化 |

生成物和运行数据不是源码：`node_modules/`、`dist/`、`dist-new/`、`tmp/`、`notes/`、`.dsh-vision-toolkit/`。定位代码时默认跳过。

## 4. 渲染进程：页面与状态

### DOM 页面

`renderer/index.html` 中的 `.pages-container` 横向承载三个页面：

1. `.page-main`：任务列表、项目页签、日历、文本/图片输入、整理、日报。
2. `.page-notepad`：Markdown 笔记编辑器、文件列表、文件/内容搜索、设置入口。
3. `.page-tools`：翻译卡、视频下载卡与 DeepSeek Harness 卡；所有功能卡通过 `#tool-card-template` 与 `createToolCard()` 统一创建。

新增功能卡时不要手写 `.tool-card` 根节点，统一使用：

```js
const { card, body } = createToolCard('功能标识', '可选变体类名');
body.append(/* 功能卡内容 */);
toolsCards.appendChild(card);
```

全局覆盖层包括 `#settings-overlay` 和 `#processing-overlay`。无边框窗口拖动区域是 `#window-drag-handle`。

### 前端状态

`renderer/renderer.js` 顶部的 `state` 是唯一的渲染层状态对象，主要分组为：

- 任务：`tasks`、`activeSheet`、`projectNames`、输入图片和整理状态。
- 日历：当前月、选中日期、当日视图、历史任务缓存映射和周条状态。
- 笔记：文件列表、当前文件、原始/当前内容、置顶、搜索和图片缓存。
- 页面/设置：`currentPage`、快捷键、页面与工具启用开关。
- Harness：运行状态、会话、消息、待办、差异、耗时和 Token 统计。

`init()` 负责读取配置、恢复页面、加载数据并绑定全部 DOM/IPC 事件。新增交互入口通常需要同时检查 `index.html`、`init()` 和对应的渲染函数。

## 5. 主进程职责分区

`main.js` 已用区块注释划分职责，可用函数名直接搜索：

| 分区 | 关键函数或入口 |
|---|---|
| 配置 | `loadConfig`、`saveConfig`、`sanitizeHarnessSettings` |
| OCR | `initOCR`、`ocrImage`、空闲回收计时器 |
| DeepSeek | `callDeepSeek`、`organizeText`、`parseTaskJSON` |
| 翻译 | `detectLang`、`translateText` |
| 视频下载 | `runVideoDownload`、下载文件命名/路径校验、进度事件、Windows 通知 |
| 任务文件 | `loadTasksFromFile`、`saveTasksToFile` |
| 笔记文件 | `getNotesDir`、`safeJoin`、`listNotes`、`readNote`、`saveNote`、创建/重命名/删除/置顶 |
| AI 命名 | `aiNameNote` |
| 提醒 | `checkAlarms`、`showAlarmWindow`、`startAlarmTimer` |
| 安全校验 | `isTrustedSender`、任务/笔记/图片输入校验 |
| Harness | `emitHarnessEvent`、Harness 网页版函数、`HarnessManager` 调用 |
| IPC | `setupIPC` |
| 窗口 | `createWindow`、`showWindow`、`hideWindow`、`getWindowPosition` |
| 托盘/快捷键 | `createTray`、`registerToggleShortcut` |
| 生命周期 | `app.whenReady()`、退出前保存握手 |

主窗口启用 `contextIsolation`、禁用 `nodeIntegration`，并阻止外部导航和新窗口。涉及文件路径或 IPC 时必须保留 `isTrustedSender`、`safeJoin`、文件名和输入大小校验。

## 6. IPC 数据流

修改跨进程功能时按以下顺序检查：

```text
renderer/renderer.js 调用 window.electronAPI.xxx
  → preload.js 映射到 ipcRenderer.invoke/send/on
  → main.js / setupIPC() 中同名 ipcMain.handle/on
  → 文件、系统 API、DeepSeek、OCR 或 Harness
  → 返回 renderer 更新 state 并重新渲染
```

IPC 按功能分为：窗口事件、AI 整理、配置、自启动、任务文件、窗口位置、页面状态、笔记及图片、日报、翻译、视频下载、Harness。新增通道一般必须同时修改 `preload.js` 与 `main.js`；还需在主进程处理器中验证发送方和参数。

## 7. 关键业务调用链

### 任务录入与 AI 整理

```text
输入/粘贴 → handlePaste / organize
  → electronAPI.organizeRequest
  → main.js: organizeText
  → OCR（有图片）+ DeepSeek
  → renderer: addTasks / renderTasks
  → saveTasks
  → %APPDATA%/sticky-notes/tasks/YYYY-MM-DD.json
```

无 API Key 或请求失败时，渲染层 `fallbackOrganize` 提供本地按行拆分。

### 任务操作、排序与日期同步

- 列表 UI：`renderTasks`、`buildTaskRow`。
- 完成/编辑/删除：`toggleTask`、`enterEditMode`、`deleteTask`。
- 拖拽：`startDrag` → `onDragMove` → `onDragEnd` → `reassignSortOrders`。
- 时间/日期：`openTimePicker`、`openDatePicker`、`commitTaskDueDate`。
- 历史文件同步：`persistTask`、`syncTaskCopies`、`removeTaskFromFile`。
- 跨天迁移：主进程 `loadTasksFromFile` 扫描最近 14 天未完成任务并沿用稳定 `id`。

修改任务字段时必须检查：AI JSON 解析、`buildTaskRow`、排序、今日文件、历史同步、日历索引和相关测试。

### 项目与日历

- 项目页签：`renderSheetBar`、`activeSheet`、`projectNames`。
- 行内项目选择：`openProjectExpand`。
- 月历/周条/当日视图：`renderCalendar`、`renderWeekbar`、`enterDayMode`、`renderDayTasks`。
- 跨日期读取：`ensureTaskFilesLoaded`、`loadTasksForDate`、`buildDueDateIndex`。

日历不是独立数据源，它聚合 `tasks/YYYY-MM-DD.json` 并按任务稳定 `id` 同步副本。

### Markdown 笔记

```text
switchToNotepad / 文件列表选择
  → electronAPI.listNotes/readNote
  → loadMarkdown 显示到 contenteditable
  → onNotepadInput（300ms 防抖）
  → htmlToMarkdown
  → electronAPI.saveNote
  → main.js: safeJoin + atomicWriteFileSync
```

- 文件操作：`createNote`、`openNote`、`saveCurrentNoteNow`、`renderNoteList`、重命名、删除和置顶。
- 文本搜索：`doNoteSearch`；文件名/内容搜索在 `renderNoteList`。
- 图片：粘贴时 `saveNoteImage`，Markdown 保存相对路径，通过 `note-image://` 显示。
- 未命名笔记可在离开时调用 `aiNameNote`。

### 设置、窗口和快捷键

- 设置 UI：`openSettings`、`confirmSettings`、`cancelSettings`。
- 配置存储：`main.js` 使用 Electron `safeStorage` 加密整个 `config.enc`。
- 页面内快捷键：渲染层 `matchShortcut`。
- 唤出窗口的全局快捷键：主进程 `registerToggleShortcut`。
- 窗口显示/隐藏：主进程发送事件，渲染层完成动画和隐藏前保存。

### 工具箱翻译

`renderToolsPage` / 翻译卡事件 → `electronAPI.translateRequest` → `main.js: translateText` → DeepSeek；支持图片 OCR，并可自动反向翻译验证。

### 工具箱视频下载

```text
renderVideoDownloadCard
  → electronAPI.startVideoDownload
  → main.js: runVideoDownload（HTTP/HTTPS、重定向、.part 临时文件）
  → video-download:progress 实时更新卡片
  → 完成后启用资源管理器定位 + 成功/失败 Windows 通知
```

- 下载目录使用独立配置 `videoDownloadDir` / `videoDownloadDirHistory`，空目录表示 Windows 系统下载目录；最近历史最多 5 条。
- 同一时间只运行一个下载；应用重启后不恢复任务。文件名优先取响应头，其次取 URL，危险或未知扩展名改为视频扩展名，同名文件自动追加序号。
- 成功通知点击后在资源管理器中选中文件；失败通知点击后唤起应用并定位视频下载卡。

### DeepSeek Harness

```text
renderer Harness 卡
  → preload Harness IPC
  → main.js IPC
  → harness/manager.js: HarnessManager
  → 子进程 harness/bridge.mjs
  → harness/runtime.mjs + 外部 DeepSeek Harness SDK
  → session.jsonl
  → harness/session-store.js 解析回 UI
```

- `harness/manager.js`：配置校验、子进程生命周期、JSONL 请求/事件桥、会话列表入口。
- `harness/bridge.mjs`：把 SDK 流事件压缩成 UI 事件，执行/停止任务。
- `harness/runtime.mjs`：启动外部 Harness/Cordis 运行时。
- `harness/session-store.js`：解析会话、消息、Token、待办和文件差异；大日志采用头尾读取。
- `harness/sticky-harness.cordis.yml`：运行时插件和权限配置。
- `harness/migrate-sessions.mjs`：会话迁移工具。

## 8. 本地数据布局

Electron 的 `userDataPath` 在 Windows 通常对应 `%APPDATA%/sticky-notes/`：

```text
config.enc                  加密配置、API Key、页面开关、快捷键、Harness 配置
                            以及视频下载目录与最近 5 条目录历史
window-state.json           非固定窗口的位置
tasks/YYYY-MM-DD.json       每日任务数组
notes/*.md                  默认笔记文件（可在设置中改成自定义目录）
notes/pins.json             置顶文件名列表
notes/attachments/*         笔记图片
```

关键约束：

- JSON 和笔记保存优先走 `atomicWriteFileSync`，避免异常退出留下半文件。
- 笔记只允许存储目录根层的 `.md` 文件。
- 路径同时做词法与真实路径校验，防止 `..`、符号链接或 Junction 越界。
- 删除笔记优先发送到 Windows 回收站，失败时才直接删除。

## 9. 测试地图

根目录没有统一 `npm test` 脚本。`tests/` 中既有可直接用 Node 运行的回归脚本，也有历史里程碑脚本：

| 修改区域 | 优先检查的测试 |
|---|---|
| 原子写入 | `tests/test_atomic_write.js` |
| 窗口定位/多屏 | `tests/test_window_bounds.js` |
| 任务加载与跨天迁移 | `tests/test_load_tasks.js`、`tests/test_sort_order.js`、`tests/m3-test.js` |
| 排序与拖拽 | `tests/test_sort_order.js` |
| 日历/日期选择/当日视图 | `tests/test_calendar_logic.js`、`tests/test_date_picker_dom.js`、`tests/test_day_view_toggle_dom.js` |
| 时间选择 | `tests/test_time_picker_dom.js` |
| 笔记刷新/存储 | `tests/test_notepad_refresh_dom.js`、`tests/m7-note-storage.js` |
| 笔记目录历史 | `tests/m11-notesdir-history.js`、`tests/m11-notesdir-history-testcases.md` |
| Harness | `tests/test_harness_manager.js` |
| 卡片页模板与卡片 DOM | `tests/test_tool_card_template.js`、`tests/m14-tools-page.js` |
| 视频下载卡、IPC 与通知契约 | `tests/test_video_download_card.js` |
| 内存与长期运行 | `tests/m13-memory-check.js`、`scripts/mem-check.ps1` |
| OCR/AI/提醒/综合流程 | 对应的 `tests/m2-*` 至 `tests/m10-*` 历史回归脚本 |

`assistant-prototype/` 的测试完全独立，在该目录运行 `npm test`。

## 10. 按需求快速定位

| 用户需求 | 首读文件 | 按需继续读取 |
|---|---|---|
| 调整颜色、间距、动画、悬停或布局 | `renderer/styles.css` | `renderer/index.html`、相关渲染函数 |
| 新增按钮、设置项或页面区域 | `renderer/index.html`、`renderer/renderer.js:init` | `styles.css`；需持久化时读 `preload.js`、`main.js` |
| 修改任务展示、完成、编辑、删除、拖拽 | `renderer/renderer.js` 的任务区块 | `styles.css`、任务测试 |
| 修改任务字段或保存规则 | `renderer/renderer.js`、`main.js` 的任务存储 | `preload.js`、日历/同步逻辑、测试 |
| 修改 AI 整理或 OCR | `main.js` 的 OCR/DeepSeek/IPC 区块 | `renderer.js:organize`、`preload.js` |
| 修改项目页签或项目胶囊 | `renderer.js` 的项目区块 | `styles.css`、设置持久化 |
| 修改日历或截止日期 | `renderer.js` 的日期选择器和日历区块 | `main.js` 任务文件、日历 DOM 测试 |
| 修改提醒 | `renderer.js:openTimePicker`、`main.js` 提醒区块 | `preload.js`、提醒测试 |
| 修改笔记编辑/Markdown/搜索 | `renderer.js` 的 Markdown 与笔记区块 | `index.html`、`styles.css` |
| 修改笔记文件、图片、目录或置顶 | `main.js` 的笔记存储 | `preload.js`、`renderer.js`、存储测试 |
| 修改设置、快捷键、自启动 | `renderer.js` 设置区块、`main.js` 配置/快捷键 | `preload.js`、`index.html` |
| 修改窗口、托盘、失焦隐藏、多屏 | `main.js` 窗口/托盘区块 | `window-bounds.js`、`renderer.js:init` |
| 修改翻译工具 | `renderer.js` 工具箱翻译区块 | `main.js:translateText`、`preload.js` |
| 修改视频下载工具 | `renderer.js` 视频下载卡区块 | `main.js:runVideoDownload`、`preload.js`、视频下载测试 |
| 修改 Harness 工具 | `harness/`、`renderer.js` Harness 区块 | `main.js` Harness IPC、`preload.js` |
| 修改小智助手原型 | `assistant-prototype/README.md`、`DEVELOPMENT_GUIDE.md` | 对应 `src/` 分层；不要改生产主链路 |
| 修改打包、版本、安装器 | `package.json` | `scripts/clean-locales.js`、图标资源 |

## 11. 开始修改前的最小阅读策略

1. 从上表找到功能入口，只读对应源码区块，不通读 `main.js` 和 `renderer.js`。
2. 跨进程功能再沿 `renderer → preload → main` 搜索同一个 API/IPC 名称。
3. 修改共享函数前用 `rg` 搜索所有调用者；任务字段变化额外检查日历和历史文件同步。
4. UI 变更先读 `PRODUCT.md` 的设计原则，再检查 DOM、事件、样式三处是否一致。
5. 只运行与改动相关的最小测试；发布或大范围重构时再扩大验证范围。

## 12. 当前架构注意点

- `main.js` 和 `renderer/renderer.js` 都是大型单文件；当前功能按区块组织，不要仅为“看起来更架构化”就拆文件。
- README 中的技术版本或目录示例可能滞后，以 `package.json` 和实际源码为准。
- 生产 Harness 与 `assistant-prototype/` 不是同一套实现，名称相近但不要互相套用。
- 新增 IPC、文件读写和图片处理时，安全边界与大小限制属于必要逻辑，不能为缩小改动而绕过。
