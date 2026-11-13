// 派活专区 DOM 测试（批次 C）：Flag、四标签计数、卡片、分页、满窗展开/收起、
// 空/错误状态、旧日程模式回归。只在临时内存数据上跑，不读写真实 userData。
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
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function runInPage(fn, ...args) {
  const argText = args.map((arg) => JSON.stringify(arg)).join(', ');
  const script = '(' + fn.toString() + ')(' + argText + ')';
  return await win.webContents.executeJavaScript(script, true);
}

async function finish(code) {
  if (timeout) clearTimeout(timeout);
  console.log('通过 ' + pass + ' 失败 ' + fail);
  app.exit(code);
}

function dispatchRecord(id, status, extra) {
  const now = Date.now();
  const base = {
    schemaVersion: 1,
    writerVersion: '1.0.0',
    minimumReaderVersion: '1.0.0',
    id: id,
    intentId: 'intent-' + id.slice(-4),
    workItemId: null,
    task: '派活内容 ' + id.slice(-4),
    model: 'GLM',
    status: status,
    observationHealth: 'fresh',
    observationDetail: null,
    progress: status === 'completed' ? 100 : 60,
    dispatchedAt: new Date(now - 22 * 60000).toISOString(),
    recordedAt: new Date(now - 22 * 60000).toISOString(),
    finishedAt: status === 'completed' ? new Date(now - 2 * 60000).toISOString() : null,
    clockSource: { dispatchedAt: 'pc', finishedAt: 'pc', recordedAt: 'pc' },
    project: '报价单',
    goal: null,
    statusDetail: '阶段：验证空报价与税率边界',
    executorRef: null,
    tokenUsage: null,
    usageSource: null,
    provider: null,
    modelVersion: null,
    usageScope: null,
    cachedTokens: null,
    updatedAt: new Date(now - 60000).toISOString(),
    revision: 1,
    lastOperationId: '11111111-1111-4111-8111-111111111111',
    lastFactAt: new Date(now - 60000).toISOString()
  };
  return Object.assign(base, extra || {});
}

function dispatchId(n) {
  const hex = String(n).padStart(8, '0');
  return 'dispatch_2026-11-12_' + hex + '-0000-4000-8000-000000000000';
}

async function run() {
  timeout = setTimeout(() => {
    console.error('❌ 测试超时');
    app.exit(1);
  }, 120000);

  win = new BrowserWindow({
    show: true,
    width: 360,
    height: 500,
    webPreferences: { contextIsolation: false, nodeIntegration: true }
  });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 300));

  // M1: 新 DOM 骨架
  const m1 = await runInPage(async function () {
    const q = (sel) => document.querySelector(sel);
    const close = q('#monitor-expand-close');
    return {
      back: !!q('#monitor-expand-back'),
      pager: !!q('#monitor-pager'),
      pagerPrev: !!q('#monitor-pager-prev'),
      pagerNext: !!q('#monitor-pager-next'),
      settingsFlag: !!q('#settings-monitor-dispatches'),
      // × 只在旧日程展开态保留；派活展开态由 CSS 隐藏（M4 验证）
      closeExists: !!close,
      tabFilters: Array.from(document.querySelectorAll('#monitor-filters .monitor-filter-tab')).map((t) => t.dataset.filter)
    };
  });
  check('M1 展开态有“← 返回”按钮', m1.back);
  check('M1 分页容器与按钮存在', m1.pager && m1.pagerPrev && m1.pagerNext);
  check('M1 设置页有派活开关', m1.settingsFlag);
  check('M1 保留旧日程展开用的 × 节点', m1.closeExists);
  check('M1 四个状态标签保持不变', arraysEqual(m1.tabFilters, ['all', 'running', 'waiting', 'completed']), JSON.stringify(m1.tabFilters));

  // M2: Flag 关闭 → 旧日程模式，派活不出现
  const m2 = await runInPage(async function (records) {
    window.electronAPI = {
      getMonitorDispatchSource: () => Promise.resolve(false),
      getDispatchSnapshot: () => Promise.resolve({
        epoch: 1, revision: 5, source: 'dispatches', records: records,
        warnings: [], errors: [], complete: true, staleFileCount: 0,
        oldestSnapshotAt: null, unreadDates: [], lastReadAt: new Date().toISOString(), watcherHealthy: true
      }),
      onDispatchChanged: () => () => {},
      onTasksChanged: () => () => {},
      setPage: () => {}
    };
    state.monitorFilter = 'all';
    state.currentPage = 'main';
    state.tasks = [{
      id: 'muse-task-1', task: '用户日程里的 Muse 任务', source: 'muse', model: 'Muse',
      progress: 20, status: 'running', completed: false, createdAt: new Date().toISOString()
    }];
    await switchToMonitor();
    await new Promise((r) => setTimeout(r, 60));
    const cards = Array.from(document.querySelectorAll('#monitor-list .monitor-task'));
    return {
      source: state.monitorSource,
      count: cards.length,
      text: cards.map((c) => c.textContent || '').join(' | ')
    };
  }, [dispatchRecord(dispatchId(1), 'running')]);
  check('M2 Flag 关闭时走旧日程数据源', m2.source === 'tasks', JSON.stringify(m2.source));
  check('M2 Flag 关闭时不显示派活', m2.text.indexOf('派活内容') < 0, m2.text);
  check('M2 Flag 关闭时旧日程仍可见', m2.text.indexOf('用户日程里的 Muse 任务') >= 0, m2.text);

  // M9（回归）：日程链 revision 很高时切到派活，低 revision 快照不能被误判过期丢弃
  const m9 = await runInPage(async function (records) {
    window.electronAPI.getMonitorDispatchSource = () => Promise.resolve(true);
    window.electronAPI.getDispatchSnapshot = () => Promise.resolve({
      epoch: 1, revision: 3, source: 'dispatches', records: records,
      warnings: [], errors: [], complete: true, staleFileCount: 0,
      oldestSnapshotAt: null, unreadDates: [], lastReadAt: new Date().toISOString(), watcherHealthy: true
    });
    // 模拟刚离开旧日程模式：任务链 revision 远高于派活链
    state.monitorSource = 'tasks';
    state.monitorRevision = 999;
    state.monitorEpoch = 0;
    state.currentPage = 'main';
    await switchToMonitor();
    await new Promise((r) => setTimeout(r, 80));
    return {
      source: state.monitorSource,
      revision: state.monitorRevision,
      cards: document.querySelectorAll('#monitor-list .monitor-task').length
    };
  }, [dispatchRecord(dispatchId(1), 'running'), dispatchRecord(dispatchId(2), 'waiting')]);
  check('M9 切源后接受派活低 revision 快照', m9.source === 'dispatches' && m9.cards === 2, JSON.stringify(m9));
  check('M9 切源后 revision 采用派活链', m9.revision === 3, String(m9.revision));

  // M3: Flag 开启 → 只显示派活，四标签计数
  const fixture = [
    dispatchRecord(dispatchId(1), 'running'),
    dispatchRecord(dispatchId(2), 'waiting', { progress: null, model: 'DeepSeek', project: null }),
    dispatchRecord(dispatchId(3), 'completed'),
    dispatchRecord(dispatchId(4), 'blocked', { statusDetail: '等依赖' }),
    dispatchRecord(dispatchId(5), 'failed', { statusDetail: '执行异常', finishedAt: new Date().toISOString() }),
    dispatchRecord(dispatchId(6), 'cancelled', { statusDetail: '已确认停止', finishedAt: new Date().toISOString() })
  ];
  const m3 = await runInPage(async function (records) {
    window.__dispatchSnapshot = {
      epoch: 1, revision: 7, source: 'dispatches', records: records,
      warnings: [], errors: [], complete: true, staleFileCount: 0,
      oldestSnapshotAt: null, unreadDates: [], lastReadAt: new Date().toISOString(), watcherHealthy: true
    };
    window.electronAPI.getMonitorDispatchSource = () => Promise.resolve(true);
    window.electronAPI.getDispatchSnapshot = () => Promise.resolve(window.__dispatchSnapshot);
    state.currentPage = 'main';
    state.monitorRevision = 0;
    state.monitorEpoch = 0;
    await switchToMonitor();
    await new Promise((r) => setTimeout(r, 80));

    const countOf = (f) => {
      const el = document.querySelector('.monitor-filter-tab[data-filter="' + f + '"] .monitor-filter-count');
      return el ? el.textContent.trim() : '';
    };
    const cards = Array.from(document.querySelectorAll('#monitor-list .monitor-task'));
    const byId = {};
    cards.forEach((c) => { byId[c.dataset.id] = (c.textContent || ''); });
    const summary = (document.querySelector('#monitor-running-count') || {}).textContent || '';
    const sync = (document.querySelector('#monitor-sync-status') || {}).textContent || '';

    document.querySelector('.monitor-filter-tab[data-filter="running"]').click();
    await new Promise((r) => setTimeout(r, 40));
    const runningCards = document.querySelectorAll('#monitor-list .monitor-task').length;
    const banner = (document.querySelector('.monitor-issue-banner') || {}).textContent || '';
    document.querySelector('.monitor-filter-tab[data-filter="all"]').click();
    await new Promise((r) => setTimeout(r, 40));
    const allCards = document.querySelectorAll('#monitor-list .monitor-task').length;
    return {
      source: state.monitorSource, summary: summary, sync: sync,
      counts: { all: countOf('all'), running: countOf('running'), waiting: countOf('waiting'), completed: countOf('completed') },
      cardCount: cards.length, runningCards: runningCards, allCards: allCards,
      banner: banner, byId: byId,
      hasTaskFallback: Object.keys(byId).some((id) => id.indexOf('muse-task') === 0)
    };
  }, fixture);
  check('M3 Flag 开启时走派活数据源', m3.source === 'dispatches', JSON.stringify(m3.source));
  check('M3 只显示 6 条派活', m3.cardCount === 6, '实际 ' + m3.cardCount);
  check('M3 不混入用户日程', !m3.hasTaskFallback, JSON.stringify(Object.keys(m3.byId)));
  check('M3 全部计数为 6', m3.counts.all === '6', JSON.stringify(m3.counts));
  check('M3 进行中只算 running', m3.counts.running === '1', JSON.stringify(m3.counts));
  check('M3 等待中只算 waiting', m3.counts.waiting === '1', JSON.stringify(m3.counts));
  check('M3 已完成只算 completed（不含 failed/cancelled）', m3.counts.completed === '1', JSON.stringify(m3.counts));
  check('M3 汇总为进行中/已完成/等待', m3.summary.indexOf('进行中 1') >= 0 && m3.summary.indexOf('已完成 1') >= 0 && m3.summary.indexOf('等待 1') >= 0, JSON.stringify(m3.summary));
  check('M3 同步行显示“已读取 HH:mm”', /已读取 \d{2}:\d{2}/.test(m3.sync), JSON.stringify(m3.sync));
  check('M3 进行中筛选只剩 1 张', m3.runningCards === 1, '实际 ' + m3.runningCards);
  check('M3 其他标签提示另有阻塞/失败', m3.banner.indexOf('另有 2 项阻塞/失败') >= 0, JSON.stringify(m3.banner));
  check('M3 回到全部恢复 6 张', m3.allCards === 6, '实际 ' + m3.allCards);
  check('M3 卡片显示派出与总历时', (m3.byId[dispatchId(1)] || '').indexOf('派出') >= 0 && (m3.byId[dispatchId(1)] || '').indexOf('总历时') >= 0, m3.byId[dispatchId(1)]);
  check('M3 卡片显示 Muse 估算进度', (m3.byId[dispatchId(1)] || '').indexOf('Muse 估算约 60%') >= 0, m3.byId[dispatchId(1)]);
  check('M3 无进度时显示暂不可估算', (m3.byId[dispatchId(2)] || '').indexOf('暂不可估算') >= 0, m3.byId[dispatchId(2)]);
  check('M3 GLM 徽标带文字', (m3.byId[dispatchId(1)] || '').indexOf('GLM') >= 0, m3.byId[dispatchId(1)]);
  check('M3 阻塞卡片显示阶段原因', (m3.byId[dispatchId(4)] || '').indexOf('阶段：等依赖') >= 0, m3.byId[dispatchId(4)]);

  // M4: 满窗展开契约 + Esc/返回 + scrollTop 恢复
  const m4 = await runInPage(async function (runningId) {
    const list = document.querySelector('#monitor-list');
    list.scrollTop = 0;
    // 选运行中的卡：详情应显示“尚未结束”，且排序后它一定在第一张
    const target = document.querySelector('#monitor-list [data-id="' + runningId + '"]');
    if (!target) return { found: false, opened: {}, afterEsc: {}, afterBack: {} };
    const targetId = target.dataset.id;
    target.click();
    await new Promise((r) => setTimeout(r, 120));

    const overlay = document.querySelector('#monitor-expand-overlay');
    const pageMonitor = document.querySelector('.page-monitor');
    const back = document.querySelector('#monitor-expand-back');
    const rect = overlay.getBoundingClientRect();
    const opened = {
      open: overlay.classList.contains('open') && !overlay.classList.contains('hidden'),
      windowClass: overlay.classList.contains('monitor-expand-window'),
      expandedId: state.monitorExpandedId,
      pageExpanded: pageMonitor.classList.contains('monitor-expanded'),
      width: rect.width, height: rect.height, left: rect.left, top: rect.top,
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      backVisible: !!back && getComputedStyle(back).display !== 'none',
      focusOnBack: document.activeElement === back,
      detailText: (document.querySelector('#monitor-expand-card') || {}).textContent || '',
      closeHidden: getComputedStyle(document.querySelector('#monitor-expand-close')).display === 'none'
    };

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    const afterEsc = {
      hidden: overlay.classList.contains('hidden'),
      expandedId: state.monitorExpandedId,
      pageExpanded: pageMonitor.classList.contains('monitor-expanded'),
      inHome: overlay.parentNode === pageMonitor,
      scrollTop: list.scrollTop
    };

    const again = document.querySelector('#monitor-list [data-id="' + targetId + '"]');
    again.click();
    await new Promise((r) => setTimeout(r, 80));
    document.querySelector('#monitor-expand-back').click();
    await new Promise((r) => setTimeout(r, 80));
    const afterBack = {
      hidden: overlay.classList.contains('hidden'),
      expandedId: state.monitorExpandedId,
      focusOnCard: document.activeElement === document.querySelector('#monitor-list [data-id="' + targetId + '"]')
    };
    return { opened: opened, afterEsc: afterEsc, afterBack: afterBack };
  }, dispatchId(1));
  check('M4 找到运行中卡片', m4.found);
  check('M4 点击卡片后满窗展开', m4.opened.open && m4.opened.windowClass);
  check('M4 展开后 state.monitorExpandedId 有值', m4.opened.expandedId === dispatchId(1), String(m4.opened.expandedId));
  check('M4 展开后 .page-monitor 含 monitor-expanded', m4.opened.pageExpanded);
  check('M4 覆盖层贴满窗口 (0,0,innerW,innerH)',
    Math.abs(m4.opened.left) <= 1 && Math.abs(m4.opened.top) <= 1 &&
    Math.abs(m4.opened.width - m4.opened.innerWidth) <= 1 &&
    Math.abs(m4.opened.height - m4.opened.innerHeight) <= 1,
    JSON.stringify({ rect: [m4.opened.left, m4.opened.top, m4.opened.width, m4.opened.height], win: [m4.opened.innerWidth, m4.opened.innerHeight] }));
  check('M4 展开态“← 返回”可见且获得焦点', m4.opened.backVisible && m4.opened.focusOnBack);
  check('M4 展开态不显示右上 ×', m4.opened.closeHidden);
  check('M4 详情含状态/观测/时间/Token 字段', ['执行状态', '观测状态', '派出', '记录', '结束', 'Token', '记录 ID'].every((k) => m4.opened.detailText.indexOf(k) >= 0), m4.opened.detailText.slice(0, 200));
  check('M4 未结束显示“尚未结束”', m4.opened.detailText.indexOf('尚未结束') >= 0);
  check('M4 Esc 收起覆盖层', m4.afterEsc.hidden && m4.afterEsc.expandedId === null);
  check('M4 Esc 后移除 monitor-expanded', !m4.afterEsc.pageExpanded);
  check('M4 收起后覆盖层回到监控台页面', m4.afterEsc.inHome);
  check('M4 返回按钮收起覆盖层', m4.afterBack.hidden && m4.afterBack.expandedId === null);
  check('M4 收起后焦点回原卡', m4.afterBack.focusOnCard);

  // M4b（回归，缺陷 1）：展开详情后切页必须收起覆盖层，不能残留满窗遮住主页（§3.4/U06）
  const m4b = await runInPage(async function (runningId) {
    const target = document.querySelector('#monitor-list [data-id="' + runningId + '"]');
    if (!target) return { found: false };
    target.click();
    await new Promise((r) => setTimeout(r, 120));
    const overlay = document.querySelector('#monitor-expand-overlay');
    const opened = {
      open: overlay.classList.contains('open') && !overlay.classList.contains('hidden'),
      expandedId: state.monitorExpandedId,
      focusInOverlay: overlay.contains(document.activeElement)
    };
    await switchToMain();
    await new Promise((r) => setTimeout(r, 60));
    const after = {
      page: state.currentPage,
      hidden: overlay.classList.contains('hidden'),
      open: overlay.classList.contains('open'),
      windowClass: overlay.classList.contains('monitor-expand-window'),
      expandedId: state.monitorExpandedId,
      inHome: overlay.parentNode === document.querySelector('.page-monitor'),
      pageExpanded: document.querySelector('.page-monitor').classList.contains('monitor-expanded'),
      focusInOverlay: overlay.contains(document.activeElement),
      display: getComputedStyle(overlay).display
    };
    // 切回监控台重新进入，后续用例仍有可用状态
    state.currentPage = 'main';
    await switchToMonitor();
    await new Promise((r) => setTimeout(r, 80));
    return { found: true, opened: opened, after: after };
  }, dispatchId(1));
  check('M4b 切页前详情确实展开且焦点在层内', m4b.found && m4b.opened.open && m4b.opened.focusInOverlay, JSON.stringify(m4b.opened));
  check('M4b Alt+1 切主页后覆盖层收起', m4b.after.page === 'main' && m4b.after.hidden && !m4b.after.open, JSON.stringify(m4b.after));
  check('M4b 切页后 monitorExpandedId 清空', m4b.after.expandedId === null, String(m4b.after.expandedId));
  check('M4b 切页后覆盖层回到监控台页面且去掉满窗类', m4b.after.inHome && !m4b.after.windowClass, JSON.stringify(m4b.after));
  check('M4b 切页后焦点不再困在隐藏层', !m4b.after.focusInOverlay, JSON.stringify(m4b.after));
  check('M4b 切页后 monitor-expanded 移除', !m4b.after.pageExpanded);

  // M5: 分页 50/51 与标签切回首页
  const m5 = await runInPage(async function (makeIds) {
    const records = makeIds.map(function (id, i) {
      return {
        schemaVersion: 1, writerVersion: '1.0.0', minimumReaderVersion: '1.0.0',
        id: id, intentId: 'intent-' + i, workItemId: null, task: '批量派活 ' + i,
        model: 'Muse', status: 'running', observationHealth: 'fresh', observationDetail: null,
        progress: 10, dispatchedAt: new Date(Date.now() - i * 60000).toISOString(),
        recordedAt: new Date(Date.now() - i * 60000).toISOString(), finishedAt: null,
        clockSource: { dispatchedAt: 'pc', finishedAt: 'pc', recordedAt: 'pc' },
        project: null, goal: null, statusDetail: null, executorRef: null, tokenUsage: null,
        usageSource: null, provider: null, modelVersion: null, usageScope: null, cachedTokens: null,
        updatedAt: new Date().toISOString(), revision: 1,
        lastOperationId: '11111111-1111-4111-8111-111111111111',
        lastFactAt: new Date().toISOString()
      };
    });
    window.__dispatchSnapshot.records = records;
    window.__dispatchSnapshot.revision += 1;
    state.monitorFilter = 'all';
    state.monitorPage = 1;
    await loadMonitorSnapshot(true);
    await new Promise((r) => setTimeout(r, 60));
    const page1 = document.querySelectorAll('#monitor-list .monitor-task').length;
    const pagerVisible = !document.querySelector('#monitor-pager').hidden;
    const status1 = (document.querySelector('#monitor-pager-status') || {}).textContent || '';
    document.querySelector('#monitor-pager-next').click();
    await new Promise((r) => setTimeout(r, 60));
    const page2 = document.querySelectorAll('#monitor-list .monitor-task').length;
    const status2 = (document.querySelector('#monitor-pager-status') || {}).textContent || '';
    document.querySelector('.monitor-filter-tab[data-filter="running"]').click();
    await new Promise((r) => setTimeout(r, 60));
    const afterFilter = state.monitorPage;
    return { page1: page1, page2: page2, pagerVisible: pagerVisible, status1: status1, status2: status2, afterFilter: afterFilter };
  }, Array.from({ length: 51 }, (_, i) => dispatchId(100 + i)));
  check('M5 51 条时首页 50 张', m5.page1 === 50, '实际 ' + m5.page1);
  check('M5 分页入口始终可达', m5.pagerVisible && m5.status1 === '第 1/2 页', JSON.stringify(m5.status1));
  check('M5 下一页 1 张', m5.page2 === 1 && m5.status2 === '第 2/2 页', JSON.stringify({ n: m5.page2, s: m5.status2 }));
  check('M5 切换标签回首页', m5.afterFilter === 1, '实际 ' + m5.afterFilter);

  // M6: 空状态 / 筛选空 / 桥缺失
  const m6 = await runInPage(async function () {
    window.__dispatchSnapshot.records = [];
    window.__dispatchSnapshot.revision += 1;
    state.monitorFilter = 'all';
    state.monitorPage = 1;
    await loadMonitorSnapshot(true);
    await new Promise((r) => setTimeout(r, 60));
    const emptyText = (document.querySelector('#monitor-list') || {}).textContent || '';

    const saved = window.electronAPI.getDispatchSnapshot;
    delete window.electronAPI.getDispatchSnapshot;
    state.monitorDispatches = [];
    state.monitorStatus = 'loading';
    await loadMonitorSnapshot(true);
    await new Promise((r) => setTimeout(r, 60));
    const bridgeText = (document.querySelector('#monitor-list') || {}).textContent || '';
    const bridgeStatus = (document.querySelector('#monitor-sync-status') || {}).textContent || '';
    window.electronAPI.getDispatchSnapshot = saved;
    return { emptyText: emptyText, bridgeText: bridgeText, bridgeStatus: bridgeStatus };
  });
  check('M6 空派活显示专用空状态', m6.emptyText.indexOf('还没有派活记录') >= 0 && m6.emptyText.indexOf('你的日程仍在便利贴和 Day 中') >= 0, JSON.stringify(m6.emptyText));
  check('M6 缺派活桥显示接口不可用', m6.bridgeText.indexOf('派活读取接口不可用') >= 0, JSON.stringify(m6.bridgeText));
  check('M6 缺派活桥同步行说明原因', m6.bridgeStatus.indexOf('派活读取接口不可用') >= 0, JSON.stringify(m6.bridgeStatus));

  // M7: 首次读取占位 —— 计数与汇总为“—”，不把未读取写成 0
  const m7 = await runInPage(async function () {
    window.electronAPI.getMonitorDispatchSource = () => Promise.resolve(true);
    state.monitorSource = 'dispatches';
    state.monitorDispatches = [];
    state.monitorFilter = 'all';
    state.monitorPage = 1;
    state.monitorStatus = 'loading';
    renderMonitor();
    const counts = Array.from(document.querySelectorAll('#monitor-filters .monitor-filter-count')).map((el) => el.textContent.trim());
    const summary = (document.querySelector('#monitor-running-count') || {}).textContent || '';
    const listText = (document.querySelector('#monitor-list') || {}).textContent || '';
    const pagerHidden = document.querySelector('#monitor-pager').hidden;
    return { counts: counts, summary: summary, listText: listText, pagerHidden: pagerHidden };
  });
  check('M7 首次读取计数显示 —', m7.counts.length === 4 && m7.counts.every((c) => c === '—'), JSON.stringify(m7.counts));
  check('M7 首次读取汇总显示 —', m7.summary.indexOf('进行中 —') >= 0 && m7.summary.indexOf('已完成 —') >= 0, JSON.stringify(m7.summary));
  check('M7 首次读取显示读取中文案', m7.listText.indexOf('正在读取本地派活记录') >= 0, JSON.stringify(m7.listText));
  check('M7 首次读取不显示分页', m7.pagerHidden === true);

  // M8: 旧日程展开路径回归（Flag 关闭仍可用）
  const m8 = await runInPage(async function () {
    window.electronAPI.getMonitorDispatchSource = () => Promise.resolve(false);
    state.currentPage = 'main';
    state.tasks = [{
      id: 'muse-legacy-1', task: '旧日程任务', source: 'muse', model: 'Sol',
      progress: 60, status: 'running', completed: false, createdAt: new Date().toISOString()
    }];
    state.monitorRevision = 0;
    await switchToMonitor();
    await new Promise((r) => setTimeout(r, 60));
    const card = document.querySelector('#monitor-list .monitor-task');
    if (!card) return { found: false };
    card.click();
    await new Promise((r) => setTimeout(r, 420));
    const overlay = document.querySelector('#monitor-expand-overlay');
    const rect = overlay.getBoundingClientRect();
    const open = overlay.classList.contains('open') && !overlay.classList.contains('hidden');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 320));
    return {
      found: true, open: open, width: rect.width, height: rect.height,
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      hidden: overlay.classList.contains('hidden')
    };
  });
  check('M8 旧日程模式仍能展开满窗', m8.found && m8.open && m8.width >= m8.innerWidth - 2 && m8.height >= m8.innerHeight - 2, JSON.stringify(m8));
  check('M8 旧日程模式 Esc 仍能收起', m8.found && m8.hidden);

  await finish(fail === 0 ? 0 : 1);
}

app.whenReady().then(() => {
  run().catch((err) => {
    console.error('❌ 测试异常', err && err.stack || err);
    app.exit(1);
  });
});
