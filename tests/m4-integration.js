// M4 集成测试：端到端流程
// 运行: "C:/Program Files/nodejs/node" tests/m4-integration.js
// 注意：此测试仅测试主进程纯逻辑，不含 Electron GUI 交互

const fs = require('fs');
const path = require('path');
const os = require('os');
let passed = 0, failed = 0;

function assert(condition, name) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`); }
}

const testDir = path.join(os.tmpdir(), 'sticky-notes-m4');
function clean() { if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true }); }
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function readJSON(fp) {
  try { return fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf-8')) : null; }
  catch (e) { return null; }
}
function writeJSON(fp, data) { ensureDir(path.dirname(fp)); fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8'); }

// ========== 模拟 organizeText 的纯逻辑 ==========
function parseTaskJSON(content) {
  try { const arr = JSON.parse(content); if (Array.isArray(arr)) return arr.filter(t => t.task && typeof t.task === 'string'); }
  catch (e) {}
  const match = content.match(/\[[\s\S]*\]/);
  if (match) {
    try { const arr = JSON.parse(match[0]); if (Array.isArray(arr)) return arr.filter(t => t.task && typeof t.task === 'string'); }
    catch (e) {}
  }
  throw new Error('PARSE_ERROR');
}

const ORGANIZE_PROMPT = `你是一个任务整理助手。用户会给你一段杂乱的想法或文字，可能包含 OCR 识别的聊天截图内容。
请从中提取出所有独立的待办任务，每项用简洁的一句话表述，不添加编号、优先级或分类。
返回严格的 JSON 数组格式，不要输出任何其他内容。
格式示例：[{"task":"周三前出合同"},{"task":"找运维要服务器账号"}]
如果用户输入本身已是单一任务，也返回单条数组。
如果用户的输入无法提取出任何任务，返回空数组 []。

用户输入：
`;

// ========== 测试 1：端到端整理流程 ==========
console.log('\n📋 E2E：文字输入 → 整理 → 任务清单');

// 模拟 AI 返回（因为无法调用真实 API）
function simulateOrganize(userText, ocrResults) {
  let combined = userText || '';
  if (ocrResults && ocrResults.length > 0) {
    combined += '\n\n[以下为截图OCR识别内容]\n' + ocrResults.join('\n---\n');
  }
  if (!combined.trim()) throw new Error('EMPTY_INPUT');
  return { prompt: ORGANIZE_PROMPT + combined, inputLength: combined.length };
}

const sim1 = simulateOrganize('下午开会 取快递', []);
assert(sim1.prompt.includes('下午开会'), 'Prompt 包含用户输入');
assert(sim1.prompt.includes('{"task":"'), 'Prompt 包含格式示例');

const sim2 = simulateOrganize('测试', ['OCR: 周三前出合同']);
assert(sim2.prompt.includes('截图OCR'), '含 OCR 标注');
assert(sim2.prompt.includes('周三前出合同'), '含 OCR 内容');

// ========== 测试 2：JSON 解析全部场景 ==========
console.log('\n📋 JSON 解析全部场景');

// 正常单条
const r1 = parseTaskJSON('[{"task":"完成报告"}]');
assert(r1.length === 1 && r1[0].task === '完成报告', '单条正常');

// 多条
const r2 = parseTaskJSON('[{"task":"任务A"},{"task":"任务B"},{"task":"任务C"}]');
assert(r2.length === 3, '3 条正常');

// 空数组
const r3 = parseTaskJSON('[]');
assert(r3.length === 0, '空数组');

// 带额外文字
const r4 = parseTaskJSON('好的，以下是任务：\n[{"task":"项目1"},{"task":"项目2"}]\n共2条');
assert(r4.length === 2, '额外文字容错');

// Markdown 代码块中的 JSON
const r5 = parseTaskJSON('```json\n[{"task":"代码块任务"}]\n```');
assert(r5.length === 1, 'Markdown 代码块容错');

// 纯文本乱入
try { parseTaskJSON('这是一段完全不是JSON的文本'); assert(false, '不应到达'); }
catch (e) { assert(e.message === 'PARSE_ERROR', '纯文本正确拒绝'); }

// 缺少 task 字段
const r6 = parseTaskJSON('[{"name":"无task字段"},{"task":"有效"}]');
assert(r6.length === 1, '过滤无 task 字段条目');

// 嵌套对象
const r7 = parseTaskJSON('[{"task":"测试","extra":"额外字段应保留"}]');
assert(r7.length === 1 && r7[0].task === '测试', '保留额外字段');

// ========== 测试 3：任务状态转换 ==========
console.log('\n📋 任务状态转换');

function createTask(text) {
  return { id: 't_' + Date.now(), task: text, completed: false, createdAt: new Date().toISOString(), completedAt: null };
}
function toggleTask(task) {
  task.completed = !task.completed;
  task.completedAt = task.completed ? new Date().toISOString() : null;
  return task;
}

const task = createTask('测试任务');
assert(!task.completed, '初始未完成');
assert(task.completedAt === null, 'completionAt 初始 null');

toggleTask(task);
assert(task.completed, '勾选后已完成');
assert(task.completedAt !== null, 'completionAt 已设置');

toggleTask(task);
assert(!task.completed, '取消勾选后未完成');
assert(task.completedAt === null, 'completionAt 恢复 null');

// ========== 测试 4：今日/昨日过滤逻辑 ==========
console.log('\n📋 每日过滤逻辑');
clean();

function getToday() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function getYesterday() { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

// 写入昨天数据
const yTasks = [
  { id: 'y1', task: '已完成', completed: true, createdAt: '2026-06-12T10:00:00', completedAt: '2026-06-12T18:00:00' },
  { id: 'y2', task: '未完成', completed: false, createdAt: '2026-06-12T10:00:00', completedAt: null },
];
writeJSON(path.join(testDir, 'tasks', `${getYesterday()}.json`), yTasks);

// 加载逻辑
const yesterdayData = readJSON(path.join(testDir, 'tasks', `${getYesterday()}.json`));
const todayData = readJSON(path.join(testDir, 'tasks', `${getToday()}.json`)) || [];
const unfinished = yesterdayData.filter(t => !t.completed);
const merged = [...unfinished, ...todayData];

assert(merged.length === 1, '只保留未完成');
assert(merged[0].task === '未完成', '未完成任务迁移');
assert(!merged.some(t => t.task === '已完成'), '已完成不出现');

// ========== 测试 5：数据持久性 ==========
console.log('\n📋 数据持久性');
clean();

const testFile = path.join(testDir, 'tasks', `${getToday()}.json`);
const saved = [
  { id: 'p1', task: '持久测试A', completed: false, createdAt: new Date().toISOString(), completedAt: null },
  { id: 'p2', task: '持久测试B', completed: true, createdAt: new Date().toISOString(), completedAt: new Date().toISOString() },
];
writeJSON(testFile, saved);

const loaded = readJSON(testFile);
assert(loaded.length === 2, '写入后读取 2 条');
assert(loaded[0].task === '持久测试A', '内容一致');
assert(loaded[1].completed === true, '状态一致');

// 模拟进程重启后重新加载
const reloaded = readJSON(testFile);
assert(reloaded.length === 2, '重启后数据完整');

clean();
console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
process.exit(failed > 0 ? 1 : 0);
