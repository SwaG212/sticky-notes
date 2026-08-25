const { app, BrowserWindow, Tray, globalShortcut, Menu, nativeImage, screen, ipcMain, safeStorage, clipboard, protocol, net, shell, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, spawnSync, spawn } = require('child_process');
const os = require('os');
const nodeNet = require('net');
const { pathToFileURL } = require('url');
const { HarnessManager, dshSessionsRoot, harnessConfig } = require('./harness/manager');
const { parseSessionFile } = require('./harness/session-store');
const { atomicWriteFileSync } = require('./atomic-write');
const { fitBoundsToWorkArea } = require('./window-bounds');

const APP_ICON = path.join(__dirname, 'assets', 'icon.png');

// ========== 性能优化 ==========
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-software-rasterizer');

// ========== 透明窗口必需参数 ==========
app.commandLine.appendSwitch('enable-transparent-visuals');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=128');
if (process.platform === 'win32') app.setAppUserModelId('com.stickynotes.app');

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
let harnessManager = null;
let harnessWebChild = null;
let harnessWebStderr = '';
let quitSavePending = false;
let quitSaveReady = false;
let quitSaveTimer = null;
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
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function escapeHtml(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s).replace(/[&<>"']/g, c => map[c]);
}

// ========== 配置管理（加密存储 + 内存缓存） ==========
let cachedConfig = null;

function normalizeToolsEnabled(value, harness = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    translate: typeof source.translate === 'boolean' ? source.translate : true,
    harness: typeof source.harness === 'boolean' ? source.harness : harness.enabled !== false,
  };
}

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
      if (!cachedConfig.harness) cachedConfig.harness = {};
      cachedConfig.harness = sanitizeHarnessSettings(cachedConfig.harness, cachedConfig.harness);
      cachedConfig.toolsEnabled = normalizeToolsEnabled(cachedConfig.toolsEnabled, cachedConfig.harness);
      // 迁移：把当前 notesDir 加入历史（修复旧版本遗留数据）
      if (cachedConfig.notesDir && cachedConfig.notesDir.trim() && !cachedConfig.notesDirHistory.includes(cachedConfig.notesDir.trim())) {
        cachedConfig.notesDirHistory = [cachedConfig.notesDir.trim(), ...cachedConfig.notesDirHistory].slice(0, 5);
      }
      return cachedConfig;
    }
  } catch (e) { /* ignore */ }
  cachedConfig = { apiKey: '', baseUrl: 'https://api.deepseek.com', reportName: '', notesDir: '', notesDirHistory: [], projectNames: [], shortcuts: { toggle: 'Alt+`', organize: 'Ctrl+Enter', switchTask: 'Alt+1', switchNotepad: 'Alt+2', switchTools: 'Alt+3' }, pagesEnabled: { tasks: true, tools: true }, toolsEnabled: { translate: true, harness: true }, blurHide: { tasks: true, notepad: true, tools: true }, harness: {} };
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
  const json = JSON.stringify(cfg);
  const encrypted = safeStorage.encryptString(json);
  atomicWriteFileSync(configPath, encrypted);
  cachedConfig = cfg;
  registerToggleShortcut(cfg.shortcuts?.toggle || 'Alt+`');
}

function sanitizeHarnessSettings(value, current = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const permission = source.permission === 'read-only' ? 'read-only' : 'workspace-write';
  const mode = source.mode === 'minimal' ? 'minimal' : 'standard';
  const model = ['deepseek-v4-pro', 'deepseek-v4-flash'].includes(source.model)
    ? source.model
    : ['deepseek-v4-pro', 'deepseek-v4-flash'].includes(current.model) ? current.model : 'deepseek-v4-flash';
  const reasoningEffort = ['off', 'high', 'max'].includes(source.reasoningEffort)
    ? source.reasoningEffort
    : ['off', 'high', 'max'].includes(current.reasoningEffort) ? current.reasoningEffort : 'high';
  return {
    enabled: source.enabled !== false,
    installDir: typeof source.installDir === 'string' ? source.installDir.trim() : String(current.installDir || ''),
    nodePath: typeof source.nodePath === 'string' ? source.nodePath.trim() : String(current.nodePath || ''),
    workspace: typeof source.workspace === 'string' ? source.workspace.trim() : String(current.workspace || ''),
    mode,
    model,
    reasoningEffort,
    permission,
  };
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
let ocrInitPromise = null; // 并发去重锁:初始化期间复用同一 promise,防止 worker 泄漏
const OCR_IDLE_TIMEOUT = 5 * 60 * 1000;

async function initOCR() {
  if (ocrWorker) return;
  if (ocrInitPromise) return ocrInitPromise;
  ocrInitPromise = (async () => {
    const { createWorker } = require('tesseract.js');
    // 定位核心 wasm:开发环境在顶层 node_modules,打包后可能被扁平化为 tesseract.js 的嵌套依赖
    let corePath = path.join(__dirname, 'node_modules', 'tesseract.js-core', 'tesseract-core-simd-lstm.wasm');
    if (!fs.existsSync(corePath)) {
      corePath = path.join(__dirname, 'node_modules', 'tesseract.js', 'node_modules', 'tesseract.js-core', 'tesseract-core-simd-lstm.wasm');
    }
    // 中文语言包本地化:assets/ocr/chi_sim.traineddata.gz,离线可用,不依赖 CDN
    const langPath = path.join(__dirname, 'assets', 'ocr');
    ocrWorker = await createWorker('chi_sim', 1, { corePath, langPath });
    return ocrWorker;
  })();
  try {
    return await ocrInitPromise;
  } finally {
    ocrInitPromise = null; // 初始化完成(无论成败)释放锁,失败可重试
  }
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
  // 按中文字符(基本区)与英文字母的数量比较判定,避免个别字符误判
  let zh = 0, en = 0;
  for (const ch of text) {
    if (/[一-鿿]/.test(ch)) zh++;
    else if (/[a-zA-Z]/.test(ch)) en++;
  }
  return zh > en ? '中文' : '英文';
}

function buildTranslatePrompt(text, targetLang) {
  return `你是一个中英互译助手。请将以下用户输入翻译成${targetLang}。

硬性要求：
- 输入为中文时，必须输出英文译文；输入为英文时，必须输出中文译文
- 输出语言必须与输入语言不同，禁止原样输出用户输入
- 保持原文语气和格式
- 只输出译文，不要输出任何解释、备注或其他内容

用户输入：
${text}`;
}

async function translateText(text, imageDataUrls) {
  const cfg = loadConfig();
  if (!cfg.apiKey) throw new Error('NO_API_KEY');

  // 1. OCR 处理所有图片：识别失败的图片不参与翻译，单独计数提示
  let ocrResults = [];
  let ocrFailed = 0;
  for (const dataUrl of imageDataUrls) {
    try {
      const t = await ocrImage(dataUrl);
      if (t) ocrResults.push(t);
      else ocrFailed++;
    } catch (e) {
      ocrFailed++;
    }
  }

  // 2. 组装输入
  let combinedInput = text || '';
  if (ocrResults.length > 0) {
    combinedInput += '\n\n[以下为截图OCR识别内容]\n' + ocrResults.join('\n---\n');
  }
  // 只有图片且全部识别失败：直接报错，避免把失败占位符当内容硬翻译
  if (imageDataUrls.length > 0 && ocrFailed === imageDataUrls.length && !combinedInput.trim()) {
    throw new Error('OCR_FAILED');
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
  return { translated, sourceLang, targetLang, ocrFailed };
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
          // 跨天副本沿用稳定 id，后续完成/编辑/删除才能精确同步全部历史文件
          if (!t.id) t.id = 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
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

// 路径安全:词法校验(防 ../ 穿越) + 真实路径校验(防符号链接/Junction 逃逸)
// 已存在的文件验证 realpath;不存在(新建)则向上找存在的最深祖先目录验证真实路径后拼回
function safeJoin(baseDir, name) {
  if (typeof name !== 'string' || !name) throw new Error('INVALID_PATH');
  const base = path.resolve(baseDir);
  const full = path.resolve(base, name);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error('INVALID_PATH');
  let target = full;
  const suffix = [];
  while (!fs.existsSync(target) && target !== path.dirname(target)) {
    suffix.unshift(path.basename(target));
    target = path.dirname(target);
  }
  try {
    const realTarget = fs.realpathSync(target);
    const realBase = fs.realpathSync(base);
    let realFull = realTarget;
    for (const s of suffix) realFull = path.join(realFull, s);
    if (realFull !== realBase && !realFull.startsWith(realBase + path.sep)) throw new Error('INVALID_PATH');
  } catch (e) {
    throw new Error('INVALID_PATH'); // realpath 失败或真实路径逃出根目录,一律拒绝
  }
  return full;
}

// 笔记文件名:必须是根目录下单层 .md 文件(禁止子目录/路径/其他扩展名)
function validateNoteName(filename) {
  if (typeof filename !== 'string' || !filename) return false;
  if (path.basename(filename) !== filename) return false;
  return filename.toLowerCase().endsWith('.md');
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
  if (!validateNoteName(filename)) return getPinnedNotes(); // 非法文件名拒绝置顶
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
  if (!validateNoteName(filename)) return ''; // 非法文件名按"文件不存在"处理
  let filePath;
  try { filePath = safeJoin(getNotesDir(), filename); }
  catch (e) { return ''; } // 非法路径按"文件不存在"处理
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

function saveNote(filename, content) {
  if (!validateNoteName(filename)) throw new Error('INVALID_PATH');
  const dir = getNotesDir();
  ensureDir(dir);
  atomicWriteFileSync(safeJoin(dir, filename), content, 'utf-8');
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
  if (!validateNoteName(oldName) || !validateNoteName(newName)) throw new Error('INVALID_PATH'); // 禁跨目录/改扩展名
  const dir = getNotesDir();
  const oldPath = safeJoin(dir, oldName);
  const newPath = safeJoin(dir, newName);
  if (!fs.existsSync(oldPath)) throw new Error('FILE_NOT_FOUND');
  if (fs.existsSync(newPath)) throw new Error('FILE_EXISTS');
  fs.renameSync(oldPath, newPath);
  const pinned = getPinnedNotes();
  const idx = pinned.indexOf(oldName);
  if (idx !== -1) { pinned[idx] = newName; savePinnedNotes(pinned); }
}

function deleteNoteFile(filename) {
  if (!validateNoteName(filename)) return; // 非法文件名按"文件不存在"处理
  let filePath;
  try { filePath = safeJoin(getNotesDir(), filename); }
  catch (e) { return; } // 非法路径按"文件不存在"处理
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
  if (!validateNoteName(filename)) return null; // 源文件名非法则放弃
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
    summary = summary.replace(/[，,。\.！!？?\n\r\/\\]/g, '').trim().slice(0, 15);
    if (!summary) return null;
    const newName = `${summary}.md`;
    if (!validateNoteName(newName)) return null; // AI 摘要含路径分隔符则放弃
    const dir = getNotesDir();
    const oldPath = safeJoin(dir, filename);
    const newPath = safeJoin(dir, newName);
    if (fs.existsSync(newPath)) {
      let n = 2;
      while (fs.existsSync(safeJoin(dir, `${summary}_${n}.md`))) n++;
      const altName = `${summary}_${n}.md`;
      fs.renameSync(oldPath, safeJoin(dir, altName));
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

  const taskLines = tasks.map(t => `<div class="task-name">「${escapeHtml(t)}」</div>`).join('');

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

// ========== 输入校验(防内存/磁盘耗尽) ==========
const MAX_TASKS = 1000;                 // 任务数组条数
const MAX_TASK_LEN = 1000;              // 单条任务文本长度
const MAX_NOTE_LEN = 5 * 1024 * 1024;   // 笔记内容(字符数)
const MAX_IMAGE_DATAURL_LEN = 14 * 1024 * 1024; // 图片 data URL 字符串长度(base64 4/3 膨胀,14MB 解码约 10.5MB)
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;       // 图片解码后字节数(与渲染层限制一致)
const MAX_IMAGE_READ_BYTES = 10 * 1024 * 1024;  // 读取磁盘图片文件上限(防外部放入的超大文件被读入内存)
const MAX_AI_TEXT_LEN = 10000;          // AI 输入文本长度
const MAX_AI_IMAGES = 5;                // AI 附带图片张数

// ========== IPC 安全 ==========
const MAIN_PAGE_URL = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;

// 只接受主页面(index.html)发出的 IPC,拒绝其他 webContents/frame
function isTrustedSender(event) {
  const url = event && event.senderFrame ? event.senderFrame.url : '';
  return typeof url === 'string' && url.toLowerCase() === MAIN_PAGE_URL.toLowerCase();
}

// 图片附件相对路径:必须 attachments/ 下单层文件 + 固定图片扩展名
const IMAGE_REL_RE = /^attachments\/[^\\/]+\.(png|jpe?g|gif|webp|bmp)$/i;
function validateImageRelPath(relPath) {
  return typeof relPath === 'string' && IMAGE_REL_RE.test(relPath);
}

// 文件魔数检测(不信 Data URL 声明的 MIME):返回实际类型,无法识别返回 null
function detectImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return null;
}

function validateTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length > MAX_TASKS) throw new Error('INPUT_TOO_LARGE');
  for (const t of tasks) {
    if (!t || typeof t !== 'object') throw new Error('INPUT_TOO_LARGE');
    if (typeof t.task === 'string' && t.task.length > MAX_TASK_LEN) throw new Error('INPUT_TOO_LARGE');
  }
}

function validateNoteContent(content) {
  if (typeof content !== 'string' || content.length > MAX_NOTE_LEN) throw new Error('INPUT_TOO_LARGE');
}

function validateImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_IMAGE_DATAURL_LEN) throw new Error('INPUT_TOO_LARGE');
  const comma = dataUrl.indexOf(',');
  if (comma === -1 || !/^data:image\/[a-zA-Z0-9.+-]+;base64$/.test(dataUrl.slice(0, comma))) throw new Error('INPUT_TOO_LARGE');
  const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('INPUT_TOO_LARGE');
  return buf;
}

function validateAiInput(text, images) {
  if (text != null && (typeof text !== 'string' || text.length > MAX_AI_TEXT_LEN)) throw new Error('INPUT_TOO_LARGE');
  if (!Array.isArray(images) || images.length > MAX_AI_IMAGES) throw new Error('INPUT_TOO_LARGE');
  for (const d of images) validateImageDataUrl(d);
}

function emitHarnessEvent(event) {
  if (win && !win.isDestroyed()) win.webContents.send('harness:event', event);
  // 任务结束时的系统通知：由主进程按窗口可见性权威判断，避免依赖渲染层状态
  if (event && (event.type === 'result' || event.type === 'error')) {
    const visible = win && !win.isDestroyed() && win.isVisible();
    if (!visible) showHarnessNotification(event.type === 'result');
  }
}

function showHarnessNotification(success) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: '便利贴',
    body: success ? 'Harness 任务已完成' : 'Harness 任务失败',
    icon: APP_ICON,
  });
  notification.on('click', () => showWindow());
  notification.show();
}

// ========== Harness 网页版（dsh web）懒启动 ==========
// 便利贴启动时不拉起服务；用户点击卡片状态区时，才在后台启动 `dsh web`
// （等价于 `启动 DeepSeek Harness.bat` 里的 `pnpm dsh web`）并打开浏览器。

/** 定位可执行的 Harness CLI 入口：优先构建产物（纯 JS、无 tsx/esbuild 子进程），其次回退到 tsx 直跑源码。 */
function harnessWebEntry(installDir) {
  const built = path.join(installDir, 'apps', 'cli', 'lib', 'bin.js');
  if (fs.existsSync(built)) return [built];
  const source = path.join(installDir, 'apps', 'cli', 'src', 'bin.ts');
  if (fs.existsSync(source)) return ['--import', 'tsx/esm', source];
  return null;
}

function isPortListening(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = nodeNet.connect({ host, port });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs || 400);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = async () => {
      if (await isPortListening(host, port, 400)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 250);
    };
    void tick();
  });
}

async function openHarnessWeb() {
  const url = 'http://127.0.0.1:3080';
  const cfg = harnessConfig(loadConfig(), __dirname);
  if (cfg.enabled === false) return { success: false, error: 'DeepSeek Harness 已禁用' };
  if (!path.isAbsolute(cfg.installDir) || !fs.existsSync(cfg.installDir)) {
    return { success: false, error: 'Harness 安装目录不存在' };
  }
  if (!fs.existsSync(cfg.nodePath)) return { success: false, error: 'Node.js 路径不存在' };
  const entry = harnessWebEntry(cfg.installDir);
  if (!entry) return { success: false, error: '未找到 Harness CLI 入口，请先在安装目录运行 pnpm run build' };

  // 端口已在监听（可能是手动跑 bat 或上一次启动的）→ 直接打开浏览器。
  if (await isPortListening('127.0.0.1', 3080, 400)) {
    shell.openExternal(url).catch(() => {});
    return { success: true };
  }

  // 尚未启动 → 后台拉起服务。
  if (!(harnessWebChild && harnessWebChild.exitCode === null)) {
    harnessWebStderr = '';
    const child = spawn(cfg.nodePath, [...entry, 'web'], {
      cwd: cfg.installDir,
      env: { ...process.env },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    harnessWebChild = child;
    child.stderr.on('data', (chunk) => {
      harnessWebStderr = (harnessWebStderr + chunk.toString()).slice(-4000);
    });
    child.on('error', (err) => {
      if (harnessWebChild === child) harnessWebChild = null;
      harnessWebStderr = err.message;
    });
    child.on('exit', () => {
      if (harnessWebChild === child) harnessWebChild = null;
    });
  }

  // 等待端口就绪（冷启动可能较慢）；子进程提前退出则立即失败，不干等。
  const child = harnessWebChild;
  const ready = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    if (!child || child.exitCode !== null) return finish(false);
    child.once('exit', () => finish(false));
    child.once('error', () => finish(false));
    waitForPort('127.0.0.1', 3080, 25000).then((value) => finish(value));
  });
  shell.openExternal(url).catch(() => {});
  if (!ready) {
    const hint = harnessWebStderr.trim();
    return { success: false, error: hint || 'Harness 网页版启动失败或超时，浏览器已打开，请稍后刷新页面' };
  }
  return { success: true };
}

// 确保 `dsh web` 与会话明文存储（compression: none），使便利贴与网页共用同一
// 批 session.jsonl。写入 home 级补丁 $DSH_HOME/cordis.patch.yml（作用于所有
// profile，无需改动启动脚本），幂等：已存在同 id 行则跳过。
function ensureWebCompressionNone() {
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const cfg = harnessConfig(loadConfig(), __dirname);
    const migration = spawnSync(cfg.nodePath, [
      path.join(__dirname, 'harness', 'migrate-sessions.mjs'),
      dshSessionsRoot(),
      path.join(userDataPath, 'harness-sessions'),
      cfg.installDir,
    ], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (migration.error || migration.status !== 0) {
      throw migration.error || new Error(migration.stderr.trim() || 'Harness session migration failed');
    }
    const patchPath = path.join(home, 'cordis.patch.yml');
    const block = [
      '# Written by 便利贴 (sticky-notes) so its Harness and `dsh web` share one plain-JSONL session store.',
      '- id: session-persistence-jsonl',
      '  config:',
      "    root: !!js dshHomePath('sessions')",
      '    compression: none',
      '',
    ].join('\n');
    fs.mkdirSync(home, { recursive: true });
    if (!fs.existsSync(patchPath)) {
      fs.writeFileSync(patchPath, block, 'utf8');
      return;
    }
    const existing = fs.readFileSync(patchPath, 'utf8');
    if (existing.includes('session-persistence-jsonl')) return; // 已配置
    fs.writeFileSync(patchPath, existing.replace(/\s*$/, '\n\n') + block, 'utf8');
  } catch (e) {
    console.error('Harness shared-session setup failed:', e);
  }
}

// 网页端任务完成 → 复用便利贴的推送逻辑：窗口可见时发内部事件给渲染层弹底部提示，
// 隐藏时直接弹 Windows 系统通知。
function notifyExternalComplete(success) {
  if (win && !win.isDestroyed() && win.isVisible()) {
    win.webContents.send('harness:event', { type: 'external-complete', success });
  } else {
    showHarnessNotification(success);
  }
}

function collectWebSessionFiles(root) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  for (const project of fs.readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectPath = path.join(root, project.name);
    for (const session of fs.readdirSync(projectPath, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      if (session.name.startsWith('sticky-')) continue; // 便利贴自己发起的会话，无需监听
      const filePath = path.join(projectPath, session.name, 'session.jsonl');
      if (fs.existsSync(filePath)) found.push(filePath);
    }
  }
  return found;
}

let webWatcherTimer = null;
const webWatcherSeen = new Map(); // filePath -> { mtimeMs, size, turnEnds, outcome }
let webWatcherBaseline = false;

function pollWebSessions() {
  let files = [];
  try { files = collectWebSessionFiles(dshSessionsRoot()); } catch { return; }
  for (const filePath of files) {
    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }
    const prev = webWatcherSeen.get(filePath);
    if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) continue;
    let session = null;
    try { session = parseSessionFile(filePath); } catch { continue; }
    if (!session) continue;
    const entry = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      turnEnds: session.turnEnds || 0,
      outcome: session.outcome || 'idle',
    };
    const isWebSession = !String(session.id).startsWith('sticky-');
    // 网页会话「新增或内容变化」时实时通知渲染层刷新会话列表并同步当前会话进度，
    // 这样任务即使尚未完成，便利贴里也能看到进行中的消息/待办/工具调用。
    // 便利贴自己发起的任务已由 bridge 的事件流实时更新，此处跳过避免重复覆盖。
    if (webWatcherBaseline && isWebSession) {
      emitHarnessEvent({ type: 'sessions-changed', sessionId: session.id });
    }
    // 仅在基线建立后、网页会话出现新的轮次结束时再弹「完成/失败」提示。
    if (webWatcherBaseline && prev && isWebSession) {
      if ((session.turnEnds || 0) > (prev.turnEnds || 0)) {
        const outcome = session.outcome || 'idle';
        if (outcome === 'completed') notifyExternalComplete(true);
        else if (!['completed', 'idle', 'aborted', 'interrupted'].includes(outcome)) notifyExternalComplete(false);
      }
    }
    webWatcherSeen.set(filePath, entry);
  }
  for (const key of webWatcherSeen.keys()) {
    if (!files.includes(key)) webWatcherSeen.delete(key);
  }
  webWatcherBaseline = true;
}

function startWebSessionWatcher() {
  if (webWatcherTimer) return;
  webWatcherTimer = setInterval(pollWebSessions, 2000);
}

// ========== IPC 处理 ==========
function setupIPC() {
  ipcMain.handle('organize-request', async (_event, { text, images, project }) => {
    try {
      if (!isTrustedSender(_event)) throw new Error('FORBIDDEN');
      validateAiInput(text, images);
      const tasks = await organizeText(text, images, project);
      return { success: true, tasks };
    } catch (e) {
      const errMap = {
        'NO_API_KEY': '请先配置 API Key',
        'AUTH_FAILED': 'API Key 无效，请重新配置',
        'INSUFFICIENT_FUNDS': 'API 余额不足，请充值后重试',
        'EMPTY_INPUT': '请输入内容',
        'PARSE_ERROR': 'AI 返回格式异常，请重试',
        'INPUT_TOO_LARGE': '输入内容过大',
        'FORBIDDEN': '请求被拒绝',
      };
      const msg = errMap[e.message] || `AI 服务异常：${e.message}`;
      return { success: false, error: msg };
    }
  });

  ipcMain.handle('get-config', (_event) => {
    if (!isTrustedSender(_event)) return null;
    const cfg = loadConfig();
    const { apiKey, ...safe } = cfg; // 不向渲染层返回 API Key
    return safe;
  });
  ipcMain.handle('has-api-key', (_event) => {
    if (!isTrustedSender(_event)) return false;
    return !!loadConfig().apiKey;
  });
  ipcMain.handle('set-settings-open', (_e, open) => { if (isTrustedSender(_e)) settingsOpen = open; });
  // 配置白名单:渲染层只能改这些字段,其余字段(含 apiKey 结构)一律丢弃
  const CONFIG_WHITELIST = ['baseUrl', 'reportName', 'notesDir', 'projectNames', 'shortcuts', 'pagesEnabled', 'blurHide', 'winFixed', 'showSheetBar', 'showProjectBadge', 'showDailyReport', 'showCalendar'];
  ipcMain.handle('save-config', async (_event, cfg) => {
    if (!isTrustedSender(_event)) return { success: false, error: 'FORBIDDEN' };
    const cur = loadConfig();
    const merged = { ...cur };
    for (const key of CONFIG_WHITELIST) {
      if (cfg && cfg[key] !== undefined) merged[key] = cfg[key];
    }
    if (cfg && cfg.toolsEnabled !== undefined) {
      merged.toolsEnabled = normalizeToolsEnabled(cfg.toolsEnabled, cur.harness);
    }
    // API Key:渲染层拿不到旧 Key;仅显式输入新 Key 才更新,留空/占位则保留旧 Key
    if (cfg && typeof cfg.apiKey === 'string' && cfg.apiKey.trim() && !cfg.apiKey.trim().startsWith('*')) {
      merged.apiKey = cfg.apiKey.trim();
    }
    if (cfg && cfg.harness !== undefined) {
      merged.harness = sanitizeHarnessSettings(cfg.harness, cur.harness);
    }
    // 笔记目录变更需主进程确认(防受控渲染层替换受信任根目录)
    const newDir = String(merged.notesDir || '').trim();
    const oldDir = String(cur.notesDir || '').trim();
    if (newDir !== oldDir) {
      try {
        const { response } = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: ['确认修改', '取消'],
          defaultId: 1,
          cancelId: 1,
          message: '确认修改笔记目录？',
          detail: `笔记目录将从「${oldDir || '默认位置'}」修改为「${newDir}」`,
        });
        if (response !== 0) merged.notesDir = cur.notesDir; // 取消则保持旧目录
      } catch (e) {
        merged.notesDir = cur.notesDir; // 弹窗失败保守拒绝
      }
    }
    const harnessChanged = JSON.stringify(cur.harness || {}) !== JSON.stringify(merged.harness || {});
    try { saveConfig(merged); }
    catch (e) { return { success: false, error: 'WRITE_FAILED' }; }
    if (harnessChanged) harnessManager?.reset();
    return { success: true };
  });
  ipcMain.handle('get-login-settings', (_e) => { if (!isTrustedSender(_e)) return false; return app.getLoginItemSettings().openAtLogin; });
  ipcMain.handle('set-login-settings', (_e, enabled) => { if (isTrustedSender(_e)) app.setLoginItemSettings({ openAtLogin: enabled }); });
  ipcMain.handle('load-tasks', (_e) => { if (!isTrustedSender(_e)) return []; return loadTasksFromFile(); });
  ipcMain.handle('save-tasks', (_event, tasks) => {
    if (!isTrustedSender(_event)) return { success: false, error: 'FORBIDDEN' };
    try { validateTasks(tasks); }
    catch (e) { return { success: false, error: e.message }; }
    try { saveTasksToFile(tasks); return { success: true }; }
    catch (e) { return { success: false, error: 'WRITE_FAILED' }; }
  });
  // 按日期读/写历史任务文件(day 视图显示该日期全部任务,含已完成);日期格式校验防目录穿越
  const TASK_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  ipcMain.handle('list-tasks-files', (_e) => {
    if (!isTrustedSender(_e)) return [];
    const dir = path.join(userDataPath, 'tasks');
    try { return fs.existsSync(dir) ? fs.readdirSync(dir) : []; }
    catch (e) { return []; }
  });
  ipcMain.handle('load-tasks-by-date', (_e, dateStr) => {
    if (!isTrustedSender(_e) || !TASK_DATE_RE.test(dateStr || '')) return [];
    return readJSON(path.join(userDataPath, 'tasks', `${dateStr}.json`)) || [];
  });
  ipcMain.handle('save-tasks-by-date', (_e, dateStr, tasks) => {
    if (!isTrustedSender(_e) || !TASK_DATE_RE.test(dateStr || '')) return { success: false, error: 'FORBIDDEN' };
    try { validateTasks(tasks); }
    catch (e) { return { success: false, error: e.message }; }
    try {
      writeJSON(path.join(userDataPath, 'tasks', `${dateStr}.json`), tasks);
      return { success: true };
    } catch (e) {
      return { success: false, error: 'WRITE_FAILED' };
    }
  });

  ipcMain.on('renderer-ready-to-quit', (_event, saved) => {
    if (!isTrustedSender(_event) || !quitSavePending) return;
    if (saved !== true) {
      quitSavePending = false;
      clearTimeout(quitSaveTimer);
      quitSaveTimer = null;
      showWindow();
      return;
    }
    finishQuitAfterRendererSave();
  });
  ipcMain.handle('set-window-fixed', (_e, fixed) => {
    if (!isTrustedSender(_e)) return;
    winFixed = fixed;
    if (win && !win.isDestroyed() && fixed) {
      const { x, y, width, height } = getWindowPosition();
      win.setBounds({ x, y, width, height });
    }
  });

  ipcMain.handle('set-page', (_e, page) => { if (isTrustedSender(_e)) currentPage = page; });
  ipcMain.handle('get-page', (_e) => isTrustedSender(_e) ? currentPage : 'main');
  ipcMain.handle('list-notes', (_e) => { if (!isTrustedSender(_e)) return []; return listNotes(); });
  ipcMain.handle('get-pinned-notes', (_e) => { if (!isTrustedSender(_e)) return []; return getPinnedNotes(); });
  ipcMain.handle('toggle-pin-note', (_e, filename) => { if (!isTrustedSender(_e)) return getPinnedNotes(); return togglePinNote(filename); });
  ipcMain.handle('read-note', (_e, filename) => { if (!isTrustedSender(_e)) return ''; return readNote(filename); });
  ipcMain.handle('save-note', (_e, filename, content) => {
    if (!isTrustedSender(_e)) return { success: false, error: 'FORBIDDEN' };
    try { validateNoteContent(content); }
    catch (err) { return { success: false, error: err.message }; }
    try { saveNote(filename, content); return { success: true }; }
    catch (err) { return { success: false, error: err.message }; }
  });
  ipcMain.handle('create-note', (_e) => { if (!isTrustedSender(_e)) return null; return createNote(); });
  ipcMain.handle('rename-note', (_e, oldName, newName) => {
    if (!isTrustedSender(_e)) return { success: false, error: 'FORBIDDEN' };
    try { renameNoteFile(oldName, newName); return { success: true }; }
    catch (err) { return { success: false, error: err.message }; }
  });
  ipcMain.handle('delete-note', (_e, filename) => {
    if (!isTrustedSender(_e)) return { success: false, error: 'FORBIDDEN' };
    deleteNoteFile(filename); return { success: true };
  });
  ipcMain.handle('save-note-image', (_event, dataUrl) => {
    if (!isTrustedSender(_event)) return { error: 'Invalid data URL' };
    let buf;
    try { buf = validateImageDataUrl(dataUrl); }
    catch (e) { return { error: 'Invalid data URL' }; }
    const type = detectImageType(buf); // 魔数验证:不信 Data URL 声明
    if (!type) return { error: 'Invalid data URL' };
    const dir = path.join(getNotesDir(), 'attachments');
    ensureDir(dir);
    const filename = `img_${Date.now()}.${type}`; // 扩展名取自真实文件类型
    fs.writeFileSync(path.join(dir, filename), buf);
    return { filename: `attachments/${filename}` };
  });
  ipcMain.handle('read-note-image', (_e, relativePath) => {
    if (!isTrustedSender(_e)) return null;
    if (!validateImageRelPath(relativePath)) return null; // 仅 attachments/ 单层图片
    let fullPath;
    try { fullPath = safeJoin(getNotesDir(), relativePath); }
    catch (e) { return null; }
    if (!fs.existsSync(fullPath)) return null;
    try {
      if (fs.statSync(fullPath).size > MAX_IMAGE_READ_BYTES) return null; // 超大文件拒读
      const data = fs.readFileSync(fullPath);
      if (!detectImageType(data)) return null; // 伪装文件(扩展名与内容不符)拒读
      const ext = path.extname(relativePath).toLowerCase();
      const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
      return `data:${mimeTypes[ext] || 'image/png'};base64,${data.toString('base64')}`;
    } catch (e) { return null; }
  });
  ipcMain.handle('open-note-image', (_e, relativePath) => {
    if (!isTrustedSender(_e)) return { error: 'File not found' };
    if (!validateImageRelPath(relativePath)) return { error: 'File not found' };
    let fullPath;
    try { fullPath = safeJoin(getNotesDir(), relativePath); }
    catch (e) { return { error: 'File not found' }; }
    if (!fs.existsSync(fullPath)) return { error: 'File not found' };
    try { // 打开前复核:大小限制 + 魔数,防止外部放置的超大/伪装文件被系统关联程序执行
      if (fs.statSync(fullPath).size > MAX_IMAGE_READ_BYTES) return { error: 'File not found' };
      const fd = fs.openSync(fullPath, 'r');
      const head = Buffer.alloc(12);
      fs.readSync(fd, head, 0, 12, 0);
      fs.closeSync(fd);
      if (!detectImageType(head)) return { error: 'File not found' };
    } catch (e) { return { error: 'File not found' }; }
    shell.openPath(fullPath);
    return { success: true };
  });
  ipcMain.handle('delete-note-image', (_e, relativePath) => {
    if (!isTrustedSender(_e)) return { success: true };
    if (!validateImageRelPath(relativePath)) return { success: true };
    let fullPath;
    try { fullPath = safeJoin(getNotesDir(), relativePath); }
    catch (e) { return { success: true }; }
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
    if (!isTrustedSender(_e)) return { newFilename: null };
    const newName = await aiNameNote(filename, content);
    return { newFilename: newName };
  });

  ipcMain.handle('generate-daily-report', (_event, tasks) => {
    if (!isTrustedSender(_event)) return { report: '' };
    try { validateTasks(tasks); }
    catch (e) { return { report: '' }; }
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
      if (!isTrustedSender(_event)) throw new Error('FORBIDDEN');
      validateAiInput(text, images);
      const res = await translateText(text || '', images || []);
      return { success: true, translated: res.translated, sourceLang: res.sourceLang, targetLang: res.targetLang };
    } catch (e) {
      const errMap = {
        'NO_API_KEY': '请先配置 API Key',
        'AUTH_FAILED': 'API Key 无效，请重新配置',
        'INSUFFICIENT_FUNDS': 'API 余额不足，请充值后重试',
        'EMPTY_INPUT': '请输入内容',
        'OCR_FAILED': '图片识别失败，请重试或直接输入文字',
        'INPUT_TOO_LARGE': '输入内容过大',
        'FORBIDDEN': '请求被拒绝',
      };
      const msg = errMap[e.message] || `翻译服务异常：${e.message}`;
      return { success: false, error: msg };
    }
  });

  ipcMain.handle('harness-snapshot', (_event) => {
    if (!isTrustedSender(_event) || !harnessManager) return null;
    return harnessManager.snapshot();
  });
  ipcMain.handle('harness-list-sessions', (_event) => {
    if (!isTrustedSender(_event) || !harnessManager) return [];
    return harnessManager.listSessions();
  });
  ipcMain.handle('harness-load-session', (_event, sessionId) => {
    if (!isTrustedSender(_event) || !harnessManager || typeof sessionId !== 'string') return null;
    return harnessManager.loadSession(sessionId);
  });
  ipcMain.handle('harness-select-workspace', async (_event) => {
    if (!isTrustedSender(_event)) return { success: false, error: 'FORBIDDEN' };
    const cfg = loadConfig();
    const current = sanitizeHarnessSettings(cfg.harness);
    const result = await dialog.showOpenDialog(win, {
      title: '选择 Harness 工作目录',
      defaultPath: current.workspace || __dirname,
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return { success: false, cancelled: true };
    cfg.harness = { ...current, workspace: result.filePaths[0] };
    saveConfig(cfg);
    harnessManager?.reset();
    return { success: true, workspace: cfg.harness.workspace };
  });
  ipcMain.handle('harness-update-options', (_event, payload) => {
    try {
      if (!isTrustedSender(_event) || !harnessManager) return { success: false, error: 'FORBIDDEN' };
      if (['starting', 'running', 'stopping'].includes(harnessManager.snapshot().status)) {
        return { success: false, error: '任务执行期间无法切换模型或推理等级' };
      }
      const cfg = loadConfig();
      const current = sanitizeHarnessSettings(cfg.harness);
      const next = sanitizeHarnessSettings({
        ...current,
        model: payload && payload.model,
        reasoningEffort: payload && payload.reasoningEffort,
      }, current);
      const changed = current.model !== next.model || current.reasoningEffort !== next.reasoningEffort;
      cfg.harness = next;
      saveConfig(cfg);
      // Restarting the bridge must not broadcast an idle snapshot: the tools card
      // should keep showing the completed session with process output folded.
      if (changed) harnessManager.reset({ emitSnapshot: false });
      return { success: true, model: next.model, reasoningEffort: next.reasoningEffort };
    } catch (error) {
      return { success: false, error: error.message || '保存 Harness 选项失败' };
    }
  });
  ipcMain.handle('harness-start', async (_event, payload) => {
    if (!isTrustedSender(_event) || !harnessManager) return { success: false, error: 'FORBIDDEN' };
    const text = payload && typeof payload.text === 'string' ? payload.text : '';
    const sessionId = payload && typeof payload.sessionId === 'string' ? payload.sessionId : null;
    const snapshot = harnessManager.snapshot();
    if (!snapshot.configured) return { success: false, error: snapshot.configError };
    if (!text.trim() || text.length > 8000) {
      return { success: false, error: text.trim() ? '任务内容过长' : '请输入任务内容' };
    }
    const cfg = sanitizeHarnessSettings(loadConfig().harness);
    const fullCfg = loadConfig();
    // 写权限授权：按工作目录记忆，首次确认后不再每次弹窗；更换目录或重置后重新询问
    if (cfg.permission === 'workspace-write' && fullCfg.harnessWorkspaceApproved !== cfg.workspace) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['运行任务', '取消'],
        defaultId: 1,
        cancelId: 1,
        message: '允许 Harness 修改工作目录？',
        detail: `${cfg.workspace || '尚未选择目录'}\n\nHarness 可以读取并修改此目录中的文件。\n确认后不再每次询问，直到更换工作目录或在设置中重置授权。`,
      });
      if (response !== 0) return { success: false, cancelled: true };
      fullCfg.harnessWorkspaceApproved = cfg.workspace;
      saveConfig(fullCfg);
    }
    return harnessManager.run(text, sessionId);
  });
  ipcMain.handle('harness-stop', async (_event) => {
    if (!isTrustedSender(_event) || !harnessManager) return { success: false, error: 'FORBIDDEN' };
    return harnessManager.stop();
  });
  ipcMain.handle('harness-new-session', (_event) => {
    if (!isTrustedSender(_event) || !harnessManager) return { success: false, error: 'FORBIDDEN' };
    return harnessManager.newSession();
  });
  ipcMain.handle('harness-reset-workspace-approval', (_event) => {
    if (!isTrustedSender(_event)) return { success: false, error: 'FORBIDDEN' };
    const cfg = loadConfig();
    if (cfg.harnessWorkspaceApproved !== undefined) {
      delete cfg.harnessWorkspaceApproved;
      saveConfig(cfg);
    }
    return { success: true };
  });
  ipcMain.handle('harness-open-web', async (_event) => {
    if (!isTrustedSender(_event)) return { success: false, error: 'FORBIDDEN' };
    try {
      return await openHarnessWeb();
    } catch (error) {
      return { success: false, error: error.message || '打开 Harness 网页版失败' };
    }
  });
}

// ========== 窗口管理 ==========
function getWindowPosition() {
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  if (!winFixed && savedWinX != null && savedWinY != null) {
    const bounds = { x: savedWinX, y: savedWinY, width: 360, height: 500 };
    return fitBoundsToWorkArea(bounds, screen.getDisplayMatching(bounds).workArea);
  }
  return {
    x: primaryWorkArea.x + primaryWorkArea.width - 360 - 8,
    y: primaryWorkArea.y + primaryWorkArea.height - 500,
    width: 360,
    height: 500,
  };
}

function createWindow() {
  const { x, y, width, height } = getWindowPosition();
  win = new BrowserWindow({
    width, height, x, y,
    icon: APP_ICON,
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

  // 导航与弹窗防护:禁止页面导航离开主页面,禁止新窗口
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

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
        const bounds = win.getBounds();
        const fitted = fitBoundsToWorkArea(bounds, screen.getDisplayMatching(bounds).workArea);
        if (fitted.x !== bounds.x || fitted.y !== bounds.y) win.setBounds(fitted);
        saveWindowState(fitted.x, fitted.y);
      }
    }, 500);
  });

  win.on('close', (e) => {
    if (app.isQuitting) return; // 真正退出，允许窗口关闭
    e.preventDefault();
    win.webContents.send('window-will-hide'); // 保持渲染层可见性状态与窗口一致
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
  return nativeImage.createFromPath(APP_ICON);
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
    { label: '退出便利贴', click: () => app.quit() },
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
    let relativePath;
    try { relativePath = decodeURIComponent(url.host + url.pathname); }
    catch (e) { return new Response('Not Found', { status: 404 }); } // 非法百分号编码
    let fullPath;
    try { fullPath = safeJoin(getNotesDir(), relativePath); }
    catch (e) { return new Response('Not Found', { status: 404 }); }
    try {
      return net.fetch(`file:///${fullPath.replace(/\\/g, '/')}`);
    } catch (e) {
      return new Response('Not Found', { status: 404 });
    }
  });

  harnessManager = new HarnessManager({
    appRoot: __dirname,
    userDataPath,
    getConfig: loadConfig,
    emit: emitHarnessEvent,
  });
  setupIPC();
  createTray();
  ensureWebCompressionNone();
  startWebSessionWatcher();

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

function finishQuitAfterRendererSave() {
  if (quitSaveReady) return;
  quitSaveReady = true;
  quitSavePending = false;
  clearTimeout(quitSaveTimer);
  quitSaveTimer = null;
  app.isQuitting = true;
  app.quit();
}

app.on('before-quit', (event) => {
  if (!quitSaveReady && win && !win.isDestroyed()) {
    event.preventDefault();
    if (!quitSavePending) {
      quitSavePending = true;
      win.webContents.send('app-before-quit');
      // 渲染进程异常时不能让应用永久无法退出。
      quitSaveTimer = setTimeout(finishQuitAfterRendererSave, 3000);
    }
    return;
  }
  app.isQuitting = true;
  harnessManager?.dispose();
  if (harnessWebChild && harnessWebChild.exitCode === null) {
    harnessWebChild.kill();
    harnessWebChild = null;
  }
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  clearTimeout(ocrIdleTimer);
  if (ocrWorker) { ocrWorker.terminate().catch(() => {}); ocrWorker = null; }
});
