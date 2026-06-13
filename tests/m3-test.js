// M3 单元测试：数据存储模块
// 运行: "C:/Program Files/nodejs/node" tests/m3-test.js

const fs = require('fs');
const path = require('path');
const os = require('os');
let passed = 0, failed = 0;

function assert(condition, name) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`); }
}

const testDir = path.join(os.tmpdir(), 'sticky-notes-m3-test');

function clean() { if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true }); }
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function readJSON(fp) {
  try { return fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf-8')) : null; }
  catch (e) { return null; }
}
function writeJSON(fp, data) { ensureDir(path.dirname(fp)); fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8'); }

function getToday() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function getYesterday() { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

function loadTasksFromFile(basePath) {
  const today = getToday();
  let tasks = readJSON(path.join(basePath, 'tasks', `${today}.json`)) || [];
  const yesterday = getYesterday();
  const yesterdayTasks = readJSON(path.join(basePath, 'tasks', `${yesterday}.json`));
  if (yesterdayTasks) {
    const unfinished = yesterdayTasks.filter(t => !t.completed);
    if (unfinished.length > 0) {
      unfinished.forEach(t => { t.createdAt = new Date().toISOString(); t.id = 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); });
      tasks = [...unfinished, ...tasks];
    }
  }
  return tasks;
}

function saveTasksToFile(basePath, tasks) {
  writeJSON(path.join(basePath, 'tasks', `${getToday()}.json`), tasks);
}

// ========== 测试 1：文件读写 ==========
console.log('\n📋 文件读写');
clean();
const taskData = [{ id: 't1', task: '测试任务', completed: false, createdAt: new Date().toISOString(), completedAt: null }];
saveTasksToFile(testDir, taskData);
const loaded = loadTasksFromFile(testDir);
assert(loaded.length === 1, '保存后加载 1 条任务');
assert(loaded[0].task === '测试任务', '任务内容正确');
assert(loaded[0].completed === false, '未完成状态正确');

// ========== 测试 2：多任务保存加载 ==========
console.log('\n📋 多任务保存加载');
clean();
const multiTasks = [
  { id: 't1', task: '任务A', completed: false, createdAt: new Date().toISOString(), completedAt: null },
  { id: 't2', task: '任务B', completed: true, createdAt: new Date().toISOString(), completedAt: new Date().toISOString() },
  { id: 't3', task: '任务C', completed: false, createdAt: new Date().toISOString(), completedAt: null },
];
saveTasksToFile(testDir, multiTasks);
const loadedMulti = loadTasksFromFile(testDir);
assert(loadedMulti.length === 3, '加载 3 条任务');
assert(loadedMulti[1].completed === true, '已完成状态正确');

// ========== 测试 3：昨天未完成任务迁移 ==========
console.log('\n📋 跨天任务迁移');
clean();
const yesterdayDate = getYesterday();
const todayDate = getToday();
// 写入昨天的数据（2 条完成 + 2 条未完成）
const yesterdayTasks = [
  { id: 'y1', task: '昨天已完成', completed: true, createdAt: '2026-06-12T10:00:00', completedAt: '2026-06-12T15:00:00' },
  { id: 'y2', task: '昨天未完成1', completed: false, createdAt: '2026-06-12T10:00:00', completedAt: null },
  { id: 'y3', task: '昨天已完成2', completed: true, createdAt: '2026-06-12T11:00:00', completedAt: '2026-06-12T16:00:00' },
  { id: 'y4', task: '昨天未完成2', completed: false, createdAt: '2026-06-12T12:00:00', completedAt: null },
];
writeJSON(path.join(testDir, 'tasks', `${yesterdayDate}.json`), yesterdayTasks);

// 写入今天的 1 条任务
const todayTasks = [{ id: 't1', task: '今天任务', completed: false, createdAt: '2026-06-13T08:00:00', completedAt: null }];
saveTasksToFile(testDir, todayTasks);

const loaded2 = loadTasksFromFile(testDir);
console.log(`  加载到 ${loaded2.length} 条任务`);
// 应该：2条昨天未完成 + 1条今天 = 3条
// 检查昨天已完成的不在其中
const completedFromYesterday = loaded2.filter(t => t.id === 'y1' || t.id === 'y3');
assert(completedFromYesterday.length === 0, '昨天已完成的不出现');
// 检查昨天未完成的在其中（已更新 id）
const unfinishedFromYesterday = loaded2.filter(t => t.task === '昨天未完成1' || t.task === '昨天未完成2');
assert(unfinishedFromYesterday.length === 2, '昨天 2 条未完成的出现');
// 今天的任务在其中
const todayOne = loaded2.find(t => t.task === '今天任务');
assert(!!todayOne, '今天任务仍在');

// ========== 测试 4：空数据加载 ==========
console.log('\n📋 空数据加载');
clean();
const empty = loadTasksFromFile(testDir);
assert(Array.isArray(empty), '空数据返回数组');
assert(empty.length === 0, '空数据为空数组');

// ========== 测试 5：损坏的 JSON 文件 ==========
console.log('\n📋 损坏 JSON 容错');
clean();
ensureDir(path.join(testDir, 'tasks'));
fs.writeFileSync(path.join(testDir, 'tasks', `${getToday()}.json`), '这不是合法JSON{');
const corrupt = loadTasksFromFile(testDir);
assert(Array.isArray(corrupt), '损坏文件返回数组');
assert(corrupt.length === 0, '损坏文件返回空数组');

// ========== 清理 ==========
clean();
console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
process.exit(failed > 0 ? 1 : 0);
