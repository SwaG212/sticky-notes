/**
 * 测试 loadTasksFromFile() 的跨天迁移逻辑
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const testDir = path.join(os.tmpdir(), 'sticky-test-' + Date.now());
const tasksDir = path.join(testDir, 'tasks');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {}
  return null;
}

function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function getToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function getYesterday() {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ====== 修复后的 loadTasksFromFile() ======
function loadTasksFromFile() {
  const today = getToday();
  const filePath = path.join(tasksDir, `${today}.json`);

  // 文件损坏保护：>5MB 自动归档
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
      const mtime = fs.statSync(filePath).mtime;
      isNewDay = mtime.toDateString() !== new Date().toDateString();
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
          unique.forEach(t => {
            t.createdAt = new Date().toISOString();
            t.id = 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
            t.alarmTime = null;
          });
          tasks = [...unique, ...tasks];
          changed = true;
        }
      }
    }
  }

  if (changed) writeJSON(filePath, tasks);
  return tasks;
}

// ====== 测试用例 ======
let passed = 0, failed = 0;

function assert(condition, desc) {
  if (condition) { passed++; console.log(`  ✓ ${desc}`); }
  else { failed++; console.error(`  ✗ FAIL: ${desc}`); }
}

function assertEquals(actual, expected, desc) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++; console.log(`  ✓ ${desc}`);
  } else {
    failed++; console.error(`  ✗ FAIL: ${desc}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
  }
}

// Setup
ensureDir(tasksDir);

// --- 测试 1: 跨天迁移只迁移未完成任务，已完成的不带过来 ---
console.log('\nTest 1: completed tasks not carried over');
const yesterday = getYesterday();
const today = getToday();
const todayFile = path.join(tasksDir, `${today}.json`);
writeJSON(path.join(tasksDir, `${yesterday}.json`), [
  { id: 't1', task: 'unfinished-1', completed: false, createdAt: '2026-01-01', alarmTime: null },
  { id: 't2', task: 'completed', completed: true, createdAt: '2026-01-01', alarmTime: null },
  { id: 't3', task: 'unfinished-2', completed: false, createdAt: '2026-01-01', alarmTime: '09:00' },
]);
if (fs.existsSync(todayFile)) fs.unlinkSync(todayFile);

const result1 = loadTasksFromFile();
assertEquals(result1.length, 2, 'should have 2 unfinished tasks');
assert(result1.every(t => !t.completed), 'all imported tasks should be unfinished');
assert(!result1.some(t => t.task === 'completed'), 'completed task should not appear');
assert(result1.every(t => t.alarmTime === null), 'alarmTime should be cleared');

// --- 测试 2: 今天文件已存在且是今天创建的 -> isNewDay=false -> 不重复追加 ---
console.log('\nTest 2: isNewDay=false skips migration');
const tasksToday = [
  { id: 'tx', task: 'today-task', completed: false, createdAt: new Date().toISOString(), alarmTime: null }
];
writeJSON(todayFile, tasksToday);

const result2 = loadTasksFromFile();
assertEquals(result2.length, 1, 'should still have 1 task');
assert(result2[0].task === 'today-task', 'should be unchanged');

// --- 测试 3: 已有同名任务时去重 ---
console.log('\nTest 3: dedup identical tasks');
writeJSON(path.join(tasksDir, `${yesterday}.json`), [
  { id: 't4', task: 'unfinished-1', completed: false, createdAt: '2026-01-01', alarmTime: null },
  { id: 't5', task: 'new-unfinished', completed: false, createdAt: '2026-01-01', alarmTime: null },
]);
writeJSON(todayFile, [
  { id: 'tx2', task: 'unfinished-1', completed: false, createdAt: new Date().toISOString(), alarmTime: null }
]);
const yesterdayDate = new Date(); yesterdayDate.setDate(yesterdayDate.getDate() - 1);
fs.utimesSync(todayFile, yesterdayDate, yesterdayDate);

const result3 = loadTasksFromFile();
assertEquals(result3.length, 2, 'should have 2 after dedup');
assert(result3.some(t => t.task === 'unfinished-1'), 'should keep existing unfinished-1');
assert(result3.some(t => t.task === 'new-unfinished'), 'should add new-unfinished');

// --- 测试 4: 文件 >5MB 自动归档 ---
console.log('\nTest 4: file bloat protection');
fs.rmSync(tasksDir, { recursive: true });
ensureDir(tasksDir);
// 重新创建昨天的测试数据
writeJSON(path.join(tasksDir, `${yesterday}.json`), [
  { id: 't1', task: 'unfinished-1', completed: false, createdAt: '2026-01-01', alarmTime: null },
]);
// 直接写一个 >5MB 的文件
const bigFile = path.join(tasksDir, `${today}.json`);
const dummy = { id: 'x', task: 'x'.repeat(200), completed: false };
const items = [];
for (let i = 0; i < 30000; i++) items.push({ ...dummy, id: 't' + i });
fs.writeFileSync(bigFile, JSON.stringify(items), 'utf-8');
const size = fs.statSync(bigFile).size;
console.log(`  file size: ${(size / 1024 / 1024).toFixed(2)}MB`);
assert(size > 5 * 1024 * 1024, 'test file should be >5MB');

const result4 = loadTasksFromFile();
const archivedFiles = fs.readdirSync(tasksDir).filter(f => f.includes('_corrupted_'));
assert(archivedFiles.length > 0, 'should create archive file');
assert(!fs.existsSync(bigFile) || fs.statSync(bigFile).size < 5 * 1024 * 1024, 'old file should be moved');

// --- 测试 5: 多次调用不重复追加（模拟 setInterval 场景）---
console.log('\nTest 5: repeated calls do not inflate');
fs.rmSync(tasksDir, { recursive: true });
ensureDir(tasksDir);

writeJSON(path.join(tasksDir, `${yesterday}.json`), [
  { id: 't10', task: 'yesterday-unfinished', completed: false, createdAt: '2026-01-01', alarmTime: null },
]);
const freshTodayFile = path.join(tasksDir, `${today}.json`);
if (fs.existsSync(freshTodayFile)) fs.unlinkSync(freshTodayFile);

// 第一次调用（isNewDay=true，创建文件）
const r5a = loadTasksFromFile();
assertEquals(r5a.length, 1, 'first call should have 1 task');

// 模拟 setInterval 再调用 10 次（文件已存在且今天创建，isNewDay=false）
for (let i = 0; i < 10; i++) {
  loadTasksFromFile();
}
const r5b = loadTasksFromFile();
assertEquals(r5b.length, 1, `after 10 calls should still be 1 (got ${r5b.length})`);

// Cleanup
fs.rmSync(testDir, { recursive: true });

// Summary
console.log(`\n==========`);
console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
