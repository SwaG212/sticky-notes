const path = require('path');
const { app, BrowserWindow } = require('electron');

let win = null;
let pass = 0;
let fail = 0;
let timeout = null;

function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('✅ ' + name);
  } else {
    fail += 1;
    console.log('❌ ' + name + (detail ? '：' + detail : ''));
  }
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

async function runInPage(fn, ...args) {
  const argText = args.map((arg) => JSON.stringify(arg)).join(', ');
  const script = '(' + fn.toString() + ')(' + argText + ')';
  return await win.webContents.executeJavaScript(script, true);
}

async function finish(code) {
  if (timeout) {
    clearTimeout(timeout);
  }
  console.log('通过 ' + pass + ' 失败 ' + fail);
  app.exit(code);
}

async function run() {
  timeout = setTimeout(() => {
    console.error('❌ 测试超时');
    app.exit(1);
  }, 90000);

  win = new BrowserWindow({
    show: true,
    width: 360,
    height: 500,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true
    }
  });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 300));

  const m1 = await runInPage(async function () {
    const q = (sel) => document.querySelector(sel);
    const tabs = Array.from(document.querySelectorAll('#monitor-filters .monitor-filter-tab'));
    const overlay = q('#monitor-expand-overlay');
    return {
      pageMonitor: !!q('.page-monitor'),
      list: !!q('#monitor-list'),
      filters: !!q('#monitor-filters'),
      tabCount: tabs.length,
      tabFilters: tabs.map((tab) => tab.getAttribute('data-filter')),
      back: !!q('#btn-monitor-back'),
      forward: !!q('#btn-monitor-forward'),
      overlayHidden: !!overlay && overlay.classList.contains('hidden'),
      pageOrderList: !!q('#page-order-list'),
      pageOrderReset: !!q('#btn-page-order-reset'),
      settingsMonitorPage: !!q('#settings-monitor-page')
    };
  });

  check('M1 .page-monitor 存在', m1.pageMonitor);
  check('M1 #monitor-list 存在', m1.list);
  check('M1 #monitor-filters 存在', m1.filters);
  check('M1 筛选 tab 数量为 4', m1.tabCount === 4, '实际 ' + m1.tabCount);
  check('M1 筛选 tab data-filter 正确', arraysEqual(m1.tabFilters, ['all', 'running', 'waiting', 'completed']), JSON.stringify(m1.tabFilters));
  check('M1 #btn-monitor-back 存在', m1.back);
  check('M1 #btn-monitor-forward 存在', m1.forward);
  check('M1 #monitor-expand-overlay 初始 hidden', m1.overlayHidden);
  check('M1 #page-order-list 存在', m1.pageOrderList);
  check('M1 #btn-page-order-reset 存在', m1.pageOrderReset);
  check('M1 #settings-monitor-page 存在', m1.settingsMonitorPage);

  const m2 = await runInPage(async function () {
    const container = document.querySelector('.pages-container');
    const pages = Array.from(document.querySelectorAll('.page'));
    const widths = pages.map((page) => page.offsetWidth);
    return {
      pageCount: pages.length,
      containerWidth: container ? container.offsetWidth : 0,
      pageWidths: widths
    };
  });

  check('M2 .page 数量为 4', m2.pageCount === 4, '实际 ' + m2.pageCount);
  const allPageWidthEqual = m2.pageWidths.length > 0 && m2.pageWidths.every((w) => Math.abs(w - m2.pageWidths[0]) <= 1);
  check('M2 四个 .page 等宽', allPageWidthEqual, JSON.stringify(m2.pageWidths));
  const firstPageWidth = m2.pageWidths[0] || 0;
  check('M2 pages-container 宽度约为 4× 单页宽', Math.abs(m2.containerWidth - firstPageWidth * 4) <= 2, '容器 ' + m2.containerWidth + '，单页 ' + firstPageWidth);

  const m3 = await runInPage(async function () {
    const now = Date.now();
    const makeMuseTask = (id, status, model, progress, text) => ({
      id: id,
      task: text,
      text: text,
      content: text,
      title: text,
      source: 'muse',
      model: model,
      progress: progress,
      status: status,
      completed: status === 'completed',
      createdAt: new Date(now - 3600000).toISOString(),
      created_at: new Date(now - 3600000).toISOString(),
      completedAt: status === 'completed' ? new Date(now - 1800000).toISOString() : null,
      startedAt: now - 1800000,
      started_at: now - 1800000,
      runStartedAt: now - 1800000,
      run_started_at: now - 1800000,
      updatedAt: now - 600000
    });

    state.tasks = [
      makeMuseTask('m3-running', 'running', 'Sol', 60, '整理监控台卡片布局'),
      makeMuseTask('m3-waiting', 'waiting', 'Muse', 0, '等待 Muse 生成样式'),
      makeMuseTask('m3-completed', 'completed', 'DeepSeek', 100, '完成同步机制检查'),
      {
        id: 'm3-local',
        task: '本地普通任务',
        text: '本地普通任务',
        content: '本地普通任务',
        title: '本地普通任务',
        source: 'local',
        model: '',
        progress: 0,
        status: 'waiting',
        createdAt: new Date(now).toISOString(),
        created_at: new Date(now).toISOString()
      }
    ];

    switchToMonitor();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const countCards = () => document.querySelectorAll('#monitor-list .monitor-task').length;
    const getCount = (filter) => {
      const el = document.querySelector('.monitor-filter-tab[data-filter="' + filter + '"] .monitor-filter-count');
      return el ? (parseInt(el.textContent, 10) || 0) : -1;
    };

    const allCards = countCards();
    const runningCountText = (document.querySelector('#monitor-running-count') || {}).textContent || '';
    const counts = {
      all: getCount('all'),
      running: getCount('running'),
      waiting: getCount('waiting'),
      completed: getCount('completed')
    };

    document.querySelector('.monitor-filter-tab[data-filter="running"]').click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const runningCards = countCards();

    document.querySelector('.monitor-filter-tab[data-filter="all"]').click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const restoredCards = countCards();

    return {
      allCards: allCards,
      runningCountText: runningCountText,
      counts: counts,
      runningCards: runningCards,
      restoredCards: restoredCards
    };
  });

  check('M3 仅渲染 Muse 任务卡 3 张', m3.allCards === 3, '实际 ' + m3.allCards);
  check('M3 运行中计数含 1', m3.runningCountText.indexOf('1') >= 0, JSON.stringify(m3.runningCountText));
  check('M3 全部计数为 3', m3.counts.all === 3, '实际 ' + m3.counts.all);
  check('M3 进行中计数为 1', m3.counts.running === 1, '实际 ' + m3.counts.running);
  check('M3 等待中计数为 1', m3.counts.waiting === 1, '实际 ' + m3.counts.waiting);
  check('M3 已完成计数为 1', m3.counts.completed === 1, '实际 ' + m3.counts.completed);
  check('M3 点击“进行中”后只剩 1 张卡', m3.runningCards === 1, '实际 ' + m3.runningCards);
  check('M3 点击“全部”恢复 3 张卡', m3.restoredCards === 3, '实际 ' + m3.restoredCards);

  const m4 = await runInPage(async function () {
    const card = document.querySelector('#monitor-list .monitor-task');
    if (!card) {
      return { found: false };
    }
    const text = card.textContent || '';
    const metaLines = Array.from(card.querySelectorAll('.monitor-meta-line')).map((line) => (line.textContent || '').trim());
    const metaText = (card.querySelector('.monitor-meta') || {}).textContent || '';
    return {
      found: true,
      text: text,
      status: (card.querySelector('.monitor-status') || {}).textContent || '',
      model: (card.querySelector('.monitor-model') || {}).textContent || '',
      progress: (card.querySelector('.monitor-progress-value') || {}).textContent || '',
      metaLines: metaLines,
      metaText: metaText
    };
  });

  check('M4 第一张卡存在', m4.found);
  if (m4.found) {
    check('M4 第一张卡含任务文字', m4.text.indexOf('整理监控台卡片布局') >= 0);
    check('M4 第一张卡状态文字为“运行中”', m4.status.indexOf('运行中') >= 0, JSON.stringify(m4.status));
    check('M4 第一张卡模型文字为“Sol”', m4.model.indexOf('Sol') >= 0, JSON.stringify(m4.model));
    check('M4 第一张卡进度为“60%”', m4.progress.indexOf('60%') >= 0, JSON.stringify(m4.progress));
    check('M4 第一张卡创建时间与运行时间非空且不为“—”', m4.metaLines.length >= 2 && m4.metaLines.every((line) => line && line !== '—'), JSON.stringify(m4.metaLines));
    check('M4 第一张卡 meta 含创建与运行', m4.metaText.indexOf('创建') >= 0 && m4.metaText.indexOf('运行') >= 0, JSON.stringify(m4.metaText));
  }

  const m5 = await runInPage(async function () {
    const card = document.querySelector('#monitor-list .monitor-task');
    if (!card) {
      return { found: false };
    }

    card.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const overlay = document.querySelector('#monitor-expand-overlay');
    const pageMonitor = document.querySelector('.page-monitor');
    const opened = {
      notHidden: !!overlay && !overlay.classList.contains('hidden'),
      expandedId: state.monitorExpandedId,
      pageExpanded: !!pageMonitor && pageMonitor.classList.contains('monitor-expanded'),
      overlayOpen: !!overlay && overlay.classList.contains('open')
    };

    // D1 回归：等展开动画（260ms）+ 内联样式清除（280ms）结束后再量几何尺寸
    await new Promise((resolve) => setTimeout(resolve, 420));
    const rect = overlay ? overlay.getBoundingClientRect() : null;
    const geometry = {
      width: rect ? rect.width : 0,
      height: rect ? rect.height : 0,
      inlineLeft: overlay ? overlay.style.left : '',
      inlineTop: overlay ? overlay.style.top : '',
      inlineWidth: overlay ? overlay.style.width : '',
      inlineHeight: overlay ? overlay.style.height : ''
    };

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 320));

    const closed = {
      hidden: !!overlay && overlay.classList.contains('hidden'),
      expandedId: state.monitorExpandedId,
      pageExpanded: !!pageMonitor && pageMonitor.classList.contains('monitor-expanded')
    };

    return { found: true, opened: opened, geometry: geometry, closed: closed };
  });

  check('M5 点击第一张卡后展开', m5.found && m5.opened.notHidden);
  check('M5 展开后 state.monitorExpandedId 有值', m5.found && m5.opened.expandedId !== null && m5.opened.expandedId !== undefined, m5.found ? String(m5.opened.expandedId) : '未找到卡片');
  check('M5 展开后 .page-monitor 含 monitor-expanded 类', m5.found && m5.opened.pageExpanded);
  check('M5 展开后 overlay 含 open 类', m5.found && m5.opened.overlayOpen);
  check('M5 Esc 后 overlay 重新 hidden', m5.found && m5.closed.hidden);
  check('M5 Esc 后 state.monitorExpandedId 为 null', m5.found && m5.closed.expandedId === null, m5.found ? String(m5.closed.expandedId) : '未找到卡片');
  check('M5 Esc 后移除 monitor-expanded 类', m5.found && !m5.closed.pageExpanded);
  check('M5 展开后覆盖层接近满窗（宽≥330）', m5.found && m5.geometry.width >= 330, m5.found ? ('宽 ' + m5.geometry.width + '，高 ' + m5.geometry.height) : '未找到卡片');
  check('M5 展开后覆盖层接近满窗（高≥420）', m5.found && m5.geometry.height >= 420, m5.found ? ('宽 ' + m5.geometry.width + '，高 ' + m5.geometry.height) : '未找到卡片');
  check('M5 展开后内联 left/top/width/height 已清除', m5.found && !m5.geometry.inlineLeft && !m5.geometry.inlineTop && !m5.geometry.inlineWidth && !m5.geometry.inlineHeight, m5.found ? JSON.stringify(m5.geometry) : '未找到卡片');

  const m6 = await runInPage(async function () {
    state.pageOrder = ['monitor', 'main', 'notepad', 'tools'];
    applyPageOrderDOM();

    const firstPage = document.querySelector('.pages-container > .page');
    const firstIsMonitor = !!firstPage && firstPage.classList.contains('page-monitor');

    switchToMonitor();
    await new Promise((resolve) => setTimeout(resolve, 60));

    const pagesContainer = document.querySelector('.pages-container');
    const afterSwitch = {
      currentPage: state.currentPage,
      transform: pagesContainer ? pagesContainer.style.transform : ''
    };

    navigatePage(1);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const afterNavigate = { currentPage: state.currentPage };
    return { firstIsMonitor: firstIsMonitor, afterSwitch: afterSwitch, afterNavigate: afterNavigate };
  });

  check('M6 applyPageOrderDOM 后第一个 .page 是 .page-monitor', m6.firstIsMonitor);
  check('M6 switchToMonitor 后 currentPage 为 monitor', m6.afterSwitch.currentPage === 'monitor', JSON.stringify(m6.afterSwitch.currentPage));
  check('M6 switchToMonitor 后 transform 为 translateX(0%)', m6.afterSwitch.transform === 'translateX(0%)', JSON.stringify(m6.afterSwitch.transform));
  check('M6 navigatePage(1) 后 currentPage 为 main', m6.afterNavigate.currentPage === 'main', JSON.stringify(m6.afterNavigate.currentPage));

  const m7 = await runInPage(async function () {
    const original = state.pageOrder.slice();

    openSettings();
    await new Promise((resolve) => setTimeout(resolve, 60));

    const rowsBefore = Array.from(document.querySelectorAll('#page-order-list .page-order-row'));
    const namesBefore = rowsBefore.map((row) => {
      const name = row.querySelector('.page-order-name');
      return name ? name.textContent.trim() : '';
    });

    const firstRow = rowsBefore[0];
    const downButton = firstRow ? firstRow.querySelectorAll('.page-order-btn')[1] : null;
    if (downButton) {
      downButton.click();
    }
    await new Promise((resolve) => setTimeout(resolve, 60));

    const rowsAfter = Array.from(document.querySelectorAll('#page-order-list .page-order-row'));
    const namesAfter = rowsAfter.map((row) => {
      const name = row.querySelector('.page-order-name');
      return name ? name.textContent.trim() : '';
    });

    cancelSettings();
    await new Promise((resolve) => setTimeout(resolve, 60));

    const stateAfterCancel = state.pageOrder.slice();
    return {
      rowCount: rowsBefore.length,
      namesBefore: namesBefore,
      namesAfter: namesAfter,
      original: original,
      stateAfterCancel: stateAfterCancel
    };
  });

  check('M7 #page-order-list 有 4 行', m7.rowCount === 4, '实际 ' + m7.rowCount);
  check('M7 第一行下移后首行变为原第二页名称', m7.namesAfter.length >= 2 && m7.namesAfter[0] === m7.namesBefore[1], '实际 ' + JSON.stringify(m7.namesAfter));
  check('M7 cancelSettings 后 state.pageOrder 未变', arraysEqual(m7.stateAfterCancel, m7.original), JSON.stringify(m7.stateAfterCancel));

  const m8 = await runInPage(async function () {
    state.tasks = [];
    state.monitorFilter = 'all';
    await switchToMonitor();
    renderMonitor();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const list = document.querySelector('#monitor-list');
    return { text: list ? (list.textContent || '') : '' };
  });

  check('M8 空状态显示“还没有 Muse 安排的任务”', m8.text.indexOf('还没有 Muse 安排的任务') >= 0, JSON.stringify(m8.text));

  // M9: D2/D3/D4 回归 —— 五个状态的徽标颜色、模型为空的显示、选中筛选的数量颜色
  const m9 = await runInPage(async function () {
    const now = Date.now();
    const makeMuseTask = (id, status, model, progress, text) => ({
      id: id,
      task: text,
      text: text,
      content: text,
      title: text,
      source: 'muse',
      model: model,
      progress: progress,
      status: status,
      completed: status === 'completed',
      createdAt: new Date(now - 3600000).toISOString(),
      created_at: new Date(now - 3600000).toISOString(),
      completedAt: status === 'completed' ? new Date(now - 1800000).toISOString() : null,
      startedAt: now - 1800000,
      started_at: now - 1800000,
      runStartedAt: now - 1800000,
      run_started_at: now - 1800000,
      updatedAt: now - 600000
    });

    state.tasks = [
      makeMuseTask('m9-running', 'running', 'Sol', 60, '运行中任务'),
      makeMuseTask('m9-waiting-null', 'waiting', null, 0, '模型为空的等待任务'),
      makeMuseTask('m9-completed', 'completed', 'DeepSeek', 100, '已完成任务'),
      makeMuseTask('m9-blocked', 'blocked', 'Muse', 30, '阻塞任务'),
      makeMuseTask('m9-failed-unknown', 'failed', 'GPT', 10, '未知模型失败任务')
    ];
    state.monitorFilter = 'all';
    // 注意：此时 currentPage 已是 monitor，switchToMonitor() 会直接返回不刷新；
    // 直接调 loadMonitorSnapshot() 从 state.tasks 重建 monitorTasks。
    await loadMonitorSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 60));

    const byId = {};
    document.querySelectorAll('#monitor-list .monitor-task').forEach((card) => {
      const statusEl = card.querySelector('.monitor-status');
      const modelEl = card.querySelector('.monitor-model');
      const cs = statusEl ? getComputedStyle(statusEl) : null;
      byId[card.dataset.id] = {
        statusBg: cs ? cs.backgroundColor : '',
        statusColor: cs ? cs.color : '',
        modelText: modelEl ? (modelEl.textContent || '').trim() : ''
      };
    });

    document.querySelector('.monitor-filter-tab[data-filter="running"]').click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const activeCountEl = document.querySelector('.monitor-filter-tab[data-filter="running"] .monitor-filter-count');
    const activeCountColor = activeCountEl ? getComputedStyle(activeCountEl).color : '';
    const inactiveCountEl = document.querySelector('.monitor-filter-tab[data-filter="all"] .monitor-filter-count');
    const inactiveCountColor = inactiveCountEl ? getComputedStyle(inactiveCountEl).color : '';

    return { byId: byId, activeCountColor: activeCountColor, inactiveCountColor: inactiveCountColor };
  });

  // D3: 五个状态徽标均为浅底深字（bg 当背景、color 当文字）
  check('M9 运行中徽标背景为浅绿 #F0FDF4', m9.byId['m9-running'] && m9.byId['m9-running'].statusBg === 'rgb(240, 253, 244)', JSON.stringify(m9.byId['m9-running']));
  check('M9 运行中徽标文字为深绿 #15803D', m9.byId['m9-running'] && m9.byId['m9-running'].statusColor === 'rgb(21, 128, 61)', JSON.stringify(m9.byId['m9-running']));
  check('M9 等待中徽标背景为浅黄 #FFFBEB', m9.byId['m9-waiting-null'] && m9.byId['m9-waiting-null'].statusBg === 'rgb(255, 251, 235)', JSON.stringify(m9.byId['m9-waiting-null']));
  check('M9 等待中徽标文字为深棕 #92400E', m9.byId['m9-waiting-null'] && m9.byId['m9-waiting-null'].statusColor === 'rgb(146, 64, 14)', JSON.stringify(m9.byId['m9-waiting-null']));
  check('M9 已完成徽标背景为浅灰 #F1F5F9', m9.byId['m9-completed'] && m9.byId['m9-completed'].statusBg === 'rgb(241, 245, 249)', JSON.stringify(m9.byId['m9-completed']));
  check('M9 已完成徽标文字为灰 #64748B', m9.byId['m9-completed'] && m9.byId['m9-completed'].statusColor === 'rgb(100, 116, 139)', JSON.stringify(m9.byId['m9-completed']));
  check('M9 阻塞徽标背景为浅红 #FEF2F2', m9.byId['m9-blocked'] && m9.byId['m9-blocked'].statusBg === 'rgb(254, 242, 242)', JSON.stringify(m9.byId['m9-blocked']));
  check('M9 阻塞徽标文字为深红 #B91C1C', m9.byId['m9-blocked'] && m9.byId['m9-blocked'].statusColor === 'rgb(185, 28, 28)', JSON.stringify(m9.byId['m9-blocked']));
  check('M9 失败徽标背景为浅红 #FEF2F2', m9.byId['m9-failed-unknown'] && m9.byId['m9-failed-unknown'].statusBg === 'rgb(254, 242, 242)', JSON.stringify(m9.byId['m9-failed-unknown']));
  check('M9 失败徽标文字为深红 #B91C1C', m9.byId['m9-failed-unknown'] && m9.byId['m9-failed-unknown'].statusColor === 'rgb(185, 28, 28)', JSON.stringify(m9.byId['m9-failed-unknown']));
  // D2: 模型为空显示“未指定”，未知模型仍显示“未知模型”
  check('M9 模型为 null 的任务显示“未指定”', m9.byId['m9-waiting-null'] && m9.byId['m9-waiting-null'].modelText.indexOf('未指定') >= 0, JSON.stringify(m9.byId['m9-waiting-null']));
  check('M9 未知模型的任务仍显示“未知模型”', m9.byId['m9-failed-unknown'] && m9.byId['m9-failed-unknown'].modelText.indexOf('未知模型') >= 0, JSON.stringify(m9.byId['m9-failed-unknown']));
  // D4: 选中筛选标签的数量保持灰色 #9a9aac
  check('M9 选中筛选的数量颜色为灰色 #9a9aac', m9.activeCountColor === 'rgb(154, 154, 172)', JSON.stringify(m9.activeCountColor));
  check('M9 未选中筛选的数量颜色仍为灰色 #9a9aac', m9.inactiveCountColor === 'rgb(154, 154, 172)', JSON.stringify(m9.inactiveCountColor));

  await finish(fail ? 1 : 0);
}

app.whenReady().then(() => {
  run().catch((err) => {
    console.error('❌ 测试异常', err);
    app.exit(1);
  });
});
