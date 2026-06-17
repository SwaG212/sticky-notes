# Sticky Notes (便利贴)

A Windows desktop sticky notes app — jot down ideas, AI organizes them into a task list, check them off, plus a built-in notepad for multi-file note-taking.

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Electron](https://img.shields.io/badge/electron-33.x-47848f)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

### Sticky Note Page
- **Quick Capture** — Type or paste screenshots (Ctrl+V), AI organizes everything into a structured task list
- **Image OCR** — Built-in Tesseract.js OCR extracts Chinese text from pasted images before sending to AI
- **AI Organization** — Powered by DeepSeek API, converts raw input into a JSON task list with categories
- **Time Alarms** — Set alarm times per task, desktop notifications when due
- **Check-off** — Tap to complete/uncomplete, completed items move to bottom with FLIP animation
- **Offline Fallback** — Works without AI: splits text by line into individual tasks

### Notepad Page
- **Multi-file Notes** — Create, rename, delete plain-text note files
- **AI Auto-naming** — AI suggests filenames based on note content
- **Pin Notes** — Pin important notes to the top of the file list
- **Search** — Fuzzy filter files by name
- **Auto-save** — Saves on every keystroke (300ms debounce), auto-names untitled notes on close
- **Custom Storage Directory** — Configure where notes are stored (default: `%APPDATA%/sticky-notes/notes/`)

### General
- **System Tray** — Lives in the system tray, right-click menu for quick actions
- **Global Hotkey** — `Alt+\`` toggles the window from anywhere
- **Transparent Window** — Rounded corners (R=16), fade-in/out animation, always on top option
- **Daily Report** — Generate a summary of today's tasks grouped by completion status, copied to clipboard
- **Configurable Shortcuts** — Customize all 4 global shortcuts in settings
- **Auto-start** — Option to launch on Windows startup
- **Encrypted Storage** — API key encrypted via Electron safeStorage

## Screenshots

<!-- TODO: add screenshots -->

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Electron 33 |
| Frontend | Vanilla JS + HTML + CSS |
| AI | DeepSeek API (deepseek-chat) |
| OCR | Tesseract.js v5 (chi_sim) |
| Storage | Local JSON files + Electron safeStorage |
| Packaging | electron-builder + NSIS → `.exe` installer |

## Installation

### Prerequisites
- [Node.js](https://nodejs.org/) >= 18
- Windows 10/11

### Development

```bash
git clone https://github.com/SwaG212/sticky-notes.git
cd sticky-notes
npm install
npm start
```

### One-Click Launch

Double-click `启动便利贴.bat` — uses the bundled Electron binary, no Node.js setup required (after `npm install`).

### Build Installer

```bash
npm run build
```

Installer output: `dist/便利贴 Setup x.x.x.exe`

## Usage

1. **Configure API Key** — Open settings (gear icon), enter your DeepSeek API key
2. **Capture Tasks** — Type text or paste a screenshot (Ctrl+V) in the sticky note page
3. **Organize** — Click "整理" (Organize) or close the window — AI will process and return a task list
4. **Set Alarms** — Click the clock icon on any task to set a reminder time
5. **Take Notes** — Switch to the notepad page to manage text notes
6. **Daily Report** — Click the report button to copy today's summary to clipboard

### Keyboard Shortcuts (default)

| Shortcut | Action |
|----------|--------|
| `Alt+\`` | Toggle window |
| `Ctrl+Shift+O` | Organize |
| `Ctrl+Shift+N` | Switch to sticky note |
| `Ctrl+Shift+B` | Switch to notepad |

## Project Structure

```
sticky-notes/
├── main.js              # Electron main process (window, tray, IPC, OCR, LLM)
├── preload.js           # IPC bridge (contextBridge)
├── renderer/
│   ├── index.html       # DOM (sticky note page + notepad page + settings overlay)
│   ├── renderer.js      # Frontend logic (state, rendering, notes, settings)
│   └── styles.css       # All styles (CSS variables, components, animations)
├── assets/
│   └── icon.png         # App icon
├── docs/
│   ├── PRD.md           # Product requirements document (Chinese)
│   ├── 测试用例.md       # Test cases
│   └── 测试报告.md       # Test report
├── tests/               # Integration & module tests
├── package.json
└── 启动便利贴.bat        # One-click launcher
```

## Configuration

All settings are stored in `%APPDATA%/sticky-notes/`:

- `config.enc` — Encrypted API key, base URL, report name, notes directory, shortcuts
- `tasks/YYYY-MM-DD.json` — Daily task files
- `notes/` — Default note files directory (can be customized)

## License

[MIT](LICENSE)
