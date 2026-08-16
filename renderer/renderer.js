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
  showSheetBar: true, // 项目页签栏显示开关(设置页,默认显示)
  showProjectBadge: true, // 任务行项目胶囊显示开关(设置页,默认显示)
  showDailyReport: true, // 任务页日报按钮显示开关(设置页,默认显示)
  showCalendar: true, // 任务页日历按钮显示开关(设置页,默认显示)
  calendarOpen: false, // 日历视图是否打开
  calendarMonth: { y: 0, m: 0 }, // 日历当前显示的年月
  calendarSelected: null, // 点击选中的日期 YYYY-MM-DD(organize 应用到新任务)
  calendarDayDate: null, // 当日任务视图当前日期 YYYY-MM-DD
  calendarDayTasks: null, // 当日视图渲染的任务数组(历史日期含文件任务,负 idx 操作映射)
  calendarDayIdMap: null, // 负 idx → 任务 的精确映射(点击操作按 id 定位,防排序错位)
  calendarWeek: null, // 周条当前显示的周(基准日,可独立于选中日期切周)
  toolsEnabled: { translate: true, harness: true },
  harness: {
    status: 'idle', sessionId: null, workspace: '', permission: 'workspace-write', mode: 'standard',
    model: 'deepseek-v4-flash', reasoningEffort: 'high', configured: false, configError: '',
    messages: [], sessions: [], todos: [], diffs: [], sessionTitle: '', toolGroupExpanded: false, todosExpanded: false,
    runStartedAt: null, runElapsedMs: null, runTokens: null,
  },
  hoveredImage: null,
  activeSheet: 'all',
  noteSearch: null,
  windowVisible: false,
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
const dailyReportGroup = $('.daily-report-group');
const inputActions = $('#input-actions');
const taskArea = $('#task-area');
const btnCalendar = $('#btn-calendar');
const calendarView = $('#calendar-view');
const calGrid = $('#cal-grid');
const calWeekline = $('#cal-weekline');
const calWeekDays = $('#cal-week-days');
const calWeekPrevBtn = $('#cal-week-prev');
const calWeekNextBtn = $('#cal-week-next');
const calMonthlabel = $('#cal-monthlabel');
const calPrevBtn = $('#cal-prev');
const calNextBtn = $('#cal-next');
const calDayTasks = $('#cal-day-tasks');
const recogTab = $('#recog-tab');
const noteSearchBar = $('#note-search-bar');
const noteSearchInput = $('#note-search-input');
const noteSearchStatus = $('#note-search-status');

// ========== 初始化 ==========
async function init() {
  await loadShortcutsFromConfig();
  initializeSettingsSelects();
  if (window.electronAPI?.onHarnessEvent) window.electronAPI.onHarnessEvent(handleHarnessEvent);
  await refreshHarnessSnapshot();
  await refreshHarnessSessions(true);
  const restoredPage = window.electronAPI?.getPage ? await window.electronAPI.getPage() : 'main';
  if (state.pagesEnabled.tasks) {
    await loadTasks();
    renderTasks();
  }
  if (restoredPage === 'tools' && isToolsPageEnabled()) await switchToTools();
  else if (restoredPage === 'notepad' || !state.pagesEnabled.tasks) await switchToNotepad();
  updateOrganizeButton();
  updateTasksPageVisibility();
  updateToolsPageVisibility();
  applyCalendarVisibility(); // 日历按钮开关(旧配置无字段时默认显示)

  textInput.addEventListener('input', updateOrganizeButton);
  textInput.addEventListener('paste', handlePaste);
  textInput.addEventListener('keydown', (e) => {
    if (matchShortcut(e, state.shortcuts.organize)) { e.preventDefault(); e.stopPropagation(); organize(); }
  });

  btnOrganize.addEventListener('click', rearrangeTasks);
  $('#btn-settings-confirm').addEventListener('click', confirmSettings);
  $('#btn-settings-back').addEventListener('click', cancelSettings);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#settings-harness-reset-approval').addEventListener('click', async () => {
    if (window.electronAPI?.harnessResetWorkspaceApproval) {
      await window.electronAPI.harnessResetWorkspaceApproval();
    }
    const hint = $('#settings-reset-approval-hint');
    hint.textContent = '目录授权已重置';
    hint.classList.add('show');
    clearTimeout(hint._resetTimer);
    hint._resetTimer = setTimeout(() => {
      hint.classList.remove('show');
      setTimeout(() => { hint.textContent = ''; }, 200);
    }, 2000);
  });
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
  // 日历
  btnCalendar.addEventListener('click', toggleCalendar);
  calPrevBtn.addEventListener('click', () => shiftCalendarMonth(-1));
  calNextBtn.addEventListener('click', () => shiftCalendarMonth(1));
  // 点击年月:当日视图→返回全屏日历;全屏日历→返回任务列表(同 Esc)
  calMonthlabel.addEventListener('click', () => {
    if (state.calendarDayDate) exitDayMode();
    else closeCalendar();
  });
  calWeekPrevBtn.addEventListener('click', () => shiftWeek(-1)); // 周条上一周
  calWeekNextBtn.addEventListener('click', () => shiftWeek(1)); // 周条下一周
  calGrid.addEventListener('wheel', onCalGridWheel, { passive: false }); // 日历滚轮切月
  recogTab.addEventListener('click', () => {
    collapseTextInput(false);
    textInput.focus();
  });
  // 页签栏滚轮横向滚动(仅当有横向溢出时拦截,否则放行给任务列表)
  sheetBar.addEventListener('wheel', (e) => {
    const scroller = sheetBar.querySelector('.sheet-scroll');
    if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return;
    e.preventDefault();
    // 与待选项目一致的丝滑滚动:增量累积到目标,rAF 指数缓动逼近,滚轮停止后惯性滑行
    startExpandScroll(scroller, e.deltaY);
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
      state.windowVisible = true;
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
      state.windowVisible = false;
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
            unfinished.forEach(t => { t.createdAt = new Date().toISOString(); if (!t.id) t.id = genId(); t.alarmTime = null; });
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
function snapshotPositions(container = taskItems) {
  const map = {};
  container.querySelectorAll('.task-item').forEach(el => {
    map[el.dataset.id] = el.getBoundingClientRect().top;
  });
  return map;
}

// 任务行统一出现动画：日历返回与项目页签切换共用同一节奏。
function animateTaskRowsIn(container = taskItems) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  container.querySelectorAll('.task-item').forEach((el, i) => {
    el.animate([
      { opacity: 0, transform: 'translateY(8px)' },
      { opacity: 1, transform: 'translateY(0)' }
    ], { duration: 220, delay: i * 45, easing: 'ease', fill: 'both' });
  });
}

// ========== 项目页签栏 ==========
// 页签栏显示开关:整行隐藏;关闭时若停在项目页签,强制回任务汇总(否则无入口切回)
function applySheetBarVisibility() {
  sheetBar.style.display = state.showSheetBar ? '' : 'none';
  if (!state.showSheetBar && state.activeSheet !== 'all') {
    state.activeSheet = 'all';
    renderTasks();
  }
}

// 日报按钮显示开关:隐藏日报按钮组;space-between 单元素会左对齐,切 flex-end 保证重排/右滑按钮仍在最右侧
function applyDailyReportVisibility() {
  inputActions.classList.toggle('no-daily-report', !state.showDailyReport);
}

// 日历按钮显示开关
function applyCalendarVisibility() {
  btnCalendar.style.display = state.showCalendar ? '' : 'none';
}

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
      if (state.activeSheet === key) return;
      state.activeSheet = key;
      renderTasks(false, true);
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

function renderTasks(shouldAnimate = false, staggerIn = false) {
  // 列表重建后旧行元素失效,清除选择器行引用
  if (activePickerRow) activePickerRow = null;
  expandingRow = null; // 行重建,项目展开态失效
  clearTimeout(expandCloseTimer);
  // 记住滚动位置,切换页签重建列表后保持当前位置
  const prevScrollTop = taskList.scrollTop;
  renderSheetBar();
  // FLIP 动画第一步：记录旧位置
  const oldPos = shouldAnimate ? snapshotPositions() : null;

  // 当天已完成任务继续显示，并由 sortTasks 沉到列表底部；历史日期仍由日历文件提供。
  let visible = state.activeSheet === 'all'
    ? state.tasks
    : state.tasks.filter(t => t.project === state.activeSheet);

  // 项目页签内按日期单独排序:有日期的按日期升序(最早在上),无日期的沉底保持原相对顺序
  // 拷贝排序,不改 state.tasks,汇总页顺序与拖拽排序不受影响
  if (state.activeSheet !== 'all') {
    visible = [...visible].sort((a, b) => {
      // 已完成的任务沉底
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      if (a.completed && b.completed) {
        return new Date(a.completedAt || 0).getTime() - new Date(b.completedAt || 0).getTime();
      }
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
    const row = buildTaskRow(task, idx, {});

    // 整行拖拽排序:仅未完成任务,且仅在汇总页可用(项目页签按日期排序,禁拖)
    if (!task.completed && state.activeSheet === 'all') {
      row.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // 仅左键拖拽;右键用于长按删除
        // 勾选框/操作栏/编辑输入框/项目控件/展开态上的点击不触发拖拽
        if (e.target.closest('.task-checkbox, .hover-bar, .task-edit-input, .project-badge, .project-placeholder, .project-expanding')) return;
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
  if (staggerIn) animateTaskRowsIn(taskItems);
  // 日历开着时刷新月历圆点(勾选/增删任务后计数同步)
  if (state.calendarOpen) renderCalendar();
  // 当日任务视图开着时同步刷新(行内项目切换/编辑/删除后保持一致),勾选重排时同步 FLIP 滑动
  if (state.calendarDayDate) renderDayTasks(shouldAnimate);
}

// ========== 任务行构造(主列表与当日任务视图共用) ==========
// opts.noHoverBar: 特殊只读场景可禁用悬停操作栏(alarm/日期修改)与热区提示
function buildTaskRow(task, idx, opts = {}) {
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

  // 项目徽标:单击行内展开项目选择(仅未完成任务;已完成任务徽标不可点);项目胶囊开关关闭时不渲染
  if (state.showProjectBadge && task.project) {
    const badge = document.createElement('span');
    badge.className = 'project-badge';
    badge.textContent = task.project;
    if (!task.completed) {
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        openProjectExpand(row, +row.dataset.idx);
      });
    }
    text.appendChild(badge);
  } else if (state.showProjectBadge && !task.completed) {
    // 无项目任务:徽标位常驻虚位胶囊,单击行内展开项目选择
    const ph = document.createElement('span');
    ph.className = 'project-placeholder';
    ph.textContent = '+';
    ph.addEventListener('click', (e) => {
      e.stopPropagation();
      openProjectExpand(row, +row.dataset.idx);
    });
    text.appendChild(ph);
  }
  // 任务文字独立包装:展开态隐藏文字但保留徽标
  const textContent = document.createElement('span');
  textContent.className = 'task-text-content';
  textContent.appendChild(document.createTextNode(task.task));
  text.appendChild(textContent);

  // 到期日颜色反馈（仅未完成任务）
  let dueClass = null;
  if (!task.completed && task.dueDate) {
    const today = getToday();
    const tomorrow = getTomorrowStr();
    if (task.dueDate < today) dueClass = 'due-overdue';
    else if (task.dueDate === today) dueClass = 'due-today';
    else if (task.dueDate === tomorrow) dueClass = 'due-tomorrow';
  }

  textContent.title = task.task.length > 50 ? task.task : '';

  // 悬停操作栏(时间/日期修改):任务列表与日视图共用
  let hoverBar = null;
  if (!opts.noHoverBar) {
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

    hoverBar = document.createElement('div');
    hoverBar.className = 'hover-bar';
    hoverBar.append(alarm, ddate);
  }

  // 常驻日期胶囊:仅展示,悬停时 CSS 隐藏;修改日期仍走 hover 栏 📅
  let dateChip = null;
  if (task.dueDate) {
    dateChip = document.createElement('span');
    dateChip.className = 'task-date-chip';
    dateChip.textContent = task.dueDate.slice(5);
    if (dueClass) dateChip.classList.add(dueClass);
  }

  let barTimer = null;
  row.addEventListener('mouseenter', () => {
    // 选择器展开期间:其他行不显示操作栏(选择器行已钉住,不受影响)
    if (activePickerRow && row !== activePickerRow) return;
    row.style.background = '#f3f3f8'; // 整行悬停背景;操作栏由右缘热区 mousemove 触发
  });
  row.addEventListener('mousemove', (e) => {
    if (!hoverBar) return; // 当日视图无操作栏
    if (activePickerRow) return; // 选择器展开:选择器行钉住显示,其他行不显示
    if (delHold) return; // 长按删除进行中,不弹操作栏
    if (expandingRow === row) return; // 项目展开态:右缘热区不生效
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
    if (hoverBar) hoverBar.classList.remove('visible');
    row.style.background = '';
  });

  // 右键长按删除:按住右键 → 红色进度条 1 秒填满 → 粒子消散 → 删除(仅未完成任务)
  row.addEventListener('mousedown', (e) => {
    if (e.button !== 2) return;
    if (e.target.closest('.project-badge, .project-placeholder, .project-expanding')) return; // 项目控件/展开态上的右键不触发删除
    const rIdx = +row.dataset.idx;
    const t = taskByIdx(rIdx);
    if (!t || t.completed) return; // 已完成任务不可删除(历史任务经 taskByIdx 映射,防非法索引)
    const taskId = t.id;
    startDeleteHold(e, row, {
      textEl: text,
      text: t.task,
      // 粒子散尽后按 id 删除,避免动画期间列表变化导致索引错位
      onComplete: () => {
        const i = state.tasks.findIndex(x => x.id === taskId);
        if (i !== -1) deleteTask(i);
        else removeTaskFromFile(t).then(() => renderTasks()); // 历史任务:删除全部副本后刷新日历
      }
    });
  });
  row.addEventListener('mouseup', cancelDeleteHold);
  row.addEventListener('mouseleave', cancelDeleteHold);
  row.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.task-edit-input')) e.preventDefault();
  });

  if (hoverBar) row.append(cb, text, hoverBar);
  else row.append(cb, text);
  // 注意:append 不能传 null(WebIDL 会把 null 转成 "null" 文本),空值用 appendChild 跳过
  if (dateChip) row.appendChild(dateChip);
  // 热区提示条:悬停行时右侧灰色竖条提示热区位置;操作栏浮现时由 CSS 淡出
  if (!opts.noHoverBar) {
    const zoneHint = document.createElement('span');
    zoneHint.className = 'hotzone-hint';
    row.appendChild(zoneHint);
  }
  // 行内项目展开容器:默认隐藏,点击徽标/「+」时填充项目胶囊并显示
  const projectExpand = document.createElement('div');
  projectExpand.className = 'project-expand';
  row.appendChild(projectExpand);
  // 滚轮横向滚动(仅当内容溢出时拦截垂直滚动):增量累积到目标,平滑动画逼近
  projectExpand.addEventListener('wheel', (e) => {
    if (projectExpand.scrollWidth > projectExpand.clientWidth) {
      e.preventDefault();
      startExpandScroll(projectExpand, e.deltaY);
    }
  }, { passive: false });
  // 边缘渐隐:滚动位置变化时更新左右渐隐遮罩
  projectExpand.addEventListener('scroll', () => updateExpandMask(projectExpand));

  let clickTimer = null;
  row.addEventListener('click', (e) => {
    if (expandingRow === row) return; // 项目展开态不进入双击编辑
    if (hoverBar && (e.target === hoverBar.children[0] || e.target === hoverBar.children[1])) return;
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
      enterEditMode(row, +row.dataset.idx);
    } else {
      clickTimer = setTimeout(() => { clickTimer = null; }, 400);
    }
  });

  return row;
}

// ========== 任务操作 ==========
function sortTasks() {
  const undone = state.tasks.filter(t => !t.completed);
  const done = state.tasks.filter(t => t.completed);
  undone.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  // 最近勾选完成的任务排在最末尾，视觉上会从原位置滑到整个列表底部。
  done.sort((a, b) => new Date(a.completedAt || 0).getTime() - new Date(b.completedAt || 0).getTime());
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
    row, // 拖拽结束把行插回占位块位置,否则任务行从列表消失
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
  // 把任务行插回占位块位置;若拖拽期间列表被重建(placeholder 已不在 DOM),重建列表对齐
  if (dragState.placeholder.isConnected) {
    dragState.placeholder.replaceWith(dragState.row);
  } else {
    dragState.row.remove();
    renderTasks();
  }
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
  dragState = null;

  // 行索引与数组顺序对齐(不重建 DOM,避免列表刷新闪烁)
  [...taskItems.children].forEach((el, i) => {
    if (el.classList.contains('task-item')) el.dataset.idx = i;
  });
}

function toggleTask(idx) {
  const t = taskByIdx(idx);
  if (!t) return;
  t.completed = !t.completed;
  t.completedAt = t.completed ? new Date().toISOString() : null;
  sortTasks();
  // 今天任务:写今天文件并同步历史副本(带 updatedAt);历史任务:写回并同步
  persistTask(t).then(() => renderTasks(true));
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

// Esc 全局取消长按删除 + 关闭项目展开态;日历开着优先退出日历
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (state.calendarOpen) { closeCalendar(); return; }
    cancelDeleteHold(); closeProjectExpand();
  }
});

function deleteTask(idx) {
  const t = taskByIdx(idx);
  if (!t) return;
  removeTaskFromFile(t).then(() => renderTasks()); // 当天与历史文件中的同一任务一并删除
}

function enterEditMode(row, idx) {
  const t = taskByIdx(idx);
  if (!t) return;
  closeActivePicker(); // 编辑中操作栏隐藏,先收起可能展开的选择器
  row.classList.add('editing'); // 编辑中隐藏悬停操作栏(CSS 规则)
  const span = row.querySelector('.task-text');
  const oldText = t.task;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'task-edit-input';
  input.value = oldText;
  span.replaceWith(input);
  input.focus();
  input.select();

  const finish = async () => {
    const newText = input.value.trim();
    if (newText && newText !== oldText) {
      const prevKey = t.task + '|' + (t.project || ''); // 修改前身份键,供跨文件副本匹配
      t.task = newText;
      await persistTask(t, prevKey);
    }
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
  if (activePicker) {
    const picker = activePicker;
    activePicker = null;
    if (typeof picker._cleanup === 'function') picker._cleanup();
    picker.remove();
  }
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
  const task = taskByIdx(taskIdx);
  if (!task) return;

  // 再点同一个时间入口时直接收起，与日期选择器行为一致。
  if (activePicker?.classList.contains('time-picker') && activePicker._anchorEl === anchorEl) {
    closeActivePicker();
    return;
  }

  closeActivePicker();
  activePickerRow = anchorEl.closest('.task-item');
  if (activePickerRow) {
    const bar = activePickerRow.querySelector('.hover-bar');
    if (bar) bar.classList.add('visible'); // 选择器展开即钉住操作栏
    activePickerRow.style.background = '#f3f3f8';
  }

  const current = task.alarmTime || '';
  const now = new Date();
  const localTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  // 未设置提醒时只把当前本地时间滚入视野，不显示紫色选中态；已有提醒仍显示已保存时间。
  let selectedTime = current || localTime;
  const displayH = selectedTime.slice(0, 2);
  const displayM = selectedTime.slice(3, 5);

  const scrim = document.createElement('div');
  scrim.className = 'time-picker-scrim';
  scrim.setAttribute('aria-hidden', 'true');
  const picker = document.createElement('div');
  picker.className = 'time-picker';
  picker.setAttribute('role', 'dialog');
  picker.setAttribute('aria-label', '设置提醒时间');
  picker._anchorEl = anchorEl;
  picker.innerHTML = `<div class="tp-cols"><div class="tp-col" id="tp-hour" aria-label="小时"></div><div class="tp-col" id="tp-min" aria-label="分钟"></div></div><div class="tp-actions"><button type="button" class="tp-clear"${current ? '' : ' disabled'}>清除</button><button type="button" class="tp-save">保存</button></div>`;
  app.appendChild(scrim);
  app.appendChild(picker);
  activePicker = picker;

  // 填充小时 00-23
  const colH = picker.querySelector('#tp-hour');
  const colM = picker.querySelector('#tp-min');
  const syncActiveOptions = () => {
    const selectedH = selectedTime.slice(0, 2);
    const selectedM = selectedTime.slice(3, 5);
    colH.querySelector('.tp-opt.active')?.classList.remove('active');
    colM.querySelector('.tp-opt.active')?.classList.remove('active');
    [...colH.children].find(el => el.textContent === selectedH)?.classList.add('active');
    [...colM.children].find(el => el.textContent === selectedM)?.classList.add('active');
  };
  for (let h = 0; h < 24; h++) {
    const opt = document.createElement('div');
    opt.className = 'tp-opt' + (current && String(h).padStart(2,'0') === displayH ? ' active' : '');
    opt.textContent = String(h).padStart(2, '0');
    opt.addEventListener('click', () => {
      const m = selectedTime ? selectedTime.slice(3, 5) : '00';
      selectedTime = `${opt.textContent}:${m}`;
      syncActiveOptions();
    });
    colH.appendChild(opt);
  }

  // 填充分钟 00-59
  for (let m = 0; m < 60; m++) {
    const opt = document.createElement('div');
    opt.className = 'tp-opt' + (current && String(m).padStart(2,'0') === displayM ? ' active' : '');
    opt.textContent = String(m).padStart(2, '0');
    opt.addEventListener('click', () => {
      const h = selectedTime ? selectedTime.slice(0, 2) : '00';
      selectedTime = `${h}:${opt.textContent}`;
      syncActiveOptions();
    });
    colM.appendChild(opt);
  }

  // 保存按钮
  picker.querySelector('.tp-save').addEventListener('click', async () => {
    task.alarmTime = selectedTime || null;
    await persistTask(task);
    closeActivePicker();
    renderTasks();
  });

  // 清除按钮
  picker.querySelector('.tp-clear').addEventListener('click', async () => {
    if (!current) return;
    task.alarmTime = null;
    await persistTask(task);
    closeActivePicker();
    renderTasks();
  });

  // 无论是否已有提醒，都把应显示的时间滚到可视区域中央；未保存时间不添加 active。
  [...colH.children].find(el => el.textContent === displayH)?.scrollIntoView({ block: 'center' });
  [...colM.children].find(el => el.textContent === displayM)?.scrollIntoView({ block: 'center' });

  // 定位规则与日期选择器一致：默认下方，下方不足时翻到上方，并钳制在应用边界内。
  function positionPicker() {
    if (!picker.isConnected) return;
    const appRect = app.getBoundingClientRect();
    const anchorRect = anchorEl.getBoundingClientRect();
    const pickerWidth = picker.offsetWidth;
    const pickerHeight = picker.offsetHeight;
    const edge = 8;
    const gap = 7;

    let left = anchorRect.right - appRect.left - pickerWidth;
    left = Math.max(edge, Math.min(appRect.width - pickerWidth - edge, left));

    const above = anchorRect.top - appRect.top - pickerHeight - gap;
    const below = anchorRect.bottom - appRect.top + gap;
    const fitsAbove = above >= edge;
    const fitsBelow = below + pickerHeight <= appRect.height - edge;
    const spaceAbove = anchorRect.top - appRect.top - edge;
    const spaceBelow = appRect.bottom - anchorRect.bottom - edge;
    const placeBelow = fitsBelow || (!fitsAbove && spaceBelow >= spaceAbove);
    let top = placeBelow ? below : above;
    top = Math.max(edge, Math.min(appRect.height - pickerHeight - edge, top));

    picker.style.left = `${left}px`;
    picker.style.top = `${top}px`;
    picker.style.setProperty('--tp-anchor-x', `${Math.max(18, Math.min(pickerWidth - 18, anchorRect.left + anchorRect.width / 2 - appRect.left - left))}px`);
    picker.classList.toggle('tp-place-below', placeBelow);
  }

  positionPicker();

  // 点击外部或按 Esc 关闭（不保存）。
  const closeTp = (e) => {
    const isEsc = e.key === 'Escape';
    if (isEsc || (!picker.contains(e.target) && e.target !== anchorEl)) {
      if (activePicker === picker) closeActivePicker();
    }
  };
  const outsideTimer = setTimeout(() => {
    document.addEventListener('keydown', closeTp, true);
    app.addEventListener('click', closeTp, true);
  }, 0);
  picker._cleanup = () => {
    clearTimeout(outsideTimer);
    document.removeEventListener('keydown', closeTp, true);
    app.removeEventListener('click', closeTp, true);
    scrim.remove();
  };
}

// ========== 日视图修改日期：任务行离场 + 下方任务 FLIP 补位 ==========
let activeDayDateExit = null;
let dayDateChangeSeq = 0;
let pendingDayEmptyFadeDate = null;

function cleanupDayDateExitVisual() {
  const active = activeDayDateExit;
  if (!active) return;
  active.animations.forEach(anim => anim.cancel());
  active.clone.remove();
  activeDayDateExit = null;
}

function cancelDayDateExit() {
  dayDateChangeSeq++;
  cleanupDayDateExitVisual();
  pendingDayEmptyFadeDate = null;
}

// -1=向左(更早)，0=原地淡出(清除日期)，1=向右(更晚)，null=仍属当前日期
function getDayDateExitDirection(newDate, dayDate) {
  if (newDate === null) return 0;
  if (newDate < dayDate) return -1;
  if (newDate > dayDate) return 1;
  return null;
}

async function animateDayDateExit(row, direction) {
  if (!row?.isConnected) return;

  const list = row.parentElement;
  const rows = [...list.children].filter(el => el.classList.contains('task-item'));
  const survivingRows = rows.filter(el => el !== row);
  const oldTops = new Map(survivingRows.map(el => [el, el.getBoundingClientRect().top]));

  // 尊重系统减少动态效果设置：数据与布局仍立即更新，不播放位移动画。
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    row.remove();
    return;
  }

  const rowRect = row.getBoundingClientRect();
  const appRect = app.getBoundingClientRect();
  const clone = row.cloneNode(true);
  clone.classList.add('day-date-exit-clone');
  clone.querySelector('.hover-bar')?.classList.remove('visible');
  Object.assign(clone.style, {
    left: `${rowRect.left - appRect.left}px`,
    top: `${rowRect.top - appRect.top}px`,
    width: `${rowRect.width}px`,
    height: `${rowRect.height}px`,
  });
  app.appendChild(clone);

  // 原行退出布局后，下方任务先用反向位移保持原位，再延迟 130ms 向上补位。
  row.remove();
  const animations = survivingRows.flatMap(el => {
    const oldTop = oldTops.get(el);
    const newTop = el.getBoundingClientRect().top;
    const delta = oldTop - newTop;
    if (Math.abs(delta) < 1) return [];
    return [el.animate([
      { transform: `translateY(${delta}px)` },
      { transform: 'translateY(0)' }
    ], {
      duration: 200,
      delay: 130,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      fill: 'both'
    })];
  });

  let exitFrames;
  let exitDuration;
  if (direction === 0) {
    exitDuration = 130;
    exitFrames = [
      { opacity: 1, transform: 'scale(1)' },
      { opacity: 0, transform: 'scale(0.97)' }
    ];
  } else {
    exitDuration = 200;
    const distance = direction < 0
      ? -(rowRect.right - appRect.left + 20)
      : (appRect.right - rowRect.left + 20);
    exitFrames = [
      { opacity: 1, transform: 'translateX(0)', offset: 0 },
      { opacity: 1, transform: `translateX(${distance * 0.62}px)`, offset: 0.62 },
      { opacity: 0, transform: `translateX(${distance}px)`, offset: 1 }
    ];
  }

  const exitAnimation = clone.animate(exitFrames, {
    duration: exitDuration,
    easing: direction === 0 ? 'ease-out' : 'cubic-bezier(0.4, 0, 1, 1)',
    fill: 'forwards'
  });
  animations.push(exitAnimation);

  const active = { clone, animations };
  activeDayDateExit = active;
  await Promise.all(animations.map(anim => anim.finished.catch(() => null)));
  if (activeDayDateExit === active) {
    clone.remove();
    activeDayDateExit = null;
  }
}

async function commitTaskDueDate(task, anchorEl, newDate) {
  const row = anchorEl.closest('#cal-day-list .cal-day-task-item');
  const dayDate = state.calendarDayDate;
  const direction = row && dayDate ? getDayDateExitDirection(newDate, dayDate) : null;
  const shouldExitDay = !!row && direction !== null;
  const wasLastDayTask = shouldExitDay
    && row.parentElement.querySelectorAll('.task-item').length === 1;

  const seq = ++dayDateChangeSeq;
  cleanupDayDateExitVisual();
  task.dueDate = newDate;
  closeActivePicker();

  const persistPromise = persistTask(task);
  if (shouldExitDay) {
    await Promise.all([persistPromise, animateDayDateExit(row, direction)]);
  } else {
    await persistPromise;
  }

  // 期间若已关闭日历、切换日期或开始另一项修改，由最新视图接管刷新。
  if (seq !== dayDateChangeSeq) return;
  if (wasLastDayTask && state.calendarDayDate === dayDate) {
    pendingDayEmptyFadeDate = dayDate;
  }
  renderTasks();
}

// ========== 到期日选择器 ==========
// 日期选择器以周日为一周起点；远期周标签使用紧凑的 MMDD-MMDD 格式。
function shiftPickerDate(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const shifted = new Date(y, m - 1, d + deltaDays);
  return formatDateStr(shifted.getFullYear(), shifted.getMonth() + 1, shifted.getDate());
}

function getPickerWeekStart(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() - date.getDay());
  return formatDateStr(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function getPickerWeekDistance(weekStart, todayStr) {
  const toUtcDay = (dateStr) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const currentStart = getPickerWeekStart(todayStr);
  return Math.round((toUtcDay(weekStart) - toUtcDay(currentStart)) / (7 * 86400000));
}

function formatPickerWeekRange(weekStart) {
  const weekEnd = shiftPickerDate(weekStart, 6);
  return `${weekStart.slice(5, 7)}${weekStart.slice(8, 10)}-${weekEnd.slice(5, 7)}${weekEnd.slice(8, 10)}`;
}

function formatPickerWeekLabel(weekStart, todayStr) {
  const distance = getPickerWeekDistance(weekStart, todayStr);
  if (distance === -2) return '上上周';
  if (distance === -1) return '上周';
  if (distance === 0) return '本周';
  if (distance === 1) return '下周';
  if (distance === 2) return '下下周';
  return formatPickerWeekRange(weekStart);
}

function buildDatePickerWeekState(viewWeekStart, todayStr) {
  const weekStarts = [-7, 0, 7].map(delta => shiftPickerDate(viewWeekStart, delta));
  return {
    weekStarts,
    labels: weekStarts.map(start => formatPickerWeekLabel(start, todayStr)),
    days: buildWeekDays(viewWeekStart),
  };
}

function openDatePicker(anchorEl, taskIdx) {
  const task = taskByIdx(taskIdx);
  if (!task) return;

  // 再点同一个日期入口时直接收起，不重新创建选择器。
  if (activePicker?.classList.contains('date-picker') && activePicker._anchorEl === anchorEl) {
    closeActivePicker();
    return;
  }

  closeActivePicker();
  activePickerRow = anchorEl.closest('.task-item');
  if (activePickerRow) {
    const bar = activePickerRow.querySelector('.hover-bar');
    if (bar) bar.classList.add('visible');
    activePickerRow.style.background = '#f3f3f8';
  }

  const today = getToday();
  const current = task.dueDate || '';
  let viewWeekStart = getPickerWeekStart(current || today);

  const scrim = document.createElement('div');
  scrim.className = 'date-picker-scrim';
  scrim.setAttribute('aria-hidden', 'true');
  const picker = document.createElement('div');
  picker.className = 'date-picker';
  picker.setAttribute('role', 'dialog');
  picker.setAttribute('aria-label', '设置任务日期');
  picker._anchorEl = anchorEl;
  app.appendChild(scrim);
  app.appendChild(picker);
  activePicker = picker;

  function positionPicker() {
    if (!picker.isConnected) return;
    const appRect = app.getBoundingClientRect();
    const anchorRect = anchorEl.getBoundingClientRect();
    const pickerWidth = picker.offsetWidth;
    const pickerHeight = picker.offsetHeight;
    const edge = 8;
    const gap = 7;

    let left = anchorRect.right - appRect.left - pickerWidth;
    left = Math.max(edge, Math.min(appRect.width - pickerWidth - edge, left));

    const above = anchorRect.top - appRect.top - pickerHeight - gap;
    const below = anchorRect.bottom - appRect.top + gap;
    const fitsAbove = above >= edge;
    const fitsBelow = below + pickerHeight <= appRect.height - edge;
    // 默认从任务行下方展开；仅当下方放不下而上方可用时翻转到上方。
    // 两侧都不足的极端情况下，选择可用空间更多的一侧，再由边界钳制保证完整显示。
    const spaceAbove = anchorRect.top - appRect.top - edge;
    const spaceBelow = appRect.bottom - anchorRect.bottom - edge;
    const placeBelow = fitsBelow || (!fitsAbove && spaceBelow >= spaceAbove);
    let top = placeBelow ? below : above;
    top = Math.max(edge, Math.min(appRect.height - pickerHeight - edge, top));

    picker.style.left = `${left}px`;
    picker.style.top = `${top}px`;
    picker.style.setProperty('--dp-anchor-x', `${Math.max(18, Math.min(pickerWidth - 18, anchorRect.left + anchorRect.width / 2 - appRect.left - left))}px`);
    picker.classList.toggle('dp-place-below', placeBelow);
  }

  function renderWeek(direction = 0, focusMiddle = false) {
    const stateForWeek = buildDatePickerWeekState(viewWeekStart, today);
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const dayButtons = stateForWeek.days.map((dateStr, i) => {
      const dayNumber = Number(dateStr.slice(8, 10));
      const monthNumber = Number(dateStr.slice(5, 7));
      const crossesMonth = dayNumber === 1 || (i > 0 && dateStr.slice(5, 7) !== stateForWeek.days[i - 1].slice(5, 7));
      const displayNumber = crossesMonth ? `${monthNumber}/${dayNumber}` : String(dayNumber);
      let cls = 'dp-date-option';
      if (dateStr < today) cls += ' is-past';
      if (dateStr === today) cls += ' is-today';
      if (dateStr === current) cls += ' is-selected';
      return `<button type="button" class="${cls}" data-date="${dateStr}" aria-label="${dateStr}">
        <span class="dp-weekday">${weekdays[i]}</span>
        <span class="dp-day-number">${displayNumber}</span>
      </button>`;
    }).join('');

    const directionClass = direction > 0 ? ' dp-slide-next' : direction < 0 ? ' dp-slide-prev' : '';
    const railDirectionClass = direction > 0 ? ' dp-scroll-next' : direction < 0 ? ' dp-scroll-prev' : '';
    picker.innerHTML = `<div class="dp-week-rail${railDirectionClass}" role="group" aria-label="选择周">
      <button type="button" class="dp-week-option" data-week-start="${stateForWeek.weekStarts[0]}">${stateForWeek.labels[0]}</button>
      <button type="button" class="dp-week-option is-active" data-week-start="${stateForWeek.weekStarts[1]}" aria-current="date">${stateForWeek.labels[1]}</button>
      <button type="button" class="dp-week-option" data-week-start="${stateForWeek.weekStarts[2]}">${stateForWeek.labels[2]}</button>
    </div>
    <div class="dp-week-content${directionClass}">
      <div class="dp-date-grid">${dayButtons}</div>
      <button type="button" class="dp-clear-btn"${current ? '' : ' disabled'}>清除</button>
    </div>`;

    const weekOptions = picker.querySelectorAll('.dp-week-option');
    weekOptions[0].addEventListener('click', () => {
      viewWeekStart = stateForWeek.weekStarts[0];
      renderWeek(-1, true);
    });
    weekOptions[2].addEventListener('click', () => {
      viewWeekStart = stateForWeek.weekStarts[2];
      renderWeek(1, true);
    });

    const dateOptions = [...picker.querySelectorAll('.dp-date-option')];
    dateOptions.forEach((dateEl, index) => {
      dateEl.addEventListener('click', async () => {
        await commitTaskDueDate(task, anchorEl, dateEl.dataset.date);
      });
      dateEl.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const nextIndex = Math.max(0, Math.min(dateOptions.length - 1, index + (e.key === 'ArrowRight' ? 1 : -1)));
        dateOptions[nextIndex].focus();
      });
    });

    picker.querySelector('.dp-clear-btn').addEventListener('click', async () => {
      if (!current) return;
      await commitTaskDueDate(task, anchorEl, null);
    });

    requestAnimationFrame(() => {
      positionPicker();
      if (focusMiddle) picker.querySelector('.dp-week-option.is-active')?.focus({ preventScroll: true });
    });
  }

  renderWeek();
  positionPicker();

  const closeDp = (e) => {
    const isEsc = e.key === 'Escape';
    if (isEsc || (!picker.contains(e.target) && e.target !== anchorEl)) {
      if (activePicker === picker) closeActivePicker();
    }
  };
  const outsideTimer = setTimeout(() => {
    document.addEventListener('keydown', closeDp, true);
    app.addEventListener('click', closeDp, true);
  }, 0);
  picker._cleanup = () => {
    clearTimeout(outsideTimer);
    document.removeEventListener('keydown', closeDp, true);
    app.removeEventListener('click', closeDp, true);
    scrim.remove();
  };
}

// ========== 项目行内展开 ==========
let expandingRow = null; // 当前处于项目展开态的任务行
let expandCloseTimer = null; // 回收动画结束后移除行类的计时器

function closeProjectExpand() {
  if (!expandingRow) return;
  const row = expandingRow;
  expandingRow = null;
  clearTimeout(expandCloseTimer);

  const opts = [...row.querySelectorAll('.pe-opt')];
  // 反向逐个回收:从右到左依次消失(与出现动画相反)
  opts.forEach((el, i) => {
    el.classList.add('pe-out');
    el.style.setProperty('--i', opts.length - 1 - i);
  });
  // 等最长的回收动画结束后移除行类(行还在则正常收起;行已重建则直接清类)
  const maxDelay = opts.length * 20 + 100;
  expandCloseTimer = setTimeout(() => {
    if (row.isConnected) {
      row.classList.remove('project-expanding');
      row.style.minHeight = ''; // 与行类同步释放:文字已恢复,行高自然回到原值
    }
  }, maxDelay);
}

// 边缘渐隐:内容滚出可视区的那一侧加 12px 渐变遮罩,到头的方向不遮
function updateExpandMask(container) {
  const atStart = container.scrollLeft <= 0;
  const atEnd = container.scrollLeft + container.clientWidth >= container.scrollWidth - 1;
  const fades = [];
  if (!atStart) fades.push('transparent 0, #000 12px');
  if (!atEnd) fades.push('#000 calc(100% - 12px), transparent 100%');
  container.style.maskImage = fades.length
    ? `linear-gradient(to right, ${fades.join(', ')})`
    : 'none';
}

// 展开胶囊平滑滚动:滚轮增量累积到目标值,rAF 指数缓动逼近,滚轮停止后惯性滑行到目标
const expandScrollState = new WeakMap(); // container -> { target, raf }
function startExpandScroll(container, delta) {
  let st = expandScrollState.get(container);
  if (!st) {
    st = { target: container.scrollLeft, raf: null };
    expandScrollState.set(container, st);
  }
  st.target += delta;
  const max = container.scrollWidth - container.clientWidth;
  if (st.target < 0) st.target = 0;
  else if (st.target > max) st.target = max;
  if (st.raf) return; // 动画已在跑,只更新目标
  const step = () => {
    if (expandScrollState.get(container) !== st) { st.raf = null; return; } // 已重置(重开),停止旧动画
    const stepPx = (st.target - container.scrollLeft) * 0.2;
    if (Math.abs(stepPx) < 1) {
      // scrollLeft 是整数属性,步长不足 1px 会被取整吞掉导致永远差几像素,直接置位
      container.scrollLeft = st.target;
      st.raf = null;
      return;
    }
    container.scrollLeft += stepPx;
    st.raf = requestAnimationFrame(step);
  };
  st.raf = requestAnimationFrame(step);
}

function openProjectExpand(rowEl, taskIdx) {
  if (expandingRow === rowEl) { closeProjectExpand(); return; } // 再点当前展开行 = 关闭
  closeProjectExpand();
  closeActivePicker(); // 展开态操作栏隐藏,先收起可能展开的时间/日期选择器

  // 展开态隐藏任务文字后行高会塌缩到徽标高度:先锁定当前行高,收起时同步释放
  const keepHeight = rowEl.offsetHeight;
  expandingRow = rowEl;
  rowEl.classList.add('project-expanding');
  if (keepHeight > 0) rowEl.style.minHeight = keepHeight + 'px';

  // 填充项目胶囊列表(白名单 ∪ 历史任务项目,去重,按出现顺序)
  const container = rowEl.querySelector('.project-expand');
  container.innerHTML = '';
  container.scrollLeft = 0;
  expandScrollState.delete(container); // 重置滚动动画目标,避免旧目标残留
  const current = taskByIdx(taskIdx).project || null;

  const seen = new Set();
  const options = [];
  for (const name of state.projectNames) {
    if (name && !seen.has(name)) { seen.add(name); options.push(name); }
  }
  for (const t of state.tasks) {
    if (t.project && !seen.has(t.project)) { seen.add(t.project); options.push(t.project); }
  }

  const appendOpt = (name, cls, label) => {
    const opt = document.createElement('span');
    opt.className = 'pe-opt' + (cls ? ' ' + cls : '');
    opt.textContent = label;
    opt.style.setProperty('--i', container.children.length); // 逐个弹出延迟
    opt.addEventListener('click', async () => {
      const t = taskByIdx(taskIdx);
      if (!t) return;
      const prevKey = t.task + '|' + (t.project || ''); // 修改前身份键
      t.project = name;
      await persistTask(t, prevKey);
      closeProjectExpand();
      renderTasks();
    });
    container.appendChild(opt);
  };

  options.forEach(name => {
    if (name === current) return; // 已选项目从待选列表移除(当前归属由行内徽标展示)
    appendOpt(name, '', name);
  });

  // 「无项目」清除归属:末尾,✕ 显示
  const none = document.createElement('span');
  none.className = 'pe-opt none' + (current === null ? ' active' : '');
  none.textContent = '✕';
  none.title = '清除项目归属';
  none.style.setProperty('--i', container.children.length);
  none.addEventListener('click', async () => {
    const t = taskByIdx(taskIdx);
    if (!t) return;
    if (current !== null) {
      const prevKey = t.task + '|' + (t.project || ''); // 修改前身份键
      t.project = null;
      await persistTask(t, prevKey);
    }
    closeProjectExpand();
    renderTasks();
  });
  container.appendChild(none);

  // 滚轮横向滚动已在容器构造时绑定;填充完成后更新边缘渐隐
  updateExpandMask(container);

  // 点击行外或行内非胶囊区域关闭(徽标/「+」除外,它们有自己的 toggle 逻辑)
  setTimeout(() => {
    const closeX = (e) => {
      if (!e.target.closest('.pe-opt, .project-badge, .project-placeholder')) {
        if (expandingRow === rowEl) closeProjectExpand();
        document.removeEventListener('click', closeX, true);
      }
    };
    document.addEventListener('click', closeX, true);
  }, 0);
}

function hasContent() {
  return textInput.value.trim().length > 0 || state.images.length > 0;
}

function updateOrganizeButton() {
  // 重排仅对任务汇总页生效：汇总页且有未完成任务时可点击
  const hasPending = state.tasks.some(t => !t.completed);
  btnOrganize.disabled = state.calendarOpen || state.activeSheet !== 'all' || !hasPending || state.organizing;
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
  if (state.calendarOpen || state.activeSheet !== 'all' || state.organizing) return;
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
        applyCalendarDate(result.tasks);
        addTasks(result.tasks);
      } else {
        // IPC 失败或无结果时 fallback，不丢失用户任务
        if (!result.success) console.warn(result.error);
        const tasks = fallbackOrganize(text, imgs, projectNames, project);
        applyCalendarDate(tasks);
        if (tasks.length > 0) addTasks(tasks);
      }
    } else {
      // 浏览器调试模式：fallback 简单拆分
      await sleep(500);
      const tasks = fallbackOrganize(text, imgs, projectNames, project);
      applyCalendarDate(tasks);
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
      persistProjectNames();
    });
    list.appendChild(tag);
  });
}

// 项目白名单变更即持久化:录入后不点「保存设置」也生效,重启不丢
async function persistProjectNames() {
  if (window.electronAPI) {
    const cfg = await window.electronAPI.getConfig();
    cfg.projectNames = [...state.projectNames];
    await window.electronAPI.saveConfig(cfg);
  } else {
    const cfg = JSON.parse(localStorage.getItem('sticky_config') || '{}');
    cfg.projectNames = [...state.projectNames];
    localStorage.setItem('sticky_config', JSON.stringify(cfg));
  }
}

function addProjectTag(name) {
  const trimmed = name.trim();
  if (!trimmed || state.projectNames.includes(trimmed)) return;
  state.projectNames.push(trimmed);
  renderProjectTags();
  $('#project-tags-text').value = '';
  persistProjectNames();
}

function escapeHtml(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, c => map[c]);
}

// ========== Markdown ↔ HTML 转换 ==========
  // 图片数据缓存（用于复制到外部应用时替换 note-image:// 为 base64）
const imageDataCache = new Map(); // relativePath → base64 data URL
const MAX_IMAGE_CACHE_BYTES = 40 * 1024 * 1024; // 总字节上限 ~40MB(防 30 条 × 10MB 突破 V8 128MB 堆)

function cacheImageData(relativePath, dataUrl) {
  if (imageDataCache.has(relativePath)) imageDataCache.delete(relativePath); // 刷新访问时间(移到末尾,真 LRU)
  imageDataCache.set(relativePath, dataUrl);
  let total = 0;
  for (const v of imageDataCache.values()) total += v.length;
  while (total > MAX_IMAGE_CACHE_BYTES && imageDataCache.size > 1) {
    const oldest = imageDataCache.keys().next().value;
    total -= imageDataCache.get(oldest).length;
    imageDataCache.delete(oldest);
  }
}

function loadMarkdown(md) {
  if (!md) return '';
  const html = renderMarkdown(md);
  // 把相对路径的 markdown 图片统一挂到便利贴的 note-image:// 协议下（网络/已有协议图片保持原样）
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src') || '';
    if (src && !/^(https?:|data:|note-image:)/i.test(src)) {
      img.setAttribute('src', `note-image://${src}`);
    }
  });
  return div.innerHTML;
}

function htmlToMarkdown(html) {
  if (!html) return '';
  const root = document.createElement('div');
  root.innerHTML = html;

  // 行内节点序列化为 markdown（块级结构在下方 collect 处理）
  function childrenInline(node) {
    let s = '';
    for (const c of node.childNodes) s += inline(c);
    return s;
  }
  function inline(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    switch (node.tagName) {
      case 'BR': return '\n';
      case 'STRONG': case 'B': return `**${childrenInline(node)}**`;
      case 'EM': case 'I': return `*${childrenInline(node)}*`;
      case 'DEL': case 'S': case 'STRIKE': return `~~${childrenInline(node)}~~`;
      case 'CODE': return `\`${node.textContent}\``;
      case 'A': {
        const href = node.getAttribute('href') || '';
        return `[${childrenInline(node)}](${href})`;
      }
      case 'IMG': {
        const src = node.getAttribute('src') || '';
        if (src.startsWith('note-image://')) return `![](${src.slice('note-image://'.length)})`;
        if (src) return `![](${src})`;
        return '';
      }
      case 'MARK': return node.textContent; // 搜索高亮标记还原为纯文本
      default: return childrenInline(node);
    }
  }

  const blocks = [];
  const BLOCK = new Set(['DIV', 'P', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'LI']);

  function collect(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child.textContent.trim();
        if (t) blocks.push([t]);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName;
      if (tag === 'PRE') {
        const code = child.querySelector('code');
        const lang = (code?.className || '').match(/language-([\w-]+)/)?.[1] || '';
        const text = (code?.textContent ?? child.textContent ?? '').replace(/\n+$/, '');
        blocks.push(['```' + lang, ...text.split('\n'), '```']);
      } else if (tag === 'UL' || tag === 'OL') {
        const ordered = tag === 'OL';
        const items = [];
        let n = 1;
        for (const li of child.children) {
          if (li.tagName !== 'LI') continue;
          items.push(ordered ? `${n++}. ${childrenInline(li).trim()}` : `- ${childrenInline(li).trim()}`);
        }
        if (items.length) blocks.push(items);
      } else if (tag === 'BLOCKQUOTE') {
        const text = childrenInline(child).trim();
        if (text) blocks.push(text.split('\n').map(l => `> ${l}`));
      } else if (tag === 'HR') {
        blocks.push(['---']);
      } else if (/^H[1-6]$/.test(tag)) {
        blocks.push(['#'.repeat(+tag[1]) + ' ' + childrenInline(child).trim()]);
      } else if (tag === 'LI') {
        blocks.push(['- ' + childrenInline(child).trim()]);
      } else {
        const hasBlockChild = Array.from(child.children).some(c => BLOCK.has(c.tagName));
        if (hasBlockChild) {
          collect(child);
        } else {
          const text = childrenInline(child).trim();
          if (text) blocks.push(text.split('\n'));
        }
      }
    }
  }

  collect(root);
  const cleaned = blocks.filter(b => b.length && b.some(l => l.trim() !== ''));
  return cleaned.map(b => b.join('\n')).join('\n\n');
}

function insertImageAtCursor(relativePath) {
  const img = document.createElement('img');
  img.src = `note-image://${relativePath}`;
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
        if (dataUrl) cacheImageData(relativePath, dataUrl);
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
    state.toolsEnabled = {
      translate: cfg.toolsEnabled?.translate !== false,
      harness: cfg.toolsEnabled?.harness ?? cfg.harness?.enabled ?? true,
    };
    // 项目白名单:启动即加载,弹出胶囊选项 = 白名单 ∪ 任务历史项目
    if (cfg.projectNames) {
      state.projectNames = [...cfg.projectNames];
    }
    // 页签栏显示开关(默认 true,旧配置无此字段视为显示)
    if (cfg.showSheetBar !== undefined) {
      state.showSheetBar = !!cfg.showSheetBar;
      applySheetBarVisibility();
    }
    // 任务行项目胶囊显示开关(默认 true,旧配置无此字段视为显示)
    if (cfg.showProjectBadge !== undefined) {
      state.showProjectBadge = !!cfg.showProjectBadge;
    }
    // 任务页日报按钮显示开关(默认 true,旧配置无此字段视为显示)
    if (cfg.showDailyReport !== undefined) {
      state.showDailyReport = !!cfg.showDailyReport;
      applyDailyReportVisibility();
    }
    // 任务页日历按钮显示开关(默认 true,旧配置无此字段视为显示)
    if (cfg.showCalendar !== undefined) {
      state.showCalendar = !!cfg.showCalendar;
      applyCalendarVisibility();
    }
    app.classList.toggle('win-fixed', cfg.winFixed !== false);
  }
}

async function openSettings() {
  if (window.electronAPI) {
    window.electronAPI.setSettingsOpen(true);
    const cfg = await window.electronAPI.getConfig();
    // API Key 不回填(主进程隔离):已配置时显示占位提示,留空提交则保持旧 Key
    const hasKey = await window.electronAPI.hasApiKey();
    $('#settings-apikey').value = hasKey ? '************************' : '';
    $('#settings-apikey').placeholder = hasKey ? '已配置，留空保持不变' : 'sk-xxxxxxxxxxxxxxxxxxxx';
    $('#settings-baseurl').value = cfg.baseUrl || 'https://api.deepseek.com';
    $('#settings-reportname').value = cfg.reportName || '';
    const harness = cfg.harness || {};
    $('#settings-translate-enabled').checked = cfg.toolsEnabled?.translate !== false;
    $('#settings-harness-enabled').checked = cfg.toolsEnabled?.harness ?? harness.enabled ?? true;
    $('#settings-harness-dir').value = harness.installDir || 'F:\\Tools\\deepseek-harness';
    $('#settings-harness-node').value = harness.nodePath || 'C:\\Program Files\\nodejs\\node.exe';
    $('#settings-harness-mode').value = harness.mode === 'minimal' ? 'minimal' : 'standard';
    $('#settings-harness-permission').value = harness.permission === 'read-only' ? 'read-only' : 'workspace-write';

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
    $('#settings-sheetbar').checked = cfg.showSheetBar !== false;
    $('#settings-projectcapsule').checked = cfg.showProjectBadge !== false;
    $('#settings-dailyreport').checked = cfg.showDailyReport !== false;
    $('#settings-calendar').checked = cfg.showCalendar !== false;
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
  syncSettingsSelects();
  renderShortcutInputs();
  settingsOverlay.classList.remove('hidden');
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

  // 检测文件位置是否变更，并保留卡片中选择的 Harness 工作目录
  const oldCfg = window.electronAPI ? await window.electronAPI.getConfig() : {};
  const harness = {
    enabled: $('#settings-harness-enabled').checked,
    installDir: $('#settings-harness-dir').value.trim(),
    nodePath: $('#settings-harness-node').value.trim(),
    workspace: oldCfg?.harness?.workspace || '',
    mode: $('#settings-harness-mode').value === 'minimal' ? 'minimal' : 'standard',
    model: oldCfg?.harness?.model || 'deepseek-v4-flash',
    permission: $('#settings-harness-permission').value === 'read-only' ? 'read-only' : 'workspace-write',
  };
  const dirChanged = notesDir !== (oldCfg.notesDir || '');

  collectShortcutsFromInputs();
  const winFixed = $('#settings-winfixed').checked;
  const showSheetBar = $('#settings-sheetbar').checked;
  const showProjectBadge = $('#settings-projectcapsule').checked;
  const showDailyReport = $('#settings-dailyreport').checked;
  const showCalendar = $('#settings-calendar').checked;
  const tasksEnabled = $('#settings-tasks-page').checked;
  const toolsEnabled = $('#settings-tools-page').checked;
  const toolFeatures = {
    translate: $('#settings-translate-enabled').checked,
    harness: $('#settings-harness-enabled').checked,
  };
  const pagesEnabled = { tasks: tasksEnabled, tools: toolsEnabled };
  const blurHide = {
    tasks: $('#settings-blurhide-tasks').checked,
    notepad: $('#settings-blurhide-notepad').checked,
    tools: $('#settings-blurhide-tools').checked,
  };
  harness.workspace = oldCfg?.harness?.workspace || '';
  const cfg = { apiKey, baseUrl, reportName, notesDir, notesDirHistory: oldCfg.notesDirHistory || [], projectNames: [...state.projectNames], shortcuts: { ...state.shortcuts }, winFixed, showSheetBar, showProjectBadge, showDailyReport, showCalendar, pagesEnabled, toolsEnabled: toolFeatures, blurHide, harness };

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
  // 页签栏显示开关:整行隐藏;关闭时若停在项目页签,强制回任务汇总(否则无入口切回)
  state.showSheetBar = showSheetBar;
  applySheetBarVisibility();
  // 任务行项目胶囊开关:关闭时徽标/「+」占位不渲染(改归属需重新打开开关)
  state.showProjectBadge = showProjectBadge;
  // 任务页日报按钮显示开关
  state.showDailyReport = showDailyReport;
  applyDailyReportVisibility();
  // 任务页日历按钮显示开关
  state.showCalendar = showCalendar;
  applyCalendarVisibility();
  renderTasks();
  if (!tasksEnabled && tasksWasEnabled && state.currentPage === 'main') {
    switchToNotepad();
  }
  if (!toolsEnabled && state.currentPage === 'tools') {
    switchToMain();
  }
  state.toolsEnabled = toolFeatures;
  await refreshHarnessSnapshot();
  if (state.currentPage === 'tools') renderToolsPage();

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

// 日历选中日期:organize 生成的任务统一带该日期;提示使命完成恢复默认占位符
function applyCalendarDate(tasks) {
  if (!state.calendarSelected) return;
  tasks.forEach(t => { t.dueDate = state.calendarSelected; });
  textInput.placeholder = '记录想做的事...';
}

// ========== 日历 ==========
// 纯函数:dateStr(YYYY-MM-DD) → 所在周 7 天(周日开头,与 openDatePicker 一致)
function buildWeekDays(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = new Date(y, m - 1, d - new Date(y, m - 1, d).getDay());
  const days = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    days.push(formatDateStr(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()));
  }
  return days;
}

// 纯函数:月历网格(周日开头,前后补齐上月/下月格)
function buildMonthGrid(y, m) {
  const firstDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const daysInPrev = new Date(y, m, 0).getDate();
  const cells = [];
  for (let i = firstDow - 1; i >= 0; i--) {
    const d = daysInPrev - i;
    const dt = new Date(y, m - 1, d);
    cells.push({ date: formatDateStr(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()), inMonth: false, day: d });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: formatDateStr(y, m + 1, d), inMonth: true, day: d });
  }
  const remainder = cells.length % 7 === 0 ? 0 : 7 - (cells.length % 7);
  for (let d = 1; d <= remainder; d++) {
    const dt = new Date(y, m + 1, d);
    cells.push({ date: formatDateStr(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()), inMonth: false, day: d });
  }
  return cells;
}

// 纯函数:统计某日期任务数组(未完成/总数)与去重项目数(未完成/已完成,无项目任务计 1 类)
// 数组已按日期归属(今天=dueDate 匹配;历史=文件日期),不再按 dueDate 过滤
function countDayTasks(dayTasks) {
  let undone = 0, total = 0;
  const undoneProjects = new Set();
  const doneProjects = new Set();
  for (const t of dayTasks) {
    total++;
    if (!t.completed) {
      undone++;
      undoneProjects.add(t.project || '(无项目)');
    } else {
      doneProjects.add(t.project || '(无项目)');
    }
  }
  return { undone, total, projectCount: undoneProjects.size, doneProjectCount: doneProjects.size };
}

// 纯函数:合并某日期任务(按 任务+项目 去重;保留 updatedAt 最新版本,同时间戳时 done=true 优先)
function mergeDayTasks(todayOnes, historic) {
  const seen = new Map(); // key → task(保留最新)
  const order = [];
  const add = (t) => {
    const key = t.task + '|' + (t.project || '');
    if (seen.has(key)) {
      const cur = seen.get(key);
      const tNew = (t.updatedAt || t.createdAt || '');
      const curNew = (cur.updatedAt || cur.createdAt || '');
      if (tNew > curNew) {
        const i = order.indexOf(key);
        order[i] = key;
        seen.set(key, t);
      } else if (tNew === curNew && t.completed && !cur.completed) {
        // 同时间戳:勾选状态优先(旧的持久化任务无 updatedAt,createdAt 相同,勾选副本视为最新)
        const i = order.indexOf(key);
        order[i] = key;
        seen.set(key, t);
      }
      return;
    }
    seen.set(key, t);
    order.push(key);
  };
  for (const t of todayOnes) add(t);
  for (const t of (historic || [])) add(t);
  return order.map(k => seen.get(k));
}

// 纯函数:按日期类型生成圆点颜色序列(最多 3 点)
// 历史日期:每个未完成项目对应 1 个红点(#fe231b),剩余名额用完成绿点(#4caf50)填充
// 当天/未来:沿用绿黄橙的未完成项目圆点,不显示完成绿点
function dotSequenceForDate(dayTasks, dateStr, todayStr) {
  const { projectCount, doneProjectCount } = countDayTasks(dayTasks);
  if (dateStr < todayStr) {
    const n1 = Math.min(projectCount, 3);
    const colors = Array(n1).fill('cal-dot-overdue');
    const n2 = Math.min(doneProjectCount, 3 - n1);
    for (let i = 0; i < n2; i++) colors.push('cal-dot-done');
    return colors;
  }
  return ['cal-dot-green', 'cal-dot-yellow', 'cal-dot-red'].slice(0, Math.min(projectCount, 3));
}

// direction: 1=下月(网格从右滑入), -1=上月(从左滑入), 0=无动画(首次打开/返回月历)
// 任务归属:完全按日期胶囊(dueDate);无日期胶囊任务不显示;历史任务按 dueDate 跨文件收集
// 异步:首次需增量加载历史任务文件;序列号丢弃切月/关闭期间的过期渲染
let renderCalSeq = 0;
async function renderCalendar(direction = 0) {
  const seq = ++renderCalSeq;
  const { y, m } = state.calendarMonth;
  const today = getToday();
  calMonthlabel.textContent = `${y}/${m + 1}`;

  const cells = buildMonthGrid(y, m);
  await ensureTaskFilesLoaded(); // 增量加载全部历史任务文件(之后日历/日视图都按 dueDate 归属)
  if (seq !== renderCalSeq) return; // 期间切月/关闭,丢弃过期渲染
  const dueIndex = buildDueDateIndex(state.tasks, taskFileCache.values());

  const weekdays = document.createElement('div');
  weekdays.className = 'cal-weekdays';
  ['日', '一', '二', '三', '四', '五', '六'].forEach(w => {
    const el = document.createElement('div');
    el.className = 'cal-wd';
    el.textContent = w;
    weekdays.appendChild(el);
  });

  const grid = document.createElement('div');
  grid.className = 'cal-days';
  cells.forEach(cell => {
    const el = document.createElement('div');
    let cls = 'cal-day';
    if (!cell.inMonth) cls += ' other-month';
    if (cell.date === today) cls += ' today';
    if (cell.date === state.calendarSelected) cls += ' selected';
    el.className = cls;
    el.dataset.date = cell.date;
    const num = document.createElement('span');
    num.className = 'cal-day-num';
    num.textContent = cell.day;
    el.appendChild(num);
    // 底部圆点:该日期全部任务(完全按 dueDate 归属);历史未完成优先+完成补绿点,当天/未来仅未完成
    const dayTasks = dueIndex.get(cell.date) || [];
    const { undone, total } = countDayTasks(dayTasks);
    const dotColors = dotSequenceForDate(dayTasks, cell.date, today);
    if (dotColors.length > 0) {
      const dots = document.createElement('span');
      dots.className = 'cal-dots';
      for (let i = 0; i < dotColors.length; i++) {
        const dot = document.createElement('span');
        dot.className = 'cal-dot ' + dotColors[i];
        dots.appendChild(dot);
      }
      el.appendChild(dots);
      el.title = undone > 0 ? `未完成 ${undone} / 共 ${total}` : `已完成 ${total} / 共 ${total}`;
    }
    el.addEventListener('click', () => selectDate(cell.date));
    el.addEventListener('dblclick', () => enterDayMode(cell.date));
    grid.appendChild(el);
  });

  calGrid.innerHTML = '';
  calGrid.append(weekdays, grid);

  // 滑动换月:新网格从切月方向滑入(旧网格随 innerHTML 重建消失,由新网格滑入带来滚动感)
  if (direction !== 0) {
    grid.animate([
      { transform: `translateX(${direction * 36}px)`, opacity: 0 },
      { transform: 'translateX(0)', opacity: 1 }
    ], { duration: 220, easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)' });
  }
}

// direction: 1=下一周(整行从右滑入), -1=上一周(从左滑入), 0=无切周动画
function renderWeekbar(direction = 0) {
  // 周条显示的周:优先周基准(可被 ‹ › 独立切周),否则选中日期所在周
  const base = state.calendarWeek || state.calendarDayDate || state.calendarSelected || getToday();
  // 高亮:选中日期(day 模式=当日视图日期;切周后选中日不在显示周内则无高亮)
  const activeDate = state.calendarDayDate || state.calendarSelected;
  const today = getToday();
  // 记录旧 active 位置(切换日期时选中底色平滑滑动到新位置)
  const prevActive = calWeekDays.querySelector('.cal-week-day.active');
  const prevLeft = prevActive ? prevActive.getBoundingClientRect().left : null;
  calWeekDays.innerHTML = '';
  buildWeekDays(base).forEach(dateStr => {
    const el = document.createElement('span');
    let cls = 'cal-week-day';
    if (dateStr === today) cls += ' today';
    if (dateStr === activeDate) cls += ' active';
    el.className = cls;
    el.textContent = String(parseInt(dateStr.slice(8, 10), 10));
    el.title = dateStr;
    // day 模式:单击立即切换当天任务(点已选中日期不再重播任务渐现动画);全屏日历模式:选中日期
    el.addEventListener('click', () => {
      if (state.calendarDayDate) {
        if (dateStr === state.calendarDayDate) return; // 已选中,无变化
        enterDayMode(dateStr);
      } else {
        selectDate(dateStr);
      }
    });
    calWeekDays.appendChild(el);
  });

  // FLIP 滑动:新 active 从旧位置滑到新位置(选中底色移动的视觉)
  if (prevLeft !== null) {
    const newActive = calWeekDays.querySelector('.cal-week-day.active');
    if (newActive) {
      const delta = prevLeft - newActive.getBoundingClientRect().left;
      if (Math.abs(delta) > 0) {
        newActive.animate([
          { transform: `translateX(${delta}px)` },
          { transform: 'translateX(0)' }
        ], { duration: 250, easing: 'ease' });
      }
    }
  }

  // 切周动画:整行从切周方向滑入(任务列表不变,待点击日期后才切换)
  if (direction !== 0) {
    calWeekDays.animate([
      { transform: `translateX(${direction * 42}px)`, opacity: 0 },
      { transform: 'translateX(0)', opacity: 1 }
    ], { duration: 250, easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)' });
  }
}

// 周条切周:仅移动周条显示,任务列表保持原选中日期不变
function shiftWeek(delta) {
  const base = state.calendarWeek || state.calendarDayDate || state.calendarSelected || getToday();
  const dt = new Date(base.slice(0, 4), parseInt(base.slice(5, 7), 10) - 1, parseInt(base.slice(8, 10), 10));
  dt.setDate(dt.getDate() + delta * 7);
  state.calendarWeek = formatDateStr(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  renderWeekbar(delta);
}

let monthFadeCleanupTimer = null;
let monthFadeAnimations = [];

function cleanupMonthFade() {
  if (monthFadeCleanupTimer) {
    clearTimeout(monthFadeCleanupTimer);
    monthFadeCleanupTimer = null;
  }
  // 先让静态样式接管最终 opacity:1，再取消 fill:forwards，视觉值不会跳变。
  calendarView.classList.remove('month-entering');
  monthFadeAnimations.forEach(anim => anim.cancel());
  monthFadeAnimations = [];
}

// 退出当日任务视图回月历:任务+周行 250ms 淡出,220ms 后月历 300ms 淡入
async function exitDayMode() {
  if (!state.calendarDayDate || calendarView.classList.contains('day-mode-exiting')) return;
  cancelDayDateExit();
  calendarView.classList.add('day-mode-exiting');

  // 与任务列表→日历保持相同节奏:淡出尚余 30ms 时开始下一个视图的淡入。
  await new Promise(resolve => setTimeout(resolve, 220));
  if (!state.calendarOpen || !state.calendarDayDate) return;

  state.calendarDayDate = null;
  state.calendarWeek = null; // 周基准随当日视图退出清空
  calendarView.classList.add('month-entering');
  calendarView.classList.remove('day-mode', 'day-mode-exiting');
  calGrid.style.maxHeight = '';
  calWeekDays.innerHTML = '';
  collapseTextInput(false);
  await renderCalendar();

  if (!state.calendarOpen || state.calendarDayDate) return;
  monthFadeAnimations = [calGrid, calPrevBtn, calNextBtn].map(el => el.animate([
    { opacity: 0 },
    { opacity: 1 }
  ], { duration: 300, easing: 'ease', fill: 'forwards' }));

  // 520ms 是最早清理点；低帧率时仍要等动画确认到达最终帧，不能中途跳到 opacity:1。
  const activeMonthFadeAnimations = monthFadeAnimations;
  monthFadeCleanupTimer = setTimeout(async () => {
    monthFadeCleanupTimer = null;
    await Promise.all(activeMonthFadeAnimations.map(anim => anim.finished.catch(() => null)));
    if (monthFadeAnimations === activeMonthFadeAnimations) cleanupMonthFade();
  }, 520);
}

// 点击日期:选中高亮 + 识别框提示聚焦(不重建网格,保证双击可连续触发)
function selectDate(dateStr) {
  state.calendarSelected = dateStr;
  calGrid.querySelectorAll('.cal-day').forEach(el => {
    el.classList.toggle('selected', el.dataset.date === dateStr);
  });
  const [, m, d] = dateStr.split('-').map(Number);
  textInput.placeholder = `识别添加${m}月${d}日任务`;
  textInput.focus();
}

// 双击日期:进入当日任务视图(日期格渐隐+网格折叠+周条上移,识别框保持展开)
async function enterDayMode(dateStr) {
  cancelDayDateExit();
  cleanupMonthFade();
  calendarView.classList.remove('day-mode-exiting');
  state.calendarSelected = dateStr;
  state.calendarDayDate = dateStr;
  state.calendarWeek = dateStr; // 周条显示该日所在周
  calendarView.classList.add('day-mode');
  // 网格折叠动画:先清旧 inline,测实际高度设初始 max-height,再过渡到 0(auto→0 无法过渡)
  calGrid.style.maxHeight = '';
  const h = calGrid.getBoundingClientRect().height;
  calGrid.style.maxHeight = h + 'px';
  void calGrid.offsetHeight; // 强制重排,使过渡起点生效
  calGrid.style.maxHeight = '0px';
  renderWeekbar();
  await renderDayTasks(false, true); // 切换日期/进入视图:任务行逐行渐现
}

// 识别框收起:向左滑出为窄条,左侧留识别条(✍),点击再展开
function collapseTextInput(collapsed) {
  textInput.classList.toggle('collapsed', collapsed);
  recogTab.classList.toggle('hidden', !collapsed);
}

// 日历区域滚轮切月:上滚上月,下滚下月;300ms 节流防一次滚动连切多个月
let lastCalWheelSwitch = 0;
function onCalGridWheel(e) {
  if (!state.calendarOpen || state.calendarDayDate) return; // day 模式当日任务列表正常滚动
  e.preventDefault();
  const now = Date.now();
  if (now - lastCalWheelSwitch < 300) return;
  lastCalWheelSwitch = now;
  shiftCalendarMonth(e.deltaY > 0 ? 1 : -1);
}

function shiftCalendarMonth(delta) {
  state.calendarMonth.m += delta;
  if (state.calendarMonth.m < 0) { state.calendarMonth.m = 11; state.calendarMonth.y--; }
  if (state.calendarMonth.m > 11) { state.calendarMonth.m = 0; state.calendarMonth.y++; }
  renderCalendar(delta); // 传方向:下月从右滑入,上月从左滑入
}

function toggleCalendar() {
  if (state.calendarOpen) closeCalendar();
  else openCalendar();
}

function openCalendar() {
  const now = new Date();
  state.calendarMonth = { y: now.getFullYear(), m: now.getMonth() };
  state.calendarOpen = true;
  updateOrganizeButton(); // 复用项目页签切换时的置灰过渡
  btnCalendar.textContent = '列表'; // 日历状态:按钮切换为「列表」
  taskArea.classList.add('dimmed'); // 任务区淡出(识别框不动)
  calendarView.classList.remove('hidden'); // 日历就位(仍 opacity 0)
  setTimeout(() => {
    calendarView.classList.add('open'); // 日历渐渐出现
    renderCalendar();
  }, 220);
}

function closeCalendar() {
  cancelDayDateExit();
  cleanupMonthFade();
  state.calendarOpen = false;
  updateOrganizeButton();
  btnCalendar.textContent = '日历'; // 切回任务列表:按钮文字恢复
  state.calendarSelected = null;
  state.calendarDayDate = null;
  state.calendarWeek = null; // 周基准随日历关闭清空
  calendarView.classList.remove('open', 'day-mode', 'day-mode-exiting');
  taskArea.classList.remove('dimmed'); // 任务列表淡回
  // 任务行从上到下逐行渐现(与项目页签切换、当日视图切换日期一致)
  animateTaskRowsIn(taskItems);
  collapseTextInput(false);
  textInput.placeholder = '记录想做的事...';
  // 清理 day 模式残留:折叠动画 inline、周条、当日任务,确保下次打开为初始态
  calGrid.style.maxHeight = '';
  calWeekDays.innerHTML = '';
  calDayTasks.innerHTML = '';
  setTimeout(() => {
    if (!state.calendarOpen) calendarView.classList.add('hidden');
  }, 350);
}

// 当日任务单列列表:与主任务列格式完全一致(含右侧热区操作栏),未完成在前(按 sortOrder),已完成灰显置底
// 数据源:当前活动任务 + 历史已完成记录;历史未完成孤立副本不显示
// shouldAnimate:勾选完成/取消后行滑动重排,与主列表 FLIP 特效一致
// stagger:切换日期/进入视图时,任务行从上到下一个一个渐渐出现
let dayTasksSeq = 0; // 渲染序列号:丢弃过期异步渲染,防快速切日期的竞态

// 行索引解析:idx>=0 今天任务(state.tasks);idx<0 历史任务(state.calendarDayTasks 按渲染时记录的 id 映射)
// 注意:负 idx 必须用渲染时该行对应的任务 id 精确定位(排序/去重数组顺序可能变化),不能靠数组下标
function taskByIdx(idx) {
  if (idx >= 0) return state.tasks[idx];
  const map = state.calendarDayIdMap;
  return map ? map.get(idx) : undefined;
}

// 修改后持久化:任务写回对应文件并同步所有同身份副本(今天任务也同步历史缓存)
// prevKey:修改前的身份键(任务+项目),用于改名/改项目后仍能匹配旧副本
// 所有操作(勾选/编辑/项目/日期/时间)都先打 updatedAt 时间戳,去重按最新时间戳判断
async function persistTask(t, prevKey) {
  if (!t) return;
  t.updatedAt = new Date().toISOString();
  await ensureTaskFilesLoaded(); // 同步前先加载全部历史文件，避免只更新已打开过的月份
  if (state.tasks.includes(t)) {
    // 今天任务:先写今天文件,再同步历史缓存里的同身份副本
    return Promise.all([saveTasks(), ...syncTaskCopies(t, prevKey, getToday())]).catch(() => { /* ignore */ });
  }
  const fileDate = t._fileDate || t.dueDate;
  if (!fileDate || !window.electronAPI) return Promise.resolve();
  let arr = taskFileCache.get(fileDate);
  if (!arr) {
    return window.electronAPI.loadTasksByDate(fileDate).then(fileTasks => {
      const list = fileTasks || [];
      for (const x of list) x._fileDate = fileDate;
      taskFileCache.set(fileDate, list);
      taskFileCacheLoaded.add(fileDate);
      return persistTask(t, prevKey);
    }).catch(() => { /* ignore */ });
  }
  // 按 id 或(任务+项目)匹配更新,避免不同 id 同名记录重复
  let idx = arr.findIndex(x => x.id === t.id);
  if (idx === -1) idx = arr.findIndex(x => (x.task === t.task) && (x.project || '') === (t.project || ''));
  if (idx >= 0) arr[idx] = t;
  else arr.push(t);
  // 从日历修改历史任务时同步内存中的当天副本，保证切回任务列表后状态立即一致
  const matchesState = (x) => (x.id && t.id && x.id === t.id)
    || (x.task === t.task && (x.project || '') === (t.project || ''))
    || (prevKey && (x.task + '|' + (x.project || '')) === prevKey);
  const stateCopy = state.tasks.find(matchesState);
  const stateSyncs = [];
  const skipDates = [fileDate];
  if (stateCopy && stateCopy !== t) {
    stateCopy.completed = t.completed;
    stateCopy.completedAt = t.completedAt;
    stateCopy.project = t.project;
    stateCopy.task = t.task;
    stateCopy.dueDate = t.dueDate;
    stateCopy.alarmTime = t.alarmTime;
    stateCopy.updatedAt = t.updatedAt;
    stateSyncs.push(saveTasks());
    skipDates.push(getToday());
  } else if (!stateCopy && !t.completed) {
    // 在历史日历中取消完成时恢复为当前待办，避免从日历消失却不回到任务列表
    const { _fileDate, ...currentCopy } = t;
    currentCopy.sortOrder = state.tasks.reduce((max, x) => Math.max(max, x.sortOrder ?? -1), -1) + 1;
    state.tasks.push(currentCopy);
    stateSyncs.push(saveTasks());
    skipDates.push(getToday());
  }
  return Promise.all([
    window.electronAPI.saveTasksByDate(fileDate, arr),
    ...stateSyncs,
    ...syncTaskCopies(t, prevKey, skipDates),
  ]).then(() => {
    taskFileCacheLoaded.add(fileDate);
    // 视图同步:更新 calendarDayTasks 中同名对象,避免重渲染时被旧文件状态覆盖
    if (state.calendarDayTasks) {
      const vi = state.calendarDayTasks.findIndex(x => x.id === t.id);
      if (vi >= 0) state.calendarDayTasks[vi] = t;
      else {
        const vi2 = state.calendarDayTasks.findIndex(x => x.task === t.task && (x.project || '') === (t.project || ''));
        if (vi2 >= 0) state.calendarDayTasks[vi2] = t;
      }
    }
  }).catch(() => { /* ignore */ });
}

// 同步所有文件里的同身份副本(按 id 或 任务+项目,支持旧身份键 prevKey 匹配改名/改项目前的副本)
// 返回写盘 promise 数组
function syncTaskCopies(t, prevKey, skipDates) {
  if (!window.electronAPI) return [];
  const syncs = [];
  const skipped = new Set(Array.isArray(skipDates) ? skipDates : [skipDates].filter(Boolean));
  const matchesKey = (x) => {
    if (x.id && t.id && x.id === t.id) return true;
    if (x.task === t.task && (x.project || '') === (t.project || '')) return true;
    if (prevKey && (x.task + '|' + (x.project || '')) === prevKey) return true;
    return false;
  };
  for (const [d, fileArr] of taskFileCache) {
    if (skipped.has(d)) continue;
    if (!fileArr) continue;
    let changed = false;
    for (let i = 0; i < fileArr.length; i++) {
      const x = fileArr[i];
      if (x === t) continue;
      if (matchesKey(x)) {
        x.completed = t.completed;
        x.completedAt = t.completedAt;
        x.project = t.project;
        x.task = t.task;
        x.dueDate = t.dueDate;
        x.alarmTime = t.alarmTime;
        x.updatedAt = t.updatedAt;
        changed = true;
      }
    }
    if (changed) syncs.push(window.electronAPI.saveTasksByDate(d, fileArr));
  }
  return syncs;
}

// 删除任务:同时清除当天 state.tasks 与全部历史文件中的同身份副本(id 或 任务+项目)
async function removeTaskFromFile(t) {
  if (!t) return;
  const matchesTask = (x) => x === t
    || (x.id && t.id && x.id === t.id)
    || (x.task === t.task && (x.project || '') === (t.project || ''));

  if (!window.electronAPI) {
    state.tasks = state.tasks.filter(x => !matchesTask(x));
    await saveTasks();
    return;
  }

  await ensureTaskFilesLoaded(); // 删除必须覆盖尚未打开过的历史日期文件
  const syncs = [];
  const today = getToday();
  const todayRest = state.tasks.filter(x => !matchesTask(x));
  if (todayRest.length !== state.tasks.length) {
    state.tasks = todayRest;
    syncs.push(saveTasks());
  }
  for (const [d, fileArr] of taskFileCache) {
    if (d === today) continue; // 今天文件由 state.tasks 作为唯一数据源写入
    if (!fileArr) continue;
    const rest = fileArr.filter(x => !matchesTask(x));
    if (rest.length !== fileArr.length) {
      taskFileCache.set(d, rest);
      taskFileCacheLoaded.add(d);
      syncs.push(window.electronAPI.saveTasksByDate(d, rest));
    }
  }
  await Promise.all(syncs).catch(() => { /* ignore */ });
}

// 某日期全部任务:完全按日期胶囊(dueDate)归属,不按文件日期
// 今天文件任务=state.tasks;历史文件任务从缓存取;去重(任务+项目)今天版本优先
// 历史文件任务附加运行时标记 _fileDate(来源文件,不持久化):写回据此定位文件
const taskFileCache = new Map();  // dateStr → tasks[](已加载的历史任务文件)
const taskFileCacheLoaded = new Set(); // 已加载的日期(增量加载判断)

// 增量加载全部历史任务文件到缓存
async function ensureTaskFilesLoaded() {
  if (!window.electronAPI) return;
  try {
    const files = await window.electronAPI.listTasksFiles();
    const need = (files || [])
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.slice(0, 10))
      .filter(d => !taskFileCacheLoaded.has(d));
    if (need.length === 0) return;
    await Promise.all(need.map(async (d) => {
      try {
        const arr = await window.electronAPI.loadTasksByDate(d);
        for (const t of (arr || [])) t._fileDate = d;
        taskFileCache.set(d, arr || []);
      } catch (e) { taskFileCache.set(d, []); }
      taskFileCacheLoaded.add(d);
    }));
  } catch (e) { /* ignore */ }
}

// 纯函数:先跨数据源选出每个任务的最新副本,再完全按该副本的 dueDate 归属
// 当前列表提供全部活动任务;历史文件只补充已完成记录,历史未完成孤立副本不再显示为幽灵任务
// 无日期胶囊任务不收录;同名按 任务+项目 去重,保留 updatedAt 最新版本
function buildDueDateIndex(todayTasks, cachedFiles) {
  const latest = new Map();
  const currentKeys = new Set();
  const index = new Map();
  const add = (t, isCurrent = false) => {
    if (!t) return;
    const key = t.task + '|' + (t.project || '');
    if (isCurrent) currentKeys.add(key);
    const cur = latest.get(key);
    if (!cur) { latest.set(key, t); return; }
    if (!isCurrent && currentKeys.has(key)) return; // 当前列表状态是活动任务的权威版本
    // 同名副本:保留 updatedAt 最新;同时间戳时 done=true 优先(旧数据无 updatedAt 时勾选副本视为最新)
    const tNew = (t.updatedAt || t.createdAt || '');
    const curNew = (cur.updatedAt || cur.createdAt || '');
    if (tNew > curNew) latest.set(key, t);
    else if (tNew === curNew && t.completed && !cur.completed) latest.set(key, t);
  };
  for (const t of todayTasks) add(t, true);
  for (const arr of cachedFiles) for (const t of arr) if (t.completed) add(t);
  for (const t of latest.values()) {
    if (typeof t.dueDate !== 'string') continue;
    const list = index.get(t.dueDate);
    if (list) list.push(t);
    else index.set(t.dueDate, [t]);
  }
  return index;
}

async function loadTasksForDate(dateStr) {
  await ensureTaskFilesLoaded();
  const dueIndex = buildDueDateIndex(state.tasks, taskFileCache.values());
  return dueIndex.get(dateStr) || []; // 历史对象自带 _fileDate(缓存加载时打标),今天对象走 state.tasks
}

async function renderDayTasks(shouldAnimate = false, stagger = false) {
  const seq = ++dayTasksSeq;
  const dateStr = state.calendarDayDate;
  const oldPos = shouldAnimate ? snapshotPositions(calDayTasks) : null;
  const tasks = (await loadTasksForDate(dateStr)).sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  });
  if (seq !== dayTasksSeq) return; // 期间已切换到其他日期,丢弃本次渲染
  // 数据就绪后再替换旧列表，避免异步加载期间出现一帧空白（取消勾选重排时尤为明显）。
  calDayTasks.innerHTML = '';
  const list = document.createElement('div');
  list.id = 'cal-day-list';
  const fadeEmptyState = pendingDayEmptyFadeDate === dateStr;
  if (pendingDayEmptyFadeDate) pendingDayEmptyFadeDate = null;
  state.calendarDayTasks = tasks;

  let emptyState = null;
  if (tasks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.padding = '36px 0';
    const icon = document.createElement('div');
    icon.className = 'empty-icon';
    icon.textContent = '🗓';
    const title = document.createElement('div');
    title.className = 'empty-title';
    title.textContent = '当天暂无任务';
    empty.append(icon, title);
    list.appendChild(empty);
    emptyState = empty;
  } else {
    // 负 idx 用唯一负序列号(-1,-2,...),渲染时记录 idx→任务 映射,点击经 taskByIdx 精确取对象
    // 不能用 -i-1(排序后下标):合并/去重数组顺序可能与渲染行不一致,导致勾选连带误改
    state.calendarDayIdMap = new Map();
    let neg = 0;
    tasks.forEach((task) => {
      const idxInToday = state.tasks.indexOf(task);
      let idx;
      if (idxInToday >= 0) {
        idx = idxInToday;
      } else {
        idx = -(++neg);
        state.calendarDayIdMap.set(idx, task);
      }
      const row = buildTaskRow(task, idx);
      row.classList.add('cal-day-task-item');
      list.appendChild(row);
    });
  }
  calDayTasks.appendChild(list);

  if (emptyState && fadeEmptyState) {
    emptyState.animate([
      { opacity: 0, transform: 'translateY(4px)' },
      { opacity: 1, transform: 'translateY(0)' }
    ], { duration: 180, easing: 'ease-out', fill: 'both' });
  }

  // FLIP 动画:与主列表一致(记旧位置 → 重建 → 计算位移 → translateY 滑动归位)
  if (oldPos) {
    list.querySelectorAll('.task-item').forEach(el => {
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
  } else if (stagger) {
    // 逐行渐现:从上到下依次淡入+上滑,每行间隔 45ms
    list.querySelectorAll('.task-item').forEach((el, i) => {
      el.animate([
        { opacity: 0, transform: 'translateY(8px)' },
        { opacity: 1, transform: 'translateY(0)' }
      ], { duration: 220, delay: i * 45, easing: 'ease', fill: 'both' });
    });
  }
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
  if (state.toolsEnabled.harness) renderHarnessCard();
}

// ========== 工具箱:DeepSeek Harness 卡 ==========
const HARNESS_STATUS_LABELS = {
  idle: '就绪', ready: '就绪', starting: '启动中', running: '执行中',
  stopping: '停止中', stopped: '已停止', completed: '已完成', error: '失败',
};

let harnessStatusTimer = null;

function formatHarnessClock(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function formatHarnessDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function formatHarnessTokens(usage) {
  const total = Number(usage?.totalTokens);
  if (!Number.isFinite(total) || total <= 0) return '';
  if (total >= 1000000) return `${(total / 1000000).toFixed(1)}M`;
  if (total >= 1000) return `${(total / 1000).toFixed(total >= 10000 ? 0 : 1)}k`;
  return String(Math.round(total));
}

function getHarnessStatusParts() {
  const status = state.harness.status || 'idle';
  const label = HARNESS_STATUS_LABELS[status] || status || '就绪';
  let meta = '';
  if (['starting', 'running', 'stopping'].includes(status) && state.harness.runStartedAt) {
    meta = formatHarnessClock(Date.now() - state.harness.runStartedAt);
  } else if (status === 'completed') {
    const parts = [];
    if (Number.isFinite(state.harness.runElapsedMs)) {
      parts.push(`耗时 ${formatHarnessDuration(state.harness.runElapsedMs)}`);
    }
    const tokens = formatHarnessTokens(state.harness.runTokens);
    if (tokens) parts.push(`${tokens} tokens`);
    meta = parts.join(' · ');
  }
  return { label, meta };
}

function updateHarnessStatusBadge() {
  const badge = toolsCards?.querySelector('[data-tool="harness"] .harness-status');
  if (!badge) return;
  const { label, meta } = getHarnessStatusParts();
  let statusLine = badge.querySelector('.harness-status-line');
  let metaLine = badge.querySelector('.harness-status-meta');
  if (!statusLine) {
    statusLine = document.createElement('span');
    statusLine.className = 'harness-status-line';
    badge.appendChild(statusLine);
  }
  if (!metaLine) {
    metaLine = document.createElement('span');
    metaLine.className = 'harness-status-meta';
    badge.appendChild(metaLine);
  }
  statusLine.textContent = label;
  metaLine.textContent = meta;
  metaLine.classList.toggle('hidden', !meta);
  badge.dataset.harnessStatus = state.harness.status || 'idle';
}

function syncHarnessStatusTimer() {
  const shouldTick = ['starting', 'running', 'stopping'].includes(state.harness.status);
  if (shouldTick && !harnessStatusTimer) {
    harnessStatusTimer = setInterval(updateHarnessStatusBadge, 500);
  } else if (!shouldTick && harnessStatusTimer) {
    clearInterval(harnessStatusTimer);
    harnessStatusTimer = null;
  }
}

async function refreshHarnessSnapshot() {
  if (!window.electronAPI?.harnessSnapshot) return;
  const snapshot = await window.electronAPI.harnessSnapshot();
  if (!snapshot) return;
  state.harness = {
    ...state.harness,
    ...snapshot,
    toolGroupExpanded: ['starting', 'running', 'stopping'].includes(snapshot.status),
  };
  updateHarnessCard();
}

async function refreshHarnessSessions(restoreLatest = false) {
  if (!window.electronAPI?.harnessListSessions || !state.harness.workspace) return;
  const sessions = await window.electronAPI.harnessListSessions();
  state.harness.sessions = Array.isArray(sessions) ? sessions : [];
  const currentId = state.harness.sessionId;
  // 渲染层重载后内存里的消息会被清空，但快照已把当前会话 id 恢复回来。此时也要
  // 从磁盘把当前会话的消息补回来，否则会出现“任务跑着跑着对话全没了”的现象。
  if (currentId && state.harness.messages.length === 0) {
    await loadHarnessSession(currentId);
    return;
  }
  if (restoreLatest && !currentId && state.harness.sessions[0]) {
    await loadHarnessSession(state.harness.sessions[0].id);
    return;
  }
  updateHarnessCard();
}

async function loadHarnessSession(sessionId, preserveStats = false) {
  if (!window.electronAPI?.harnessLoadSession || !sessionId) return;
  const session = await window.electronAPI.harnessLoadSession(sessionId);
  if (!session) return;
  const busy = ['starting', 'running', 'stopping'].includes(state.harness.status);
  const loaded = Array.isArray(session.messages) ? session.messages : [];
  state.harness.sessionId = session.id;
  state.harness.sessionTitle = session.title || '';
  // 用空/不完整的读取结果覆盖正在展示的实时对话，是“对话消失”的主要来源。
  // 任务刚结束时持久化仍在批量落盘，此时读到的磁盘存档可能缺少结尾的最终答复；
  // 只要本地实时对话以最终答复收尾、而磁盘存档里找不到这条答复，就保留实时对话，
  // 等下一次能读到完整存档时（重载页面/切换目录/再次刷新）再换成磁盘版本。
  const liveMessages = state.harness.messages;
  const liveLast = liveMessages.length > 0 ? liveMessages[liveMessages.length - 1] : null;
  const diskMissingLiveAnswer = liveLast?.role === 'assistant'
    && !loaded.some(message => message.role === 'assistant' && message.text === liveLast.text);
  if (liveMessages.length === 0 || (loaded.length > 0 && !diskMissingLiveAnswer)) {
    state.harness.messages = loaded;
  }
  state.harness.todos = Array.isArray(session.todos) ? session.todos : [];
  state.harness.diffs = Array.isArray(session.diffs) ? session.diffs : [];
  state.harness.toolGroupExpanded = false;
  if (!preserveStats) {
    state.harness.runStartedAt = null;
    state.harness.runElapsedMs = null;
    state.harness.runTokens = null;
  }
    const sessionElapsedMs = Number.isFinite(session.elapsedMs) ? session.elapsedMs : null;
    const sessionTokens = Number.isFinite(session.usage?.totalTokens) ? session.usage : null;
    if (preserveStats) {
      // 网页会话实时刷新时不要清掉已有统计；若当前没有，则从磁盘补齐 token/耗时。
      if (!Number.isFinite(state.harness.runElapsedMs) && sessionElapsedMs !== null) {
        state.harness.runElapsedMs = sessionElapsedMs;
      }
      if (!state.harness.runTokens && sessionTokens) {
        state.harness.runTokens = sessionTokens;
      }
    } else {
      state.harness.runElapsedMs = sessionElapsedMs;
      state.harness.runTokens = sessionTokens;
    }
  // 任务执行期间从磁盘补历史时，不要用文件里的“已完成/空闲”结果覆盖掉运行状态。
  if (!busy) {
    state.harness.status = session.outcome === 'completed' ? 'completed'
      : ['aborted', 'interrupted'].includes(session.outcome) ? 'stopped'
        : session.outcome === 'idle' ? 'idle' : 'error';
  }
  updateHarnessCard();
}

function addHarnessMessage(role, text, extra = {}) {
  const value = String(text || '').trim();
  if (!value) return;
  state.harness.messages.push({ role, text: value.slice(0, 12000), ...extra });
  // 数量上限只裁最旧的非用户消息：用户发言永远保留，长任务不会把开头提问挤出窗口。
  while (state.harness.messages.length > 100) {
    const index = state.harness.messages.findIndex(message => message.role !== 'user');
    if (index === -1) break;
    state.harness.messages.splice(index, 1);
  }
}

let harnessToastTimer = null;
function showHarnessCompletionToast(success) {
  if (!state.windowVisible) return; // 窗口未显示：系统通知由主进程负责
  const host = state.currentPage === 'notepad'
    ? document.querySelector('.page-notepad .notepad-footer')
    : state.currentPage === 'tools'
      ? document.querySelector('.page-tools .notepad-footer')
      : $('#input-actions');
  if (!host) return;
  host.classList.add('harness-toast-host');
  let toast = host.querySelector('.harness-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'harness-toast';
    host.appendChild(toast);
  }
  const accent = success ? 'harness-toast-success' : 'harness-toast-error';
  const dot = document.createElement('span');
  dot.className = `harness-toast-dot ${accent}`;
  const tail = document.createElement('span');
  tail.className = accent;
  tail.textContent = success ? '已完成' : '失败';
  toast.innerHTML = '';
  toast.append(dot, document.createTextNode('Harness任务'), tail);
  void toast.offsetWidth; // 强制重排，确保连续触发时动画重新播放
  toast.classList.add('show');
  clearTimeout(harnessToastTimer);
  harnessToastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
}

// 点击 Harness 卡片状态区 → 懒启动 dsh web 并打开浏览器；失败时弹提示。
async function openHarnessWebPage() {
  if (typeof window.electronAPI?.harnessOpenWeb !== 'function') {
    showHarnessWebToast('功能未加载，请重启便利贴后重试');
    return;
  }
  showHarnessWebToast('正在启动…', true);
  try {
    const result = await window.electronAPI.harnessOpenWeb();
    if (result && result.success === false && result.error) {
      showHarnessWebToast(result.error);
    }
  } catch (error) {
    showHarnessWebToast(error?.message || '打开失败');
  }
}

function showHarnessWebToast(message, starting = false) {
  if (!state.windowVisible) return;
  const host = state.currentPage === 'tools'
    ? document.querySelector('.page-tools .notepad-footer')
    : $('#input-actions');
  if (!host) return;
  host.classList.add('harness-toast-host');
  let toast = host.querySelector('.harness-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'harness-toast';
    host.appendChild(toast);
  }
  const accent = starting ? 'harness-toast-success' : 'harness-toast-error';
  const dot = document.createElement('span');
  dot.className = `harness-toast-dot ${accent}`;
  const tail = document.createElement('span');
  tail.className = accent;
  tail.textContent = String(message || (starting ? '' : '打开失败')).slice(0, 60);
  toast.innerHTML = '';
  toast.append(dot, document.createTextNode('Harness网页'), tail);
  void toast.offsetWidth;
  toast.classList.add('show');
  clearTimeout(harnessToastTimer);
  harnessToastTimer = setTimeout(() => toast.classList.remove('show'), starting ? 8000 : 2600);
}

function handleHarnessEvent(event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'snapshot' && event.snapshot) {
    state.harness = { ...state.harness, ...event.snapshot };
    state.harness.toolGroupExpanded = ['starting', 'running', 'stopping'].includes(state.harness.status);
  } else if (event.type === 'status') {
    state.harness.status = event.status || state.harness.status;
    state.harness.toolGroupExpanded = ['starting', 'running', 'stopping'].includes(state.harness.status);
    if (event.sessionId) state.harness.sessionId = event.sessionId;
    if (['starting', 'running'].includes(state.harness.status) && !state.harness.runStartedAt) {
      state.harness.runStartedAt = Date.now();
      state.harness.runElapsedMs = null;
      state.harness.runTokens = null;
    }
  } else if (event.type === 'message' && event.role === 'assistant') {
    const streamed = event.streamKey
      ? [...state.harness.messages].reverse().find(message => message.role === 'assistant' && message.streamKey === event.streamKey)
      : null;
    if (event.delta) {
      if (streamed) streamed.text = (streamed.text + event.text).slice(-12000);
      else state.harness.messages.push({ role: 'assistant', text: String(event.text || ''), streamKey: event.streamKey, streaming: true });
    } else if (streamed) {
      streamed.text = String(event.text || streamed.text).slice(0, 12000);
      streamed.streaming = false;
    } else {
      const last = state.harness.messages[state.harness.messages.length - 1];
      if (!last || last.role !== 'assistant' || last.text !== event.text) addHarnessMessage('assistant', event.text);
    }
  } else if (event.type === 'tool') {
    if (event.phase === 'start') {
      state.harness.toolGroupExpanded = true;
      addHarnessMessage('tool', event.name || '工具', { callId: event.callId, detail: event.detail || '', pending: true });
    } else {
      const row = [...state.harness.messages].reverse().find(m => m.role === 'tool' && m.callId === event.callId);
      if (row) {
        row.pending = false;
        row.failed = !!event.failed;
        row.output = event.output || '';
      }
      if (Array.isArray(event.diffs)) state.harness.diffs.push(...event.diffs);
      if (state.harness.diffs.length > 50) state.harness.diffs.splice(0, state.harness.diffs.length - 50);
    }
  } else if (event.type === 'todos') {
    state.harness.todos = Array.isArray(event.todos) ? event.todos : [];
  } else if (event.type === 'subagent') {
    addHarnessMessage('tool', `子任务${event.status === 'finished' ? '已完成' : '已启动'}`, { pending: event.status !== 'finished' });
  } else if (event.type === 'result') {
    const last = state.harness.messages[state.harness.messages.length - 1];
    if (event.text && (!last || last.role !== 'assistant' || last.text !== event.text)) {
      addHarnessMessage('assistant', event.text);
    }
    state.harness.status = 'completed';
    state.harness.toolGroupExpanded = false;
    state.harness.runElapsedMs = Number.isFinite(event.elapsedMs)
      ? event.elapsedMs
      : (state.harness.runStartedAt ? Date.now() - state.harness.runStartedAt : null);
    state.harness.runTokens = event.usage || null;
    state.harness.runStartedAt = null;
    showHarnessCompletionToast(true);
    setTimeout(async () => {
      await refreshHarnessSessions();
      if (state.harness.sessionId) await loadHarnessSession(state.harness.sessionId, true);
    }, 300);
  } else if (event.type === 'error') {
    state.harness.status = 'error';
    state.harness.toolGroupExpanded = false;
    state.harness.error = event.message || 'Harness 执行失败';
    if (!Number.isFinite(state.harness.runElapsedMs) && state.harness.runStartedAt) {
      state.harness.runElapsedMs = Date.now() - state.harness.runStartedAt;
    }
    state.harness.runStartedAt = null;
    addHarnessMessage('error', state.harness.error);
    showHarnessCompletionToast(false);
  } else if (event.type === 'external-complete') {
    // 网页端任务完成：只弹提示，不改动便利贴当前会话状态；同时刷新会话列表让网页会话可见
    showHarnessCompletionToast(event.success !== false);
    refreshHarnessSessions();
  } else if (event.type === 'sessions-changed') {
    // 网页端会话文件新增/内容变化：实时刷新会话列表，并同步当前查看会话的进行中进度，
    // 任务未完成也能看到消息/待办/工具调用，无需等待任务结束或手动刷新。
    refreshHarnessSessions().then(async () => {
      if (!event.sessionId) return;
      const currentId = state.harness.sessionId;
      const isCurrent = currentId === event.sessionId;
      const isLatestWhenNone = !currentId && state.harness.sessions[0]?.id === event.sessionId;
      if (isCurrent || isLatestWhenNone) await loadHarnessSession(event.sessionId, true);
    });
  }
  updateHarnessCard();
}

function syncHarnessInputCompact(card) {
  const input = card?.querySelector('.harness-input');
  if (!input) return;
  const compact = !input.value.trim() && input !== document.activeElement;
  input.classList.toggle('harness-input-compact', compact);
  card.classList.toggle('harness-input-compact', compact);
  syncHarnessTodosHeight(card); // 任务框基准高度随输入框压缩态变化,同步重算待办补偿
}

function renderHarnessCard() {
  const card = document.createElement('section');
  card.className = 'tool-card harness-card';
  card.dataset.tool = 'harness';

  const header = document.createElement('div');
  header.className = 'harness-header';
  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'tool-card-title harness-title-trigger';
  title.textContent = 'DeepSeek Harness';
  title.setAttribute('aria-expanded', 'false');
  const badge = document.createElement('span');
  badge.className = 'harness-status';
  badge.dataset.harnessStatus = state.harness.status;
  badge.title = '打开网页版 (http://127.0.0.1:3080)';
  badge.setAttribute('role', 'button');
  badge.tabIndex = 0;
  badge.addEventListener('click', openHarnessWebPage);
  badge.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHarnessWebPage(); }
  });

  const headingControl = document.createElement('div');
  headingControl.className = 'harness-heading-control';

  const workspaceButton = document.createElement('button');
  workspaceButton.type = 'button';
  workspaceButton.className = 'harness-workspace harness-quick-btn';
  workspaceButton.title = '选择工作目录';

  const historyButton = document.createElement('button');
  historyButton.type = 'button';
  historyButton.className = 'harness-history-btn harness-quick-btn';
  historyButton.textContent = '◷ 历史会话';
  historyButton.setAttribute('aria-expanded', 'false');

  const quickActions = document.createElement('div');
  quickActions.className = 'harness-quick-actions';
  quickActions.append(workspaceButton, historyButton);
  headingControl.append(title, quickActions);

  const sessionList = document.createElement('div');
  sessionList.className = 'harness-session-list';
  sessionList.setAttribute('role', 'listbox');
  sessionList.setAttribute('aria-label', '历史会话');
  header.append(headingControl, badge, sessionList);

  title.addEventListener('click', () => openHarnessQuickActions(card));
  workspaceButton.addEventListener('click', async () => {
    await selectHarnessWorkspace();
    closeHarnessQuickActions(card);
  });
  historyButton.addEventListener('click', async () => {
    const open = card.classList.toggle('harness-history-open');
    historyButton.setAttribute('aria-expanded', String(open));
    if (open) await refreshHarnessSessions(); // 打开列表时拉取最新会话（含网页端新建的）
  });

  const todos = document.createElement('div');
  todos.className = 'harness-todos';
  todos.dataset.expanded = state.harness.todosExpanded ? '1' : '0'; // 展开/收起动画仅在用户点击时播放

  const history = document.createElement('div');
  history.className = 'harness-history';
  history.setAttribute('aria-live', 'polite');

  const artifacts = document.createElement('details');
  artifacts.className = 'harness-artifacts';
  const artifactsSummary = document.createElement('summary');
  const artifactsBody = document.createElement('div');
  artifactsBody.className = 'harness-artifacts-body';
  artifacts.append(artifactsSummary, artifactsBody);

  const input = document.createElement('textarea');
  input.className = 'harness-input';
  input.rows = 3;
  input.maxLength = 8000;
  input.placeholder = '描述要完成的任务…';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitHarnessTask(card);
    }
  });
  input.addEventListener('focus', () => syncHarnessInputCompact(card));
  input.addEventListener('blur', () => syncHarnessInputCompact(card));
  input.addEventListener('input', () => syncHarnessInputCompact(card));

  const actions = document.createElement('div');
  actions.className = 'harness-actions';
  const options = document.createElement('div');
  options.className = 'harness-run-options';
  const optionsTrigger = document.createElement('button');
  optionsTrigger.type = 'button';
  optionsTrigger.className = 'harness-options-trigger';
  optionsTrigger.setAttribute('aria-label', '选择模型和推理等级');
  optionsTrigger.setAttribute('aria-expanded', 'false');
  const optionsPanel = document.createElement('div');
  optionsPanel.className = 'harness-options-panel';
  optionsPanel.setAttribute('role', 'dialog');
  optionsPanel.setAttribute('aria-label', '模型和推理等级');
  const optionRows = [
    ['模型', [['Flash', 'deepseek-v4-flash'], ['Pro', 'deepseek-v4-pro']]],
    ['推理', [['Off', 'off'], ['High', 'high'], ['Max', 'max']]],
  ];
  for (const [labelText, choices] of optionRows) {
    const row = document.createElement('div');
    row.className = 'harness-option-row';
    const label = document.createElement('span');
    label.textContent = labelText;
    const choicesBox = document.createElement('div');
    choicesBox.className = 'harness-option-choices';
    for (const [text, value] of choices) {
      const choice = document.createElement('button');
      choice.type = 'button';
      choice.textContent = text;
      choice.dataset.value = value;
      choice.dataset.kind = labelText === '模型' ? 'model' : 'effort';
      choice.addEventListener('click', () => {
        const model = choice.dataset.kind === 'model' ? value : state.harness.model;
        const effort = choice.dataset.kind === 'effort' ? value : state.harness.reasoningEffort;
        updateHarnessRunOptions(card, model, effort);
      });
      choicesBox.appendChild(choice);
    }
    row.append(label, choicesBox);
    optionsPanel.appendChild(row);
  }
  optionsTrigger.addEventListener('click', () => {
    const open = options.classList.toggle('open');
    optionsTrigger.setAttribute('aria-expanded', String(open));
  });
  options.append(optionsTrigger, optionsPanel);
  const buttons = document.createElement('div');
  buttons.className = 'harness-action-buttons';
  const newButton = document.createElement('button');
  newButton.type = 'button';
  newButton.className = 'harness-secondary-btn harness-new-btn';
  newButton.textContent = '+';
  newButton.title = '新会话';
  newButton.setAttribute('aria-label', '新会话');
  newButton.addEventListener('click', newHarnessSession);
  const runButton = document.createElement('button');
  runButton.type = 'button';
  runButton.className = 'harness-send-btn harness-run-stop-btn';
  const runIcon = document.createElement('span');
  runIcon.className = 'harness-run-stop-icon';
  runIcon.setAttribute('aria-hidden', 'true');
  const runLabel = document.createElement('span');
  runLabel.className = 'harness-run-stop-label';
  runLabel.textContent = '运行';
  runButton.append(runIcon, runLabel);
  runButton.addEventListener('click', () => {
    const busy = ['starting', 'running', 'stopping'].includes(state.harness.status);
    if (busy) stopHarnessTask();
    else submitHarnessTask(card);
  });
  buttons.append(newButton, runButton);
  actions.append(options, buttons);

  card.append(header, todos, history, artifacts, input, actions);
  toolsCards.appendChild(card);
  updateHarnessCard();
}

function compactHarnessPath(value) {
  const full = String(value || '').trim();
  if (!full) return '选择目录';
  const parts = full.split(/[\\/]+/).filter(Boolean);
  return parts.length > 2 ? `…\\${parts.slice(-2).join('\\')}` : full;
}

function updateHarnessWorkspaceButton(card) {
  const workspace = card?.querySelector('.harness-workspace');
  if (!workspace) return;
  workspace.textContent = `📁 ${compactHarnessPath(state.harness.workspace)}`;
  workspace.title = state.harness.workspace || '选择工作目录';
}

function openHarnessQuickActions(card) {
  card.classList.add('harness-actions-open');
  card.querySelector('.harness-title-trigger')?.setAttribute('aria-expanded', 'true');
}

function closeHarnessQuickActions(card) {
  if (!card) return;
  card.classList.remove('harness-actions-open', 'harness-history-open');
  card.querySelector('.harness-title-trigger')?.setAttribute('aria-expanded', 'false');
  updateHarnessWorkspaceButton(card);
}

document.addEventListener('pointerdown', (event) => {
  const card = toolsCards?.querySelector('.harness-card.harness-actions-open');
  if (!card || event.target.closest('.harness-title-trigger, .harness-quick-actions, .harness-session-list')) return;
  closeHarnessQuickActions(card);
});
document.addEventListener('pointerdown', (event) => {
  const options = toolsCards?.querySelector('.harness-run-options.open');
  if (!options || event.target.closest('.harness-run-options')) return;
  closeHarnessRunOptions(options);
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  closeHarnessQuickActions(toolsCards?.querySelector('.harness-card'));
  closeHarnessRunOptions(toolsCards?.querySelector('.harness-run-options'));
});

function closeHarnessRunOptions(options) {
  if (!options) return;
  options.classList.remove('open');
  options.querySelector('.harness-options-trigger')?.setAttribute('aria-expanded', 'false');
}

function closeSettingsSelect(wrapper) {
  if (!wrapper) return;
  wrapper.classList.remove('open');
  wrapper.querySelector('.settings-select-trigger')?.setAttribute('aria-expanded', 'false');
  wrapper.querySelector('.combo-dropdown')?.classList.add('hidden');
}

function syncSettingsSelects() {
  document.querySelectorAll('.settings-select').forEach(wrapper => {
    const select = wrapper.querySelector('select');
    const selected = select?.selectedOptions[0];
    const trigger = wrapper.querySelector('.settings-select-trigger');
    if (trigger) trigger.textContent = selected?.textContent || '';
    wrapper.querySelectorAll('.settings-select-option').forEach(option => {
      option.setAttribute('aria-selected', String(option.dataset.value === select?.value));
    });
  });
}

function initializeSettingsSelects() {
  settingsOverlay.querySelectorAll('.settings-card select').forEach((select, index) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'settings-select';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'settings-select-trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', select.previousElementSibling?.textContent?.trim() || '选择选项');
    const menu = document.createElement('div');
    menu.id = `settings-select-menu-${index}`;
    menu.className = 'combo-dropdown settings-select-menu hidden';
    menu.setAttribute('role', 'listbox');
    trigger.setAttribute('aria-controls', menu.id);

    [...select.options].forEach(option => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'combo-dropdown-item settings-select-option';
      item.dataset.value = option.value;
      item.textContent = option.textContent;
      item.setAttribute('role', 'option');
      item.addEventListener('click', () => {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        syncSettingsSelects();
        closeSettingsSelect(wrapper);
        trigger.focus({ preventScroll: true });
      });
      menu.appendChild(item);
    });

    select.before(wrapper);
    select.classList.add('settings-native-select');
    select.addEventListener('change', syncSettingsSelects);
    wrapper.append(select, trigger, menu);

    const open = () => {
      document.querySelectorAll('.settings-select.open').forEach(other => {
        if (other !== wrapper) closeSettingsSelect(other);
      });
      wrapper.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      menu.classList.remove('hidden', 'open-up');
      const triggerRect = trigger.getBoundingClientRect();
      const bodyRect = $('.settings-body').getBoundingClientRect();
      if (bodyRect.bottom - triggerRect.bottom < menu.scrollHeight + 4) menu.classList.add('open-up');
    };
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      if (wrapper.classList.contains('open')) closeSettingsSelect(wrapper);
      else open();
    });
    trigger.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      if (!wrapper.classList.contains('open')) open();
      const items = [...menu.querySelectorAll('.settings-select-option')];
      const selectedIndex = Math.max(0, items.findIndex(item => item.dataset.value === select.value));
      items[event.key === 'ArrowDown' ? selectedIndex : Math.max(0, selectedIndex - 1)]?.focus();
    });
    menu.addEventListener('keydown', (event) => {
      const items = [...menu.querySelectorAll('.settings-select-option')];
      const current = items.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSettingsSelect(wrapper);
        trigger.focus({ preventScroll: true });
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const offset = event.key === 'ArrowDown' ? 1 : -1;
        items[(current + offset + items.length) % items.length]?.focus();
      }
    });
    wrapper.addEventListener('focusout', () => {
      setTimeout(() => {
        if (!wrapper.contains(document.activeElement)) closeSettingsSelect(wrapper);
      });
    });
  });
  document.addEventListener('click', () => {
    document.querySelectorAll('.settings-select.open').forEach(closeSettingsSelect);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') document.querySelectorAll('.settings-select.open').forEach(closeSettingsSelect);
  });
  syncSettingsSelects();
}

// 转义 HTML 特殊字符，避免 Harness 输出中的 <>& 被当作标签注入
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 行内格式：`code`、**加粗**、*斜体*、~~删除线~~、[链接](url)
// 输入必须是已 HTML 转义过的文本
function renderInline(text) {
  const protectedTokens = [];
  const protect = (html) => {
    const index = protectedTokens.length;
    protectedTokens.push(html);
    return `\u0000${index}\u0000`;
  };

  let out = text.replace(/`([^`\n]+)`/g, (match, code) => protect(`<code>${code}</code>`));
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => protect(`<img src="${src}" alt="${alt}">`));

  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  return out.replace(/\u0000(\d+)\u0000/g, (match, index) => protectedTokens[+index]);
}

// 轻量 Markdown 渲染：标题、代码块、列表、引用、水平线、段落 + 行内格式
function renderMarkdown(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = [];
  let para = [];
  let listType = null;
  let listItems = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${renderInline(escapeHtml(para.join('\n')))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (listItems.length) {
      out.push(`<${listType}>${listItems.join('')}</${listType}>`);
      listItems = [];
    }
    listType = null;
  };
  const flushAll = () => { flushPara(); flushList(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 围栏代码块 ``` 或 ~~~
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*(.*)$/);
    if (fence) {
      flushAll();
      const marker = fence[1][0];
      const length = fence[1].length;
      const lang = escapeHtml(fence[2].trim());
      const codeLines = [];
      i++;
      while (i < lines.length) {
        if (new RegExp(`^\\s*${marker}{${length},}\\s*$`).test(lines[i])) break;
        codeLines.push(lines[i]);
        i++;
      }
      out.push(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${escapeHtml(codeLines.join('\n'))}\n</code></pre>`);
      continue;
    }

    // 水平线 --- / *** / ___
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushAll();
      out.push('<hr>');
      continue;
    }

    // 标题 # ~ ######
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(escapeHtml(heading[2].trim()))}</h${level}>`);
      continue;
    }

    // 无序列表 - * +
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (listType !== 'ul') { flushList(); listType = 'ul'; }
      listItems.push(`<li>${renderInline(escapeHtml(ul[1]))}</li>`);
      continue;
    }

    // 有序列表 1. 2)
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (listType !== 'ol') { flushList(); listType = 'ol'; }
      listItems.push(`<li>${renderInline(escapeHtml(ol[1]))}</li>`);
      continue;
    }

    // 引用 >
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushAll();
      const quoteLines = [quote[1]];
      while (i + 1 < lines.length && /^\s*>\s?/.test(lines[i + 1])) {
        i++;
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
      }
      out.push(`<blockquote>${renderMarkdown(quoteLines.join('\n'))}</blockquote>`);
      continue;
    }

    // 空行
    if (!line.trim()) {
      flushAll();
      continue;
    }

    // 普通段落
    flushList();
    para.push(line);
  }

  flushAll();
  return out.join('');
}

function buildHarnessMessageRow(message) {
  const row = document.createElement('div');
  row.className = `harness-message ${message.role}${message.failed ? ' failed' : ''}`;
  const label = document.createElement('span');
  label.className = 'harness-message-label';
  label.textContent = message.role === 'user' ? '你' : message.role === 'assistant' ? 'Harness' : message.role === 'tool' ? '·' : '!';
  let body;
  if (message.role === 'tool') {
    body = document.createElement('details');
    body.className = 'harness-message-body harness-tool-detail';
    const summary = document.createElement('summary');
    summary.textContent = `${message.text} · ${message.pending ? '执行中' : message.failed ? '失败' : '完成'}`;
    body.appendChild(summary);
    if (message.detail) {
      const args = document.createElement('pre');
      args.textContent = message.detail;
      body.appendChild(args);
    }
    if (message.output) {
      const output = document.createElement('pre');
      output.textContent = message.output;
      body.appendChild(output);
    }
  } else {
    body = document.createElement('div');
    const markdown = message.role === 'assistant';
    body.className = 'harness-message-body' + (markdown ? ' harness-markdown' : '');
    if (markdown) {
      body.innerHTML = renderMarkdown(message.text);
    } else {
      body.textContent = message.text;
    }
  }
  if (message.role !== 'user' && message.role !== 'assistant') row.appendChild(label);
  row.appendChild(body);
  return row;
}

function appendHarnessMessages(container, messages, toolGroupOpen) {
  let toolGroup = null;
  for (const message of messages) {
    if (message.role === 'tool' && !toolGroup) {
      const group = document.createElement('details');
      group.className = 'harness-tool-group';
      group.open = toolGroupOpen;
      const summary = document.createElement('summary');
      const body = document.createElement('div');
      body.className = 'harness-tool-group-body';
      group.append(summary, body);
      container.appendChild(group);
      toolGroup = { summary, body, count: 0, failed: 0, pending: 0 };
    } else if (message.role !== 'tool') {
      toolGroup = null;
    }
    const row = buildHarnessMessageRow(message);
    if (message.role === 'tool' && toolGroup) {
      toolGroup.count++;
      if (message.failed) toolGroup.failed++;
      if (message.pending) toolGroup.pending++;
      const suffix = toolGroup.pending ? '执行中' : toolGroup.failed ? `${toolGroup.failed} 项失败` : '已完成';
      toolGroup.summary.textContent = `执行过程 · ${toolGroup.count} 项 · ${suffix}`;
      toolGroup.body.appendChild(row);
    } else {
      container.appendChild(row);
    }
  }
}

// 判断每条消息是否属于「执行过程」内容：
// - tool(工具调用/子任务)一定是过程；
// - assistant 在其所在「轮」(两条相邻 user 消息之间)里，只有最后一条是最终答复，更早的都是中间输出(过程)。
// 用户消息、报错永远不是过程。
function computeProcessFolds(messages) {
  const folds = messages.map(m => m.role === 'tool');
  let turnStart = 0;
  for (let i = 0; i <= messages.length; i++) {
    if (i === messages.length || messages[i].role === 'user') {
      // 在 [turnStart, i) 内找最后一条 assistant 作为最终答复；更早的 assistant 记为过程
      for (let j = i - 1; j >= turnStart; j--) {
        if (messages[j].role === 'assistant') {
          for (let k = turnStart; k < j; k++) {
            if (messages[k].role === 'assistant') folds[k] = true;
          }
          break;
        }
      }
      turnStart = i + 1;
    }
  }
  return folds;
}

function renderHarnessHistory(card) {
  const history = card.querySelector('.harness-history');
  history.innerHTML = '';
  const messages = state.harness.messages;
  const isEmpty = messages.length === 0;
  history.classList.toggle('harness-empty-state', isEmpty);
  if (isEmpty) {
    const empty = document.createElement('div');
    empty.className = 'harness-empty';
    const icon = document.createElement('img');
    icon.className = 'harness-empty-icon';
    icon.src = 'deepseek-whale.png';
    icon.alt = '';
    icon.setAttribute('aria-hidden', 'true');
    empty.append(icon);
    if (state.harness.configError) {
      const error = document.createElement('span');
      error.className = 'harness-empty-error';
      error.textContent = state.harness.configError;
      empty.appendChild(error);
    }
    history.appendChild(empty);
    return;
  }

  // 完成后：把「过程内容」折叠成可展开的组，用户消息、报错、每轮的最终答复保持可见
  if (state.harness.status === 'completed') {
    const folds = computeProcessFolds(messages);
    let processGroup = null;
    const flushProcessGroup = () => {
      if (processGroup) {
        processGroup.summary.textContent = `执行过程 · ${processGroup.count} 项`;
        processGroup = null;
      }
    };
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const fold = folds[i];
      if (!fold) flushProcessGroup();
      if (fold && !processGroup) {
        const group = document.createElement('details');
        group.className = 'harness-process-group';
        group.open = false;
        const summary = document.createElement('summary');
        const body = document.createElement('div');
        body.className = 'harness-process-body';
        group.append(summary, body);
        history.appendChild(group);
        processGroup = { summary, body, count: 0 };
      }
      const row = buildHarnessMessageRow(message);
      if (fold && processGroup) {
        processGroup.count++;
        processGroup.body.appendChild(row);
      } else {
        history.appendChild(row);
      }
    }
    flushProcessGroup();
  } else {
    appendHarnessMessages(history, messages, state.harness.toolGroupExpanded);
  }
  history.scrollTop = history.scrollHeight;
}

function renderHarnessSessions(card) {
  const list = card.querySelector('.harness-session-list');
  if (!list) return;
  list.innerHTML = '';
  for (const session of state.harness.sessions) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'harness-session-item';
    item.dataset.sessionId = session.id;
    item.textContent = session.title;
    item.classList.toggle('selected', session.id === state.harness.sessionId);
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(session.id === state.harness.sessionId));
    item.addEventListener('click', () => {
      closeHarnessQuickActions(card);
      loadHarnessSession(session.id);
    });
    list.appendChild(item);
  }
}

// 待办区:默认折叠为一行摘要,点击展开完整列表
// 展开时列表多占的高度从任务框(history)里扣除,保证卡片总高度不变
const HARNESS_TODOS_LIST_MAX = 132; // 展开列表最大高度(px),超出部分内部滚动
const HARNESS_HISTORY_MIN = 120;    // 任务框最低高度(px),低于此值不再压缩

function renderHarnessTodos(card) {
  const container = card.querySelector('.harness-todos');
  const expanded = state.harness.todosExpanded && state.harness.todos.length > 0;
  // 记录上一次展开态,判断本次是否为用户主动切换(仅切换时播放展开/收起动画)
  const wasExpanded = container.dataset.expanded === '1';
  container.dataset.expanded = expanded ? '1' : '0';
  const toggling = wasExpanded !== expanded;

  container.innerHTML = '';
  container.classList.toggle('hidden', state.harness.todos.length === 0);
  container.classList.toggle('harness-todos-open', expanded);
  if (state.harness.todos.length === 0) {
    syncHarnessTodosHeight(card);
    return;
  }

  // 折叠摘要行:显示待办数量,点击展开/收起
  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'harness-todos-summary';
  summary.setAttribute('aria-expanded', String(expanded));
  const count = document.createElement('span');
  count.className = 'harness-todos-count';
  count.textContent = `待办 · ${state.harness.todos.length}`;
  const chevron = document.createElement('span');
  chevron.className = 'harness-todos-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '▾';
  summary.append(count, chevron);
  summary.addEventListener('click', () => {
    state.harness.todosExpanded = !state.harness.todosExpanded;
    renderHarnessTodos(card);
  });
  container.appendChild(summary);

  // 待办列表
  const list = document.createElement('div');
  list.className = 'harness-todos-list';
  for (const todo of state.harness.todos) {
    const row = document.createElement('div');
    row.className = `harness-todo ${todo.status}`;
    const mark = todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : '○';
    row.textContent = `${mark} ${todo.content}`;
    list.appendChild(row);
  }
  container.appendChild(list);

  // 在动画钉住列表高度前先量出内容高度(高度 0 时 scrollHeight 会失真),供高度补偿使用
  const naturalListHeight = Math.min(list.scrollHeight, HARNESS_TODOS_LIST_MAX);
  container.dataset.listHeight = String(naturalListHeight); // 存一份,动画期间外部同步也能拿到正确值

  // 切换时播放高度动画,其余更新(运行中状态刷新)直接定格
  if (toggling) animateHarnessTodosList(list, expanded);
  else list.hidden = !expanded;

  syncHarnessTodosHeight(card, naturalListHeight);
}

// 待办列表高度动画:展开 0→实际高度,收起 实际高度→0
function animateHarnessTodosList(list, expanded) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    list.hidden = !expanded;
    return;
  }
  const target = Math.min(list.scrollHeight, HARNESS_TODOS_LIST_MAX);
  const from = expanded ? 0 : target;
  list.style.height = from + 'px';
  list.style.overflow = 'hidden';
  if (!expanded) list.hidden = false;
  list.getBoundingClientRect(); // 强制回流,确保起始高度生效
  const anim = list.animate(
    [{ height: `${from}px` }, { height: `${target}px` }],
    { duration: 300, easing: 'ease' }
  );
  anim.onfinish = () => {
    list.style.height = '';
    list.style.overflow = '';
    if (!expanded) list.hidden = true;
  };
}

// 待办区高度变化时从任务框高度里扣除,与输入框压缩/文件变更共用同一基准,卡片总高不变
// measuredListHeight: 可选,由调用方传入展开列表内容高度(动画钉住高度时外部测量更可靠)
function syncHarnessTodosHeight(card, measuredListHeight) {
  const history = card?.querySelector('.harness-history');
  const container = card?.querySelector('.harness-todos');
  if (!history || !container) return;
  let listHeight = 0;
  if (state.harness.todos.length > 0 && state.harness.todosExpanded) {
    if (measuredListHeight !== undefined) {
      listHeight = measuredListHeight;
    } else {
      // 优先用最近一次渲染时量出的内容高度(动画期间 scrollHeight 会失真)
      const stored = parseFloat(container.dataset.listHeight);
      listHeight = Number.isFinite(stored) ? stored : 0;
      if (listHeight === 0) {
        const list = container.querySelector('.harness-todos-list');
        if (list) listHeight = Math.min(list.scrollHeight, HARNESS_TODOS_LIST_MAX);
      }
    }
    // 折叠时待办区只有摘要行,展开后还多出摘要与列表之间的 gap,需一并从任务框扣除
    const gap = parseFloat(getComputedStyle(container).gap) || 0;
    listHeight += gap;
  }
  const base = parseFloat(getComputedStyle(card).getPropertyValue('--harness-history-base')) || 249;
  const target = Math.max(HARNESS_HISTORY_MIN, base - listHeight);
  if (listHeight === 0) {
    // 折叠/无待办:交给 CSS 状态规则,不残留内联高度
    history.style.height = '';
    history.style.minHeight = '';
    history.style.maxHeight = '';
  } else {
    history.style.height = target + 'px';
    history.style.minHeight = target + 'px';
    history.style.maxHeight = target + 'px';
  }
}

function renderHarnessDiffs(card) {
  const details = card.querySelector('.harness-artifacts');
  const hasDiffs = state.harness.diffs.length > 0;
  details.classList.toggle('hidden', !hasDiffs);
  card.classList.toggle('has-diffs', hasDiffs);
  details.querySelector('summary').textContent = `文件变更 · ${new Set(state.harness.diffs.map(diff => diff.path)).size}`;
  const body = details.querySelector('.harness-artifacts-body');
  body.innerHTML = '';
  for (const diff of state.harness.diffs) {
    const section = document.createElement('section');
    section.className = 'harness-diff';
    const title = document.createElement('div');
    title.className = 'harness-diff-path';
    title.textContent = diff.path;
    const content = document.createElement('pre');
    const oldText = diff.oldText === null ? '' : diff.oldText.split('\n').map(line => `- ${line}`).join('\n');
    const newText = diff.newText.split('\n').map(line => `+ ${line}`).join('\n');
    content.textContent = [oldText, newText].filter(Boolean).join('\n');
    section.append(title, content);
    body.appendChild(section);
  }
}

function updateHarnessCard() {
  const card = toolsCards?.querySelector('[data-tool="harness"]');
  if (!card) return;
  const busy = ['starting', 'running', 'stopping'].includes(state.harness.status);
  updateHarnessStatusBadge();
  syncHarnessStatusTimer();
  const workspace = card.querySelector('.harness-workspace');
  updateHarnessWorkspaceButton(card);
  card.querySelector('.harness-input').disabled = busy || !state.harness.configured;
  syncHarnessInputCompact(card);
  const runButton = card.querySelector('.harness-run-stop-btn');
  runButton.disabled = !state.harness.configured && !busy;
  runButton.classList.toggle('harness-running', busy);
  runButton.querySelector('.harness-run-stop-icon').textContent = busy ? '' : '▶';
  runButton.querySelector('.harness-run-stop-label').textContent = busy ? '停止' : '运行';
  card.querySelector('.harness-new-btn').disabled = busy;
  const model = state.harness.model === 'deepseek-v4-pro' ? 'Pro' : 'Flash';
  const effort = ['off', 'max'].includes(state.harness.reasoningEffort) ? state.harness.reasoningEffort : 'high';
  const optionsTrigger = card.querySelector('.harness-options-trigger');
  optionsTrigger.textContent = `${model}-${effort[0].toUpperCase()}${effort.slice(1)}`;
  optionsTrigger.disabled = busy;
  card.querySelectorAll('.harness-option-choices button').forEach(button => {
    const selected = button.dataset.kind === 'model'
      ? button.dataset.value === state.harness.model
      : button.dataset.value === effort;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.disabled = busy;
  });
  card.querySelectorAll('.harness-option-choices').forEach(choices => {
    const buttons = [...choices.querySelectorAll('button')];
    const selectedIndex = Math.max(0, buttons.findIndex(button => button.classList.contains('selected')));
    choices.style.setProperty('--option-count', buttons.length);
    choices.style.setProperty('--option-index', selectedIndex);
  });
  if (busy) closeHarnessRunOptions(card.querySelector('.harness-run-options'));
  card.querySelector('.harness-workspace').disabled = busy;
  card.querySelector('.harness-history-btn').disabled = busy || state.harness.sessions.length === 0;
  renderHarnessSessions(card);
  renderHarnessTodos(card);
  renderHarnessHistory(card);
  renderHarnessDiffs(card);
  syncHarnessTodosHeight(card); // 文件变更/输入框压缩态变化后,按最新基准重算待办补偿
}

let harnessOptionsRequestSeq = 0;
async function updateHarnessRunOptions(card, model, reasoningEffort) {
  const requestSeq = ++harnessOptionsRequestSeq;
  state.harness.model = model;
  state.harness.reasoningEffort = reasoningEffort;
  updateHarnessCard();
  if (!window.electronAPI?.harnessUpdateOptions) {
    return;
  }
  try {
    const result = await window.electronAPI.harnessUpdateOptions({ model, reasoningEffort });
    if (requestSeq !== harnessOptionsRequestSeq) return;
    if (!result?.success) throw new Error(result?.error || '保存 Harness 选项失败');
    state.harness.model = result.model;
    state.harness.reasoningEffort = result.reasoningEffort;
  } catch (error) {
    if (requestSeq === harnessOptionsRequestSeq) await refreshHarnessSnapshot();
  } finally {
    if (requestSeq === harnessOptionsRequestSeq) updateHarnessCard();
  }
}

async function selectHarnessWorkspace() {
  if (!window.electronAPI?.harnessSelectWorkspace) return;
  const result = await window.electronAPI.harnessSelectWorkspace();
  if (result?.success) {
    state.harness.workspace = result.workspace;
    await refreshHarnessSnapshot();
    state.harness.sessionId = null;
    state.harness.sessionTitle = '';
    state.harness.messages = [];
    state.harness.todos = [];
    state.harness.diffs = [];
    state.harness.runStartedAt = null;
    state.harness.runElapsedMs = null;
    state.harness.runTokens = null;
    await refreshHarnessSessions(true);
  }
}

async function submitHarnessTask(card) {
  const input = card.querySelector('.harness-input');
  const text = input.value.trim();
  if (!text || !window.electronAPI?.harnessStart) return;
  const result = await window.electronAPI.harnessStart({ text, sessionId: state.harness.sessionId });
  if (result?.success) {
    state.harness.sessionId = result.sessionId;
    state.harness.status = 'starting';
    state.harness.toolGroupExpanded = true;
    state.harness.runStartedAt = Date.now();
    state.harness.runElapsedMs = null;
    state.harness.runTokens = null;
    addHarnessMessage('user', text);
    input.value = '';
  } else if (!result?.cancelled) {
    addHarnessMessage('error', result?.error || '无法启动 Harness');
    state.harness.status = 'error';
    state.harness.toolGroupExpanded = false;
  }
  updateHarnessCard();
}

async function stopHarnessTask() {
  if (!window.electronAPI?.harnessStop) return;
  state.harness.status = 'stopping';
  updateHarnessCard();
  await window.electronAPI.harnessStop();
}

async function newHarnessSession() {
  if (!window.electronAPI?.harnessNewSession) return;
  const result = await window.electronAPI.harnessNewSession();
  if (!result?.success) return;
  state.harness.sessionId = null;
  state.harness.status = 'idle';
  state.harness.toolGroupExpanded = false;
  state.harness.error = null;
  state.harness.messages = [];
  state.harness.todos = [];
  state.harness.diffs = [];
  state.harness.sessionTitle = '';
  state.harness.runStartedAt = null;
  state.harness.runElapsedMs = null;
  state.harness.runTokens = null;
  updateHarnessCard();
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
  // 日历状态切页:不播关闭动画,日历随任务页直接右滑;切回任务页时由 switchToMain 保持状态
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
  // 日历状态切页保持:切回任务页时保留上次视图(日历/选中日期/当日模式),与隐藏再显示一致
  if (window.electronAPI) window.electronAPI.setPage('main');
  pagesContainer.classList.remove('on-notepad', 'on-tools');
  setTimeout(() => textInput.focus(), 400);
}

async function switchToTools() {
  if (state.currentPage === 'tools') return;
  if (!isToolsPageEnabled()) return;
  // 日历状态切页:不播关闭动画,日历随任务页直接右滑(同 switchToNotepad)
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
  clearNoteSearchStatus();
  state.noteSearch = null;
  noteSearchInput.focus();
}

function closeNoteSearch() {
  const wasOpen = !noteSearchBar.classList.contains('hidden');
  noteSearchBar.classList.add('hidden');
  clearNoteSearchStatus();
  if (wasOpen) clearNoteSearchMarks();
  state.noteSearch = null;
}

function clearNoteSearchStatus() {
  noteSearchStatus.textContent = '';
  noteSearchStatus.classList.remove('noresult');
}

function clearNoteSearchMarks() {
  notepadTextarea.querySelectorAll('mark').forEach(m => m.replaceWith(document.createTextNode(m.textContent)));
}

function doNoteSearch() {
  const query = noteSearchInput.value.trim().toLowerCase();
  clearNoteSearchMarks();
  clearNoteSearchStatus();
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
            cacheImageData(result.filename, dataUrl);
            insertImageAtCursor(result.filename);
          }
        }
      } catch (e) { /* ignore */ }
    }
  }
}

async function handleNotepadCopy(e) {
  // 只处理来自记事本编辑区的复制
  if (!notepadTextarea.contains(window.getSelection()?.anchorNode)) return;

  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return;

  const fragment = range.cloneContents();
  const container = document.createElement('div');
  container.appendChild(fragment);

  for (const img of container.querySelectorAll('img[src^="note-image://"]')) {
    const url = img.getAttribute('src');
    const relativePath = url.replace('note-image://', '');
    // 缓存未命中时回读磁盘(不再长期把 Base64 存 DOM 属性)
    let b64 = imageDataCache.get(relativePath);
    if (!b64 && window.electronAPI) {
      try { b64 = await window.electronAPI.readNoteImage(relativePath); } catch (err) { b64 = null; }
    }
    if (b64) img.src = b64;
  }

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
