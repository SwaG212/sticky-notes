// 日视图勾选重排无闪烁 DOM 回归测试
// 运行: node_modules\electron\dist\electron.exe tests\test_day_view_toggle_dom.js
const { app, BrowserWindow } = require('electron');
const path = require('path');

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 360, height: 500 });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  const run = code => win.webContents.executeJavaScript(code);
  const today = await run('getToday()');

  const result = JSON.parse(await run(`(async () => {
    const completedTask = {
      id: 'completed-task', task: '取消勾选任务', project: null, completed: true,
      createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      alarmTime: null, dueDate: '${today}', sortOrder: 0
    };
    const pendingTask = {
      id: 'pending-task', task: '未完成任务', project: null, completed: false,
      createdAt: new Date().toISOString(), completedAt: null,
      alarmTime: null, dueDate: '${today}', sortOrder: 1
    };
    state.tasks = [pendingTask, completedTask];
    state.calendarDayDate = '${today}';
    calDayTasks.style.display = 'flex';
    await renderDayTasks(false, false);

    const oldList = document.querySelector('#cal-day-list');
    const beforeCount = oldList.querySelectorAll('.task-item').length;
    const oldCompletedRow = oldList.querySelector('[data-id="completed-task"]');
    const wasChecked = oldCompletedRow.querySelector('.task-checkbox').classList.contains('checked');

    const originalLoadTasksForDate = loadTasksForDate;
    let releaseLoad;
    loadTasksForDate = () => new Promise(resolve => {
      releaseLoad = () => resolve(state.tasks);
    });

    completedTask.completed = false;
    completedTask.completedAt = null;
    state.tasks = [completedTask, pendingTask];
    const pendingRender = renderDayTasks(true, false);
    await Promise.resolve();

    const duringList = document.querySelector('#cal-day-list');
    const preservedWhileLoading = duringList === oldList
      && oldCompletedRow.isConnected
      && duringList.querySelectorAll('.task-item').length === beforeCount;

    releaseLoad();
    await pendingRender;
    loadTasksForDate = originalLoadTasksForDate;

    const newList = document.querySelector('#cal-day-list');
    const newCompletedRow = newList.querySelector('[data-id="completed-task"]');
    return JSON.stringify({
      beforeCount,
      wasChecked,
      preservedWhileLoading,
      replacedAfterLoading: newList !== oldList,
      afterCount: newList.querySelectorAll('.task-item').length,
      firstId: newList.querySelector('.task-item')?.dataset.id,
      uncheckedAfterRender: !newCompletedRow.querySelector('.task-checkbox').classList.contains('checked'),
    });
  })()`));

  assert(result.beforeCount === 2 && result.wasChecked, '测试场景初始包含已完成任务');
  assert(result.preservedWhileLoading, '异步刷新期间保留旧任务列表，不出现空白帧');
  assert(result.replacedAfterLoading && result.afterCount === 2, '数据就绪后一次性替换完整列表');
  assert(result.firstId === 'completed-task' && result.uncheckedAfterRender, '取消勾选后状态与排序正确更新');

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  await win.close();
  app.exit(failed ? 1 : 0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
