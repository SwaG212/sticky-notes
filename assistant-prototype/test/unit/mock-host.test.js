'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SandboxStore } = require('../../src/storage/sandbox-store');
const { MockHostAdapter } = require('../../src/host/mock-host-adapter');

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asst-sandbox-'));
  const store = new SandboxStore({ dataDir: dir });
  store.init();
  return { dir, store, host: new MockHostAdapter(store) };
}

test('createTask 写入当天任务文件', async () => {
  const { dir, host } = makeSandbox();
  const res = await host.createTask({ title: '发合同', project: '国寿' });
  assert.equal(res.ok, true);
  assert.ok(res.data.id.startsWith('task_'));
  const file = path.join(dir, 'tasks', `${new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)}.json`);
  assert.ok(fs.existsSync(file));
  const tasks = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].task, '发合同');
  assert.equal(tasks[0].completed, false);
});

test('completeTask 按标题定位并标记完成', async () => {
  const { host } = makeSandbox();
  await host.createTask({ title: '发合同' });
  const res = await host.completeTask({ title: '发合同' });
  assert.equal(res.ok, true);
  assert.equal(res.data.completed, true);
});

test('completeTask 找不到任务返回 TASK_NOT_FOUND', async () => {
  const { host } = makeSandbox();
  const res = await host.completeTask({ title: '不存在' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'TASK_NOT_FOUND');
});

test('同名任务完成时返回 AMBIGUOUS_TARGET', async () => {
  const { host } = makeSandbox();
  await host.createTask({ title: '巡检' });
  await host.createTask({ title: '巡检' });
  const res = await host.completeTask({ title: '巡检' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'AMBIGUOUS_TARGET');
  assert.ok(res.error.details.candidates.length === 2);
});

test('setReminder 无对应任务时自动创建', async () => {
  const { host } = makeSandbox();
  const res = await host.setReminder({ title: '喝水', time: '2026-08-13T15:00:00+08:00' });
  assert.equal(res.ok, true);
  assert.equal(res.data.alarmTime, '2026-08-13T15:00:00+08:00');
});

test('createNote 落盘为 md 并登记 meta', async () => {
  const { dir, host } = makeSandbox();
  const res = await host.createNote({ title: '会议纪要', content: '1. 结论' });
  assert.equal(res.ok, true);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'notes', 'meta.json'), 'utf8'));
  const note = meta[res.data.id];
  assert.equal(note.title, '会议纪要');
  assert.ok(fs.existsSync(path.join(dir, 'notes', note.fileName)));
});

test('appendNote 向已有笔记追加', async () => {
  const { host } = makeSandbox();
  const created = await host.createNote({ title: '纪要', content: '第一条' });
  const res = await host.appendNote({ noteId: created.data.id, append: '第二条' });
  assert.equal(res.ok, true);
  assert.equal(res.data.content, '第一条\n第二条');
  assert.equal(res.effect.reversible, false); // 追加不可撤销
});

test('appendNote 找不到笔记返回 NOTE_NOT_FOUND', async () => {
  const { host } = makeSandbox();
  const res = await host.appendNote({ noteId: 'note_missing', append: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'NOTE_NOT_FOUND');
});

test('searchNotes 按标题和内容检索', async () => {
  const { host } = makeSandbox();
  await host.createNote({ title: '周报', content: '本周完成合同核对' });
  await host.createNote({ title: '食谱', content: '红烧肉' });
  const res = await host.searchNotes({ query: '合同' });
  assert.equal(res.ok, true);
  assert.equal(res.data.length, 1);
  assert.equal(res.data[0].title, '周报');
});

test('generateDailyReport 汇总当天完成情况', async () => {
  const { host } = makeSandbox();
  await host.createTask({ title: 'A' });
  const b = await host.createTask({ title: 'B' });
  await host.completeTask({ taskId: b.data.id });
  const res = await host.generateDailyReport({});
  assert.equal(res.ok, true);
  assert.ok(res.data.report.includes('- 完成：1 项'));
  assert.ok(res.data.report.includes('- 未完成：1 项'));
});

test('openPage 只接受白名单页面', async () => {
  const { host } = makeSandbox();
  assert.equal((await host.openPage({ page: 'tasks' })).ok, true);
  const bad = await host.openPage({ page: 'registry' });
  assert.equal(bad.ok, false);
});

test('organizeTodayTasks 按项目过滤', async () => {
  const { host } = makeSandbox();
  await host.createTask({ title: 'x1', project: '国寿' });
  await host.createTask({ title: 'x2', project: '中加' });
  const res = await host.organizeTodayTasks({ project: '国寿' });
  assert.equal(res.data.total, 1);
  assert.deepEqual(res.data.pending, ['x1']);
});
