const { app, BrowserWindow, Tray, globalShortcut, Menu, nativeImage, screen, ipcMain, safeStorage, clipboard, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const os = require('os');

// ========== 性能优化 ==========
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-software-rasterizer');

// ========== 透明窗口必需参数 ==========
app.commandLine.appendSwitch('enable-transparent-visuals');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=128');

// ========== 单实例锁 ==========
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) showWindow();
  });
}

// ========== 全局状态 ==========
let win = null;
let tray = null;
let alarmWin = null;
let animating = false;
let alarmTimer = null;
let currentPage = 'main';
let settingsOpen = false;
let winFixed = true;
let savedWinX = null;
let savedWinY = null;
let moveSaveTimer = null;
const userDataPath = app.getPath('userData');
const configPath = path.join(userDataPath, 'config.enc');
const windowStatePath = path.join(userDataPath, 'window-state.json');

// ========== 存储模块 ==========
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (e) { /* ignore corrupt file */ }
  return null;
}

function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ========== 配置管理（加密存储 + 内存缓存） ==========
let cachedConfig = null;

function loadConfig() {
  if (cachedConfig) return cachedConfig;
  try {
    if (fs.existsSync(configPath)) {
      const encrypted = fs.readFileSync(configPath);
      const decrypted = safeStorage.decryptString(encrypted);
      cachedConfig = JSON.parse(decrypted);
      if (!cachedConfig.projectNames) cachedConfig.projectNames = [];
      if (!cachedConfig.notesDirHistory) cachedConfig.notesDirHistory = [];
      if (!cachedConfig.blurHide) cachedConfig.blurHide = { tasks: true, notepad: true, tools: true };
      // 迁移：把当前 notesDir 加入历史（修复旧版本遗留数据）
      if (cachedConfig.notesDir && cachedConfig.notesDir.trim() && !cachedConfig.notesDirHistory.includes(cachedConfig.notesDir.trim())) {
        cachedConfig.notesDirHistory = [cachedConfig.notesDir.trim(), ...cachedConfig.notesDirHistory].slice(0, 5);
      }
      return cachedConfig;
    }
  } catch (e) { /* ignore */ }
  cachedConfig = { apiKey: '', baseUrl: 'https://api.deepseek.com', reportName: '', notesDir: '', notesDirHistory: [], projectNames: [], shortcuts: { toggle: 'Alt+`', organize: 'Ctrl+Enter', switchTask: 'Alt+1', switchNotepad: 'Alt+2', switchTools: 'Alt+3' }, pagesEnabled: { tasks: true, tools: true }, blurHide: { tasks: true, notepad: true, tools: true } };
  return cachedConfig;
}

function saveConfig(cfg) {
  // 维护文件路径历史（最多5条，去重，最近使用排最前）
  if (cfg.notesDir && cfg.notesDir.trim()) {
    const dir = cfg.notesDir.trim();
    const history = cfg.notesDirHistory || [];
    const filtered = history.filter(d => d !== dir);
    cfg.notesDirHistory = [dir, ...filtered].slice(0, 5);
  }
  cachedConfig = cfg;
  const json = JSON.stringify(cfg);
  const encrypted = safeStorage.encryptString(json);
  fs.writeFileSync(configPath, encrypted);
  registerToggleShortcut(cfg.shortcuts?.toggle || 'Alt+`');
}

function loadWindowState() {
  const data = readJSON(windowStatePath);
  if (data) { savedWinX = data.x; savedWinY = data.y; }
}

function saveWindowState(x, y) {
  savedWinX = x;
  savedWinY = y;
  writeJSON(windowStatePath, { x, y });
}

// ========== OCR 模块 ==========
let ocrWorker = null;
let ocrIdleTimer = null;
const OCR_IDLE_TIMEOUT = 5 * 60 * 1000;

async function initOCR() {
  if (ocrWorker) return;
  const { createWorker } = require('tesseract.js');
  const corePath = path.join(
    __dirname, 'node_modules', 'tesseract.js-core', 'tesseract-core-simd-lstm.wasm'
  );
  // 中文语言包本地化:assets/ocr/chi_sim.traineddata.gz,离线可用,不依赖 CDN
  const langPath = path.join(__dirname, 'assets', 'ocr');
  ocrWorker = await createWorker('chi_sim', 1, { corePath, langPath });
}

function resetOcrIdleTimer() {
  clearTimeout(ocrIdleTimer);
  ocrIdleTimer = setTimeout(async () => {
    if (ocrWorker) {
      await ocrWorker.terminate();
      ocrWorker = null;
    }
  }, OCR_IDLE_TIMEOUT);
}

async function ocrImage(dataUrl) {
  await initOCR();
  resetOcrIdleTimer();
  const base64 = dataUrl.split(',')[1];
  const buf = Buffer.from(base64, 'base64');
  const { data } = await ocrWorker.recognize(buf);
  return data.text.trim();
}

// ========== DeepSeek LLM 模块 ==========
function buildOrganizePrompt(project) {
  if (project) {
    return `你是一个任务整理助手。用户会给你一段杂乱的想法或文字，可能包含 OCR 识别的聊天截图内容。
请从中提取出所有独立的待办任务，每项用简洁的一句话表述。

润色规则：
- 去掉口语化的动词前缀（如"去""跟""找一下"等），保留核心动作
- 将口语转化为书面表达（如"碰一下"→"沟通"、"看一下"→"查看"、"弄一下"→"处理"）
- 精简冗余词汇，保持任务表述专业、清晰

【重要】以下任务的所属项目已确定为「${project}」。请在每条 JSON 中添加 "project":"${project}" 字段，task 字段只写润色后的任务内容。

返回严格的 JSON 数组格式，不要输出任何其他内容。
格式示例：[{"task":"本地环境测试","project":"国寿"},{"task":"季度巡检","project":"中加"}]
如果用户输入本身已是单一任务，也返回单条数组。
如果用户的输入无法提取出任何任务，返回空数组 []。

用户输入：
`;
  }

  return `你是一个任务整理助手。用户会给你一段杂乱的想法或文字，可能包含 OCR 识别的聊天截图内容。
请从中提取出所有独立的待办任务，每项用简洁的一句话表述。

润色规则：
- 去掉口语化的动词前缀（如"去""跟""找一下"等），保留核心动作
- 将口语转化为书面表达（如"碰一下"→"沟通"、"看一下"→"查看"、"弄一下"→"处理"）
- 精简冗余词汇，保持任务表述专业、清晰

返回严格的 JSON 数组格式，不要输出任何其他内容。
格式示例：[{"task":"周三前出合同"},{"task":"找运维要服务器账号"}]
如果用户输入本身已是单一任务，也返回单条数组。
如果用户的输入无法提取出任何任务，返回空数组 []。

用户输入：
`;
}

async function callDeepSeek(messages, apiKey, baseUrl) {
  const url = `${baseUrl}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      temperature: 0.3,
      max_tokens: 1024,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    if (res.status === 401) throw new Error('AUTH_FAILED');
    if (res.status === 402) throw new Error('INSUFFICIENT_FUNDS');
    const body = await res.text().catch(() => '');
    throw new Error(`API_ERROR:${res.status}:${body}`);
  }

  return res.json();
}

// ========== 翻译模块 ==========
function detectLang(text) {
  // 含中文字符(基本区)即判定为中文,否则英文
  return /[一-鿿]/.test(text) ? '中文' : '英文';
}

function buildTranslatePrompt(text, targetLang) {
  return `你是一个中英互译助手。

请将以下文本翻译成${targetLang}。
- 保持原文语气和格式
- 只输出译文，不要输出其他内容

用户输入：
${text}`;
}

async function translateText(text, imageDataUrls) {
  const cfg = loadConfig();
  if (!cfg.apiKey) throw new Error('NO_API_KEY');

  // 1. OCR 处理所有图片
  let ocrResults = [];
  for (const dataUrl of imageDataUrls) {
    try {
      const text = await ocrImage(dataUrl);
      if (text) ocrResults.push(text);
    } catch (e) {
      ocrResults.push('[图片OCR失败]');
    }
  }

  // 2. 组装输入
  let combinedInput = text || '';
  if (ocrResults.length > 0) {
    combinedInput += '\n\n[以下为截图OCR识别内容]\n' + ocrResults.join('\n---\n');
  }
  if (!combinedInput.trim()) throw new Error('EMPTY_INPUT');

  // 3. 解析文字语言:中文→英文,英文→中文
  const sourceLang = detectLang(combinedInput);
  const targetLang = sourceLang === '中文' ? '英文' : '中文';

  // 4. 调用 DeepSeek
  const response = await callDeepSeek(
    [{ role: 'user', content: buildTranslatePrompt(combinedInput, targetLang) }],
    cfg.apiKey,
    cfg.baseUrl
  );
  const translated = (response.choices?.[0]?.message?.content || '').trim();
  return { translated, sourceLang, targetLang };
}

async function organizeText(userText, imageDataUrls, project) {
  const cfg = loadConfig();
  if (!cfg.apiKey) throw new Error('NO_API_KEY');

  // 1. OCR 处理所有图片
  let ocrResults = [];
  for (const dataUrl of imageDataUrls) {
    try {
      const text = await ocrImage(dataUrl);
      if (text) ocrResults.push(text);
    } catch (e) {
      ocrResults.push('[图片OCR失败]');
    }
  }

  // 2. 组装 prompt
  let combinedInput = userText || '';
  if (ocrResults.length > 0) {
    combinedInput += '\n\n[以下为截图OCR识别内容]\n' + ocrResults.join('\n---\n');
  }

  if (!combinedInput.trim()) throw new Error('EMPTY_INPUT');

  // 3. 调用 DeepSeek
  const response = await callDeepSeek(
    [{ role: 'user', content: buildOrganizePrompt(project) + combinedInput }],
    cfg.apiKey,
    cfg.baseUrl
  );

  // 4. 解析返回
  const content = response.choices?.[0]?.message?.content || '';
  return parseTaskJSON(content);
}

function parseTaskJSON(content) {
  // 尝试直接解析
  try {
    const arr = JSON.parse(content);
    if (Array.isArray(arr)) return arr.filter(t => t.task && typeof t.task === 'string');
  } catch (e) { /* fall through */ }

  // 容错：尝试提取 JSON 数组
  const match = content.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr)) return arr.filter(t => t.task && typeof t.task === 'string');
    } catch (e) { /* fall through */ }
  }

  throw new Error('PARSE_ERROR');
}

// ========== 任务文件存储 ==========
function getToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function loadTasksFromFile() {
  const today = getToday();
  const filePath = path.join(userDataPath, 'tasks', `${today}.json`);

  // 文件损坏保护：>5MB 自动归档
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 5 * 1024 * 1024) {
      const archivePath = filePath.replace(/\.json$/, `_corrupted_${Date.now()}.json`);
      fs.renameSync(filePath, archivePath);
    }
  } catch (e) { /* ignore */ }

  let tasks = readJSON(filePath) || [];

  // 仅在该文件不是今天创建时，才清空 alarmTime（说明是跨天首次加载）
  let isNewDay = true;
  try {
    if (fs.existsSync(filePath)) {
      const mtime = fs.statSync(filePath).mtime;
      isNewDay = mtime.toDateString() !== new Date().toDateString();
    }
  } catch (e) {}

  let changed = false;
  if (isNewDay) {
    tasks.forEach(t => { if (t.alarmTime) { t.alarmTime = null; changed = true; } }); // 跨天仅清闹钟提醒，截止日期原样保留

    // 清除过期已完成任务
    const todayStr = getToday();
    const before = tasks.length;
    tasks = tasks.filter(t => !(t.completed && t.dueDate && t.dueDate < todayStr));
    if (tasks.length !== before) changed = true;

    // 迁移最近未完成任务——扫描过去14天，找到最近有未完成任务的那天进行迁移
    for (let daysBack = 1; daysBack <= 14; daysBack++) {
      const d = new Date(); d.setDate(d.getDate() - daysBack);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const pastPath = path.join(userDataPath, 'tasks', `${dateStr}.json`);
      const pastTasks = readJSON(pastPath);
      if (!pastTasks) continue;
      const unfinished = pastTasks.filter(t => !t.completed);
      if (unfinished.length === 0) continue;
      // 去重保护：跳过今天已存在的同名任务
      const todayTexts = new Set(tasks.map(t => t.task));
      const unique = unfinished.filter(t => !todayTexts.has(t.task));
      if (unique.length > 0) {
        unique.forEach((t, i) => {
          t.createdAt = new Date().toISOString();
          t.id = 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
          t.alarmTime = null; // 截止日期原样保留，仅清闹钟提醒
          t.sortOrder = i;
        });
        // 今天已有任务 sortOrder 顺延
        tasks.forEach((t, i) => { t.sortOrder = unique.length + i; });
        tasks = [...unique, ...tasks];
        changed = true;
      }
      break;
    }
  }

  if (changed) {
    writeJSON(filePath, tasks);
  }
  return tasks;
}

function saveTasksToFile(tasks) {
  writeJSON(path.join(userDataPath, 'tasks', `${getToday()}.json`), tasks);
}

// ========== 笔记文件存储 ==========
function getNotesDir() {
  const cfg = loadConfig();
  return cfg.notesDir && cfg.notesDir.trim() ? cfg.notesDir.trim() : path.join(userDataPath, 'notes');
}

function getPinsPath() {
  return path.join(getNotesDir(), 'pins.json');
}

function getPinnedNotes() {
  return readJSON(getPinsPath()) || [];
}

function savePinnedNotes(pinned) {
  writeJSON(getPinsPath(), pinned);
}

function togglePinNote(filename) {
  const pinned = getPinnedNotes();
  const idx = pinned.indexOf(filename);
  if (idx === -1) {
    pinned.unshift(filename);
  } else {
    pinned.splice(idx, 1);
  }
  savePinnedNotes(pinned);
  return pinned;
}

async function listNotes() {
  const dir = getNotesDir();
  ensureDir(dir);
  const files = await fs.promises.readdir(dir);
  const mdFiles = files.filter(f => f.endsWith('.md'));
  const result = await Promise.all(mdFiles.map(async f => {
    const stat = await fs.promises.stat(path.join(dir, f));
    return { filename: f, mtime: stat.mtime.toISOString() };
  }));
  return result.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

function readNote(filename) {
  const filePath = path.join(getNotesDir(), filename);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

function saveNote(filename, content) {
  const dir = getNotesDir();
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, filename), content, 'utf-8');
}

function createNote() {
  const dir = getNotesDir();
  ensureDir(dir);
  const existing = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  let n = 1;
  while (existing.includes(`untitled_${n}.md`)) n++;
  const filename = `untitled_${n}.md`;
  fs.writeFileSync(path.join(dir, filename), '', 'utf-8');
  return filename;
}

function renameNoteFile(oldName, newName) {
  const dir = getNotesDir();
  const oldPath = path.join(dir, oldName);
  const newPath = path.join(dir, newName);
  if (!fs.existsSync(oldPath)) throw new Error('FILE_NOT_FOUND');
  if (fs.existsSync(newPath)) throw new Error('FILE_EXISTS');
  fs.renameSync(oldPath, newPath);
  const pinned = getPinnedNotes();
  const idx = pinned.indexOf(oldName);
  if (idx !== -1) { pinned[idx] = newName; savePinnedNotes(pinned); }
}

function deleteNoteFile(filename) {
  const filePath = path.join(getNotesDir(), filename);
  if (!fs.existsSync(filePath)) return;
  const psCmd = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${filePath.replace(/'/g, "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
  try {
    execSync(`powershell -NoProfile -Command "${psCmd}"`, { timeout: 5000 });
  } catch (e) {
    fs.unlinkSync(filePath);
  }
  // 清理置顶记录
  const pinned = getPinnedNotes();
  const idx = pinned.indexOf(filename);
  if (idx !== -1) { pinned.splice(idx, 1); savePinnedNotes(pinned); }
}

// ========== AI 笔记命名 ==========
async function aiNameNote(filename, content) {
  const cfg = loadConfig();
  if (!cfg.apiKey) return null;
  const prompt = `用不超过15个字概括以下笔记的主要内容，只返回概括文字，不要日期、标点或任何额外内容。\n\n笔记内容：\n${content}`;
  try {
    const response = await callDeepSeek(
      [{ role: 'user', content: prompt }],
      cfg.apiKey,
      cfg.baseUrl
    );
    let summary = response.choices?.[0]?.message?.content || '';
    summary = summary.replace(/[，,。\.！!？?\n\r]/g, '').trim().slice(0, 15);
    if (!summary) return null;
    const newName = `${summary}.md`;
    const dir = getNotesDir();
    const oldPath = path.join(dir, filename);
    const newPath = path.join(dir, newName);
    if (fs.existsSync(newPath)) {
      let n = 2;
      while (fs.existsSync(path.join(dir, `${summary}_${n}.md`))) n++;
      const altName = `${summary}_${n}.md`;
      fs.renameSync(oldPath, path.join(dir, altName));
      return altName;
    }
    fs.renameSync(oldPath, newPath);
    return newName;
  } catch (e) {
    console.warn('AI naming failed:', e.message);
    return null;
  }
}

// ========== 定时提醒 ==========
function checkAlarms() {
  const tasks = loadTasksFromFile();
  const now = new Date();
  const currentHHMM = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  const due = tasks.filter(t => t.alarmTime === currentHHMM && !t.completed);
  if (due.length === 0) return;

  const names = due.map(t => t.task);
  showAlarmWindow(names);
}

function showAlarmWindow(tasks) {
  if (alarmWin && !alarmWin.isDestroyed()) return;

  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  const taskLines = tasks.map(t => `<div class="task-name">「${t}」</div>`).join('');

  const popupHeight = Math.min(450, 180 + tasks.length * 30);
  const popupWidth = 300;
  alarmWin = new BrowserWindow({
    width: popupWidth,
    height: popupHeight,
    x: sw - popupWidth - 16,
    y: sh - popupHeight - 16,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:-apple-system,"Microsoft YaHei",sans-serif;background:#fff;overflow:hidden;margin:4px;padding:20px 16px 16px;text-align:center;display:flex;flex-direction:column;height:calc(100vh - 8px);}
    .title{font-size:14px;color:#2a2a36;font-weight:bold;margin-bottom:12px;flex-shrink:0;}
    .task-list{flex:1;overflow-y:auto;min-height:0;padding:4px 0;}
    .task-list::-webkit-scrollbar{width:4px;}
    .task-list::-webkit-scrollbar-thumb{background:#b0b0bc;border-radius:2px;}
    .task-list::-webkit-scrollbar-thumb:hover{background:#8a8a98;}
    .task-name{font-size:15px;color:#2a2a36;font-weight:bold;line-height:1.8;}
    .note{font-size:13px;color:#2a2a36;margin-top:10px;margin-bottom:12px;font-weight:bold;flex-shrink:0;}
    .divider{width:100%;height:1px;background:#e2e2ec;margin:8px 0;flex-shrink:0;}
    button{padding:6px 40px;background:#5b5be0;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer;font-family:inherit;flex-shrink:0;}
    button:hover{background:#4848d0;}
  </style></head><body>
    <div class="title">便利贴 - 提醒</div>
    <div class="task-list">${taskLines}</div>
    <div class="divider"></div>
    <div class="note">时间到了！</div>
    <button onclick="window.close()">确认</button>
    <script>const{ipcRenderer}=require('electron');</script>
  </body></html>`;

  alarmWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  alarmWin.setVisibleOnAllWorkspaces(true);
  alarmWin.show();

  alarmWin.on('closed', () => { alarmWin = null; });
}

function startAlarmTimer() {
  if (alarmTimer) return;
  checkAlarms(); // 启动时也检查一次
  alarmTimer = setInterval(checkAlarms, 60000);
}

// ========== IPC 处理 ==========
function setupIPC() {
  ipcMain.handle('organize-request', async (_event, { text, images, project }) => {
    try {
      const tasks = await organizeText(text, images, project);
      return { success: true, tasks };
    } catch (e) {
      const errMap = {
        'NO_API_KEY': '请先配置 API Key',
        'AUTH_FAILED': 'API Key 无效，请重新配置',
        'INSUFFICIENT_FUNDS': 'API 余额不足，请充值后重试',
        'EMPTY_INPUT': '请输入内容',
        'PARSE_ERROR': 'AI 返回格式异常，请重试',
      };
      const msg = errMap[e.message] || `AI 服务异常：${e.message}`;
      return { success: false, error: msg };
    }
  });

  ipcMain.handle('get-config', () => loadConfig());
  ipcMain.handle('set-settings-open', (_e, open) => { settingsOpen = open; });
  ipcMain.handle('save-config', (_event, cfg) => { saveConfig(cfg); return { success: true }; });
  ipcMain.handle('get-login-settings', () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle('set-login-settings', (_e, enabled) => app.setLoginItemSettings({ openAtLogin: enabled }));
  ipcMain.handle('load-tasks', () => loadTasksFromFile());
  ipcMain.handle('save-tasks', (_event, tasks) => { saveTasksToFile(tasks); return { success: true }; });
  ipcMain.handle('set-window-fixed', (_e, fixed) => {
    winFixed = fixed;
    if (win && !win.isDestroyed() && fixed) {
      const { x, y, width, height } = getWindowPosition();
      win.setBounds({ x, y, width, height });
    }
  });

  ipcMain.handle('set-page', (_e, page) => { currentPage = page; });
  ipcMain.handle('list-notes', () => listNotes());
  ipcMain.handle('get-pinned-notes', () => getPinnedNotes());
  ipcMain.handle('toggle-pin-note', (_e, filename) => togglePinNote(filename));
  ipcMain.handle('read-note', (_e, filename) => readNote(filename));
  ipcMain.handle('save-note', (_e, filename, content) => { saveNote(filename, content); return { success: true }; });
  ipcMain.handle('create-note', () => createNote());
  ipcMain.handle('rename-note', (_e, oldName, newName) => { renameNoteFile(oldName, newName); return { success: true }; });
  ipcMain.handle('delete-note', (_e, filename) => { deleteNoteFile(filename); return { success: true }; });
  ipcMain.handle('save-note-image', (_event, dataUrl) => {
    const dir = path.join(getNotesDir(), 'attachments');
    ensureDir(dir);
    const base64 = dataUrl.split(',')[1];
    if (!base64) return { error: 'Invalid data URL' };
    const buf = Buffer.from(base64, 'base64');
    const filename = `img_${Date.now()}.png`;
    fs.writeFileSync(path.join(dir, filename), buf);
    return { filename: `attachments/${filename}` };
  });
  ipcMain.handle('read-note-image', async (_e, relativePath) => {
    const fullPath = path.join(getNotesDir(), relativePath);
    if (!fs.existsSync(fullPath)) return null;
    const data = fs.readFileSync(fullPath);
    const ext = path.extname(relativePath).toLowerCase();
    const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
    return `data:${mimeTypes[ext] || 'image/png'};base64,${data.toString('base64')}`;
  });
  ipcMain.handle('open-note-image', (_e, relativePath) => {
    const fullPath = path.join(getNotesDir(), relativePath);
    if (!fs.existsSync(fullPath)) return { error: 'File not found' };
    shell.openPath(fullPath);
    return { success: true };
  });
  ipcMain.handle('delete-note-image', (_e, relativePath) => {
    const fullPath = path.join(getNotesDir(), relativePath);
    if (!fs.existsSync(fullPath)) return { success: true };
    const psCmd = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${fullPath.replace(/'/g, "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
    try {
      execSync(`powershell -NoProfile -Command "${psCmd}"`, { timeout: 5000 });
    } catch (e) {
      fs.unlinkSync(fullPath);
    }
    return { success: true };
  });
  ipcMain.handle('ai-name-note', async (_e, filename, content) => {
    const newName = await aiNameNote(filename, content);
    return { newFilename: newName };
  });

  ipcMain.handle('generate-daily-report', (_event, tasks) => {
    const cfg = loadConfig();
    const name = cfg.reportName || os.userInfo().username || '未命名';
    const done = tasks.filter(t => t.completed);
    const undone = tasks.filter(t => !t.completed);
    const ordered = [...done, ...undone];
    const today = getToday();
    const mmdd = today.slice(5).replace('-', '');
    let report = `${name} ${mmdd}`;
    ordered.forEach((t, i) => {
      const label = t.project ? `${t.project} ${t.task}` : t.task;
      report += `\n${i + 1}、${label}${t.completed ? ' 已完成' : ''}`;
    });
    clipboard.writeText(report);
    return { report };
  });

  ipcMain.handle('translate', async (_event, { text, images }) => {
    try {
      const res = await translateText(text || '', images || []);
      return { success: true, translated: res.translated, sourceLang: res.sourceLang, targetLang: res.targetLang };
    } catch (e) {
      const errMap = {
        'NO_API_KEY': '请先配置 API Key',
        'AUTH_FAILED': 'API Key 无效，请重新配置',
        'INSUFFICIENT_FUNDS': 'API 余额不足，请充值后重试',
        'EMPTY_INPUT': '请输入内容',
      };
      const msg = errMap[e.message] || `翻译服务异常：${e.message}`;
      return { success: false, error: msg };
    }
  });
}

// ========== 窗口管理 ==========
function getWindowPosition() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  if (!winFixed && savedWinX != null && savedWinY != null) {
    return { x: savedWinX, y: savedWinY, width: 360, height: 500 };
  }
  return {
    x: width - 360 - 8,
    y: height - 500,
    width: 360,
    height: 500,
  };
}

function createWindow() {
  const { x, y, width, height } = getWindowPosition();
  win = new BrowserWindow({
    width, height, x, y,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.setVisibleOnAllWorkspaces(true);

  // 物理裁切圆角（CSS border-radius 在透明窗口无效）
  win.once('ready-to-show', () => {
    const R = 16;
    const rects = [];
    for (let y = 0; y < height; y++) {
      let i = 0;
      if (y < R) i = R - Math.round(Math.sqrt(R * R - (R - y) ** 2));
      else if (y >= height - R) i = R - Math.round(Math.sqrt(R * R - (y - (height - R)) ** 2));
      rects.push({ x: i, y, width: width - i * 2, height: 1 });
    }
    win.setShape(rects);
  });

  win.on('blur', () => {
    if (win && !win.isDestroyed() && !animating && !settingsOpen) {
      // 按当前页查失焦隐藏开关；main 页对应配置里的 tasks
      const cfg = loadConfig();
      const blurHide = cfg.blurHide || { tasks: true, notepad: true, tools: true };
      const pageKey = currentPage === 'notepad' ? 'notepad' : currentPage === 'tools' ? 'tools' : 'tasks';
      if (blurHide[pageKey] !== false) hideWindow();
    }
  });

  let moveSaveTimer = null;
  win.on('move', () => {
    if (winFixed) return;
    clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      if (win && !win.isDestroyed() && !winFixed) {
        const [x, y] = win.getPosition();
        saveWindowState(x, y);
      }
    }, 500);
  });

  win.on('close', (e) => {
    if (app.isQuitting) return; // 真正退出，允许窗口关闭
    e.preventDefault();
    win.hide();
  });
}

const LOCK_MS = 400;

let lockTimer = null;

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (winFixed) {
    const { x, y, width, height } = getWindowPosition();
    win.setBounds({ x, y, width, height });
  }
  win.show();
  win.focus();
  animating = true;
  clearTimeout(lockTimer);
  win.webContents.send('window-shown');
  lockTimer = setTimeout(() => { animating = false; }, LOCK_MS);
}

function hideWindow() {
  if (win && !win.isDestroyed()) {
    animating = true;
    clearTimeout(lockTimer);
    win.webContents.send('window-will-hide');
    lockTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) win.hide();
      animating = false;
    }, LOCK_MS);
  }
}

function toggleWindow() {
  if (animating) return; // 动画进行中，忽略快捷键
  if (win && win.isVisible()) hideWindow();
  else showWindow();
}

// ========== 托盘 ==========
function createTrayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const x = i % size, y = Math.floor(i / size), offset = i * 4;
    const inner = x >= 1 && x < size - 1 && y >= 1 && y < size - 1;
    const edgeX = (x === 0 || x === size - 1) && y >= 4 && y < size - 4;
    const edgeY = (y === 0 || y === size - 1) && x >= 4 && x < size - 4;
    if (inner || edgeX || edgeY) {
      buf[offset] = 255; buf[offset + 1] = 210; buf[offset + 2] = 60; buf[offset + 3] = 255;
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('便利贴 — Alt+` 呼出');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开便利贴', click: showWindow },
    { type: 'separator' },
    { label: '配置 API Key', click: () => { showWindow(); if (win) win.webContents.send('open-config'); } },
    { type: 'separator' },
    {
      label: '开机自启', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (mi) => app.setLoginItemSettings({ openAtLogin: mi.checked }),
    },
    { type: 'separator' },
    { label: '退出便利贴', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', toggleWindow);
}

// ========== 全局快捷键管理 ==========
function registerToggleShortcut(accel) {
  globalShortcut.unregisterAll();
  try {
    globalShortcut.register(accel, toggleWindow);
  } catch (e) {
    if (accel === 'Alt+`') {
      try { globalShortcut.register('Alt+Backquote', toggleWindow); } catch (e2) { /* ignore */ }
    }
  }
}

// ========== 应用生命周期 ==========
app.whenReady().then(() => {
  // 注册 note-image:// 自定义协议，用于在 contenteditable 中加载本地图片
  protocol.handle('note-image', (request) => {
    const url = new URL(request.url);
    const relativePath = url.host + url.pathname;
    const fullPath = path.join(getNotesDir(), relativePath);
    try {
      return net.fetch(`file:///${fullPath.replace(/\\/g, '/')}`);
    } catch (e) {
      return new Response('Not Found', { status: 404 });
    }
  });

  setupIPC();
  createTray();

  const cfg = loadConfig();
  winFixed = cfg.winFixed !== false;
  loadWindowState();
  registerToggleShortcut(cfg.shortcuts?.toggle || 'Alt+`');

  startAlarmTimer();

  // 首次启动检查 API Key 配置：无 Key 时自动弹出配置窗口
  if (!cfg.apiKey) {
    setTimeout(() => {
      showWindow();
      if (win) win.webContents.send('open-config');
    }, 800);
  }
  // 有 Key 时延迟创建窗口，等待用户首次 Alt+` 唤出（Lazy Window）
});

app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  clearTimeout(ocrIdleTimer);
  if (ocrWorker) { ocrWorker.terminate().catch(() => {}); ocrWorker = null; }
});
