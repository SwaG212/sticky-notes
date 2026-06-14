// M7 单元测试：笔记文件存储模块（v2 - 无 meta 追踪）
// 运行: "C:/Program Files/nodejs/node" tests/m7-note-storage.js

const fs = require('fs');
const path = require('path');
const os = require('os');
let passed = 0, failed = 0;

function assert(condition, name) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`); }
}

const testDir = path.join(os.tmpdir(), 'sticky-notes-m7-test');

function clean() { if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true }); }
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

// ========== 复制自 main.js 的笔记存储函数（v2） ==========
const notesDir = path.join(testDir, 'notes');

function listNotes() {
  ensureDir(notesDir);
  const files = fs.readdirSync(notesDir).filter(f => f.endsWith('.md'));
  return files.map(f => {
    const stat = fs.statSync(path.join(notesDir, f));
    return { filename: f, mtime: stat.mtime.toISOString() };
  }).sort((a, b) => b.mtime.localeCompare(a.mtime));
}

function readNote(filename) {
  const filePath = path.join(notesDir, filename);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

function saveNote(filename, content) {
  ensureDir(notesDir);
  fs.writeFileSync(path.join(notesDir, filename), content, 'utf-8');
}

function createNote() {
  ensureDir(notesDir);
  const existing = fs.readdirSync(notesDir).filter(f => f.endsWith('.md'));
  let n = 1;
  while (existing.includes(`untitled_${n}.md`)) n++;
  const filename = `untitled_${n}.md`;
  fs.writeFileSync(path.join(notesDir, filename), '', 'utf-8');
  return filename;
}

function renameNoteFile(oldName, newName) {
  const oldPath = path.join(notesDir, oldName);
  const newPath = path.join(notesDir, newName);
  if (!fs.existsSync(oldPath)) throw new Error('FILE_NOT_FOUND');
  if (fs.existsSync(newPath)) throw new Error('FILE_EXISTS');
  fs.renameSync(oldPath, newPath);
}

function deleteNoteFile(filename) {
  const filePath = path.join(notesDir, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// ========== 测试 ==========
console.log('\n=== M7: 笔记文件存储模块单元测试 ===\n');

// --- createNote ---
console.log('--- createNote ---');
clean();
const name1 = createNote();
assert(name1 === 'untitled_1.md', 'createNote #1 creates untitled_1.md');
assert(fs.existsSync(path.join(notesDir, 'untitled_1.md')), 'untitled_1.md file exists on disk');
assert(readNote(name1) === '', 'new note content is empty');

const name2 = createNote();
assert(name2 === 'untitled_2.md', 'createNote #2 creates untitled_2.md');

fs.writeFileSync(path.join(notesDir, 'untitled_3.md'), 'pre-existing', 'utf-8');
const name4 = createNote();
assert(name4 === 'untitled_4.md', 'createNote skips existing to create untitled_4.md');

// --- saveNote / readNote ---
console.log('\n--- saveNote / readNote ---');
saveNote('untitled_1.md', 'Hello 世界');
assert(readNote('untitled_1.md') === 'Hello 世界', 'saveNote writes and readNote reads correct content');

saveNote('untitled_1.md', 'Overwritten!');
assert(readNote('untitled_1.md') === 'Overwritten!', 'saveNote overwrites existing content');
assert(readNote('nonexistent.md') === '', 'readNote returns empty for non-existent file');

// --- listNotes ---
console.log('\n--- listNotes ---');
saveNote('untitled_2.md', 'content 2');
const list1 = listNotes();
assert(list1.length === 4, 'listNotes returns 4 files');
assert(list1[0].filename, 'listNotes entries have filename');
assert(list1[0].mtime, 'listNotes entries have mtime');
assert(!list1[0].hasOwnProperty('manuallyRenamed'), 'listNotes no longer returns manuallyRenamed field');
assert(new Date(list1[0].mtime) >= new Date(list1[1].mtime), 'listNotes sorted by mtime desc');

// --- renameNoteFile ---
console.log('\n--- renameNoteFile ---');
renameNoteFile('untitled_1.md', 'my-renamed-note.md');
const list2 = listNotes();
assert(list2.some(n => n.filename === 'my-renamed-note.md'), 'renamed file appears in list');
assert(!list2.some(n => n.filename === 'untitled_1.md'), 'old filename removed');
assert(readNote('my-renamed-note.md') === 'Overwritten!', 'renamed file preserves content');

// rename edge cases
try { renameNoteFile('nonexistent.md', 'x.md'); assert(false, 'rename non-existent should throw'); }
catch (e) { assert(e.message === 'FILE_NOT_FOUND', 'rename non-existent throws FILE_NOT_FOUND'); }

saveNote('test-a.md', 'A');
saveNote('test-b.md', 'B');
try { renameNoteFile('test-a.md', 'test-b.md'); assert(false, 'rename to existing should throw'); }
catch (e) { assert(e.message === 'FILE_EXISTS', 'rename to existing throws FILE_EXISTS'); }

// rename again — no error
renameNoteFile('my-renamed-note.md', 'renamed-again.md');
assert(fs.existsSync(path.join(notesDir, 'renamed-again.md')), 'second rename succeeds');

// --- deleteNoteFile ---
console.log('\n--- deleteNoteFile ---');
deleteNoteFile('test-a.md');
assert(!fs.existsSync(path.join(notesDir, 'test-a.md')), 'deleted file removed from disk');
deleteNoteFile('nonexistent.md'); // no error
assert(true, 'deleteNoteFile on non-existent does not throw');

// --- isNewFile pattern check ---
console.log('\n--- isNewFile 判断 ---');
const isNewFile = (filename) => /^untitled_\d+\.md$/.test(filename);
assert(isNewFile('untitled_1.md') === true, 'untitled_1.md is a new file');
assert(isNewFile('untitled_99.md') === true, 'untitled_99.md is a new file');
assert(isNewFile('my-note.md') === false, 'my-note.md is NOT a new file');
assert(isNewFile('摘要_2026-06-14.md') === false, 'AI-named file is NOT a new file');
assert(isNewFile('untitled_.md') === false, 'malformed untitled is not new');
assert(isNewFile('untitled_abc.md') === false, 'non-numeric untitled is not new');

// --- notesDir auto-created ---
console.log('\n--- ensureDir behavior ---');
clean();
createNote();
assert(fs.existsSync(notesDir), 'notesDir auto-created by createNote');

// Cleanup
clean();

// ========== 结果 ==========
console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
if (failed > 0) process.exit(1);
