const logic = require('../renderer/monitor-logic.js');
let passed = 0, failed = 0;
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, msg) { if (!Object.is(actual, expected)) throw new Error(msg + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual)); }
function has(arr, item, msg) { if (!Array.isArray(arr) || arr.indexOf(item) < 0) throw new Error(msg + '：期望包含 ' + item + '，实际 ' + JSON.stringify(arr)); }
function test(desc, fn) { try { fn(); passed++; console.log('  ✓ ' + desc); } catch (e) { failed++; console.log('  ✗ ' + desc + '：' + e.message); } }

console.log('\n[1] 旧任务缺全部新字段');
test('completed=false 推导 waiting，默认 local/null/0', () => {
  const r = logic.normalizeTask({ task: '旧任务', completed: false });
  eq(r.task.source, 'local', 'source');
  eq(r.task.model, null, 'model');
  eq(r.task.progress, 0, 'progress');
  eq(r.task.status, 'waiting', 'status');
  eq(logic.isMuseTask(r.task), false, 'isMuseTask');
});
test('completed=true 推导 completed', () => {
  const r = logic.normalizeTask({ task: '旧任务', completed: true });
  eq(r.task.status, 'completed', 'status');
});

console.log('\n[2] muse 与 source');
test('source=muse 且缺字段', () => {
  const r = logic.normalizeTask({ source: 'muse', completed: false });
  eq(r.task.model, null, 'model');
  eq(r.task.progress, 0, 'progress');
  eq(r.task.status, 'waiting', 'status');
  eq(logic.isMuseTask(r.task), true, 'isMuseTask');
});
test('source=Muse 不算 muse', () => {
  const r = logic.normalizeTask({ source: 'Muse' });
  eq(r.task.source, 'local', 'source');
  has(r.warnings, 'source-unknown', 'warnings');
  eq(logic.isMuseTask({ source: 'Muse' }), false, 'isMuseTask');
});
test('未知 source 加警告并归为 local', () => {
  const r = logic.normalizeTask({ source: 'remote' });
  eq(r.task.source, 'local', 'source');
  has(r.warnings, 'source-unknown', 'warnings');
});

console.log('\n[3] model/progress/status 归一化');
test('未知 model 原样保留并警告', () => {
  const r = logic.normalizeTask({ model: 'GPT-9' });
  eq(r.task.model, 'GPT-9', 'model');
  has(r.warnings, 'model-unknown', 'warnings');
});
test('progress -5 clamp 到 0', () => {
  eq(logic.normalizeTask({ progress: -5 }).task.progress, 0, 'progress');
});
test('progress 150 clamp 到 100', () => {
  eq(logic.normalizeTask({ progress: 150 }).task.progress, 100, 'progress');
});
test('progress 12.6 四舍五入到 13', () => {
  eq(logic.normalizeTask({ progress: 12.6 }).task.progress, 13, 'progress');
});
test('progress 字符串置 0 并警告', () => {
  const r = logic.normalizeTask({ progress: '50' });
  eq(r.task.progress, 0, 'progress');
  has(r.warnings, 'progress-invalid', 'warnings');
});
test('未知 status 归 waiting 并警告', () => {
  const r = logic.normalizeTask({ status: 'bogus' });
  eq(r.task.status, 'waiting', 'status');
  has(r.warnings, 'status-unknown', 'warnings');
});

console.log('\n[4] completed 与 status 冲突');
test('completed=true 且 status=running', () => {
  const r = logic.normalizeTask({ completed: true, status: 'running' });
  eq(r.task.status, 'completed', 'status');
  has(r.warnings, 'completed-status-conflict', 'warnings');
});
test('completed=false 且 status=completed', () => {
  const r = logic.normalizeTask({ completed: false, status: 'completed' });
  eq(r.task.status, 'completed', 'status');
  has(r.warnings, 'completed-status-conflict', 'warnings');
});

console.log('\n[5] createdAt 与格式化');
test('createdAt 无效置 null 并警告', () => {
  const r = logic.normalizeTask({ createdAt: 'not-a-date' });
  eq(r.task.createdAt, null, 'createdAt');
  has(r.warnings, 'createdAt-invalid', 'warnings');
});
test('formatCreatedAt 无效返回 未知', () => {
  eq(logic.formatCreatedAt('not-a-date'), '未知', 'formatCreatedAt');
  eq(logic.formatCreatedAt(undefined), '未知', 'formatCreatedAt');
});
test('formatCreatedAt 有效形如 YYYY-MM-DD HH:mm', () => {
  const s = logic.formatCreatedAt('2024-01-02T03:04:00.000Z');
  ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s), '格式不符：' + s);
});

console.log('\n[6] formatRuntime');
const nowMs = Date.UTC(2024, 0, 10, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
test('未完成 30 秒前创建', () => {
  eq(logic.formatRuntime({ status: 'running', completed: false, createdAt: iso(nowMs - 30 * 1000) }, nowMs), '不足 1 分钟', 'runtime');
});
test('未完成 18 分钟前创建', () => {
  eq(logic.formatRuntime({ status: 'running', completed: false, createdAt: iso(nowMs - 18 * 60 * 1000) }, nowMs), '18 分钟', 'runtime');
});
test('未完成 2 小时 8 分钟前创建', () => {
  const ms = nowMs - (2 * 60 + 8) * 60 * 1000;
  eq(logic.formatRuntime({ status: 'running', completed: false, createdAt: iso(ms) }, nowMs), '2 小时 08 分钟', 'runtime');
});
test('未完成 3 天 4 小时 8 分钟前创建', () => {
  const ms = nowMs - (((3 * 24 + 4) * 60 + 8) * 60 * 1000);
  eq(logic.formatRuntime({ status: 'running', completed: false, createdAt: iso(ms) }, nowMs), '3 天 04 小时 08 分钟', 'runtime');
});
test('已完成耗时 65 分钟', () => {
  const createdAt = iso(nowMs - 65 * 60 * 1000);
  const completedAt = iso(nowMs);
  eq(logic.formatRuntime({ status: 'completed', completed: true, createdAt, completedAt }, nowMs), '1 小时 05 分钟', 'runtime');
});
test('completedAt 缺失返回 —', () => {
  eq(logic.formatRuntime({ status: 'completed', completed: true, createdAt: iso(nowMs - 1000) }, nowMs), '—', 'runtime');
});
test('completedAt 早于 createdAt 返回 —', () => {
  eq(logic.formatRuntime({ status: 'completed', completed: true, createdAt: iso(nowMs), completedAt: iso(nowMs - 60000) }, nowMs), '—', 'runtime');
});
test('createdAt 在未来返回 —', () => {
  eq(logic.formatRuntime({ status: 'running', completed: false, createdAt: iso(nowMs + 60000) }, nowMs), '—', 'runtime');
});
test('createdAt 缺失返回 —', () => {
  eq(logic.formatRuntime({ status: 'running', completed: false }, nowMs), '—', 'runtime');
});

console.log('\n[7] 不可变与 displayProgress');
test('normalizeTask 不修改输入对象', () => {
  const raw = { task: 'x', source: 'muse', model: 'Sol', progress: 12.6, status: 'running', completed: false, createdAt: '2024-01-01T00:00:00.000Z', completedAt: null, extra: 'keep', nested: { a: 1 } };
  const before = JSON.stringify(raw);
  const r = logic.normalizeTask(raw);
  eq(JSON.stringify(raw), before, '输入对象');
  eq(r.task.extra, 'keep', '原字段');
});
test('displayProgress 已完成返回 100', () => {
  eq(logic.displayProgress({ status: 'completed', progress: 60 }), 100, 'displayProgress');
});
test('displayProgress 未完成返回 progress', () => {
  eq(logic.displayProgress({ status: 'running', progress: 42 }), 42, 'displayProgress');
});

console.log('\n通过 ' + passed + ' 失败 ' + failed);
process.exit(failed ? 1 : 0);
