// Day 视图 dueDate 索引回归测试:历史文件里的未完成 Muse 任务可见,本地未完成孤立副本仍过滤
// 运行: node_modules\electron\dist\electron.exe tests\test_due_date_index.js
const { app, BrowserWindow } = require('electron');
const path = require('path');

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 360, height: 500 });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  const run = code => win.webContents.executeJavaScript(code);
  const result = JSON.parse(await run(`(function () {
    const D = '2026-11-14';
    const base = (over) => Object.assign({
      id: 'x', task: 't', project: 'P', completed: false,
      createdAt: '2026-11-11T00:00:00.000Z', completedAt: null,
      alarmTime: null, dueDate: D, sortOrder: 0,
      updatedAt: '2026-11-11T10:00:00.000Z'
    }, over);
    // 场景 1:只有历史文件里有任务(非当天文件),当天列表为空
    const museUnfinished = base({ id: 'm1', task: 'Muse 未完成', source: 'muse' });
    const localUnfinished = base({ id: 'l1', task: '本地未完成' });
    const localCompleted = base({ id: 'l2', task: '本地已完成', completed: true, completedAt: '2026-11-11T12:00:00.000Z', updatedAt: '2026-11-11T12:00:00.000Z' });
    const noDue = base({ id: 'n1', task: '无日期', dueDate: null, source: 'muse' });
    const idx = buildDueDateIndex([], [[museUnfinished, localUnfinished, localCompleted, noDue]]);
    const list = idx.get(D) || [];
    const ids = list.map(t => t.id);
    // 场景 2:去重,当前列表优先于更新的缓存副本
    const currentTask = base({ id: 'c1', task: '同名任务', marker: 'current', updatedAt: '2026-11-11T08:00:00.000Z' });
    const cachedCopy = base({ id: 'c2', task: '同名任务', marker: 'cached', source: 'muse', updatedAt: '2026-11-11T09:00:00.000Z' });
    const idx2 = buildDueDateIndex([currentTask], [[cachedCopy]]);
    const winner = (idx2.get(D) || [])[0];
    // 场景 3:平局时已完成副本优先(既有规则不变)
    const u2 = base({ id: 'u2', task: '同名2', source: 'muse' });
    const c2 = base({ id: 'c3', task: '同名2', completed: true, completedAt: '2026-11-11T10:00:00.000Z', source: 'muse' });
    const idx3 = buildDueDateIndex([], [[u2, c2]]);
    const winner3 = (idx3.get(D) || [])[0];
    return JSON.stringify({
      museUnfinishedVisible: ids.includes('m1'),
      localUnfinishedHidden: !ids.includes('l1'),
      localCompletedVisible: ids.includes('l2'),
      noDueExcluded: !ids.includes('n1'),
      countIs2: list.length === 2,
      dedupCurrentWins: !!(winner && winner.marker === 'current'),
      tieBreakCompletedWins: !!(winner3 && winner3.completed === true)
    });
  })()`));
  assert(result.museUnfinishedVisible, '历史文件里的未完成 Muse 任务在 Day 视图可见');
  assert(result.localUnfinishedHidden, '历史文件里的未完成本地孤立副本仍被过滤(防幽灵任务)');
  assert(result.localCompletedVisible, '历史文件里的已完成任务仍可见');
  assert(result.noDueExcluded, '无 dueDate 的任务不进索引');
  assert(result.countIs2, '索引条数正确(仅 Muse 未完成 + 本地已完成)');
  assert(result.dedupCurrentWins, '去重:当前列表优先于更新的缓存副本');
  assert(result.tieBreakCompletedWins, '平局规则:同时间戳时已完成副本优先');
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  await win.close();
  app.exit(failed ? 1 : 0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
