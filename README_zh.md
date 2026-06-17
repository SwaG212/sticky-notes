# 便利贴 (Sticky Notes)

Windows 桌面便利贴应用 — 随手记录，AI 整理成任务清单，勾选执行，还有内置记事本支持多文件笔记。

![平台](https://img.shields.io/badge/platform-Windows-blue)
![Electron](https://img.shields.io/badge/electron-33.x-47848f)
![许可证](https://img.shields.io/badge/license-MIT-green)

## 功能

### 便利贴页面
- **随手记** — 输入文字或粘贴截图（Ctrl+V），AI 自动整理成结构化任务清单
- **图片 OCR** — 内置 Tesseract.js OCR，先识别粘贴图片中的中文文字，再交给 AI 整理
- **AI 整理** — 调用 DeepSeek API，将原始输入转化为带分类的 JSON 任务清单
- **定时提醒** — 为任务设置闹钟时间，到点弹窗提醒
- **勾选执行** — 点击完成任务，已完成任务自动移至底部，带 FLIP 动画效果
- **离线备用** — 无网络时按行拆分文字为独立任务

### 记事本页面
- **多文件笔记** — 创建、重命名、删除纯文本笔记文件
- **AI 自动命名** — 根据笔记内容，AI 自动建议文件名
- **置顶** — 将重要笔记置顶到文件列表上方
- **搜索** — 按文件名模糊过滤
- **自动保存** — 每次输入 300ms 防抖自动保存，关闭时对未命名笔记自动 AI 命名
- **自定义存储目录** — 可配置笔记存放位置（默认 `%APPDATA%/sticky-notes/notes/`）

### 通用功能
- **系统托盘** — 常驻托盘，右键菜单快速操作
- **全局快捷键** — `Alt+\`` 随时随地唤出/隐藏窗口
- **透明窗口** — 圆角裁切（R=16）、淡入淡出动画
- **日报生成** — 一键生成今日任务总结，按完成状态排序，写入剪贴板
- **快捷键可配** — 设置页中可自定义全部 4 个全局快捷键
- **开机自启** — 可设置随 Windows 启动
- **加密存储** — API Key 使用 Electron safeStorage 加密存储

## 截图

<!-- TODO: 添加截图 -->

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Electron 33 |
| 前端 | 原生 JS + HTML + CSS |
| AI | DeepSeek API (deepseek-chat) |
| OCR | Tesseract.js v5 (chi_sim 简体中文) |
| 存储 | 本地 JSON 文件 + Electron safeStorage 加密 |
| 打包 | electron-builder + NSIS → `.exe` 安装包 |

## 安装

### 环境要求
- [Node.js](https://nodejs.org/) >= 18
- Windows 10/11

### 开发运行

```bash
git clone https://github.com/SwaG212/sticky-notes.git
cd sticky-notes
npm install
npm start
```

### 一键启动

双击 `启动便利贴.bat` — 使用内置 Electron 可执行文件，无需配置 Node.js 环境（需先 `npm install`）。

### 打包安装包

```bash
npm run build
```

安装包输出位置：`dist/便利贴 Setup x.x.x.exe`

## 使用说明

1. **配置 API Key** — 打开设置（齿轮按钮），填入 DeepSeek API Key
2. **记录任务** — 在便利贴页面输入文字或粘贴截图（Ctrl+V）
3. **AI 整理** — 点击「整理」或关闭窗口，AI 自动处理并返回任务清单
4. **设置提醒** — 点击任务上的时钟图标设置提醒时间
5. **记笔记** — 切换到记事本页面管理文本笔记
6. **生成日报** — 点击日报按钮，复制今日任务总结到剪贴板

### 默认快捷键

| 快捷键 | 功能 |
|--------|------|
| `Alt+\`` | 切换窗口显示/隐藏 |
| `Ctrl+Shift+O` | AI 整理 |
| `Ctrl+Shift+N` | 切换到便利贴 |
| `Ctrl+Shift+B` | 切换到记事本 |

## 项目结构

```
sticky-notes/
├── main.js              # Electron 主进程（窗口/托盘/IPC/OCR/LLM）
├── preload.js           # IPC 桥接层
├── renderer/
│   ├── index.html       # DOM 结构（便利贴页 + 记事本页 + 设置覆盖层）
│   ├── renderer.js      # 前端逻辑（状态管理/渲染/笔记/设置）
│   └── styles.css       # 全局样式（CSS 变量/布局/动画）
├── assets/
│   └── icon.png         # 应用图标
├── docs/
│   ├── PRD.md           # 产品需求文档
│   ├── 测试用例.md       # 测试用例
│   └── 测试报告.md       # 测试报告
├── tests/               # 集成测试与模块测试
├── package.json
└── 启动便利贴.bat        # 一键启动脚本
```

## 配置

所有设置存储在 `%APPDATA%/sticky-notes/`：

- `config.enc` — 加密的 API Key、Base URL、日报姓名、笔记目录、快捷键配置
- `tasks/YYYY-MM-DD.json` — 每日任务文件
- `notes/` — 默认笔记存储目录（可自定义）

## 许可证

[MIT](LICENSE)
