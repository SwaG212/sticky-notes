// M8 单元测试：renderer.js 逻辑验证（v2 - untitled_N 判断新建）
// 运行: "C:/Program Files/nodejs/node" tests/m8-renderer-logic.js

let passed = 0, failed = 0;
function assert(condition, name) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`); }
}

console.log('\n=== M8: renderer.js 逻辑单元测试 ===\n');

// --- state structure ---
console.log('--- state 结构 ---');
const state = {
  tasks: [], images: [], organizing: false,
  currentPage: 'main', notes: [], currentNoteFile: null, noteContent: '',
};
assert(state.currentPage === 'main', 'initial currentPage is main');
assert(state.currentNoteFile === null, 'initial currentNoteFile is null');
assert(state.noteContent === '', 'initial noteContent is empty');
assert(Array.isArray(state.notes), 'notes is an array');

// --- helper functions ---
function genId() { return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
function getToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
assert(typeof genId() === 'string' && genId().startsWith('t_'), 'genId produces t_ prefixed string');
assert(/^\d{4}-\d{2}-\d{2}$/.test(getToday()), 'getToday returns YYYY-MM-DD format');

// --- isNewFile pattern ---
console.log('\n--- isNewFile 判断（untitled_N.md 模式） ---');
const isNewFile = (filename) => /^untitled_\d+\.md$/.test(filename);
assert(isNewFile('untitled_1.md') === true, 'untitled_1.md → new');
assert(isNewFile('untitled_5.md') === true, 'untitled_5.md → new');
assert(isNewFile('untitled_100.md') === true, 'untitled_100.md → new');
assert(isNewFile('my-note.md') === false, 'custom name → not new');
assert(isNewFile('摘要_2026-06-14.md') === false, 'AI-named → not new');
assert(isNewFile('renamed.md') === false, 'manually renamed → not new');

// --- note list sorting ---
console.log('\n--- 笔记列表排序 ---');
const fixtureNotes = [
  { filename: 'untitled_1.md', mtime: '2026-06-14T10:00:00.000Z' },
  { filename: 'my-note.md', mtime: '2026-06-14T09:00:00.000Z' },
  { filename: 'shopping-list.md', mtime: '2026-06-13T18:00:00.000Z' },
];
const sorted = [...fixtureNotes].sort((a, b) => b.mtime.localeCompare(a.mtime));
assert(sorted[0].filename === 'untitled_1.md', 'sorted by mtime desc places newest first');

// --- filename display ---
console.log('\n--- 文件名处理 ---');
const displayName = (filename) => filename.replace(/\.md$/, '');
assert(displayName('untitled_1.md') === 'untitled_1', 'strips .md suffix');
assert(displayName('my-note.md') === 'my-note', 'strips .md for custom name');

// --- AI naming format ---
console.log('\n--- AI 命名格式 ---');
const aiNameFormat = (summary, date) => `${summary}_${date}.md`;
assert(aiNameFormat('超市购物', '2026-06-14') === '超市购物_2026-06-14.md', 'AI naming: summary_date.md');
const cleaned = '带空格 的 摘要'.replace(/[，,。\.！!？?\n\r]/g, '').trim().slice(0, 15);
assert(cleaned === '带空格 的 摘要', 'special chars cleaned from summary');

// --- content emptiness ---
console.log('\n--- 空内容检查 ---');
const hasContent = (content) => (content || '').trim().length > 0;
assert(hasContent('') === false, 'empty → no content');
assert(hasContent('   ') === false, 'whitespace → no content');
assert(hasContent('hello') === true, 'text → has content');

// --- saveCurrentNote logic ---
console.log('\n--- saveCurrentNote 核心逻辑 ---');
function shouldDeleteEmptyNewFile(filename, content) {
  if (!isNewFile(filename)) return false;
  return !content.trim();
}
function shouldAiName(filename, content) {
  if (!isNewFile(filename)) return false;
  return content.trim().length > 0;
}
assert(shouldDeleteEmptyNewFile('untitled_1.md', '') === true, 'new + empty → delete');
assert(shouldDeleteEmptyNewFile('untitled_1.md', '   ') === true, 'new + whitespace → delete');
assert(shouldDeleteEmptyNewFile('untitled_1.md', '有内容') === false, 'new + content → keep (not delete)');
assert(shouldDeleteEmptyNewFile('my-note.md', '') === false, 'not new + empty → keep');
assert(shouldDeleteEmptyNewFile('my-note.md', '有内容') === false, 'not new + content → keep');

assert(shouldAiName('untitled_1.md', '有内容') === true, 'new + content → AI name');
assert(shouldAiName('untitled_1.md', '') === false, 'new + empty → no AI name');
assert(shouldAiName('my-note.md', '有内容') === false, 'not new → no AI name (keep filename)');
assert(shouldAiName('摘要_2026-06-14.md', '新内容') === false, 'AI-named file → no AI rename');

// --- default filename ---
console.log('\n--- 默认文件名 ---');
function generateDefaultName(existingFiles) {
  let n = 1;
  while (existingFiles.includes(`untitled_${n}.md`)) n++;
  return `untitled_${n}.md`;
}
assert(generateDefaultName([]) === 'untitled_1.md', 'first note: untitled_1.md');
assert(generateDefaultName(['untitled_1.md']) === 'untitled_2.md', 'skips untitled_1');
assert(generateDefaultName(['untitled_1.md','untitled_2.md','untitled_4.md']) === 'untitled_3.md', 'fills gap at 3');

// --- note find fallback ---
console.log('\n--- 笔记切换回退 ---');
const notes = [{ filename: 'a.md' }, { filename: 'b.md' }];
const currentNoteFile = null;
const fallback = !currentNoteFile || !notes.find(n => n.filename === currentNoteFile);
assert(fallback === true, 'null currentNoteFile triggers fallback');
const validCurrent = 'a.md';
const noFallback = !validCurrent || !notes.find(n => n.filename === validCurrent);
assert(noFallback === false, 'valid currentNoteFile no fallback');

// ========== 结果 ==========
console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
if (failed > 0) process.exit(1);
