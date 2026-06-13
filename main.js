const { app, BrowserWindow, Tray, globalShortcut, Menu, nativeImage, screen, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

// ========== 透明窗口必需参数 ==========
app.commandLine.appendSwitch('enable-transparent-visuals');
app.commandLine.appendSwitch('disable-gpu-compositing');

// ========== 全局状态 ==========
let win = null;
let tray = null;
let animating = false;
const userDataPath = app.getPath('userData');
const configPath = path.join(userDataPath, 'config.enc');

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

// ========== 配置管理（加密存储） ==========
function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const encrypted = fs.readFileSync(configPath);
      const decrypted = safeStorage.decryptString(encrypted);
      return JSON.parse(decrypted);
    }
  } catch (e) { /* ignore */ }
  return { apiKey: '', baseUrl: 'https://api.deepseek.com' };
}

function saveConfig(cfg) {
  const json = JSON.stringify(cfg);
  const encrypted = safeStorage.encryptString(json);
  fs.writeFileSync(configPath, encrypted);
}

// ========== OCR 模块 ==========
let ocrWorker = null;

async function initOCR() {
  if (ocrWorker) return;
  const { createWorker } = require('tesseract.js');
  ocrWorker = await createWorker('chi_sim');
}

async function ocrImage(dataUrl) {
  await initOCR();
  // dataUrl 格式: "data:image/png;base64,..."
  const base64 = dataUrl.split(',')[1];
  const buf = Buffer.from(base64, 'base64');
  const { data } = await ocrWorker.recognize(buf);
  return data.text.trim();
}

// ========== DeepSeek LLM 模块 ==========
const ORGANIZE_PROMPT = `你是一个任务整理助手。用户会给你一段杂乱的想法或文字，可能包含 OCR 识别的聊天截图内容。
请从中提取出所有独立的待办任务，每项用简洁的一句话表述，不添加编号、优先级或分类。
返回严格的 JSON 数组格式，不要输出任何其他内容。
格式示例：[{"task":"周三前出合同"},{"task":"找运维要服务器账号"}]
如果用户输入本身已是单一任务，也返回单条数组。
如果用户的输入无法提取出任何任务，返回空数组 []。

用户输入：
`;

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

async function organizeText(userText, imageDataUrls) {
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
    [{ role: 'user', content: ORGANIZE_PROMPT + combinedInput }],
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

function getYesterday() {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function loadTasksFromFile() {
  const today = getToday();
  let tasks = readJSON(path.join(userDataPath, 'tasks', `${today}.json`)) || [];

  // 加载昨天未完成任务
  const yesterday = getYesterday();
  const yesterdayTasks = readJSON(path.join(userDataPath, 'tasks', `${yesterday}.json`));
  if (yesterdayTasks) {
    const unfinished = yesterdayTasks.filter(t => !t.completed);
    if (unfinished.length > 0) {
      unfinished.forEach(t => { t.createdAt = new Date().toISOString(); t.id = 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); });
      tasks = [...unfinished, ...tasks];
      writeJSON(path.join(userDataPath, 'tasks', `${today}.json`), tasks);
    }
  }
  return tasks;
}

function saveTasksToFile(tasks) {
  writeJSON(path.join(userDataPath, 'tasks', `${getToday()}.json`), tasks);
}

// ========== IPC 处理 ==========
function setupIPC() {
  ipcMain.handle('organize-request', async (_event, { text, images }) => {
    try {
      const tasks = await organizeText(text, images);
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
  ipcMain.handle('save-config', (_event, cfg) => { saveConfig(cfg); return { success: true }; });
  ipcMain.handle('load-tasks', () => loadTasksFromFile());
  ipcMain.handle('save-tasks', (_event, tasks) => { saveTasksToFile(tasks); return { success: true }; });
}

// ========== 窗口管理 ==========
function getWindowPosition() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
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
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.setVisibleOnAllWorkspaces(true);

  win.on('blur', () => {
    if (win && !win.isDestroyed() && !animating) {
      hideWindow();
    }
  });

  win.on('close', (e) => {
    e.preventDefault();
    win.hide();
  });
}

const LOCK_MS = 400;

let lockTimer = null;

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  const { x, y, width, height } = getWindowPosition();
  win.setBounds({ x, y, width, height });
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

// ========== 应用生命周期 ==========
app.whenReady().then(() => {
  setupIPC();
  createTray();
  createWindow();

  const ok = globalShortcut.register('Alt+`', toggleWindow);
  if (!ok) {
    try { globalShortcut.register('Alt+Backquote', toggleWindow); } catch (e) { /* ignore */ }
  }

  // 首次启动检查 API Key 配置
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    setTimeout(() => {
      showWindow();
      if (win) win.webContents.send('open-config');
    }, 800);
  } else {
    showWindow();
  }
});

app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (ocrWorker) { ocrWorker.terminate().catch(() => {}); ocrWorker = null; }
});
