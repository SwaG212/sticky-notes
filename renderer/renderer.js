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
  shortcuts: { toggle: 'Alt+`', organize: 'Ctrl+Enter', switchTask: 'Alt+1', switchNotepad: 'Alt+2', switchTools: 'Alt+3' },
  projectNames: [],
  pagesEnabled: { tasks: true, tools: true },
  toolsEnabled: { translate: true },
  hoveredImage: null,
  activeSheet: 'all',
  noteSearch: null,
};

// ========== DOM 引用 ==========
const $ = (sel) => document.querySelector(sel);
const taskItems = $('#task-items');
const taskList = $('#task-list');
const taskEmpty = $('#task-empty');
const sheetBar = $('#sheet-bar');
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
const btnNotepadForward = $('#btn-notepad-forward');
const btnToolsBack = $('#btn-tools-back');
const toolsCards = $('#tools-cards');
const notepadTextarea = $('#notepad-textarea');
const noteListOverlay = $('#note-list-overlay');
const noteListItems = $('#note-list-items');
const btnDailyReport = $('#btn-daily-report');
const dailyReportHint = $('#daily-report-hint');
const noteSearchBar = $('#note-search-bar');
const noteSearchInput = $('#note-search-input');
const noteSearchStatus = $('#note-search-status');

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
  updateToolsPageVisibility();

  textInput.addEventListener('input', updateOrganizeButton);
  textInput.addEventListener('paste', handlePaste);
  textInput.addEventListener('keydown', (e) => {
    if (matchShortcut(e, state.shortcuts.organize)) { e.preventDefault(); e.stopPropagation(); organize(); }
  });

  btnOrganize.addEventListener('click', rearrangeTasks);
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
  btnNotepadForward.addEventListener('click', switchToTools);
  btnToolsBack.addEventListener('click', switchToNotepad);
  btnNoteList.addEventListener('click', toggleNoteList);
  btnNoteNew.addEventListener('click', createNote);
  btnDailyReport.addEventListener('click', generateDailyReport);
  // 页签栏滚轮横向滚动(仅当有横向溢出时拦截,否则放行给任务列表)
  sheetBar.addEventListener('wheel', (e) => {
    const scroller = sheetBar.querySelector('.sheet-scroll');
    if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return;
    e.preventDefault();
    scroller.scrollLeft += e.deltaY;
  }, { passive: false });
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
  // 笔记页搜索框
  noteSearchInput.addEventListener('input', doNoteSearch);
  noteSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nextNoteMatch(); }
    if (e.key === 'Escape') { e.preventDefault(); closeNoteSearch(); }
  });
  // 单击笔记页底部搜索区域(两个按钮除外)直接进入搜索模式,同 Ctrl+F 打开
  // 点击区域 = 搜索框实际大小(占位 rect),不是整个底部栏
  document.querySelector('.page-notepad .notepad-footer').addEventListener('click', (e) => {
    if (e.target.closest('#btn-notepad-back, #btn-notepad-forward')) return;
    if (noteSearchBar.classList.contains('hidden')) {
      const r = noteSearchInput.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        openNoteSearch();
      }
    }
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
    if (matchShortcut(e, sc.switchTools) && state.pagesEnabled.tools) { e.preventDefault(); switchToTools(); }
    if (matchShortcut(e, sc.organize) && state.currentPage === 'main' && state.pagesEnabled.tasks) {
      e.preventDefault();
      if (!state.organizing) organize();
    }
    // 笔记页 Ctrl+F 打开/关闭搜索;文件列表面板打开时聚焦文件搜索框
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && state.currentPage === 'notepad') {
      e.preventDefault();
      if (noteListOverlay.classList.contains('hidden')) {
        toggleNoteSearch();
      } else {
        $('#note-list-search').focus();
      }
      return;
    }
    // Esc 关闭笔记搜索
    if (e.key === 'Escape' && !noteSearchBar.classList.contains('hidden')) {
      closeNoteSearch();
    }
  });

  if (window.electronAPI) {
    window.electronAPI.onOpenConfig(() => openSettings());
    window.electronAPI.onWindowShown(async () => {
      app.style.opacity = '0';
      app.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350, easing: 'ease', fill: 'forwards' });
      if (state.currentPage === 'notepad') {
        notepadTextarea.focus();
      } else if (state.currentPage === 'tools') {
        const input = toolsCards.querySelector('.tool-card-input');
        if (input) input.focus();
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
    let raw = null;
    try {
      raw = localStorage.getItem(`tasks_${today}`);
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
  // 清除过期已完成任务
  const todayStr = getToday();
  const before = state.tasks.length;
  state.tasks = state.tasks.filter(t => !(t.completed && t.dueDate && t.dueDate < todayStr));
  if (state.tasks.length !== before) saveTasks();
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

// ========== 项目页签栏 ==========
function renderSheetBar() {
  if (!sheetBar) return;
  // 记住页签栏横向滚动位置,重建后保持(滚轮横向滚动页签的场景)
  const prevScrollLeft = sheetBar.querySelector('.sheet-scroll')?.scrollLeft ?? 0;
  const projects = [];
  for (const t of state.tasks) {
    if (t.project && !projects.includes(t.project)) projects.push(t.project);
  }
  // 页签排序：完成时间优先（项目内未完成任务的最早截止日期，升序，无日期的沉底），
  // 其次未完成数量（降序），最后项目名兜底保证稳定
  const tabScores = new Map(); // project -> { minDue, count }
  for (const t of state.tasks) {
    if (!t.project) continue;
    let s = tabScores.get(t.project);
    if (!s) { s = { minDue: null, count: 0 }; tabScores.set(t.project, s); }
    if (!t.completed) {
      s.count++;
      if (t.dueDate && (!s.minDue || t.dueDate < s.minDue)) s.minDue = t.dueDate;
    }
  }
  projects.sort((a, b) => {
    const sa = tabScores.get(a), sb = tabScores.get(b);
    if (sa.minDue !== sb.minDue) {
      if (sa.minDue === null) return 1;
      if (sb.minDue === null) return -1;
      return sa.minDue < sb.minDue ? -1 : 1;
    }
    if (sa.count !== sb.count) return sb.count - sa.count;
    return a.localeCompare(b, 'zh');
  });
  // 当前页签的项目已不存在(如 organize 后任务被改/删)→ 回退到全部
  if (state.activeSheet !== 'all' && !projects.includes(state.activeSheet)) {
    state.activeSheet = 'all';
  }

  const makeTab = (key, label, count) => {
    const cls = 'sheet-tab' + (state.activeSheet === key ? ' active' : '');
    const div = document.createElement('div');
    div.className = cls;
    div.dataset.sheet = key;
    const name = document.createElement('span');
    name.textContent = label;
    const cnt = document.createElement('span');
    cnt.className = 'sheet-count';
    cnt.textContent = count;
    div.append(name, cnt);
    div.addEventListener('click', () => {
      state.activeSheet = key;
      renderTasks();
    });
    return div;
  };

  // 「任务汇总」固定在左侧,项目页签在右侧可横向滚动
  sheetBar.innerHTML = '';
  const fixed = document.createElement('div');
  fixed.className = 'sheet-fixed';
  fixed.appendChild(makeTab('all', '任务汇总', state.tasks.filter(t => !t.completed).length));
  const scroller = document.createElement('div');
  scroller.className = 'sheet-scroll';
  projects.forEach(p => scroller.appendChild(makeTab(p, p, state.tasks.filter(t => t.project === p && !t.completed).length)));
  sheetBar.append(fixed, scroller);
  scroller.scrollLeft = prevScrollLeft;
  updateOrganizeButton(); // 切页签后刷新重排按钮可用状态
}

function renderTasks(shouldAnimate = false) {
  // 列表重建后旧行元素失效,清除选择器行引用
  if (activePickerRow) activePickerRow = null;
  // 记住滚动位置,切换页签重建列表后保持当前位置
  const prevScrollTop = taskList.scrollTop;
  renderSheetBar();
  // FLIP 动画第一步：记录旧位置
  const oldPos = shouldAnimate ? snapshotPositions() : null;

  let visible = state.activeSheet === 'all'
    ? state.tasks
    : state.tasks.filter(t => t.project === state.activeSheet);

  // 项目页签内按日期单独排序:有日期的按日期升序(最早在上),无日期的沉底保持原相对顺序
  // 拷贝排序,不改 state.tasks,汇总页顺序与拖拽排序不受影响
  if (state.activeSheet !== 'all') {
    visible = [...visible].sort((a, b) => {
      // 已完成的任务沉底
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      if (a.dueDate && b.dueDate) return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0;
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return 0;
    });
  }

  taskItems.innerHTML = '';
  if (visible.length === 0) {
    const title = taskEmpty.querySelector('.empty-title');
    const desc = taskEmpty.querySelector('.empty-desc');
    if (state.activeSheet !== 'all' && state.tasks.length > 0) {
      title.textContent = '该项目暂无任务';
      desc.textContent = '切回「任务汇总」查看所有任务';
    } else {
      title.textContent = '还没有任务';
      desc.textContent = '在下方输入想做的事，然后点击「整理」';
    }
    taskEmpty.classList.remove('hidden');
    return;
  }
  taskEmpty.classList.add('hidden');

  visible.forEach((task) => {
    const idx = state.tasks.indexOf(task);
    const row = document.createElement('div');
    row.className = 'task-item';
    if (task.completed) row.classList.add('completed');
    row.dataset.id = task.id;
    row.dataset.idx = idx; // 事件回调从 dataset 读索引,拖拽重排后无需重建 DOM

    const cb = document.createElement('div');
    cb.className = `task-checkbox${task.completed ? ' checked' : ''}`;
    cb.addEventListener('click', (e) => { e.stopPropagation(); toggleTask(+row.dataset.idx); });

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

    // 到期日颜色反馈（仅未完成任务）
    let dueClass = null;
    if (!task.completed && task.dueDate) {
      const today = getToday();
      const tomorrow = getTomorrowStr();
      if (task.dueDate < today) dueClass = 'due-overdue';
      else if (task.dueDate === today) dueClass = 'due-today';
      else if (task.dueDate === tomorrow) dueClass = 'due-tomorrow';
    }
    if (dueClass) text.classList.add(dueClass);

    text.title = task.task.length > 50 ? task.task : '';

    const alarm = document.createElement('span');
    alarm.className = 'task-alarm';
    alarm.textContent = task.alarmTime || '--:--';
    alarm.addEventListener('click', (e) => {
      e.stopPropagation();
      openTimePicker(alarm, +row.dataset.idx);
    });

    // 到期日胶囊
    const ddate = document.createElement('span');
    ddate.className = 'task-duedate' + (task.dueDate ? ' has-date' : '');
    if (task.dueDate) {
      ddate.textContent = task.dueDate.slice(5);
    } else {
      ddate.textContent = '📅';
    }
    ddate.addEventListener('click', (e) => {
      e.stopPropagation();
      openDatePicker(ddate, +row.dataset.idx);
    });

    // 常驻日期胶囊:仅展示,悬停时 CSS 隐藏;修改日期仍走 hover 栏 📅
    let dateChip = null;
    if (task.dueDate) {
      dateChip = document.createElement('span');
      dateChip.className = 'task-date-chip';
      dateChip.textContent = task.dueDate.slice(5);
      if (dueClass) dateChip.classList.add(dueClass);
    }

    const hoverBar = document.createElement('div');
    hoverBar.className = 'hover-bar';
    hoverBar.append(alarm, ddate);

    let barTimer = null;
    row.addEventListener('mouseenter', () => {
      // 选择器展开期间:其他行不显示操作栏(选择器行已钉住,不受影响)
      if (activePickerRow && row !== activePickerRow) return;
      row.style.background = '#f3f3f8'; // 整行悬停背景;操作栏由右缘热区 mousemove 触发
    });
    row.addEventListener('mousemove', (e) => {
      if (activePickerRow) return; // 选择器展开:选择器行钉住显示,其他行不显示
      if (delHold) return; // 长按删除进行中,不弹操作栏
      // 右缘 15px 热区触发显示;保持范围:行右缘 115px 内(覆盖操作栏按钮),移出即隐藏
      const rect = row.getBoundingClientRect();
      if (e.clientX >= rect.right - 15) {
        hoverBar.classList.add('visible');
      } else if (e.clientX < rect.right - 115) {
        hoverBar.classList.remove('visible');
      }
    });
    row.addEventListener('mouseleave', () => {
      if (row === activePickerRow) return; // 选择器行固定显示,离开不收起
      clearTimeout(barTimer);
      hoverBar.classList.remove('visible');
      row.style.background = '';
    });

    // 右键长按删除:按住右键 → 红色进度条 1 秒填满 → 粒子消散 → 删除(仅未完成任务)
    row.addEventListener('mousedown', (e) => {
      if (e.button !== 2) return;
      const rIdx = +row.dataset.idx;
      if (state.tasks[rIdx].completed) return; // 已完成任务不可删除
      const taskId = state.tasks[rIdx].id;
      startDeleteHold(e, row, {
        textEl: text,
        text: state.tasks[rIdx].task,
        // 粒子散尽后按 id 删除,避免动画期间列表变化导致索引错位
        onComplete: () => {
          const i = state.tasks.findIndex(t => t.id === taskId);
          if (i !== -1) deleteTask(i);
        }
      });
    });
    row.addEventListener('mouseup', cancelDeleteHold);
    row.addEventListener('mouseleave', cancelDeleteHold);
    row.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('.task-edit-input')) e.preventDefault();
    });

    row.append(cb, text, hoverBar);
    // 注意:append 不能传 null(WebIDL 会把 null 转成 "null" 文本),空值用 appendChild 跳过
    if (dateChip) row.appendChild(dateChip);
    // 热区提示条:悬停行时右侧灰色竖条提示热区位置;操作栏浮现时由 CSS 淡出
    const zoneHint = document.createElement('span');
    zoneHint.className = 'hotzone-hint';
    row.appendChild(zoneHint);

    // 整行拖拽排序:仅未完成任务,且仅在汇总页可用(项目页签按日期排序,禁拖)
    if (!task.completed && state.activeSheet === 'all') {
      row.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // 仅左键拖拽;右键用于长按删除
        // 勾选框/操作栏/编辑输入框上的点击不触发拖拽
        if (e.target.closest('.task-checkbox, .hover-bar, .task-edit-input')) return;
        // 阻止文本选择;移动未超过阈值时视为普通点击,双击编辑不受影响
        e.preventDefault();
        const startX = e.clientX, startY = e.clientY;
        const onMove = (ev) => {
          if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 4) return;
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          startDrag(ev, +row.dataset.idx, row);
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }

    let clickTimer = null;
    row.addEventListener('click', (e) => {
      if (e.target === alarm || e.target === ddate) return;
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
        enterEditMode(row, +row.dataset.idx);
      } else {
        clickTimer = setTimeout(() => { clickTimer = null; }, 400);
      }
    });

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

  // 恢复滚动位置(列表变短时浏览器自动收紧到最大可滚范围)
  taskList.scrollTop = prevScrollTop;
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

function startDrag(e, taskIdx, rowEl) {
  const row = rowEl || e.currentTarget.closest('.task-item');
  // 拖拽时解除选择器行的固定显示
  if (activePickerRow === row) activePickerRow = null;
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

  // 行索引与数组顺序对齐(不重建 DOM,避免列表刷新闪烁)
  [...taskItems.children].forEach((el, i) => {
    if (el.classList.contains('task-item')) el.dataset.idx = i;
  });
}

function toggleTask(idx) {
  state.tasks[idx].completed = !state.tasks[idx].completed;
  state.tasks[idx].completedAt = state.tasks[idx].completed ? new Date().toISOString() : null;
  sortTasks();
  saveTasks();
  renderTasks(true);
}

// ========== 右键长按删除:红色进度条 + 粒子消散 ==========
const DELETE_HOLD_MS = 1000;      // 任务页删除进度填满时长
const DELETE_HOLD_MS_NOTE = 2000; // 笔记页(文件)删除进度填满时长
const PARTICLE_MS = 450;    // 粒子消散动画时长
let delHold = null;         // { row, taskId, overlay, rafId }

function startDeleteHold(e, row, opts) {
  if (delHold) return; // 全局单实例
  // 编辑框内放行默认右键(复制粘贴);笔记置顶按钮区域不触发删除
  if (e.target.closest('.task-edit-input, .note-list-item-edit')) return;
  if (e.target.closest('.note-list-pin')) return;
  e.preventDefault();
  // 长按开始时收起该行操作栏(任务行有,笔记行无,容错)
  const bar = row.querySelector('.hover-bar');
  if (bar) bar.classList.remove('visible');

  const textEl = opts.textEl || row.querySelector('.task-text');
  const progressEl = opts.progressEl || textEl; // 红线容器(默认与粒子容器一致)
  if (!progressEl) return;
  const overlay = document.createElement('div');
  overlay.className = 'del-progress';
  progressEl.appendChild(overlay);

  const start = performance.now();
  const holdMs = opts.holdMs || DELETE_HOLD_MS; // 页面级时长覆盖(任务1s/笔记2s)
  const tick = (now) => {
    const p = Math.min(1, (now - start) / holdMs);
    overlay.style.transform = `scaleX(${p})`;
    if (p >= 1) { finishDeleteHold(row, opts); return; }
    delHold.rafId = requestAnimationFrame(tick);
  };
  delHold = { row, opts, overlay, rafId: requestAnimationFrame(tick) };
}

function cancelDeleteHold() {
  if (!delHold) return;
  cancelAnimationFrame(delHold.rafId);
  delHold.overlay.remove();
  delHold = null;
}

function finishDeleteHold(row, opts) {
  cancelAnimationFrame(delHold.rafId);
  delHold.overlay.remove();
  delHold = null;
  spawnParticles(row, opts);
  // 粒子散尽后执行删除回调(任务页/笔记页各自注入)
  setTimeout(opts.onComplete, PARTICLE_MS);
}

function spawnParticles(row, opts) {
  const textEl = opts.textEl || row.querySelector('.task-text');
  if (!textEl) return;
  row.classList.add('deleting'); // 复选框/徽标/胶囊/原文字淡出
  row.style.background = ''; // 清除悬停灰色框(inline 优先级高于 CSS),让粒子独立呈现

  const rect = textEl.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  // 项目徽标占位:粒子只覆盖任务名区域(笔记行无徽标,自动为 0)
  let badgeW = 0;
  const badge = textEl.querySelector('.project-badge');
  if (badge) badgeW = badge.getBoundingClientRect().width;
  const chars = [...(opts.text || '')];
  if (chars.length === 0) return;
  const layer = document.createElement('div');
  layer.className = 'del-particle-layer';
  layer.style.left = (rect.left - rowRect.left + badgeW) + 'px';
  layer.style.top = (rect.top - rowRect.top) + 'px';
  layer.style.width = Math.max(1, rect.width - badgeW) + 'px';
  layer.style.height = rect.height + 'px';
  row.appendChild(layer);

  // 任务文字崩解为黑白小圆点:按 8px 间距网格铺设,带随机抖动
  const w = Math.max(1, rect.width - badgeW);
  const h = Math.max(1, rect.height);
  const spacing = 8;
  const cols = Math.max(1, Math.round(w / spacing));
  const rows = Math.max(1, Math.round(h / spacing));
  const dotSize = 2.5;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const dot = document.createElement('span');
      dot.className = 'del-particle';
      dot.style.left = (c * spacing + Math.random() * 4 - 2) + 'px';
      dot.style.top = (r * spacing + Math.random() * 4 - 2) + 'px';
      dot.style.width = dotSize + 'px';
      dot.style.height = dotSize + 'px';
      dot.style.background = Math.random() < 0.2 ? '#ffffff' : '#1f2328'; // 黑白混合,少量白点
      layer.appendChild(dot);
      // 小范围扩散 + 淡出:位移 12~37px,无旋转
      const angle = Math.random() * Math.PI * 2;
      const dist = 12 + Math.random() * 25;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist;
      dot.animate([
        { transform: 'translate(0,0)', opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px)`, opacity: 0 }
      ], {
        duration: 250 + Math.random() * 100,
        delay: Math.random() * 40,
        easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
        fill: 'forwards'
      });
    }
  }
}

// Esc 全局取消长按删除
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelDeleteHold(); });

function deleteTask(idx) {
  state.tasks.splice(idx, 1);
  saveTasks();
  renderTasks();
}

function enterEditMode(row, idx) {
  closeActivePicker(); // 编辑中操作栏隐藏,先收起可能展开的选择器
  row.classList.add('editing'); // 编辑中隐藏悬停操作栏(CSS 规则)
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
    alarmTime: null, dueDate: t.dueDate || null, sortOrder: maxOrder + 1 + i,
  }));

  // 无日期新任务归位：插入到该项目「无日期分组」末尾（与重排后的结构保持一致）；
  // 有日期的新任务保持追加到未完成任务末尾，下次点「重排」时归位
  const plainNew = items.filter(t => !t.dueDate);
  const withDueNew = items.filter(t => t.dueDate);
  const ordered = state.tasks.filter(t => !t.completed)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  for (const item of plainNew) {
    // 优先插到同项目无日期分组末尾；没有同项目组则插到无日期段末尾(新建一组)；都没有则追加到末尾
    let lastPlain = -1, lastSame = -1;
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i].dueDate) continue;
      lastPlain = i;
      if ((ordered[i].project || '') === (item.project || '')) lastSame = i;
    }
    const pos = lastSame !== -1 ? lastSame + 1 : (lastPlain !== -1 ? lastPlain + 1 : ordered.length);
    ordered.splice(pos, 0, item);
  }
  state.tasks = [...ordered, ...withDueNew, ...state.tasks.filter(t => t.completed)];

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

  reassignSortOrders();
  saveTasks();
  renderTasks();
}

// ========== 定时提醒 ==========
let activePicker = null;
let activePickerRow = null; // 选择器所在任务行,展开期间固定显示其操作栏

function closeActivePicker() {
  if (activePicker) { activePicker.remove(); activePicker = null; }
  if (activePickerRow) {
    const row = activePickerRow;
    activePickerRow = null;
    // 解除钉住:鼠标不在该行上,操作栏立即消失(在行上则按普通悬停逻辑保持)
    if (!row.matches(':hover')) {
      const bar = row.querySelector('.hover-bar');
      if (bar) bar.classList.remove('visible');
      row.style.background = '';
    }
  }
}

function openTimePicker(anchorEl, taskIdx) {
  closeActivePicker();
  activePickerRow = anchorEl.closest('.task-item');
  if (activePickerRow) {
    const bar = activePickerRow.querySelector('.hover-bar');
    if (bar) bar.classList.add('visible'); // 选择器展开即钉住操作栏
    activePickerRow.style.background = '#f3f3f8';
  }

  const current = state.tasks[taskIdx].alarmTime || '';
  const curH = current.slice(0, 2) || '';
  const curM = current.slice(3, 5) || '';

  const picker = document.createElement('div');
  picker.className = 'time-picker';
  picker.innerHTML = `<div class="tp-actions"><button class="tp-save">保存</button><button class="tp-clear">清除</button></div><div class="tp-cols"><div class="tp-col" id="tp-hour"></div><div class="tp-col" id="tp-min"></div></div>`;
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
      colH.querySelector('.tp-opt.active')?.classList.remove('active');
      opt.classList.add('active');
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
      colM.querySelector('.tp-opt.active')?.classList.remove('active');
      opt.classList.add('active');
    });
    colM.appendChild(opt);
  }

  // 保存按钮
  picker.querySelector('.tp-save').addEventListener('click', () => {
    saveTasks();
    closeActivePicker();
    renderTasks();
  });

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
        if (activePicker === picker) closeActivePicker();
        app.removeEventListener('click', closePk);
      }
    };
    app.addEventListener('click', closePk, true);
  }, 0);

  activePicker = picker;
}

// ========== 到期日选择器 ==========
function openDatePicker(anchorEl, taskIdx) {
  closeActivePicker();
  activePickerRow = anchorEl.closest('.task-item');
  if (activePickerRow) {
    const bar = activePickerRow.querySelector('.hover-bar');
    if (bar) bar.classList.add('visible'); // 选择器展开即钉住操作栏
    activePickerRow.style.background = '#f3f3f8';
  }

  const current = state.tasks[taskIdx].dueDate || '';
  let viewYear, viewMonth;

  if (current) {
    viewYear = parseInt(current.slice(0, 4), 10);
    viewMonth = parseInt(current.slice(5, 7), 10) - 1;
  } else {
    const now = new Date();
    viewYear = now.getFullYear();
    viewMonth = now.getMonth();
  }

  const picker = document.createElement('div');
  picker.className = 'date-picker';

  function renderCalendar() {
    const today = getToday();
    const todayParts = today.split('-');
    const todayY = parseInt(todayParts[0], 10);
    const todayM = parseInt(todayParts[1], 10);
    const todayD = parseInt(todayParts[2], 10);

    const firstDay = new Date(viewYear, viewMonth, 1).getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();

    const monthLabel = `${viewYear}年${viewMonth + 1}月`;

    let html = `<div class="dp-header">
      <button class="dp-nav dp-prev">&lt;</button>
      <span class="dp-month">${monthLabel}</span>
      <button class="dp-nav dp-next">&gt;</button>
    </div>`;

    html += '<div class="dp-weekdays">';
    ['日','一','二','三','四','五','六'].forEach(w => {
      html += `<div class="dp-weekday">${w}</div>`;
    });
    html += '</div>';

    html += '<div class="dp-grid">';
    for (let i = firstDay - 1; i >= 0; i--) {
      const d = daysInPrevMonth - i;
      html += `<div class="dp-day other-month">${d}</div>`;
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = formatDateStr(viewYear, viewMonth + 1, d);
      let cls = 'dp-day';
      if (dateStr === today) cls += ' today';
      if (dateStr === current) cls += ' selected';
      html += `<div class="${cls}" data-date="${dateStr}">${d}</div>`;
    }
    const totalCells = firstDay + daysInMonth;
    const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let d = 1; d <= remaining; d++) {
      html += `<div class="dp-day other-month">${d}</div>`;
    }
    html += '</div>';

    html += '<div class="dp-actions">';
    html += '<button class="dp-action-btn" data-action="mon">周一</button>';
    html += '<button class="dp-action-btn" data-action="tue">周二</button>';
    html += '<button class="dp-action-btn" data-action="wed">周三</button>';
    html += '<button class="dp-action-btn" data-action="thu">周四</button>';
    html += '<button class="dp-action-btn" data-action="fri">周五</button>';
    html += '</div>';
    html += '<div class="dp-clear-row">';
    html += '<button class="dp-action-btn clear-btn" data-action="clear">清除</button>';
    html += '</div>';

    picker.innerHTML = html;

    picker.querySelector('.dp-prev').addEventListener('click', () => {
      viewMonth--;
      if (viewMonth < 0) { viewMonth = 11; viewYear--; }
      renderCalendar();
    });
    picker.querySelector('.dp-next').addEventListener('click', () => {
      viewMonth++;
      if (viewMonth > 11) { viewMonth = 0; viewYear++; }
      renderCalendar();
    });

    picker.querySelectorAll('.dp-day:not(.other-month)').forEach(dayEl => {
      dayEl.addEventListener('click', () => {
        state.tasks[taskIdx].dueDate = dayEl.dataset.date;
        saveTasks();
        closeActivePicker();
        renderTasks();
      });
    });

    picker.querySelectorAll('.dp-action-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        let dateStr = null;
        if (action === 'mon' || action === 'tue' || action === 'wed' || action === 'thu' || action === 'fri') {
          const dowMap = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5 };
          const now = new Date();
          let todayDow = now.getDay();
          if (todayDow === 0) todayDow = 7; // 周日=7
          let offset = dowMap[action] - todayDow;
          if (offset < 0) offset += 7; // 本周已过 → 下周
          const d = new Date(now);
          d.setDate(now.getDate() + offset);
          dateStr = formatDateStr(d.getFullYear(), d.getMonth() + 1, d.getDate());
        } else if (action === 'clear') {
          state.tasks[taskIdx].dueDate = null;
        }
        if (dateStr !== undefined) {
          if (dateStr !== null) state.tasks[taskIdx].dueDate = dateStr;
          saveTasks();
          closeActivePicker();
          renderTasks();
        }
      });
    });
  }

  renderCalendar();
  app.appendChild(picker);

  const appRect = app.getBoundingClientRect();
  const anchorRect = anchorEl.getBoundingClientRect();
  picker.style.left = Math.max(8, Math.min(appRect.width - 218, anchorRect.left - appRect.left - 50)) + 'px';
  picker.style.top = Math.max(4, anchorRect.top - appRect.top - 260) + 'px';

  setTimeout(() => {
    function closeDp(e) {
      const isEsc = e.key === 'Escape';
      if (isEsc || (!picker.contains(e.target) && e.target !== anchorEl)) {
        if (activePicker === picker) closeActivePicker();
        document.removeEventListener('keydown', closeDp, true);
        app.removeEventListener('click', closeDp, true);
      }
    }
    document.addEventListener('keydown', closeDp, true);
    app.addEventListener('click', closeDp, true);
  }, 0);

  activePicker = picker;
}

// ========== 输入处理 ==========
function hasContent() {
  return textInput.value.trim().length > 0 || state.images.length > 0;
}

function updateOrganizeButton() {
  // 重排仅对任务汇总页生效：汇总页且有未完成任务时可点击
  const hasPending = state.tasks.some(t => !t.completed);
  btnOrganize.disabled = state.activeSheet !== 'all' || !hasPending || state.organizing;
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

// ========== 任务重排（汇总页整理按钮） ==========
function rearrangeTasks() {
  if (state.activeSheet !== 'all' || state.organizing) return;
  if (state.tasks.every(t => t.completed)) return;

  const undone = state.tasks.filter(t => !t.completed);
  const done = state.tasks.filter(t => t.completed);
  const withDue = undone.filter(t => t.dueDate);
  const withoutDue = undone.filter(t => !t.dueDate);

  // 有日期段：(日期升序, 项目名) —— 日期相同且项目相同的任务必然聚在一起
  withDue.sort((a, b) =>
    a.dueDate.localeCompare(b.dueDate) || (a.project || '').localeCompare(b.project || '', 'zh') || 0
  );

  // 无日期段：按项目首次出现顺序分组，组内保持原有相对顺序
  const groupOrder = [];
  const groups = [];
  for (const t of withoutDue) {
    const p = t.project || '';
    let gi = groupOrder.indexOf(p);
    if (gi === -1) { groupOrder.push(p); groups.push([]); gi = groups.length - 1; }
    groups[gi].push(t);
  }

  state.tasks = [...withDue, ...groups.flat(), ...done];
  reassignSortOrders();
  saveTasks();
  renderTasks(true);
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
    // 兜底：当前处于项目页签且文本中未识别出项目 → 默认归属当前页签的项目
    if (!project && state.activeSheet !== 'all') {
      project = state.activeSheet;
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
  if (imgs.length > 0) tasks.push({ task: '【截图识别】请编辑此任务补充详情', project: project || undefined });
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
  // 按块级元素分行(兼容 div/p/li 混合),空块保留为空行
  const lines = [];
  const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'UL', 'OL', 'DL', 'SECTION']);
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent.trim();
      if (t) lines.push(t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const kids = Array.from(node.childNodes);
    const hasBlockChild = kids.some(k => k.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(k.tagName));
    if (hasBlockChild) {
      kids.forEach(walk);
    } else {
      lines.push((node.textContent || '').trim());
    }
  }
  walk(div);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
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
    $('#settings-tools-page').checked = cfg.pagesEnabled?.tools !== false;
    const blurHide = cfg.blurHide || { tasks: true, notepad: true, tools: true };
    $('#settings-blurhide-tasks').checked = blurHide.tasks !== false;
    $('#settings-blurhide-notepad').checked = blurHide.notepad !== false;
    $('#settings-blurhide-tools').checked = blurHide.tools !== false;
    if (cfg.shortcuts) {
      state.shortcuts = { ...state.shortcuts, ...cfg.shortcuts };
    }
    state.projectNames = [...(cfg.projectNames || [])];
    renderProjectTags();
  }
  renderShortcutInputs();
  settingsOverlay.classList.remove('hidden');
  $('#settings-apikey').focus();
  // 聚焦后浏览器会自动滚动到输入框位置，重置到顶部
  $('.settings-body').scrollTop = 0;
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
  setKbdDisplay($('#shortcut-switchTools'), state.shortcuts.switchTools);
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
  const toolsEnabled = $('#settings-tools-page').checked;
  const pagesEnabled = { tasks: tasksEnabled, tools: toolsEnabled };
  const blurHide = {
    tasks: $('#settings-blurhide-tasks').checked,
    notepad: $('#settings-blurhide-notepad').checked,
    tools: $('#settings-blurhide-tools').checked,
  };
  const cfg = { apiKey, baseUrl, reportName, notesDir, notesDirHistory: oldCfg.notesDirHistory || [], projectNames: [...state.projectNames], shortcuts: { ...state.shortcuts }, winFixed, pagesEnabled, blurHide };

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
  updateToolsPageVisibility();
  if (!tasksEnabled && tasksWasEnabled && state.currentPage === 'main') {
    switchToNotepad();
  }
  if (!toolsEnabled && state.currentPage === 'tools') {
    switchToMain();
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
  state.shortcuts.switchTools = getVal('shortcut-switchTools');
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

function getTomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function formatDateStr(year, month, day) {
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
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
  // 用 visibility 隐藏而非 display:none,保留占位,否则页脚栏会塌陷成细条
  btnNotepadBack.style.visibility = enabled ? '' : 'hidden';
}

function updateToolsPageVisibility() {
  const enabled = state.pagesEnabled.tools;
  // 工具箱页本身通过设置开关控制;页脚栏右滑按钮在工具箱关闭时隐藏
  btnNotepadForward.style.visibility = enabled ? 'visible' : 'hidden';
}

function isToolsPageEnabled() {
  return state.pagesEnabled.tools && Object.values(state.toolsEnabled).some(v => v);
}

function renderToolsPage() {
  toolsCards.innerHTML = '';
  // 只渲染启用的功能卡;未启用不创建 DOM、不绑定事件
  if (state.toolsEnabled.translate) renderTranslateCard();
}

// ========== 工具箱:翻译卡 ==========
let translateDebounce = null;
let translateReqSeq = 0;

function renderTranslateCard() {
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.dataset.tool = 'translate';

  const title = document.createElement('div');
  title.className = 'tool-card-title';
  title.appendChild(document.createTextNode('翻译'));
  const titleEn = document.createElement('span');
  titleEn.className = 'tool-card-title-en';
  titleEn.textContent = 'Translation';
  title.appendChild(titleEn);

  const input = document.createElement('div');
  input.className = 'tool-card-input';
  input.dataset.placeholder = '粘贴或输入文字/截图...';
  input.classList.add('is-empty');
  input.contentEditable = 'true';

  const status = document.createElement('div');
  status.className = 'tool-card-status';

  const result = document.createElement('div');
  result.className = 'tool-card-result';

  // 注意：译文赋值不能直接写 result.textContent——textContent 会清空子节点，
  // 灰线/反向译文等兄弟元素会被销毁。译文只写入 forwardText，兄弟节点不受影响。
  const forwardText = document.createElement('div');
  forwardText.className = 'tool-card-result-text';

  // 灰线分割 + 反向译文：验证后显示在同一个框内
  const backSep = document.createElement('div');
  backSep.className = 'tool-card-back-sep hidden';
  const backText = document.createElement('div');
  backText.className = 'tool-card-back-text hidden';

  result.append(forwardText, backSep, backText);
  card.append(title, input, result, status);
  toolsCards.appendChild(card);

  const isEmpty = () => !input.textContent.trim() && input.querySelectorAll('img').length === 0;
  const updateEmpty = () => input.classList.toggle('is-empty', isEmpty());

  // 输入防抖翻译
  input.addEventListener('input', () => {
    updateEmpty();
    clearTimeout(translateDebounce);
    const content = collectTranslateInput(input);
    if (!content.text && content.images.length === 0) {
      // 清空输入:作废旧请求,防止旧结果覆盖
      ++translateReqSeq;
      const forwardText = card.querySelector('.tool-card-result-text');
      if (forwardText) forwardText.textContent = '';
      hideBackResult(card);
      status.textContent = '';
      return;
    }
    status.textContent = '翻译中...';
    translateDebounce = setTimeout(() => doTranslate(content), 300);
  });

  // 粘贴图片 → OCR → 翻译
  input.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob || blob.size > 10 * 1024 * 1024) { status.textContent = '图片过大，单张不超过 10MB'; return; }
        const reader = new FileReader();
        reader.onload = async (ev) => {
          const dataUrl = ev.target.result;
          // 在输入框尾部显示图片
          const img = document.createElement('img');
          img.src = dataUrl;
          img.style.cssText = 'max-width:100%;border-radius:4px;margin:4px 0;display:block;';
          input.appendChild(img);
          updateEmpty();
          status.textContent = '识别图片中...';
          const content = { text: '', images: [dataUrl] };
          doTranslate(content);
        };
        reader.readAsDataURL(blob);
      }
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); input.blur(); }
  });
}

function collectTranslateInput(input) {
  // 收集文本(排除图片)
  const clone = input.cloneNode(true);
  clone.querySelectorAll('img').forEach(img => img.remove());
  return { text: clone.textContent.trim(), images: [] };
}

async function doTranslate(content) {
  if (!content.text && content.images.length === 0) return;
  const card = toolsCards.querySelector('[data-tool="translate"]');
  if (!card) return;
  const result = card.querySelector('.tool-card-result');
  const status = card.querySelector('.tool-card-status');
  const seq = ++translateReqSeq;
  try {
    let translated, langHint = '';
    if (window.electronAPI) {
      const res = await window.electronAPI.translateRequest(content);
      if (res.success) {
        translated = res.translated;
        if (res.sourceLang && res.targetLang) langHint = `${res.sourceLang} → ${res.targetLang}`;
        if (res.ocrFailed) langHint += ` · ${res.ocrFailed}张图片识别失败`;
      }
      else { if (seq === translateReqSeq) { status.textContent = res.error; status.classList.add('error'); } return; }
    } else {
      // 浏览器调试模式:模拟翻译
      translated = `[翻译结果] ${content.text || '图片内容'}`;
    }
    if (seq !== translateReqSeq) return;
    const forwardText = card.querySelector('.tool-card-result-text');
    if (forwardText) forwardText.textContent = translated;
    // 新译文产生，隐藏旧的验证结果（灰线 + 反向译文）
    hideBackResult(card);
    status.textContent = langHint;
    status.classList.remove('error');
    // 自动反向翻译验证
    autoVerify(card, seq);
  } catch (e) {
    if (seq === translateReqSeq) { status.textContent = '翻译失败：' + e.message; status.classList.add('error'); }
  }
}

// ========== 翻译验证：自动反向翻译 ==========
function hideBackResult(card) {
  const sep = card.querySelector('.tool-card-back-sep');
  const backText = card.querySelector('.tool-card-back-text');
  if (sep) sep.classList.add('hidden');
  if (backText) { backText.classList.add('hidden'); backText.textContent = ''; }
}

// 翻译成功后自动调用：把译文反向翻译一次，灰线 + 反向译文展示在译文下方供核对
async function autoVerify(card, seq) {
  const forwardText = card.querySelector('.tool-card-result-text');
  const status = card.querySelector('.tool-card-status');
  const backSep = card.querySelector('.tool-card-back-sep');
  const backText = card.querySelector('.tool-card-back-text');
  const text = forwardText.textContent.trim();
  if (!text) return;

  try {
    let backValue, langHint = '';
    if (window.electronAPI) {
      // 复用翻译通道：自动检测译文语言并翻回原语言
      const res = await window.electronAPI.translateRequest({ text, images: [] });
      if (res.success) {
        backValue = res.translated;
        if (res.sourceLang && res.targetLang) langHint = `↩ ${res.sourceLang} → ${res.targetLang}`;
      } else {
        if (seq === translateReqSeq) { status.textContent = res.error; status.classList.add('error'); }
        return;
      }
    } else {
      backValue = `[反向翻译] ${text}`; // 浏览器调试模式模拟
    }
    // 验证期间输入已变化：丢弃过期验证结果
    if (seq !== translateReqSeq) return;
    backText.textContent = backValue;
    backSep.classList.remove('hidden');
    backText.classList.remove('hidden');
    status.textContent = langHint || '反向翻译完成';
    status.classList.remove('error');
  } catch (e) {
    if (seq === translateReqSeq) { status.textContent = '反向翻译失败：' + e.message; status.classList.add('error'); }
  }
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
  pagesContainer.classList.remove('on-tools');
  pagesContainer.classList.add('on-notepad');
  closeNoteSearch();
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
  pagesContainer.classList.remove('on-notepad', 'on-tools');
  setTimeout(() => textInput.focus(), 400);
}

async function switchToTools() {
  if (state.currentPage === 'tools') return;
  if (!isToolsPageEnabled()) return;
  // 保存当前笔记
  saveCurrentNote();
  state.currentPage = 'tools';
  if (window.electronAPI) window.electronAPI.setPage('tools');
  renderToolsPage();
  pagesContainer.classList.remove('on-notepad');
  pagesContainer.classList.add('on-tools');
  setTimeout(() => {
    const input = toolsCards.querySelector('.tool-card-input');
    if (input) input.focus();
  }, 400);
}

// ========== 笔记管理 ==========
function onNotepadInput() {
  state.noteContent = htmlToMarkdown(notepadTextarea.innerHTML);
  const isEmpty = !notepadTextarea.textContent?.trim() && notepadTextarea.querySelectorAll('img').length === 0;
  notepadTextarea.classList.toggle('is-empty', isEmpty);
  // 搜索打开时,输入内容会破坏 mark 结构,重建高亮
  if (!noteSearchBar.classList.contains('hidden')) doNoteSearch();
}

// ========== 笔记页搜索 ==========
function toggleNoteSearch() {
  if (noteSearchBar.classList.contains('hidden')) openNoteSearch();
  else closeNoteSearch();
}

function openNoteSearch() {
  noteSearchBar.classList.remove('hidden');
  noteSearchInput.value = '';
  noteSearchStatus.textContent = '';
  noteSearchStatus.classList.remove('noresult');
  state.noteSearch = null;
  noteSearchInput.focus();
}

function closeNoteSearch() {
  if (noteSearchBar.classList.contains('hidden')) return;
  noteSearchBar.classList.add('hidden');
  clearNoteSearchMarks();
  state.noteSearch = null;
}

function clearNoteSearchMarks() {
  notepadTextarea.querySelectorAll('mark').forEach(m => m.replaceWith(document.createTextNode(m.textContent)));
}

function doNoteSearch() {
  const query = noteSearchInput.value.trim().toLowerCase();
  clearNoteSearchMarks();
  noteSearchStatus.textContent = '';
  noteSearchStatus.classList.remove('noresult');
  if (!query) { state.noteSearch = null; return; }
  // 先收集文本节点,处理时替换节点不影响遍历
  const textNodes = [];
  const walker = document.createTreeWalker(notepadTextarea, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);
  const matches = [];
  for (const node of textNodes) {
    const text = node.textContent;
    const lower = text.toLowerCase();
    let idx = lower.indexOf(query);
    if (idx === -1) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    while (idx !== -1) {
      if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(idx, idx + query.length);
      frag.appendChild(mark);
      matches.push(mark);
      last = idx + query.length;
      idx = lower.indexOf(query, last);
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
  state.noteSearch = { query, matches, index: -1 };
  if (!matches.length) {
    noteSearchStatus.classList.add('noresult');
  } else {
    nextNoteMatch();
  }
}

function nextNoteMatch() {
  const s = state.noteSearch;
  if (!s || !s.matches.length) return;
  if (s.index >= 0) s.matches[s.index].classList.remove('active');
  s.index = (s.index + 1) % s.matches.length;
  const m = s.matches[s.index];
  m.classList.add('active');
  m.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
  closeNoteSearch();
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
  closeNoteSearch();
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
    nameSpan.className = 'note-list-name'; // 定位参照:进度条/粒子层
    nameSpan.textContent = note.filename.replace(/\.md$/, '');
    nameSpan.style.overflow = 'hidden';
    nameSpan.style.textOverflow = 'ellipsis';

    const rightGroup = document.createElement('span');
    rightGroup.className = 'note-list-right';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'note-list-mtime';
    timeSpan.textContent = note.mtime.slice(0, 10);

    const pinBtn = document.createElement('button');
    pinBtn.className = 'note-list-pin' + (pinnedSet.has(note.filename) ? ' pinned' : '');
    // 内联 SVG 图钉:已置顶=主题色实心,未置顶=淡灰(不依赖 emoji 字体渲染)
    pinBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>';
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
    // 右键长按删除笔记文件(与任务页一致:红色进度条 1 秒填满 → 粒子消散 → 删除)
    row.addEventListener('mousedown', (e) => {
      if (e.button !== 2) return;
      if (state.notes.length <= 1) return; // 最后一条笔记不可删除
      startDeleteHold(e, row, {
        textEl: nameSpan,
        progressEl: row, // 红线固定覆盖整行宽(终止于右侧日期),不随文件名长度变化
        holdMs: DELETE_HOLD_MS_NOTE, // 文件删除 2 秒,任务删除保持 1 秒
        text: note.filename.replace(/\.md$/, ''),
        onComplete: () => deleteNoteHandler(note.filename)
      });
    });
    row.addEventListener('mouseup', cancelDeleteHold);
    row.addEventListener('mouseleave', cancelDeleteHold);
    row.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('.note-list-item-edit')) e.preventDefault();
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
