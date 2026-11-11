const logic = require('../renderer/monitor-logic.js');
const { filterMonitorTasks, countByStatus, sortMonitorTasks, normalizePageOrder, mergeTaskArrays, dedupeTaskEntries, isValidTaskDateFilename } = logic;
let passed = 0, failed = 0;
function fail(msg) { throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) fail((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)); }
function deepEq(a, b, msg) { const sa = JSON.stringify(a), sb = JSON.stringify(b); if (sa !== sb) fail((msg || '') + ' 期望 ' + sb + ' 实际 ' + sa); }
function ok(cond, msg) { if (!cond) fail(msg || '条件不成立'); }
function test(desc, fn) { try { fn(); passed++; console.log('  ✓ ' + desc); } catch (e) { failed++; console.log('  ✗ ' + desc + ' -> ' + e.message); } }
function group(name) { console.log('\n' + name); }

group('filterMonitorTasks 四档过滤与 countByStatus 五项计数');
const tasks = [{ id: 'r', status: 'running' }, { id: 'w', status: 'waiting' }, { id: 'c', status: 'completed' }, { id: 'b', status: 'blocked' }, { id: 'f', status: 'failed' }];
test('all/running/waiting/completed 四档过滤正确', () => {
  deepEq(filterMonitorTasks(tasks, 'all').map(t => t.id), ['r','w','c','b','f']);
  deepEq(filterMonitorTasks(tasks, 'running').map(t => t.id), ['r']);
  deepEq(filterMonitorTasks(tasks, 'waiting').map(t => t.id), ['w']);
  deepEq(filterMonitorTasks(tasks, 'completed').map(t => t.id), ['c']);
});
test('blocked/failed 只在 all 出现', () => {
  ok(!filterMonitorTasks(tasks, 'running').some(t => t.status === 'blocked' || t.status === 'failed'));
  ok(!filterMonitorTasks(tasks, 'waiting').some(t => t.status === 'blocked' || t.status === 'failed'));
  ok(!filterMonitorTasks(tasks, 'completed').some(t => t.status === 'blocked' || t.status === 'failed'));
});
test('其他过滤值按 all、非数组返回空、不修改原数组', () => {
  deepEq(filterMonitorTasks(tasks, 'other').map(t => t.id), ['r','w','c','b','f']);
  deepEq(filterMonitorTasks(null, 'all'), []);
  const before = JSON.stringify(tasks);
  filterMonitorTasks(tasks, 'running');
  eq(JSON.stringify(tasks), before);
});
test('countByStatus 五项计数正确', () => {
  const c = countByStatus(tasks);
  eq(c.all, 5); eq(c.running, 1); eq(c.waiting, 1); eq(c.completed, 1); eq(c.blockedFailed, 2);
});

group('sortMonitorTasks 组顺序、组内降序与无效时间排组尾');
const sortTasks = [{ id: 'r1', status: 'running', createdAt: '2026-01-01T00:00:00.000Z' }, { id: 'r2', status: 'running', createdAt: '2026-02-01T00:00:00.000Z' }, { id: 'r3', status: 'running', createdAt: null }, { id: 'b1', status: 'blocked', createdAt: '2026-03-01T00:00:00.000Z' }, { id: 'f1', status: 'failed', createdAt: '2026-04-01T00:00:00.000Z' }, { id: 'w1', status: 'waiting', createdAt: '2026-05-01T00:00:00.000Z' }, { id: 'c1', status: 'completed', createdAt: '2026-06-01T00:00:00.000Z' }];
const sorted = sortMonitorTasks(sortTasks);
const pos = id => sorted.findIndex(t => t.id === id);
test('组顺序 running→blocked→failed→waiting→completed', () => {
  ok(pos('r1') < pos('b1'), 'running 应在 blocked 前');
  ok(pos('b1') < pos('f1'), 'blocked 应在 failed 前');
  ok(pos('f1') < pos('w1'), 'failed 应在 waiting 前');
  ok(pos('w1') < pos('c1'), 'waiting 应在 completed 前');
});
test('同组 createdAt 降序且无效排组尾', () => {
  ok(pos('r2') < pos('r1'), 'createdAt 降序');
  ok(pos('r1') < pos('r3'), '无效 createdAt 排组尾');
  ok(pos('r2') < pos('r3'), '无效 createdAt 排组尾');
  eq(sorted[2].id, 'r3', 'running 组尾');
});

group('normalizePageOrder 合法与非法输入');
const legal = ['monitor', 'main', 'tools', 'notepad'];
test('合法顺序原样返回 valid true', () => {
  const r = normalizePageOrder(legal);
  eq(r.valid, true);
  deepEq(r.order, legal);
});
const defOrder = normalizePageOrder(null).order;
const badOrders = [
  ['缺一页', ['main','notepad','tools']],
  ['多一页', ['main','notepad','tools','monitor','x']],
  ['重复', ['main','main','tools','monitor']],
  ['未知 ID', ['main','notepad','tools','unknown']],
  ['大小写错误', ['Main','notepad','tools','monitor']],
  ['null', null],
  ['字符串', 'main'],
  ['非数组', 123]
];
test('缺一页/多一页/重复/未知/大小写/null/字符串/非数组全部回默认且 valid false', () => {
  badOrders.forEach(([name, value]) => {
    const r = normalizePageOrder(value);
    eq(r.valid, false, name + ' valid');
    deepEq(r.order, defOrder, name + ' order');
  });
});

group('mergeTaskArrays 三方合并与 changed');
test('incoming 修改/新增、disk 外部保留、base 删除、base null 保留', () => {
  let r = mergeTaskArrays([{ id: 'a', v: 1 }], [{ id: 'a', v: 2 }], [{ id: 'a' }]);
  eq(r.tasks.length, 1); eq(r.tasks[0].v, 2); eq(r.changed, true);
  r = mergeTaskArrays([], [{ id: 'b', v: 9 }], []);
  eq(r.tasks.length, 1); eq(r.tasks[0].id, 'b'); eq(r.changed, true);
  r = mergeTaskArrays([{ id: 'c', v: 3 }], [], []);
  eq(r.tasks.length, 1); eq(r.tasks[0].id, 'c'); eq(r.changed, false);
  r = mergeTaskArrays([{ id: 'a' }, { id: 'd' }], [], [{ id: 'a' }, { id: 'd' }]);
  eq(r.tasks.length, 0); eq(r.changed, true);
  r = mergeTaskArrays([{ id: 'x' }], [], null);
  eq(r.tasks.length, 1); eq(r.tasks[0].id, 'x'); eq(r.changed, false);
});
test('changed 标志在无变化时为 false', () => {
  const r = mergeTaskArrays([{ id: 'a', v: 1 }], [{ id: 'a', v: 1 }], []);
  eq(r.tasks.length, 1); eq(r.tasks[0].v, 1); eq(r.changed, false);
});

group('dedupeTaskEntries 去重、冲突与缺失 id');
test('同 id 相同内容去重为 1，取 fileDate 最大者', () => {
  const r = dedupeTaskEntries([
    { task: { id: 'a', title: 'x', updatedAt: '2026-01-01T00:00:00.000Z' }, fileDate: '2026-01-01' },
    { task: { id: 'a', title: 'x', updatedAt: '2026-01-02T00:00:00.000Z' }, fileDate: '2026-01-02' }
  ]);
  eq(r.entries.length, 1);
  eq(r.entries[0].fileDate, '2026-01-02');
  eq(r.entries[0].task.updatedAt, '2026-01-02T00:00:00.000Z');
});
test('同 id 冲突选 updatedAt 最新且带 duplicate-conflict', () => {
  const r = dedupeTaskEntries([
    { task: { id: 'b', title: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }, fileDate: '2026-01-03' },
    { task: { id: 'b', title: 'new', updatedAt: '2026-01-02T00:00:00.000Z' }, fileDate: '2026-01-01' }
  ]);
  eq(r.entries.length, 1);
  eq(r.entries[0].task.title, 'new');
  ok(r.entries[0].warnings.includes('duplicate-conflict'), '缺少 duplicate-conflict');
});
test('无 id 保留并带 missing-id', () => {
  const r = dedupeTaskEntries([{ task: { title: 'no id' }, fileDate: '2026-01-01' }]);
  eq(r.entries.length, 1);
  ok(r.entries[0].warnings.includes('missing-id'), '缺少 missing-id');
});

group('isValidTaskDateFilename 日期文件名');
test('日期文件名真假日', () => {
  eq(isValidTaskDateFilename('2026-11-11.json'), true, '2026-11-11.json');
  eq(isValidTaskDateFilename('2026-02-31.json'), false, '2026-02-31.json');
  eq(isValidTaskDateFilename('2026-02-29.json'), false, '2026-02-29.json');
  eq(isValidTaskDateFilename('2024-02-29.json'), true, '2024-02-29.json');
  eq(isValidTaskDateFilename('tasks.json'), false, 'tasks.json');
  eq(isValidTaskDateFilename('2026-11-11.txt'), false, '2026-11-11.txt');
});

console.log('\n通过 ' + passed + ' 失败 ' + failed);
process.exit(failed ? 1 : 0);
