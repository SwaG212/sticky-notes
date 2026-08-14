// m16-repro-dots-2026-08-12.js — 圆点消失问题复现脚本
// 运行: cd F:\Project\sticky-notes && node_modules\electron\dist\electron.exe tests/m16-repro-dots-2026-08-12.js
// 模拟: 日视图连续修改任务日期 → 观察月历圆点是否消失
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

let passed = 0, failed = 0;
const failures = [];
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}`); }
}
const now = new Date();
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = fmt(now);
const TOMORROW = fmt(new Date(now.getTime() + 86400000));
const DAY2 = fmt(new Date(now.getTime() + 2 * 86400000));
const YESTERDAY = fmt(new Date(now.getTime() - 86400000));

function todayTasks() {
  return [
    { id: 't1', task: '任务一', project: '甲', completed: false, createdAt: '2026-08-01T00:00:00.000Z', completedAt: null, alarmTime: null, dueDate: TODAY, sortOrder: 0 },
    { id: 't2', task: '任务二', project: '乙', completed: false, createdAt: '2026-08-01T00:00:00.000Z', completedAt: null, alarmTime: null, dueDate: TODAY, sortOrder: 1 },
  ];
}
function yesterdayTasks() {
  return [
    { id: 'h1', task: '昨日任务', project: '丁', completed: false, createdAt: '2026-07-30T00:00:00.000Z', completedAt: null, alarmTime: null, dueDate: YESTERDAY, sortOrder: 0 },
  ];
}
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

app.whenReady().then(async () => {
  const preloadPath = path.join(__dirname, 'm16-mock-preload.js');
  fs.writeFileSync(preloadPath, `
const { contextBridge } = require('electron');
const files = new Map();
files.set('${TODAY}', ${JSON.stringify(todayTasks())});
files.set('${YESTERDAY}', ${JSON.stringify(yesterdayTasks())});
contextBridge.exposeInMainWorld('electronAPI', {
  loadTasks: () => Promise.resolve(files.get('${TODAY}') || []),
  saveTasks: (arr) => { files.set('${TODAY}', arr); return Promise.resolve(true); },
  loadTasksByDate: (d) => Promise.resolve(files.get(d) || []),
  saveTasksByDate: (d, arr) => { files.set(d, arr); return Promise.resolve(true); },
  listTasksFiles: () => Promise.resolve([...files.keys()].map(d => d + '.json')),
  getConfig: () => Promise.resolve({}),
  hasApiKey: () => Promise.resolve(false),
  saveConfig: () => Promise.resolve(true),
  setSettingsOpen: () => Promise.resolve(true),
  onWindowShown: () => {}, onWindowBlur: () => {}, onWindowWillHide: () => {}, onOpenConfig: () => {},
  removeAllListeners: () => {},
});
`);
  const win = new BrowserWindow({
    show: true, width: 720, height: 900,
    webPreferences: { preload: preloadPath, contextIsolation: true },
  });
  const killer = setTimeout(() => { console.log('!!! 测试超时强制退出'); app.exit(2); }, 120000);
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  const r = (code) => win.webContents.executeJavaScript(code);
  await sleep(800);

  const initInfo = await r(`JSON.stringify({ n: state.tasks.length, ids: state.tasks.map(t => t.id) })`);
  console.log('启动状态:', initInfo);

  const dotsInfo = async (date) => JSON.parse(await r(`(() => {
    const el = [...document.querySelectorAll('.cal-day')].find(e => e.dataset.date === '${date}');
    if (!el) return JSON.stringify({ found: false });
    const dotsEl = el.querySelector('.cal-dots');
    return JSON.stringify({ found: true, n: dotsEl ? dotsEl.children.length : 0, title: el.title || '' });
  })()`));
  const dump = async (label) => {
    const info = await r(`JSON.stringify({
      st: state.tasks.map(t => [t.id, t.dueDate]),
      cache: [...taskFileCache.entries()].map(([d, arr]) => [d, arr.map(t => [t.id, t.dueDate, t._fileDate])]),
      dayDate: state.calendarDayDate,
    })`);
    console.log(`  [dump:${label}]`, info);
  };
  const records = [];
  const mark = async (label) => {
    const t = await dotsInfo(TODAY);
    const m = await dotsInfo(TOMORROW);
    const y = await dotsInfo(YESTERDAY);
    records.push({ label, today: t.n, tomorrow: m.n, yesterday: y.n });
    console.log(`  [${label}] 昨天=${y.n}点 今天=${t.n}点 明天=${m.n}点 | 今天title="${t.title}"`);
  };

  // ========== 场景 1: 今天日视图改日期 ==========
  await r(`openCalendar();`);
  await sleep(500);
  await mark('S1 初始');

  await r(`enterDayMode('${TODAY}');`);
  await sleep(700);

  // 改 t1 → 明天
  await r(`document.querySelector('[data-id="t1"] .task-duedate').click();`);
  await sleep(100);
  await r(`(() => { const p = document.querySelector('.date-picker'); [...p.querySelectorAll('.dp-day')].find(d => d.dataset.date === '${TOMORROW}').click(); })()`);
  await sleep(1500);
  await dump('改t1后');
  await mark('S1 改 t1→明天 后');

  // 改 t2 → 明天
  await r(`document.querySelector('[data-id="t2"] .task-duedate').click();`);
  await sleep(100);
  await r(`(() => { const p = document.querySelector('.date-picker'); [...p.querySelectorAll('.dp-day')].find(d => d.dataset.date === '${TOMORROW}').click(); })()`);
  await sleep(1500);
  await dump('改t2后');
  await mark('S1 改 t2→明天 后');

  // 退出日视图
  await r(`exitDayMode();`);
  await sleep(900);
  await mark('S1 退出日视图后');

  // ========== 场景 2: 历史日视图改日期 ==========
  console.log('\n--- 场景 2: 昨天日视图改日期 ---');
  await r(`enterDayMode('${YESTERDAY}');`);
  await sleep(700);
  await r(`document.querySelector('[data-id="h1"] .task-duedate').click();`);
  await sleep(100);
  await r(`(() => { const p = document.querySelector('.date-picker'); [...p.querySelectorAll('.dp-day')].find(d => d.dataset.date === '${TODAY}').click(); })()`);
  await sleep(1500);
  await dump('昨天改h1→今天');
  // 诊断: dueIndex 里今天组是否有 h1 + 手动刷新后圆点数
  const diag = await r(`JSON.stringify((() => {
    try {
      const nCal = document.querySelectorAll('.cal-day').length;
      const idx = buildDueDateIndex(state.tasks, taskFileCache.values());
      const todayList = (idx.get('${TODAY}') || []).map(t => [t.id, t.dueDate]);
      const el = [...document.querySelectorAll('.cal-day')].find(e => e.dataset.date === '${TODAY}') || null;
      const before = el && el.querySelector('.cal-dots') ? el.querySelector('.cal-dots').children.length : 'noel';
      updateCalendarDots();
      const after = el && el.querySelector('.cal-dots') ? el.querySelector('.cal-dots').children.length : 'noel';
      return JSON.stringify({ nCal, todayList, before, after });
    } catch (e) { return JSON.stringify({ err: String(e && e.stack || e) }); }
  })())`);
  console.log('  [diag:h1改今天]', diag);
  await mark('S2 改 h1→今天 后');

  await r(`exitDayMode();`);
  await sleep(900);
  await mark('S2 退出日视图后');

  console.log('\n=== 断言 ===');
  const rec = records;
  assert(rec[0].today === 2, `S1 初始今天 2 点(实际 ${rec[0].today})`);
  assert(rec[1].today === 1 && rec[1].tomorrow === 1, `S1 改 t1 后今天 1 明天 1(实际 ${rec[1].today}/${rec[1].tomorrow})`);
  assert(rec[2].today === 0 && rec[2].tomorrow === 2, `S1 改 t2 后今天 0 明天 2(实际 ${rec[2].today}/${rec[2].tomorrow})`);
  assert(rec[3].today === 0 && rec[3].tomorrow === 2, `S1 退出后不变(实际 ${rec[3].today}/${rec[3].tomorrow})`);
  assert(rec[4].yesterday === 0 && rec[4].today === 1, `S2 改 h1→今天 后昨天 0 今天 1(实际 ${rec[4].yesterday}/${rec[4].today})`);
  assert(rec[5].yesterday === 0 && rec[5].today === 1, `S2 退出后不变(实际 ${rec[5].yesterday}/${rec[5].today})`);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed) console.log('失败项:', failures.join('; '));
  fs.unlinkSync(preloadPath);
  clearTimeout(killer);
  app.exit(failed ? 1 : 0);
}).catch(err => { console.error(err); app.exit(3); });
