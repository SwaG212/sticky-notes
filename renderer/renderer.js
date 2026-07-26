// ========== 状态管理 ==========
const state = {
  tasks: [],
  images: [],
  organizing: false,
  currentPage: 'main',
  notes: [],
  currentNoteFile: null,
  noteContent: '',
  noteOriginalContent: '',
  pinnedNotes: [],
  noteSearchQuery: '',
  searchMode: 'filename',
  shortcuts: { toggle: 'Alt+`', organize: 'Ctrl+Enter', switchTask: 'Alt+1', switchNotepad: 'Alt+2' },
  projectNames: [],
  pagesEnabled: { tasks: true },
  hoveredImage: null,
};

// ========== DOM 引用 ==========
const $ = (sel) => document.querySelector(sel);
const taskItems = $('#task-items');
const taskEmpty = $('#task-empty');
const textInput = $('#text-input');
const imagePreviews = $('#image-previews');
const btnOrganize = $('#btn-organize');
const settingsOverlay = $('#settings-overlay');
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
const btnDailyReport = $('#btn-daily-report');
const dailyReportHint = $('#daily-report-hint');

// ========== 初始化 ==========
async function init() {
  await loadShortcutsFromConfig();
  if (state.pagesEnabled.tasks) {
    await loadTasks();
    renderTasks();
  } else {
    state.currentPage = 'notepad';
    pagesContainer.classList.add('on-notepad');
  }
  updateOrganizeButton();
  updateTasksPageVisibility();

  textInput.addEventListener('input', updateOrganizeButton);
  textInput.addEventListener('paste', handlePaste);
  textInput.addEventListener('keydown', (e) => {
    if (matchShortcut(e, state.shortcuts.organize)) { e.preventDefault(); e.stopPropagation(); organize(); }
  });

  btnOrganize.addEventListener('click', organize);
  $('#btn-settings-confirm').addEventListener('click', confirmSettings);
  $('#btn-settings-back').addEventListener('click', cancelSettings);
  $('#btn-settings').addEventListener('click', openSettings);
  // 文件路径下拉按钮
  $('#notesdir-dropdown-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#notesdir-dropdown');
    const btn = $('#notesdir-dropdown-btn');
    const isOpen = !menu.classList.contains('hidden');
    if (isOpen) {
      menu.classList.add('hidden');
      btn.innerHTML = '&#9660;';
    } else {
      menu.classList.remove('hidden');
      btn.innerHTML = '&#9650;';
    }
  });
  // 点击菜单外部关闭
  document.addEventListener('click', (e) => {
    const menu = $('#notesdir-dropdown');
    const btn = $('#notesdir-dropdown-btn');
    if (!menu.classList.contains('hidden') && !e.target.closest('.notesdir-combo')) {
      menu.classList.add('hidden');
      btn.innerHTML = '&#9660;';
    }
  });
  // Esc 关闭下拉菜单
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const menu = $('#notesdir-dropdown');
      const btn = $('#notesdir-dropdown-btn');
      if (!menu.classList.contains('hidden')) {
        menu.classList.add('hidden');
        btn.innerHTML = '&#9660;';
      }
    }
  });
  btnSwitchNotepad.addEventListener('click', switchToNotepad);
  btnNotepadBack.addEventListener('click', switchToMain);
  btnNoteList.addEventListener('click', toggleNoteList);
  btnNoteNew.addEventListener('click', createNote);
  btnDailyReport.addEventListener('click', generateDailyReport);
  notepadTextarea.addEventListener('input', onNotepadInput);
  notepadTextarea.addEventListener('paste', handleNotepadPaste);
  notepadTextarea.addEventListener('dblclick', handleNotepadDblClick);
  notepadTextarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveCurrentNote();
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.hoveredImage) {
      e.preventDefault();
      deleteHoveredImage();
    }
  });
  notepadTextarea.addEventListener('mouseover', (e) => {
    const img = e.target.closest('img');
    state.hoveredImage = img || null;
  });
  notepadTextarea.addEventListener('mouseout', (e) => {
    const img = e.target.closest('img');
    if (img && state.hoveredImage === img) state.hoveredImage = null;
  });

  // 快捷键捕获相关
  document.querySelectorAll('.shortcut-kbd').forEach(el => {
    el.addEventListener('click', () => startShortcutCapture(el));
  });

  // 项目名称标签输入
  $('#project-tags-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addProjectTag(e.target.value); }
  });
  $('#project-tags-input').addEventListener('click', () => $('#project-tags-text').focus());

  // 笔记搜索
  $('#note-list-search').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      state.noteSearchQuery = e.target.value.trim().toLowerCase();
      await renderNoteList();
    }
  });

  // 文档级 copy 事件，确保能捕获 contenteditable 内的复制
  document.addEventListener('copy', handleNotepadCopy);

  // 搜索模式切换 — 点哪个切到哪个
  const setSearchMode = (mode) => {
    if (state.searchMode === mode) return;
    state.searchMode = mode;
    const toggle = $('#search-mode-toggle');
    if (mode === 'content') {
      toggle.classList.add('content');
      toggle.querySelector('.toggle-filename').classList.remove('active');
      toggle.querySelector('.toggle-content').classList.add('active');
      $('#note-list-search').placeholder = '搜索文件内容...';
    } else {
      toggle.classList.remove('content');
      toggle.querySelector('.toggle-filename').classList.add('active');
      toggle.querySelector('.toggle-content').classList.remove('active');
      $('#note-list-search').placeholder = '搜索文件名...';
    }
    if (state.noteSearchQuery) renderNoteList();
  };
  $('#search-mode-toggle').querySelector('.toggle-filename').addEventListener('click', (e) => {
    e.stopPropagation();
    setSearchMode('filename');
  });
  $('#search-mode-toggle').querySelector('.toggle-content').addEventListener('click', (e) => {
    e.stopPropagation();
    setSearchMode('content');
  });

  document.addEventListener('keydown', (e) => {
    const sc = state.shortcuts;
    if (matchShortcut(e, sc.switchTask) && state.pagesEnabled.tasks) { e.preventDefault(); switchToMain(); }
    if (matchShortcut(e, sc.switchNotepad)) { e.preventDefault(); switchToNotepad(); }
    if (matchShortcut(e, sc.organize) && state.currentPage === 'main' && state.pagesEnabled.tasks) {
      e.preventDefault();
      if (!state.organizing) organize();
    }
  });

  if (window.electronAPI) {
    window.electronAPI.onOpenConfig(() => openSettings());
    window.electronAPI.onWindowShown(async () => {
      app.style.opacity = '0';
      app.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350, easing: 'ease', fill: 'forwards' });
      if (state.currentPage === 'notepad') {
        notepadTextarea.focus();
      } else if (state.pagesEnabled.tasks) {
        // 每次窗口显示时重新加载任务，确保跨天后已完成任务被清除
        await loadTasks();
        renderTasks();
        textInput.focus();
      }
    });
    window.electronAPI.onWindowWillHide(() => {
      const anim = app.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, easing: 'ease', fill: 'forwards' });
      anim.finished.then(() => { /* 动画完成，元素停在 opacity:0 */ });
      if (state.currentPage === 'notepad') {
        saveCurrentNote();
      } else if (state.pagesEnabled.tasks && hasContent() && !state.organizing) {
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
    let changed = false;
    if (!raw) {
      state.tasks.forEach(t => { if (t.alarmTime) { t.alarmTime = null; changed = true; } });
    }
    // 迁移最近未完成任务——扫描过去14天，找到最近有未完成任务的那天进行迁移
    for (let daysBack = 1; daysBack <= 14; daysBack++) {
      const d = new Date(); d.setDate(d.getDate() - daysBack);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      try {
        const raw = localStorage.getItem(`tasks_${dateStr}`);
        if (raw) {
          const unfinished = JSON.parse(raw).filter(t => !t.completed);
          if (unfinished.length > 0) {
            unfinished.forEach(t => { t.createdAt = new Date().toISOString(); t.id = genId(); t.alarmTime = null; });
            state.tasks = [...unfinished, ...state.tasks];
            changed = true;
            break;
          }
        }
      } catch (e) {}
    }
    if (changed) saveTasks();
  }
  // 向后兼容：没有 sortOrder 的任务按当前顺序赋值
  let needsSave = false;
  state.tasks.forEach((t, i) => {
    if (t.sortOrder === undefined) { t.sortOrder = i; needsSave = true; }
  });
  if (needsSave) saveTasks();
  sortTasks();
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
    if (task.completed) row.classList.add('completed');
    row.dataset.id = task.id;

    const cb = document.createElement('div');
    cb.className = `task-checkbox${task.completed ? ' checked' : ''}`;
    cb.addEventListener('click', (e) => { e.stopPropagation(); toggleTask(idx); });

    const text = document.createElement('span');
    text.className = `task-text${task.completed ? ' done' : ''}`;

    // 项目徽标
    if (task.project) {
      const badge = document.createElement('span');
      badge.className = 'project-badge';
      badge.textContent = task.project;
      text.appendChild(badge);
    }
    text.appendChild(document.createTextNode(task.task));

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

    // 拖拽手柄（仅未完成任务）
    if (!task.completed) {
      const dragHandle = document.createElement('div');
      dragHandle.className = 'task-drag-handle';
      dragHandle.textContent = '⋮⋮';
      dragHandle.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); startDrag(e, idx); });
      row.append(cb, text, hoverBar, dragHandle);
    } else {
      row.append(cb, text, hoverBar);
    }

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
  undone.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  done.sort((a, b) => new Date(b.completedAt || 0).getTime() - new Date(a.completedAt || 0).getTime());
  state.tasks = [...undone, ...done];
}

function reassignSortOrders() {
  const undone = state.tasks.filter(t => !t.completed);
  undone.forEach((t, i) => { t.sortOrder = i; });
}

// ========== 拖拽排序 ==========
let dragState = null;

function startDrag(e, taskIdx) {
  const row = e.currentTarget.closest('.task-item');
  const rect = row.getBoundingClientRect();

  // 创建浮动克隆
  const clone = row.cloneNode(true);
  clone.classList.add('task-dragging');
  Object.assign(clone.style, {
    position: 'fixed',
    left: rect.left + 'px',
    top: rect.top + 'px',
    width: rect.width + 'px',
    height: rect.height + 'px',
    zIndex: '1000',
    pointerEvents: 'none',
  });
  document.body.appendChild(clone);

  // 原位置插入占位块
  const placeholder = document.createElement('div');
  placeholder.className = 'task-placeholder';
  placeholder.style.height = rect.height + 'px';
  row.parentNode.insertBefore(placeholder, row);
  row.remove();

  dragState = {
    taskIdx,
    clone,
    placeholder,
    offsetY: e.clientY - rect.top,
    undoneCount: state.tasks.filter(t => !t.completed).length,
    lastTargetIdx: -1,
  };

  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
}

function onDragMove(e) {
  if (!dragState) return;
  dragState.clone.style.top = (e.clientY - dragState.offsetY) + 'px';

  const rows = [...taskItems.querySelectorAll('.task-item')];
  let targetIdx = dragState.undoneCount;
  for (let i = 0; i < dragState.undoneCount && i < rows.length; i++) {
    const rect = rows[i].getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) {
      targetIdx = i;
      break;
    }
  }

  if (targetIdx === dragState.lastTargetIdx) return;
  dragState.lastTargetIdx = targetIdx;

  // FLIP 第一步: 记录所有行和占位块的旧位置
  const oldPos = [];
  taskItems.querySelectorAll('.task-item, .task-placeholder').forEach(el => {
    oldPos.push({ el, top: el.getBoundingClientRect().top });
  });

  // 移动占位块
  if (targetIdx < rows.length) {
    taskItems.insertBefore(dragState.placeholder, rows[targetIdx]);
  } else {
    taskItems.appendChild(dragState.placeholder);
  }

  // FLIP 第二三四步
  requestAnimationFrame(() => {
    oldPos.forEach(({ el, top: oldTop }) => {
      if (!el.isConnected) return;
      const newTop = el.getBoundingClientRect().top;
      const delta = oldTop - newTop;
      if (Math.abs(delta) < 1) return;
      el.getAnimations().forEach(a => a.cancel());
      el.animate([
        { transform: `translateY(${delta}px)` },
        { transform: 'translateY(0)' }
      ], { duration: 150, easing: 'ease-out' });
    });
  });
}

function onDragEnd() {
  if (!dragState) return;

  // 计算占位块在 task-items 子元素中的位置
  const placeholderIdx = [...taskItems.children].indexOf(dragState.placeholder);
  let targetIdx = 0;
  for (let i = 0; i < placeholderIdx; i++) {
    if (taskItems.children[i].classList.contains('task-item')) targetIdx++;
  }
  targetIdx = Math.min(targetIdx, dragState.undoneCount);

  // 更新任务数组
  if (targetIdx !== dragState.taskIdx) {
    const [task] = state.tasks.splice(dragState.taskIdx, 1);
    state.tasks.splice(targetIdx, 0, task);
    reassignSortOrders();
    saveTasks();
  }

  // 清理
  dragState.clone.remove();
  dragState.placeholder.remove();
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
  dragState = null;

  renderTasks();
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
  // 去重保护：跳过已存在的同名任务
  const existingTexts = new Set(state.tasks.map(t => t.task));
  const unique = newTasks.filter(t => !existingTexts.has(t.task));
  if (unique.length === 0) return;

  const now = new Date().toISOString();
  const maxOrder = state.tasks.reduce((max, t) => Math.max(max, t.sortOrder ?? 0), -1);
  const items = unique.map((t, i) => ({
    id: genId(), task: t.task, project: t.project || null, completed: false, createdAt: now, completedAt: null,
    alarmTime: null, sortOrder: maxOrder + 1 + i,
  }));
  state.tasks = [...items, ...state.tasks];

  // 数量上限保护：最多保留 500 条，超出部分从末尾（最旧的已完成任务）删除
  if (state.tasks.length > 500) {
    const keep = state.tasks.length - 500;
    const undone = state.tasks.filter(t => !t.completed);
    const done = state.tasks.filter(t => t.completed);
    if (undone.length >= 500) {
      state.tasks = undone.slice(0, 500);
    } else {
      state.tasks = [...undone, ...done.slice(0, 500 - undone.length)];
    }
  }

  sortTasks();
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
    if (item.type.startsWith('image/') && state.images.length < 3) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (blob.size > 10 * 1024 * 1024) { showError('图片过大，单张不超过 10MB'); continue; }
      const reader = new FileReader();
      reader.onload = (ev) => {
        state.images.push(ev.target.result);
        // 总 base64 size 防御
        const totalBytes = state.images.reduce((s, u) => s + u.length, 0);
        if (totalBytes > 20 * 1024 * 1024) {
          state.images.pop();
          showError('已超过总图片大小限制 20MB');
        }
        renderImages(); updateOrganizeButton();
      };
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
    // 读取项目名配置，前端确定性匹配项目名
    let projectNames = [];
    let project = null;
    let cleanedText = text;
    if (window.electronAPI) {
      const cfg = await window.electronAPI.getConfig();
      projectNames = cfg.projectNames || [];
    }
    if (projectNames.length > 0) {
      const lower = text.toLowerCase();
      for (const name of projectNames) {
        const idx = lower.indexOf(name.toLowerCase());
        if (idx !== -1) {
          project = name;
          cleanedText = (text.slice(0, idx) + text.slice(idx + name.length)).replace(/\s+/g, '');
          break;
        }
      }
    }

    if (window.electronAPI) {
      // 生产模式：通过 IPC 调用主进程（OCR + DeepSeek）
      const result = await window.electronAPI.organizeRequest({ text: cleanedText || text, images: imgs, project });
      if (result.success && result.tasks.length > 0) {
        // LLM 返回的 task 不含项目名，在前面拼上
        if (project) result.tasks.forEach(t => { t.project = project; });
        addTasks(result.tasks);
      } else {
        // IPC 失败或无结果时 fallback，不丢失用户任务
        if (!result.success) console.warn(result.error);
        const tasks = fallbackOrganize(text, imgs, projectNames, project);
        if (tasks.length > 0) addTasks(tasks);
      }
    } else {
      // 浏览器调试模式：fallback 简单拆分
      await sleep(500);
      const tasks = fallbackOrganize(text, imgs, projectNames, project);
      if (tasks.length > 0) addTasks(tasks);
    }
  } catch (e) {
    showError(e.message);
    // 不恢复原文到输入框，防止 windowWillHide 再次触发 organize 形成死循环
  } finally {
    state.organizing = false;
    showProcessing(false);
    updateOrganizeButton();
  }
}

function fallbackOrganize(text, imgs, projectNames, preMatchedProject) {
  const tasks = [];
  if (imgs.length > 0) tasks.push({ task: '【截图识别】请编辑此任务补充详情' });
  if (text) {
    // 使用前端已匹配的项目名，或重新匹配
    let project = preMatchedProject || null;
    let contentText = text;
    if (!project && projectNames && projectNames.length > 0) {
      const lower = text.toLowerCase();
      for (const name of projectNames) {
        const idx = lower.indexOf(name.toLowerCase());
        if (idx !== -1) {
          project = name;
          contentText = (text.slice(0, idx) + text.slice(idx + name.length)).replace(/\s+/g, '');
          break;
        }
      }
    } else if (project) {
      const lower = text.toLowerCase();
      const idx = lower.indexOf(project.toLowerCase());
      if (idx !== -1) {
        contentText = (text.slice(0, idx) + text.slice(idx + project.length)).replace(/\s+/g, '');
      }
    }

    const parts = contentText.split(/[\n\r。，；;,.。、]+/).map(s => s.trim()).filter(s => s.length > 1);
    if (project) {
      if (parts.length > 1) parts.forEach(p => tasks.push({ task: p, project }));
      else if (parts.length === 1) tasks.push({ task: parts[0], project });
      else tasks.push({ task: '', project });
    } else {
      if (parts.length > 1) parts.forEach(p => tasks.push({ task: p }));
      else if (parts.length === 1) tasks.push({ task: parts[0] });
      else tasks.push({ task: text });
    }
  }
  return tasks;
}

function showError(msg) {
  dailyReportHint.textContent = msg;
  dailyReportHint.classList.add('show');
  setTimeout(() => { dailyReportHint.classList.remove('show'); }, 2500);
}

// ========== 配置与设置管理 ==========
function renderProjectTags() {
  const list = $('#project-tags-list');
  list.innerHTML = '';
  state.projectNames.forEach(name => {
    const tag = document.createElement('span');
    tag.className = 'project-tag';
    tag.innerHTML = `<span>${escapeHtml(name)}</span><button class="project-tag-remove" data-name="${escapeHtml(name)}">×</button>`;
    tag.querySelector('button').addEventListener('click', () => {
      state.projectNames = state.projectNames.filter(n => n !== name);
      renderProjectTags();
    });
    list.appendChild(tag);
  });
}

function addProjectTag(name) {
  const trimmed = name.trim();
  if (!trimmed || state.projectNames.includes(trimmed)) return;
  state.projectNames.push(trimmed);
  renderProjectTags();
  $('#project-tags-text').value = '';
}

function escapeHtml(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, c => map[c]);
}

// ========== Markdown ↔ HTML 转换 ==========
  // 图片数据缓存（用于复制到外部应用时替换 note-image:// 为 base64）
const imageDataCache = new Map(); // relativePath → base64 data URL

function loadMarkdown(md) {
  if (!md) return '';
  const lines = md.split('\n');
  return lines.map(line => {
    if (!line.trim()) return '<div><br></div>';
    const parts = line.split(/(!\[[^\]]*\]\([^)]+\))/g);
    return '<div>' + parts.map(part => {
      const m = part.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (m) return `<img src="note-image://${m[2]}" alt="${escapeHtml(m[1] || '')}">`;
      return escapeHtml(part);
    }).join('') + '</div>';
  }).join('');
}

function htmlToMarkdown(html) {
  if (!html) return '';
  const div = document.createElement('div');
  div.innerHTML = html;
  // 清理 br 标签
  div.querySelectorAll('br').forEach(br => br.remove());
  // 图片 → markdown
  div.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src') || '';
    if (src.startsWith('note-image://')) {
      img.replaceWith(document.createTextNode(`![](${src.replace('note-image://', '')})`));
    }
  });
  const divs = div.querySelectorAll('div');
  if (divs.length > 0) return Array.from(divs).map(d => (d.textContent || '').trim()).join('\n');
  return (div.textContent || '').trim();
}

function insertImageAtCursor(relativePath, dataUrl) {
  const img = document.createElement('img');
  img.src = `note-image://${relativePath}`;
  img.setAttribute('data-b64', dataUrl);
  const sel = window.getSelection();
  if (sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(img);
    range.setStartAfter(img);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    notepadTextarea.appendChild(img);
  }
  onNotepadInput();
}

async function deleteHoveredImage() {
  const img = state.hoveredImage;
  if (!img) return;
  const src = img.getAttribute('src') || '';
  if (!src.startsWith('note-image://')) return;
  // 用浏览器原生删除操作（可被 Ctrl+Z 撤销），磁盘文件在保存时由孤儿清理逻辑删除
  notepadTextarea.focus();
  const range = document.createRange();
  range.selectNode(img);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand('delete');
  state.hoveredImage = null;
  onNotepadInput();
}

function extractImagePaths(md) {
  if (!md) return new Set();
  const re = /!\[[^\]]*\]\(([^)]+)\)/g;
  const paths = new Set();
  let m;
  while ((m = re.exec(md)) !== null) paths.add(m[1]);
  return paths;
}

async function populateImageCache() {
  if (!window.electronAPI) return;
  const imgs = notepadTextarea.querySelectorAll('img[src^="note-image://"]');
  for (const img of imgs) {
    const url = img.getAttribute('src');
    const relativePath = url.replace('note-image://', '');
    if (!imageDataCache.has(relativePath)) {
      try {
        const dataUrl = await window.electronAPI.readNoteImage(relativePath);
        if (dataUrl) {
          imageDataCache.set(relativePath, dataUrl);
          img.setAttribute('data-b64', dataUrl);
        }
      } catch (e) { /* ignore */ }
    }
  }
}

async function loadShortcutsFromConfig() {
  if (window.electronAPI) {
    const cfg = await window.electronAPI.getConfig();
    if (cfg.shortcuts) {
      state.shortcuts = { ...state.shortcuts, ...cfg.shortcuts };
    }
    if (cfg.pagesEnabled) {
      state.pagesEnabled = { ...state.pagesEnabled, ...cfg.pagesEnabled };
    }
    app.classList.toggle('win-fixed', cfg.winFixed !== false);
  }
}

async function openSettings() {
  if (window.electronAPI) {
    window.electronAPI.setSettingsOpen(true);
    const cfg = await window.electronAPI.getConfig();
    $('#settings-apikey').value = cfg.apiKey || '';
    $('#settings-baseurl').value = cfg.baseUrl || 'https://api.deepseek.com';
    $('#settings-reportname').value = cfg.reportName || '';

    // 填充文件路径下拉菜单
    const currentDir = cfg.notesDir || '';
    $('#settings-notesdir').value = currentDir;
    const menu = $('#notesdir-dropdown');
    menu.innerHTML = '';
    // 默认位置选项
    const defaultItem = document.createElement('div');
    defaultItem.className = 'combo-dropdown-item default-item';
    defaultItem.textContent = '默认位置 (AppData)';
    defaultItem.addEventListener('click', () => {
      $('#settings-notesdir').value = '';
      menu.classList.add('hidden');
      $('#notesdir-dropdown-btn').innerHTML = '&#9660;';
    });
    menu.appendChild(defaultItem);
    // 历史路径
    const history = cfg.notesDirHistory || [];
    history.forEach(dir => {
      const item = document.createElement('div');
      item.className = 'combo-dropdown-item';
      item.textContent = dir;
      item.addEventListener('click', () => {
        $('#settings-notesdir').value = dir;
        menu.classList.add('hidden');
        $('#notesdir-dropdown-btn').innerHTML = '&#9660;';
      });
      menu.appendChild(item);
    });

    if (window.electronAPI) {
      $('#settings-autostart').checked = await window.electronAPI.getLoginSettings();
    }
    $('#settings-winfixed').checked = cfg.winFixed !== false;
    $('#settings-tasks-page').checked = cfg.pagesEnabled?.tasks !== false;
    if (cfg.shortcuts) {
      state.shortcuts = { ...state.shortcuts, ...cfg.shortcuts };
    }
    state.projectNames = [...(cfg.projectNames || [])];
    renderProjectTags();
  }
  renderShortcutInputs();
  settingsOverlay.classList.remove('hidden');
  $('#settings-apikey').focus();
}

function setKbdDisplay(el, accel) {
  el.innerHTML = '';
  el.dataset.accel = accel;
  const parts = accel.split('+');
  parts.forEach((part, i) => {
    const kbd = document.createElement('kbd');
    kbd.textContent = part.trim();
    el.appendChild(kbd);
    if (i < parts.length - 1) {
      el.appendChild(document.createTextNode(' + '));
    }
  });
}

function renderShortcutInputs() {
  setKbdDisplay($('#shortcut-toggle'), state.shortcuts.toggle);
  setKbdDisplay($('#shortcut-organize'), state.shortcuts.organize);
  setKbdDisplay($('#shortcut-switchTask'), state.shortcuts.switchTask);
  setKbdDisplay($('#shortcut-switchNotepad'), state.shortcuts.switchNotepad);
  document.querySelectorAll('.shortcut-kbd').forEach(el => delete el.dataset.accel);
}

async function confirmSettings() {
  const apiKey = $('#settings-apikey').value.trim();
  const baseUrl = $('#settings-baseurl').value.trim() || 'https://api.deepseek.com';
  const reportName = $('#settings-reportname').value.trim();
  const notesDir = $('#settings-notesdir').value.trim();

  // 检测文件位置是否变更
  const oldCfg = window.electronAPI ? await window.electronAPI.getConfig() : {};
  const dirChanged = notesDir !== (oldCfg.notesDir || '');

  collectShortcutsFromInputs();
  const winFixed = $('#settings-winfixed').checked;
  const tasksEnabled = $('#settings-tasks-page').checked;
  const pagesEnabled = { tasks: tasksEnabled };
  const cfg = { apiKey, baseUrl, reportName, notesDir, notesDirHistory: oldCfg.notesDirHistory || [], projectNames: [...state.projectNames], shortcuts: { ...state.shortcuts }, winFixed, pagesEnabled };

  if (window.electronAPI) {
    await window.electronAPI.saveConfig(cfg);
    await window.electronAPI.setLoginSettings($('#settings-autostart').checked);
    await window.electronAPI.setWindowFixed(winFixed);
    app.classList.toggle('win-fixed', winFixed);
  } else {
    localStorage.setItem('sticky_config', JSON.stringify(cfg));
  }

  // 页面开关变更
  const tasksWasEnabled = state.pagesEnabled.tasks;
  state.pagesEnabled = pagesEnabled;
  updateTasksPageVisibility();
  if (!tasksEnabled && tasksWasEnabled && state.currentPage === 'main') {
    switchToNotepad();
  }

  // 文件位置变更后，刷新笔记列表
  if (dirChanged && window.electronAPI) {
    state.notes = await window.electronAPI.listNotes();
    state.pinnedNotes = await window.electronAPI.getPinnedNotes();
    state.currentNoteFile = null;
    state.noteContent = '';
    state.noteOriginalContent = '';
    if (state.currentPage === 'notepad') {
      if (state.notes.length > 0) {
        state.currentNoteFile = state.notes[0].filename;
        state.noteContent = await window.electronAPI.readNote(state.notes[0].filename);
        state.noteOriginalContent = state.noteContent;
        notepadTextarea.innerHTML = loadMarkdown(state.noteContent);
        notepadTextarea.classList.toggle('is-empty', !state.noteContent);
        populateImageCache();
      }
    }
  }

  if (window.electronAPI) window.electronAPI.setSettingsOpen(false);
  settingsOverlay.classList.add('hidden');
}

function cancelSettings() {
  // 放弃修改：恢复 shortcuts 为已保存的值
  if (window.electronAPI) {
    window.electronAPI.getConfig().then(cfg => {
      if (cfg.shortcuts) {
        state.shortcuts = { ...state.shortcuts, ...cfg.shortcuts };
      }
    });
    window.electronAPI.setSettingsOpen(false);
  }
  settingsOverlay.classList.add('hidden');
}

// ========== 快捷键捕获 ==========
function startShortcutCapture(el) {
  const oldAccel = el.dataset.accel || el.textContent.replace(/\s*\+\s*/g, '+');
  el.textContent = '按下快捷键...';
  el.classList.add('capturing');

  function onKeyDown(e) {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      setKbdDisplay(el, oldAccel);
      finish();
      return;
    }

    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;

    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    let keyName = e.key;
    if (keyName === ' ') keyName = 'Space';
    else if (keyName.length === 1) keyName = keyName.toUpperCase();

    parts.push(keyName);
    setKbdDisplay(el, parts.join('+'));
    finish();
  }

  function finish() {
    el.classList.remove('capturing');
    el.removeEventListener('keydown', onKeyDown);
    el.removeEventListener('blur', onBlur);
  }

  function onBlur() {
    if (el.classList.contains('capturing')) {
      setKbdDisplay(el, oldAccel);
    }
    finish();
  }

  el.addEventListener('keydown', onKeyDown);
  el.addEventListener('blur', onBlur);
  el.focus();
}

// 读取快捷键输入值，同步到 state.shortcuts
function collectShortcutsFromInputs() {
  const getVal = (id) => {
    const el = document.getElementById(id);
    return el.dataset.accel || state.shortcuts[id.replace('shortcut-', '')] || el.textContent.replace(/\s*\+\s*/g, '+');
  };
  state.shortcuts.toggle = getVal('shortcut-toggle');
  state.shortcuts.organize = getVal('shortcut-organize');
  state.shortcuts.switchTask = getVal('shortcut-switchTask');
  state.shortcuts.switchNotepad = getVal('shortcut-switchNotepad');
}

// ========== 快捷键匹配 ==========
function matchShortcut(e, accel) {
  if (!accel) return false;
  const parts = accel.split('+');
  const expectedKey = parts.pop().toLowerCase();
  const expectedMods = {
    ctrl: parts.includes('Ctrl') || parts.includes('CommandOrControl'),
    alt: parts.includes('Alt'),
    shift: parts.includes('Shift'),
    meta: parts.includes('Meta') || parts.includes('Command'),
  };

  let actualKey = e.key;
  // 统一特殊键名
  const keyMap = {
    'control': 'ctrl', 'escape': 'esc', ' ': 'space',
    'arrowup': 'up', 'arrowdown': 'down', 'arrowleft': 'left', 'arrowright': 'right',
  };
  actualKey = keyMap[actualKey.toLowerCase()] || actualKey.toLowerCase();
  const expectedMapped = keyMap[expectedKey] || expectedKey;

  return actualKey === expectedMapped &&
    (e.ctrlKey || e.metaKey) === expectedMods.ctrl &&
    e.altKey === expectedMods.alt &&
    e.shiftKey === expectedMods.shift;
}

// ========== 工具函数 ==========
function genId() { return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }

function getToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function showProcessing(show, text = '') {
  if (show) { processingText.textContent = text; processingOverlay.classList.remove('hidden'); }
  else { processingOverlay.classList.add('hidden'); }
}

// ========== 页面切换 ==========
function updateTasksPageVisibility() {
  const enabled = state.pagesEnabled.tasks;
  btnSwitchNotepad.style.display = enabled ? '' : 'none';
  btnNotepadBack.style.display = enabled ? '' : 'none';
}

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
      state.noteContent = '';
      state.noteOriginalContent = '';
      state.notes = await window.electronAPI.listNotes();
    } else if (!state.currentNoteFile || !notes.find(n => n.filename === state.currentNoteFile)) {
      state.currentNoteFile = notes[0].filename;
      state.noteContent = await window.electronAPI.readNote(notes[0].filename);
      state.noteOriginalContent = state.noteContent;
    }
  }
  pagesContainer.classList.add('on-notepad');
  notepadTextarea.innerHTML = loadMarkdown(state.noteContent);
  notepadTextarea.classList.toggle('is-empty', !state.noteContent);
  populateImageCache();
  setTimeout(() => notepadTextarea.focus(), 400);
}

async function switchToMain() {
  if (state.currentPage === 'main') return;
  if (!state.pagesEnabled.tasks) return;
  // 保存当前笔记
  saveCurrentNote();
  state.currentPage = 'main';
  if (window.electronAPI) window.electronAPI.setPage('main');
  pagesContainer.classList.remove('on-notepad');
  setTimeout(() => textInput.focus(), 400);
}

// ========== 笔记管理 ==========
function onNotepadInput() {
  state.noteContent = htmlToMarkdown(notepadTextarea.innerHTML);
  const isEmpty = !notepadTextarea.textContent?.trim() && notepadTextarea.querySelectorAll('img').length === 0;
  notepadTextarea.classList.toggle('is-empty', isEmpty);
}

async function handleNotepadPaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob || blob.size > 10 * 1024 * 1024) continue;
      try {
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
        if (window.electronAPI) {
          const result = await window.electronAPI.saveNoteImage(dataUrl);
          if (result.filename) {
            imageDataCache.set(result.filename, dataUrl);
            insertImageAtCursor(result.filename, dataUrl);
          }
        }
      } catch (e) { /* ignore */ }
    }
  }
}

function handleNotepadCopy(e) {
  // 只处理来自记事本编辑区的复制
  if (!notepadTextarea.contains(window.getSelection()?.anchorNode)) return;

  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return;

  const fragment = range.cloneContents();
  const container = document.createElement('div');
  container.appendChild(fragment);

  container.querySelectorAll('img[src^="note-image://"]').forEach(img => {
    const url = img.getAttribute('src');
    const relativePath = url.replace('note-image://', '');
    const b64 = imageDataCache.get(relativePath) || img.getAttribute('data-b64');
    if (b64) {
      img.src = b64;
      img.removeAttribute('data-b64');
    }
  });

  const html = container.innerHTML;
  e.preventDefault();
  e.clipboardData.setData('text/html', html);
  e.clipboardData.setData('text/plain', htmlToMarkdown(html));
}

function handleNotepadDblClick(e) {
  const img = e.target.closest('img[src^="note-image://"]');
  if (!img) return;
  const relativePath = img.getAttribute('src').replace('note-image://', '');
  if (window.electronAPI) window.electronAPI.openNoteImage(relativePath);
}

async function loadNotesList() {
  if (!window.electronAPI) return;
  state.notes = await window.electronAPI.listNotes();
  state.pinnedNotes = await window.electronAPI.getPinnedNotes();
}

async function openNote(filename) {
  if (filename === state.currentNoteFile) { closeNoteList(); return; }
  const prevFile = state.currentNoteFile;
  const prevContent = state.noteContent;
  const prevOriginal = state.noteOriginalContent;
  state.currentNoteFile = filename;
  if (!window.electronAPI) return;
  state.noteContent = await window.electronAPI.readNote(filename);
  state.noteOriginalContent = state.noteContent;
  notepadTextarea.innerHTML = loadMarkdown(state.noteContent);
  notepadTextarea.classList.toggle('is-empty', !state.noteContent);
  populateImageCache();
  closeNoteList();
  if (prevFile) persistPreviousNote(prevFile, prevContent, prevOriginal);
}

async function persistPreviousNote(prevFile, prevContent, prevOriginal) {
  if (!window.electronAPI) return;
  if (prevContent !== prevOriginal) {
    await window.electronAPI.saveNote(prevFile, prevContent);
    state.notes = await window.electronAPI.listNotes();
  }
  const isNewFile = /^untitled_\d+\.md$/.test(prevFile);
  if (!isNewFile) return;
  if (prevContent.trim()) {
    triggerAiName(prevFile, prevContent);
  } else {
    await window.electronAPI.deleteNote(prevFile);
    state.notes = await window.electronAPI.listNotes();
  }
}

async function saveCurrentNote() {
  if (!window.electronAPI || !state.currentNoteFile) return;
  // 从 DOM 直接取当前内容，而不是用 state.noteContent
  // 因为删除 img 元素时 contenteditable 可能不触发 input 事件
  const content = htmlToMarkdown(notepadTextarea.innerHTML);
  if (content !== state.noteOriginalContent) {
    await window.electronAPI.saveNote(state.currentNoteFile, content);
    // 清理已删除的图片文件
    const oldPaths = extractImagePaths(state.noteOriginalContent);
    const newPaths = extractImagePaths(content);
    for (const p of oldPaths) {
      if (!newPaths.has(p)) {
        window.electronAPI.deleteNoteImage(p);
        imageDataCache.delete(p);
      }
    }
    state.noteOriginalContent = content;
    state.noteContent = content;
    state.notes = await window.electronAPI.listNotes();
  }

  const isNewFile = /^untitled_\d+\.md$/.test(state.currentNoteFile);
  if (!isNewFile) return;

  if (content.trim()) {
    triggerAiName(state.currentNoteFile, content);
  } else {
    await window.electronAPI.deleteNote(state.currentNoteFile);
    state.currentNoteFile = null;
    state.noteContent = '';
    state.noteOriginalContent = '';
    state.notes = await window.electronAPI.listNotes();
  }
}

async function createNote() {
  await saveCurrentNote();
  if (!window.electronAPI) return;
  const filename = await window.electronAPI.createNote();
  state.currentNoteFile = filename;
  state.noteContent = '';
  state.noteOriginalContent = '';
  notepadTextarea.innerHTML = '';
  notepadTextarea.classList.add('is-empty');
  state.notes = await window.electronAPI.listNotes();
  // 如果文件列表打开着，刷新显示
  if (!noteListOverlay.classList.contains('hidden')) renderNoteList();
  notepadTextarea.focus();
}

async function deleteNoteHandler(filename) {
  if (!window.electronAPI || state.notes.length <= 1) return;
  await window.electronAPI.deleteNote(filename);
  state.notes = await window.electronAPI.listNotes();
  if (state.currentNoteFile === filename) {
    state.currentNoteFile = state.notes[0]?.filename || null;
    state.noteContent = state.currentNoteFile
      ? await window.electronAPI.readNote(state.currentNoteFile)
      : '';
    notepadTextarea.innerHTML = loadMarkdown(state.noteContent);
    notepadTextarea.classList.toggle('is-empty', !state.noteContent);
    populateImageCache();
  }
  renderNoteList();
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
    state.noteSearchQuery = '';
    state.searchMode = 'filename';
    const toggle = $('#search-mode-toggle');
    toggle.classList.remove('content');
    toggle.querySelector('.toggle-filename').classList.add('active');
    toggle.querySelector('.toggle-content').classList.remove('active');
    $('#note-list-search').placeholder = '搜索文件名...';
    loadNotesList().then(() => renderNoteList());
    noteListOverlay.classList.remove('hidden');
    const searchInput = $('#note-list-search');
    searchInput.value = '';
    setTimeout(() => searchInput.focus(), 100);
  } else {
    closeNoteList();
  }
}

async function renderNoteList() {
  noteListItems.innerHTML = '';
  const pinnedSet = new Set(state.pinnedNotes.filter(f => state.notes.some(n => n.filename === f)));

  // 搜索过滤
  const q = state.noteSearchQuery;
  let filtered = state.notes;
  if (q) {
    if (state.searchMode === 'content' && window.electronAPI) {
      // 按内容搜索：读取每个文件内容进行匹配
      const results = [];
      for (const note of state.notes) {
        const content = await window.electronAPI.readNote(note.filename);
        if (content && content.toLowerCase().includes(q)) {
          results.push(note);
        }
      }
      filtered = results;
    } else {
      // 按文件名搜索
      filtered = state.notes.filter(n => n.filename.replace(/\.md$/, '').toLowerCase().includes(q));
    }
  }

  // 置顶在前（按 mtime 降序），未置顶在后（按 mtime 降序）
  const sorted = [...filtered].sort((a, b) => {
    const aPinned = pinnedSet.has(a.filename);
    const bPinned = pinnedSet.has(b.filename);
    if (aPinned && !bPinned) return -1;
    if (!aPinned && bPinned) return 1;
    return b.mtime.localeCompare(a.mtime);
  });

  sorted.forEach(note => {
    const row = document.createElement('div');
    row.className = 'note-list-item';
    if (pinnedSet.has(note.filename)) row.classList.add('pinned');
    if (note.filename === state.currentNoteFile) row.classList.add('active');

    const nameSpan = document.createElement('span');
    nameSpan.textContent = note.filename.replace(/\.md$/, '');
    nameSpan.style.overflow = 'hidden';
    nameSpan.style.textOverflow = 'ellipsis';

    const rightGroup = document.createElement('span');
    rightGroup.className = 'note-list-right';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'note-list-mtime';
    timeSpan.textContent = note.mtime.slice(0, 10);

    const pinBtn = document.createElement('button');
    pinBtn.className = 'note-list-pin';
    pinBtn.textContent = pinnedSet.has(note.filename) ? '📌' : '📍';
    pinBtn.title = pinnedSet.has(note.filename) ? '取消置顶' : '置顶';
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePin(note.filename);
    });

    rightGroup.append(timeSpan, pinBtn);
    row.append(nameSpan, rightGroup);

    let clickTimer = null;
    row.addEventListener('click', () => {
      if (clickTimer) { clearTimeout(clickTimer); }
      clickTimer = setTimeout(() => {
        clickTimer = null;
        openNote(note.filename);
      }, 200);
    });
    row.addEventListener('dblclick', () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      enterNoteRename(row, note.filename);
    });
    let rightTimer = null;
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      if (rightTimer) {
        clearTimeout(rightTimer);
        rightTimer = null;
        deleteNoteHandler(note.filename);
      } else {
        rightTimer = setTimeout(() => { rightTimer = null; }, 400);
      }
    });

    noteListItems.appendChild(row);
  });
}

async function togglePin(filename) {
  if (!window.electronAPI) return;
  state.pinnedNotes = await window.electronAPI.togglePinNote(filename);
  renderNoteList();
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
    closeNoteList();
  }
  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = oldName; input.blur(); }
  });
}

function closeNoteList() {
  state.noteSearchQuery = '';
  $('#note-list-search').value = '';
  noteListOverlay.classList.add('hidden');
}

// 点击列表外部关闭
document.addEventListener('click', (e) => {
  if (!noteListOverlay.classList.contains('hidden') &&
      !noteListOverlay.contains(e.target) &&
      e.target !== btnNoteList) {
    closeNoteList();
  }
});

async function generateDailyReport() {
  if (!window.electronAPI) return;
  if (state.tasks.length === 0) {
    dailyReportHint.textContent = '今日暂无完成任务';
    dailyReportHint.classList.add('show');
    setTimeout(() => { dailyReportHint.classList.remove('show'); }, 1000);
    return;
  }
  await saveTasks();
  await window.electronAPI.generateDailyReport(state.tasks);
  dailyReportHint.textContent = '日报内容已复制至剪切板';
  dailyReportHint.classList.add('show');
  setTimeout(() => { dailyReportHint.classList.remove('show'); }, 1000);
}

// ========== 启动 ==========
init();
// 兜底：renderer 晚于主进程 showWindow 时，主动淡入
setTimeout(() => {
  if (parseFloat(getComputedStyle(app).opacity) < 0.1) {
    app.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350, easing: 'ease', fill: 'forwards' });
  }
}, 300);
