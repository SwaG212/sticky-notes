// m17-datepicker-2026-08-13.js — 日期选择器(四行周窗口 + 滚轮翻周)验证
// 运行: cd F:\Project\sticky-notes && node_modules\electron\dist\electron.exe tests/m17-datepicker-2026-08-13.js
// 验证: 结构(5行/35格/无表头) / 滚轮翻周(方向+快速累积) / 点选应用 / 清除 / Esc
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
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return fmt(d); };
const sundayOf = (s) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() - d.getDay()); return fmt(d); };
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

app.whenReady().then(async () => {
  const preloadPath = path.join(__dirname, 'm17-mock-preload.js');
  fs.writeFileSync(preloadPath, `
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  loadTasks: () => Promise.resolve([
    { id: 't1', task: '任务一', project: '甲', completed: false, createdAt: '2026-08-01T00:00:00.000Z', completedAt: null, alarmTime: null, dueDate: '${TODAY}', sortOrder: 0 },
    { id: 't2', task: '任务二', project: '乙', completed: false, createdAt: '2026-08-01T00:00:00.000Z', completedAt: null, alarmTime: null, dueDate: null, sortOrder: 1 },
  ]),
  saveTasks: () => Promise.resolve(true),
  loadTasksByDate: () => Promise.resolve([]),
  saveTasksByDate: () => Promise.resolve(true),
  listTasksFiles: () => Promise.resolve([]),
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
  win.webContents.on('console-message', (e, level, message) => console.log('[console]', message));
  const killer = setTimeout(() => { console.log('!!! 测试超时强制退出'); app.exit(2); }, 120000);
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  const r = async (label, code) => {
    try { return await win.webContents.executeJavaScript(code); }
    catch (e) { console.log(`  ⚠️ STEP FAIL [${label}]:`, String(e)); throw e; }
  };
  await sleep(800);

  const sunday = sundayOf(TODAY);

  // 1. 结构: 5 行(4 可见+1 动画缓冲), 35 格, 无表头
  await r('S1', `(() => { try { openDatePicker(document.querySelector('[data-id="t2"] .task-duedate'), 1); return 'opened'; } catch (e) { return 'OPEN_ERR: ' + (e && e.stack || e); } })()`);
  await sleep(300);
  const structure = JSON.parse(await r('S1', `(() => { try { return JSON.stringify({
    rows: document.querySelectorAll('.date-picker .dp-row').length,
    days: document.querySelectorAll('.date-picker .dp-day').length,
    focus: document.querySelectorAll('.dp-row.focus').length,
    dim: document.querySelectorAll('.dp-row.dim').length,
    hasHeader: !!document.querySelector('.dp-header'),
    firstRowFirst: document.querySelector('.dp-row .dp-day').dataset.date,
    todayDate: (document.querySelector('.dp-day.today') || {}).dataset ? (document.querySelector('.dp-day.today') || {}).dataset.date : null,
    selected: !!document.querySelector('.dp-day.selected'),
    weekendCount: document.querySelectorAll('.dp-day.weekend').length,
  }); } catch (e) { return JSON.stringify({ ERR: String(e && e.stack || e) }); } })()`));
  assert(structure.rows === 5, `面板 5 行(4 可见+1 缓冲)(实际 ${structure.rows})`);
  assert(structure.days === 35, `35 个日期格(实际 ${structure.days})`);
  assert(!structure.hasHeader, '无表头/星期列标');
  assert(structure.focus === 2 && structure.dim === 3, `高亮行 2 + 弱化行 3(实际 ${structure.focus}/${structure.dim})`);
  assert(structure.firstRowFirst === addDays(sunday, -7), `第一行 = 上周日 ${addDays(sunday, -7)}(实际 ${structure.firstRowFirst})`);
  assert(structure.todayDate === TODAY, `今天光圈格正确(实际 ${structure.todayDate})`);
  assert(structure.selected === false, '无选中格(t2 无日期)');
  assert(structure.weekendCount === 10, `周末淡紫格 10(2列×5行)(实际 ${structure.weekendCount})`);

  // 2. 滚轮向下 = 未来方向: 窗口上移一周
  await r('S1', `document.querySelector('.date-picker').dispatchEvent(new WheelEvent('wheel', { deltaY: 120, cancelable: true }));`);
  await sleep(500);
  const afterDown = JSON.parse(await r('S1', `JSON.stringify({ first: document.querySelector('.dp-row .dp-day').dataset.date })`));
  assert(afterDown.first === sunday, `滚轮向下后第一行 = 本周日 ${sunday}(实际 ${afterDown.first})`);

  // 3. 快速滚动累积: 一次事件 deltaY=800 → 一次翻 3 周, 今天移出窗口
  await r('S1', `document.querySelector('.date-picker').dispatchEvent(new WheelEvent('wheel', { deltaY: 800, cancelable: true }));`);
  await sleep(1500); // 3×340ms 动画串联 + 余量
  const afterFast = JSON.parse(await r('S1', `JSON.stringify({
    first: document.querySelector('.dp-row .dp-day').dataset.date,
    hasToday: !!document.querySelector('.dp-day.today'),
  })`));
  assert(afterFast.first === addDays(sunday, 21), `快速滚(800)翻 3 周 → 第一行 = 下下下周日(实际 ${afterFast.first})`);
  assert(afterFast.hasToday === false, '翻 3 周后今天移出窗口');

  // 4. 反向滚轮回本周窗口
  await r('S1', `document.querySelector('.date-picker').dispatchEvent(new WheelEvent('wheel', { deltaY: -800, cancelable: true }));`);
  await sleep(1500);
  const afterBack = JSON.parse(await r('S1', `JSON.stringify({ first: document.querySelector('.dp-row .dp-day').dataset.date })`));
  assert(afterBack.first === sunday, `反向滚回 → 第一行 = 本周日(实际 ${afterBack.first})`);

  // 5. 点击日期格应用(本周三)
  const clickDate = addDays(sunday, 3);
  await r('S1', `[...document.querySelectorAll('.dp-day')].find(e => e.dataset.date === '${clickDate}').click();`);
  await sleep(400);
  const applied = await r('S1', `JSON.stringify(state.tasks.find(t => t.id === 't2').dueDate)`);
  assert(applied === JSON.stringify(clickDate), `点击 ${clickDate} 应用成功(实际 ${applied})`);

  // 6. 重新打开: 选中格显示 + 清除
  await r('S1', `openDatePicker(document.querySelector('[data-id="t2"] .task-duedate'), 1);`);
  await sleep(300);
  const hasSelected = await r('S1', `!!document.querySelector('.dp-day.selected')`);
  assert(hasSelected, '重新打开: 选中格显示');
  await r('S1', `document.querySelector('.dp-clear').click();`);
  await sleep(400);
  const cleared = await r('S1', `JSON.stringify(state.tasks.find(t => t.id === 't2').dueDate)`);
  assert(cleared === 'null', `清除后 dueDate=null(实际 ${cleared})`);

  // 7. Esc 关闭
  await r('S1', `openDatePicker(document.querySelector('[data-id="t2"] .task-duedate'), 1);`);
  await sleep(300);
  await r('S1', `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));`);
  await sleep(200);
  const closed = await r('S1', `!document.querySelector('.date-picker')`);
  assert(closed, 'Esc 关闭面板');

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed) console.log('失败项:', failures.join('; '));
  fs.unlinkSync(preloadPath);
  clearTimeout(killer);
  app.exit(failed ? 1 : 0);
}).catch(err => { console.error(err); app.exit(3); });
