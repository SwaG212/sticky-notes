/**
 * 拖拽排序 & sortOrder 单元测试
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

// 模拟函数
function getToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function getYesterday() {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function genId() { return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }

const testDir = path.join(os.tmpdir(), 'sticky-drag-test-' + Date.now());
const tasksDir = path.join(testDir, 'tasks');

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function readJSON(p) { try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) {} return null; }
function writeJSON(p, d) { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf-8'); }

let passed = 0, failed = 0;
function assert(c, desc) { if (c) { passed++; console.log(`  ✓ ${desc}`); } else { failed++; console.error(`  ✗ FAIL: ${desc}`); } }
function assertEquals(a, e, desc) {
  if (JSON.stringify(a) === JSON.stringify(e)) { passed++; console.log(`  ✓ ${desc}`); }
  else { failed++; console.error(`  ✗ FAIL: ${desc} - got ${JSON.stringify(a)} expected ${JSON.stringify(e)}`); }
}

// ====== loadTasksFromFile() (修复后版本) ======
function loadTasksFromFile() {
  const today = getToday();
  const filePath = path.join(tasksDir, `${today}.json`);

  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 5 * 1024 * 1024) {
      const archivePath = filePath.replace(/\.json$/, `_corrupted_${Date.now()}.json`);
      fs.renameSync(filePath, archivePath);
    }
  } catch (e) {}

  let tasks = readJSON(filePath) || [];

  let isNewDay = true;
  try {
    if (fs.existsSync(filePath)) {
      isNewDay = fs.statSync(filePath).mtime.toDateString() !== new Date().toDateString();
    }
  } catch (e) {}

  let changed = false;
  if (isNewDay) {
    tasks.forEach(t => { if (t.alarmTime) { t.alarmTime = null; changed = true; } });
    const yesterday = getYesterday();
    const yesterdayPath = path.join(tasksDir, `${yesterday}.json`);
    const yesterdayTasks = readJSON(yesterdayPath);
    if (yesterdayTasks) {
      const unfinished = yesterdayTasks.filter(t => !t.completed);
      if (unfinished.length > 0) {
        const todayTexts = new Set(tasks.map(t => t.task));
        const unique = unfinished.filter(t => !todayTexts.has(t.task));
        if (unique.length > 0) {
          unique.forEach((t, i) => {
            t.createdAt = new Date().toISOString();
            t.id = genId();
            t.alarmTime = null;
            t.sortOrder = i;
          });
          tasks.forEach((t, i) => { t.sortOrder = unique.length + i; });
          tasks = [...unique, ...tasks];
          changed = true;
        }
      }
    }
  }
  if (changed) writeJSON(filePath, tasks);
  return tasks;
}

// ====== sortTasks & reassign (renderer 逻辑) ======
function sortTasks(tasks) {
  const undone = tasks.filter(t => !t.completed);
  const done = tasks.filter(t => t.completed);
  undone.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  done.sort((a, b) => new Date(b.completedAt || 0).getTime() - new Date(a.completedAt || 0).getTime());
  return [...undone, ...done];
}

function reassignSortOrders(tasks) {
  const undone = tasks.filter(t => !t.completed);
  undone.forEach((t, i) => { t.sortOrder = i; });
}

// ====== 测试 1: 迁移时 sortOrder 赋值 ======
console.log('\nTest 1: migration assigns sortOrder');
ensureDir(tasksDir);
const yesterday = getYesterday();
const today = getToday();
const todayFile = path.join(tasksDir, `${today}.json`);

writeJSON(path.join(tasksDir, `${yesterday}.json`), [
  { id: 't1', task: '昨天未完成1', completed: false, sortOrder: 5 },
  { id: 't2', task: '昨天未完成2', completed: false, sortOrder: 3 },
  { id: 't3', task: '昨天已完成', completed: true, sortOrder: 0 },
]);
writeJSON(todayFile, [
  { id: 't4', task: '今天已有1', completed: false, sortOrder: 0 },
  { id: 't5', task: '今天已有2', completed: false, sortOrder: 1 },
]);
const yesterdayDate = new Date(); yesterdayDate.setDate(yesterdayDate.getDate() - 1);
fs.utimesSync(todayFile, yesterdayDate, yesterdayDate);

const result1 = loadTasksFromFile();
assertEquals(result1.length, 4, 'should have 4 tasks total');
assert(!result1.some(t => t.completed), 'no completed tasks');
assertEquals(result1.map(t => t.sortOrder), [0, 1, 2, 3], 'sortOrders should be sequential');

// ====== 测试 2: sortTasks 按 sortOrder 排序 ======
console.log('\nTest 2: sortTasks uses sortOrder');
const tasks2 = [
  { id: 'a', task: 'A', completed: false, sortOrder: 3 },
  { id: 'b', task: 'B', completed: false, sortOrder: 1 },
  { id: 'c', task: 'C', completed: false, sortOrder: 2 },
];
const sorted2 = sortTasks(tasks2);
assertEquals(sorted2.map(t => t.id), ['b', 'c', 'a'], 'should sort by sortOrder');

// ====== 测试 3: 完成后取消完成回到 sortOrder 位置 ======
console.log('\nTest 3: uncompleting returns to sortOrder position');
const tasks3 = [
  { id: 'a', task: 'A', completed: false, sortOrder: 0 },
  { id: 'b', task: 'B', completed: true, completedAt: '2026-06-18T10:00:00Z', sortOrder: 2 },
  { id: 'c', task: 'C', completed: true, completedAt: '2026-06-18T11:00:00Z', sortOrder: 1 },
  { id: 'd', task: 'D', completed: false, sortOrder: 3 },
];
// 同时取消 b 和 c 的完成 — 各自回到 sortOrder 对应的位置
tasks3.find(t => t.id === 'b').completed = false;
tasks3.find(t => t.id === 'b').completedAt = null;
tasks3.find(t => t.id === 'c').completed = false;
tasks3.find(t => t.id === 'c').completedAt = null;
const sorted3 = sortTasks(tasks3);
assertEquals(sorted3.map(t => t.id), ['a', 'c', 'b', 'd'], 'restored: c(sortOrder=1) before b(sortOrder=2)');

// ====== 测试 4: 拖拽排序后 reassign  ======
console.log('\nTest 4: drag-reorder then reassign');
const tasks4 = [
  { id: 'a', task: 'A', completed: false, sortOrder: 0 },
  { id: 'b', task: 'B', completed: false, sortOrder: 1 },
  { id: 'c', task: 'C', completed: false, sortOrder: 2 },
  { id: 'd', task: 'D', completed: false, sortOrder: 3 },
];
// 将 a(0) 拖到 c(2) 和 d(3) 之间 → 新顺序: b, c, a, d
const [moved] = tasks4.splice(0, 1);
tasks4.splice(2, 0, moved);
assertEquals(tasks4.map(t => t.id), ['b', 'c', 'a', 'd'], 'a moved between c and d');
reassignSortOrders(tasks4);
assertEquals(tasks4.map(t => t.sortOrder), [0, 1, 2, 3], 'sortOrders reassigned sequentially');

// ====== 测试 5: 新增任务 sortOrder = max+1 ======
console.log('\nTest 5: new task gets max sortOrder + 1');
const tasks5 = [
  { id: 'a', task: 'A', completed: false, sortOrder: 0 },
  { id: 'b', task: 'B', completed: false, sortOrder: 1 },
  { id: 'c', task: 'C', completed: true, completedAt: '2026-06-18T10:00:00Z', sortOrder: 7 },
];
const maxOrder5 = tasks5.reduce((max, t) => Math.max(max, t.sortOrder ?? 0), -1);
assert(maxOrder5 === 7, 'max sortOrder = 7 (includes completed tasks)');
const newTask = { id: 'new', task: 'NEW', completed: false, sortOrder: maxOrder5 + 1 };
tasks5.push(newTask);
const sorted5 = sortTasks(tasks5);
assertEquals(sorted5.map(t => t.id), ['a', 'b', 'new', 'c'], 'new task at bottom of undone, before completed');

// ====== 测试 6: 向后兼容 — 无 sortOrder 的任务 ======
console.log('\nTest 6: backward compat - missing sortOrder');
const tasks6 = [
  { id: 'a', task: 'A', completed: false },
  { id: 'b', task: 'B', completed: false },
  { id: 'c', task: 'C', completed: true, completedAt: '2026-06-18T10:00:00Z' },
];
tasks6.forEach((t, i) => { if (t.sortOrder === undefined) t.sortOrder = i; });
assertEquals(tasks6.map(t => t.sortOrder), [0, 1, 2], 'sortOrders assigned by index');
const sorted6 = sortTasks(tasks6);
assertEquals(sorted6.map(t => t.id), ['a', 'b', 'c'], 'order preserved');

// Cleanup
fs.rmSync(testDir, { recursive: true });

console.log(`\n==========`);
console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
