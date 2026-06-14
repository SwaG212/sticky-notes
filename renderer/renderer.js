// ========== 状态管理 ==========
const state = {
  tasks: [],
  images: [],
  organizing: false,
  currentPage: 'main',
  notes: [],
  currentNoteFile: null,
  noteContent: '',
};

// ========== DOM 引用 ==========
const $ = (sel) => document.querySelector(sel);
const taskItems = $('#task-items');
const taskEmpty = $('#task-empty');
const textInput = $('#text-input');
const imagePreviews = $('#image-previews');
const btnOrganize = $('#btn-organize');
const configOverlay = $('#config-overlay');
const processingOverlay = $('#processing-overlay');
const processingText = $('#processing-text');
const app = $('#app');
const pagesContainer = $('.pages-container');
const btnSwitchNotepad = $('#btn-switch-notepad');
const btnNoteList = $('#btn-note-list');
const btnNoteNew = $('#btn-note-new');
const btnNotepadBack = $('#btn-notepad-back');
const notepadTextarea = $('#notepad-textarea');
const noteListOverlay = $('#note-list-overlay');
const noteListItems = $('#note-list-items');

// ========== 初始化 ==========
async function init() {
  await loadTasks();
  renderTasks();
  updateOrganizeButton();

  textInput.addEventListener('input', updateOrganizeButton);
  textInput.addEventListener('paste', handlePaste);
  textInput.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); organize(); }
  });

  btnOrganize.addEventListener('click', organize);
  $('#btn-config-save').addEventListener('click', saveConfig);
  btnSwitchNotepad.addEventListener('click', switchToNotepad);
  btnNotepadBack.addEventListener('click', switchToMain);
  btnNoteList.addEventListener('click', toggleNoteList);
  btnNoteNew.addEventListener('click', createNote);
  notepadTextarea.addEventListener('input', onNotepadInput);
  notepadTextarea.addEventListener('paste', handleNotepadPaste);

  if (window.electronAPI) {
    window.electronAPI.onOpenConfig(() => showConfig());
    window.electronAPI.onWindowShown(() => {
      app.style.opacity = '0';
      app.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350, easing: 'ease', fill: 'forwards' });
      if (state.currentPage === 'notepad') notepadTextarea.focus();
      else textInput.focus();
    });
    window.electronAPI.onWindowWillHide(() => {
      const anim = app.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, easing: 'ease', fill: 'forwards' });
      anim.finished.then(() => { /* 动画完成，元素停在 opacity:0 */ });
      if (state.currentPage === 'notepad') {
        saveCurrentNote();
      } else if (hasContent() && !state.organizing) {
        setTimeout(() => { organize(); }, 50);
      }
    });
  }
}

// ========== 任务存储 ==========
async function loadTasks() {
  if (window.electronAPI) {
    state.tasks = await window.electronAPI.loadTasks();
  } else {
    const today = getToday();
    try {
      const raw = localStorage.getItem(`tasks_${today}`);
      state.tasks = raw ? JSON.parse(raw) : [];
    } catch (e) { state.tasks = []; }
    // 跨天清空 alarmTime（仅今天首次加载时）
    let changed = false;
    if (!raw) {
      state.tasks.forEach(t => { if (t.alarmTime) { t.alarmTime = null; changed = true; } });
    }
    // 加载昨天未完成的
    const yesterday = getYesterday();
    try {
      const raw = localStorage.getItem(`tasks_${yesterday}`);
      if (raw) {
        const unfinished = JSON.parse(raw).filter(t => !t.completed);
        if (unfinished.length > 0) {
          unfinished.forEach(t => { t.createdAt = new Date().toISOString(); t.id = genId(); t.alarmTime = null; });
          state.tasks = [...unfinished, ...state.tasks];
          changed = true;
        }
      }
    } catch (e) {}
    if (changed) saveTasks();
  }
}

async function saveTasks() {
  if (window.electronAPI) {
    await window.electronAPI.saveTasks(state.tasks);
  } else {
    localStorage.setItem(`tasks_${getToday()}`, JSON.stringify(state.tasks));
  }
}

// ========== 任务渲染 ==========
function snapshotPositions() {
  const map = {};
  taskItems.querySelectorAll('.task-item').forEach(el => {
    map[el.dataset.id] = el.getBoundingClientRect().top;
  });
  return map;
}

function renderTasks(shouldAnimate = false) {
  // FLIP 动画第一步：记录旧位置
  const oldPos = shouldAnimate ? snapshotPositions() : null;

  taskItems.innerHTML = '';
  if (state.tasks.length === 0) {
    taskEmpty.classList.remove('hidden');
    return;
  }
  taskEmpty.classList.add('hidden');

  state.tasks.forEach((task, idx) => {
    const row = document.createElement('div');
    row.className = 'task-item';
    row.dataset.id = task.id;

    const cb = document.createElement('div');
    cb.className = `task-checkbox${task.completed ? ' checked' : ''}`;
    cb.addEventListener('click', (e) => { e.stopPropagation(); toggleTask(idx); });

    const text = document.createElement('span');
    text.className = `task-text${task.completed ? ' done' : ''}`;
    text.textContent = task.task;
    text.title = task.task.length > 50 ? task.task : '';

    const alarm = document.createElement('span');
    alarm.className = 'task-alarm';
    alarm.textContent = task.alarmTime || '--:--';
    alarm.addEventListener('click', (e) => {
      e.stopPropagation();
      openTimePicker(alarm, idx);
    });

    const del = document.createElement('button');
    del.className = 'task-delete';
    del.textContent = '✕';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteTask(idx); });

    const hoverBar = document.createElement('div');
    hoverBar.className = 'hover-bar';
    hoverBar.style.display = 'none';
    hoverBar.append(alarm, del);

    row.addEventListener('mouseenter', () => { hoverBar.style.display = 'flex'; row.style.background = '#f3f3f8'; });
    row.addEventListener('mouseleave', () => { hoverBar.style.display = 'none'; row.style.background = ''; });

    let clickTimer = null;
    row.addEventListener('click', (e) => {
      if (e.target === del || e.target === alarm) return;
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
        enterEditMode(row, idx);
      } else {
        clickTimer = setTimeout(() => { clickTimer = null; }, 400);
      }
    });

    row.append(cb, text, hoverBar);
    taskItems.appendChild(row);
  });

  // FLIP 动画第二三四步：计算新位置 → 反转 → 播放
  if (oldPos) {
    taskItems.querySelectorAll('.task-item').forEach(el => {
      const id = el.dataset.id;
      const newTop = el.getBoundingClientRect().top;
      const oldTop = oldPos[id];
      if (oldTop !== undefined && Math.abs(newTop - oldTop) > 1) {
        const delta = oldTop - newTop;
        el.animate([
          { transform: `translateY(${delta}px)` },
          { transform: 'translateY(0)' }
        ], { duration: 300, easing: 'ease' });
      }
    });
  }
}

// ========== 任务操作 ==========
function sortTasks() {
  const undone = state.tasks.filter(t => !t.completed);
  const done = state.tasks.filter(t => t.completed);
  state.tasks = [...undone, ...done];
}

function toggleTask(idx) {
  state.tasks[idx].completed = !state.tasks[idx].completed;
  state.tasks[idx].completedAt = state.tasks[idx].completed ? new Date().toISOString() : null;
  sortTasks();
  saveTasks();
  renderTasks(true);
}

function deleteTask(idx) {
  state.tasks.splice(idx, 1);
  saveTasks();
  renderTasks();
}

function enterEditMode(row, idx) {
  const span = row.querySelector('.task-text');
  const oldText = state.tasks[idx].task;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'task-edit-input';
  input.value = oldText;
  span.replaceWith(input);
  input.focus();
  input.select();

  const finish = () => {
    const newText = input.value.trim();
    if (newText && newText !== oldText) { state.tasks[idx].task = newText; saveTasks(); }
    renderTasks();
  };
  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = oldText; input.blur(); }
  });
}

function addTasks(newTasks) {
  const now = new Date().toISOString();
  const items = newTasks.map(t => ({
    id: genId(), task: t.task, completed: false, createdAt: now, completedAt: null, alarmTime: null,
  }));
  state.tasks = [...items, ...state.tasks];
  saveTasks();
  renderTasks();
}

// ========== 定时提醒 ==========
let activePicker = null;

function closeActivePicker() {
  if (activePicker) { activePicker.remove(); activePicker = null; }
}

function openTimePicker(anchorEl, taskIdx) {
  closeActivePicker();

  const current = state.tasks[taskIdx].alarmTime || '';
  const curH = current.slice(0, 2) || '';
  const curM = current.slice(3, 5) || '';

  const picker = document.createElement('div');
  picker.className = 'time-picker';
  picker.innerHTML = `<button class="tp-clear">清除</button><div class="tp-cols"><div class="tp-col" id="tp-hour"></div><div class="tp-col" id="tp-min"></div></div>`;
  app.appendChild(picker);

  // 填充小时 00-23
  const colH = picker.querySelector('#tp-hour');
  for (let h = 0; h < 24; h++) {
    const opt = document.createElement('div');
    opt.className = 'tp-opt' + (String(h).padStart(2,'0') === curH ? ' active' : '');
    opt.textContent = String(h).padStart(2, '0');
    opt.addEventListener('click', () => {
      const m = state.tasks[taskIdx].alarmTime ? state.tasks[taskIdx].alarmTime.slice(3, 5) : '00';
      state.tasks[taskIdx].alarmTime = `${opt.textContent}:${m}`;
      saveTasks();
      closeActivePicker();
      renderTasks();
    });
    colH.appendChild(opt);
  }

  // 填充分钟 00-59
  const colM = picker.querySelector('#tp-min');
  for (let m = 0; m < 60; m++) {
    const opt = document.createElement('div');
    opt.className = 'tp-opt' + (String(m).padStart(2,'0') === curM ? ' active' : '');
    opt.textContent = String(m).padStart(2, '0');
    opt.addEventListener('click', () => {
      const h = state.tasks[taskIdx].alarmTime ? state.tasks[taskIdx].alarmTime.slice(0, 2) : '00';
      state.tasks[taskIdx].alarmTime = `${h}:${opt.textContent}`;
      saveTasks();
      closeActivePicker();
      renderTasks();
    });
    colM.appendChild(opt);
  }

  // 清除按钮
  picker.querySelector('.tp-clear').addEventListener('click', () => {
    state.tasks[taskIdx].alarmTime = null;
    saveTasks();
    closeActivePicker();
    renderTasks();
  });

  // 滚动到选中的位置
  if (curH) colH.querySelector('.tp-opt.active')?.scrollIntoView({ block: 'center' });
  if (curM) colM.querySelector('.tp-opt.active')?.scrollIntoView({ block: 'center' });

  // 定位：相对于 #app 容器
  const appRect = app.getBoundingClientRect();
  const anchorRect = anchorEl.getBoundingClientRect();
  picker.style.left = Math.max(8, anchorRect.left - appRect.left - 40) + 'px';
  picker.style.top = Math.max(4, anchorRect.top - appRect.top - 185) + 'px';

  // 点击外部关闭（不保存）
  setTimeout(() => {
    const closePk = (e) => {
      if (!picker.contains(e.target) && e.target !== anchorEl) {
        picker.remove();
        if (activePicker === picker) activePicker = null;
        app.removeEventListener('click', closePk);
      }
    };
    app.addEventListener('click', closePk, true);
  }, 0);

  activePicker = picker;
}

// ========== 输入处理 ==========
function hasContent() {
  return textInput.value.trim().length > 0 || state.images.length > 0;
}

function updateOrganizeButton() {
  btnOrganize.disabled = !hasContent() || state.organizing;
}

function handlePaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/') && state.images.length < 5) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (blob.size > 20 * 1024 * 1024) { alert('图片过大，单张不超过 20MB'); continue; }
      const reader = new FileReader();
      reader.onload = (ev) => { state.images.push(ev.target.result); renderImages(); updateOrganizeButton(); };
      reader.readAsDataURL(blob);
    }
  }
}

function renderImages() {
  imagePreviews.innerHTML = '';
  state.images.forEach((url) => {
    const c = document.createElement('div');
    c.className = 'image-preview-container';
    const img = document.createElement('img'); img.src = url;
    const btn = document.createElement('button');
    btn.className = 'image-preview-delete'; btn.textContent = '✕';
    btn.addEventListener('click', () => {
      // 通过 dataUrl 查找并删除，避免索引错位
      const idx = state.images.indexOf(url);
      if (idx !== -1) { state.images.splice(idx, 1); renderImages(); updateOrganizeButton(); }
    });
    c.append(img, btn);
    imagePreviews.appendChild(c);
  });
}

// ========== AI 整理 ==========
async function organize() {
  if (!hasContent() || state.organizing) return;
  state.organizing = true;
  updateOrganizeButton();

  const text = textInput.value.trim();
  const imgs = [...state.images];

  // 清空输入
  textInput.value = '';
  state.images = [];
  renderImages();

  showProcessing(true, imgs.length > 0 ? '识别图片中...' : 'AI 整理中...');

  try {
    if (window.electronAPI) {
      // 生产模式：通过 IPC 调用主进程（OCR + DeepSeek）
      const result = await window.electronAPI.organizeRequest({ text, images: imgs });
      if (result.success && result.tasks.length > 0) {
        addTasks(result.tasks);
      } else {
        // IPC 失败或无结果时 fallback，不丢失用户任务
        if (!result.success) console.warn(result.error);
        const tasks = fallbackOrganize(text, imgs);
        if (tasks.length > 0) addTasks(tasks);
      }
    } else {
      // 浏览器调试模式：fallback 简单拆分
      await sleep(500);
      const tasks = fallbackOrganize(text, imgs);
      if (tasks.length > 0) addTasks(tasks);
    }
  } catch (e) {
    showError('操作失败：' + e.message);
    textInput.value = text;
    state.images = imgs;
    renderImages();
  } finally {
    state.organizing = false;
    showProcessing(false);
    updateOrganizeButton();
  }
}

function fallbackOrganize(text, imgs) {
  const tasks = [];
  if (imgs.length > 0) tasks.push({ task: '【截图识别】请编辑此任务补充详情' });
  if (text) {
    const parts = text.split(/[\n\r。，；;,.。、]+/).map(s => s.trim()).filter(s => s.length > 1);
    if (parts.length > 1) parts.forEach(p => tasks.push({ task: p }));
    else tasks.push({ task: text });
  }
  return tasks;
}

function showError(msg) {
  // 简单 alert，后续可改为 toast
  alert(msg);
}

// ========== 配置管理 ==========
async function showConfig() {
  if (window.electronAPI) {
    const cfg = await window.electronAPI.getConfig();
    $('#config-apikey').value = cfg.apiKey || '';
    $('#config-baseurl').value = cfg.baseUrl || 'https://api.deepseek.com';
  }
  configOverlay.classList.remove('hidden');
  $('#config-apikey').focus();
}

async function saveConfig() {
  const apiKey = $('#config-apikey').value.trim();
  const baseUrl = $('#config-baseurl').value.trim() || 'https://api.deepseek.com';

  if (!apiKey) { alert('请填写 API Key'); return; }

  if (window.electronAPI) {
    await window.electronAPI.saveConfig({ apiKey, baseUrl });
  } else {
    localStorage.setItem('sticky_config', JSON.stringify({ apiKey, baseUrl }));
  }
  configOverlay.classList.add('hidden');
}

// ========== 工具函数 ==========
function genId() { return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }

function getToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function getYesterday() {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function showProcessing(show, text = '') {
  if (show) { processingText.textContent = text; processingOverlay.classList.remove('hidden'); }
  else { processingOverlay.classList.add('hidden'); }
}

// ========== 页面切换 ==========
async function switchToNotepad() {
  if (state.currentPage === 'notepad') return;
  state.currentPage = 'notepad';
  if (window.electronAPI) {
    window.electronAPI.setPage('notepad');
    // 加载笔记列表，首次进入自动创建笔记
    const notes = await window.electronAPI.listNotes();
    state.notes = notes;
    if (notes.length === 0) {
      const filename = await window.electronAPI.createNote();
      state.currentNoteFile = filename;
      state.notes = await window.electronAPI.listNotes();
    } else if (!state.currentNoteFile || !notes.find(n => n.filename === state.currentNoteFile)) {
      state.currentNoteFile = notes[0].filename;
      state.noteContent = await window.electronAPI.readNote(notes[0].filename);
    }
  }
  pagesContainer.classList.add('on-notepad');
  notepadTextarea.value = state.noteContent;
  setTimeout(() => notepadTextarea.focus(), 400);
}

async function switchToMain() {
  if (state.currentPage === 'main') return;
  // 保存当前笔记
  saveCurrentNote();
  state.currentPage = 'main';
  if (window.electronAPI) window.electronAPI.setPage('main');
  pagesContainer.classList.remove('on-notepad');
  setTimeout(() => textInput.focus(), 400);
}

// ========== 笔记管理 ==========
function onNotepadInput() {
  state.noteContent = notepadTextarea.value;
}

function handleNotepadPaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      return;
    }
  }
}

async function loadNotesList() {
  if (!window.electronAPI) return;
  state.notes = await window.electronAPI.listNotes();
}

async function openNote(filename) {
  if (filename === state.currentNoteFile) { noteListOverlay.classList.add('hidden'); return; }
  // 切换前保存+AI命名
  await saveCurrentNote();
  if (!window.electronAPI) return;
  state.currentNoteFile = filename;
  state.noteContent = await window.electronAPI.readNote(filename);
  notepadTextarea.value = state.noteContent;
  noteListOverlay.classList.add('hidden');
}

async function saveCurrentNote() {
  if (!window.electronAPI || !state.currentNoteFile) return;
  const content = state.noteContent;
  await window.electronAPI.saveNote(state.currentNoteFile, content);

  // 仅新建文件（untitled_N.md）触发 AI 命名或删除
  const isNewFile = /^untitled_\d+\.md$/.test(state.currentNoteFile);
  if (!isNewFile) return;

  if (content.trim()) {
    triggerAiName(state.currentNoteFile, content);
  } else {
    await window.electronAPI.deleteNote(state.currentNoteFile);
    state.currentNoteFile = null;
    state.noteContent = '';
    state.notes = await window.electronAPI.listNotes();
  }
}

async function createNote() {
  await saveCurrentNote();
  if (!window.electronAPI) return;
  const filename = await window.electronAPI.createNote();
  state.currentNoteFile = filename;
  state.noteContent = '';
  notepadTextarea.value = '';
  state.notes = await window.electronAPI.listNotes();
  // 如果文件列表打开着，刷新显示
  if (!noteListOverlay.classList.contains('hidden')) renderNoteList();
  notepadTextarea.focus();
}

async function triggerAiName(filename, content) {
  if (!window.electronAPI) return;
  const result = await window.electronAPI.aiNameNote(filename, content);
  if (result.newFilename && state.currentNoteFile === filename) {
    state.currentNoteFile = result.newFilename;
    state.notes = await window.electronAPI.listNotes();
    if (!noteListOverlay.classList.contains('hidden')) renderNoteList();
  }
}

// ========== 文件列表 ==========
function toggleNoteList() {
  if (noteListOverlay.classList.contains('hidden')) {
    loadNotesList().then(() => renderNoteList());
    noteListOverlay.classList.remove('hidden');
  } else {
    noteListOverlay.classList.add('hidden');
  }
}

function renderNoteList() {
  noteListItems.innerHTML = '';
  state.notes.forEach(note => {
    const row = document.createElement('div');
    row.className = 'note-list-item';
    if (note.filename === state.currentNoteFile) row.classList.add('active');
    // 显示名去掉 .md 后缀
    row.textContent = note.filename.replace(/\.md$/, '');

    let clickTimer = null;
    row.addEventListener('click', () => {
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
        enterNoteRename(row, note.filename);
      } else {
        clickTimer = setTimeout(() => {
          clickTimer = null;
          openNote(note.filename);
        }, 300);
      }
    });

    noteListItems.appendChild(row);
  });
}

function enterNoteRename(row, filename) {
  const oldName = filename.replace(/\.md$/, '');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'note-list-item-edit';
  input.value = oldName;
  row.replaceWith(input);
  input.focus();
  input.select();

  async function finish() {
    const newName = input.value.trim();
    if (newName && newName !== oldName) {
      const newFilename = newName + '.md';
      try {
        await window.electronAPI.renameNote(filename, newFilename);
        state.notes = await window.electronAPI.listNotes();
        if (state.currentNoteFile === filename) state.currentNoteFile = newFilename;
      } catch (e) {
        // 重命名失败，恢复原状
      }
    }
    renderNoteList();
    // 关闭编辑后关闭列表
    noteListOverlay.classList.add('hidden');
  }
  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = oldName; input.blur(); }
  });
}

// 点击列表外部关闭
document.addEventListener('click', (e) => {
  if (!noteListOverlay.classList.contains('hidden') &&
      !noteListOverlay.contains(e.target) &&
      e.target !== btnNoteList) {
    noteListOverlay.classList.add('hidden');
  }
});

// ========== 启动 ==========
init();
// 兜底：renderer 晚于主进程 showWindow 时，主动淡入
setTimeout(() => {
  if (parseFloat(getComputedStyle(app).opacity) < 0.1) {
    app.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350, easing: 'ease', fill: 'forwards' });
  }
}, 300);
