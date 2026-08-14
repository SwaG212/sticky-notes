'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ExecutionJournal } = require('../../src/execution/execution-journal');
const { Executor } = require('../../src/execution/executor');
const { ActionRegistry } = require('../../src/execution/action-registry');
const { SandboxStore } = require('../../src/storage/sandbox-store');
const { MockHostAdapter } = require('../../src/host/mock-host-adapter');
const { registerActions } = require('../../src/main/register-actions');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asst-journal-'));
  const journal = new ExecutionJournal({ journalDir: path.join(dir, 'journal') });
  const store = new SandboxStore({ dataDir: path.join(dir, 'sandbox') });
  store.init();
  const registry = new ActionRegistry();
  registerActions(registry);
  const host = new MockHostAdapter(store);
  const executor = new Executor({ registry, host, journal });
  return { dir, journal, executor, store, registry, host };
}

test('动作开始/成功/失败/取消各写一条日志，且 args 脱敏', () => {
  const { journal } = setup();
  const planId = 'plan_j1';
  const runId = journal.startAction({ planId, sessionId: 's1', actionType: 'create_task', args: { title: '发合同', secret: '长'.repeat(500) } });
  journal.finishAction({ planId, sessionId: 's1', actionRunId: runId, actionType: 'create_task', result: { id: 't1' }, effect: { summary: 'ok', reversible: true }, durationMs: 5 });
  journal.finishPlan({ planId, sessionId: 's1', status: 'completed', summary: { completed: 1 } });

  const entries = journal.read(planId);
  assert.equal(entries.length, 3);
  const start = entries[0];
  assert.equal(start.kind, 'action_start');
  assert.ok(start.args.title === '发合同'); // 短文本保留
  assert.ok(start.args.secret.length < 250); // 超长截断
});

test('summarize 区分完成/失败/未执行/不可撤销', () => {
  const { journal, executor, host } = setup();
  const planId = 'plan_j2';
  const s1 = journal.startAction({ planId, sessionId: 's', index: 0, actionType: 'create_task', args: { title: 'x' } });
  journal.finishAction({ planId, sessionId: 's', actionRunId: s1, actionType: 'create_task', result: { id: 't' }, effect: { summary: '已创建', reversible: true }, durationMs: 1 });
  const s2 = journal.startAction({ planId, sessionId: 's', index: 1, actionType: 'append_note', args: { append: 'y' } });
  journal.finishAction({ planId, sessionId: 's', actionRunId: s2, actionType: 'append_note', result: { id: 'n' }, effect: { summary: '已追加', reversible: false }, durationMs: 1 });
  const s3 = journal.startAction({ planId, sessionId: 's', index: 2, actionType: 'complete_task', args: { title: 'z' } });
  journal.failAction({ planId, sessionId: 's', actionRunId: s3, actionType: 'complete_task', code: 'TASK_NOT_FOUND', message: '找不到', durationMs: 1 });

  const summary = journal.summarize(planId, [
    { index: 0, actionType: 'create_task' }, { index: 1, actionType: 'append_note' },
    { index: 2, actionType: 'complete_task' }, { index: 3, actionType: 'create_note' },
  ]);
  assert.equal(summary.completed.length, 2);
  assert.ok(summary.completed.some((c) => c.actionType === 'create_task'));
  assert.equal(summary.interrupted.length, 1);
  assert.equal(summary.interrupted[0].error, 'TASK_NOT_FOUND');
  assert.deepEqual(summary.notExecuted, [{ actionType: 'create_note', title: null }]);
  assert.equal(summary.irreversible.length, 1);
  assert.equal(summary.irreversible[0].actionType, 'append_note');
});

test('重启后通过日志恢复未完成计划：跳过已完成、执行剩余（用户确认后）', async () => {
  const { dir, journal, executor } = setup();
  const planId = 'plan_j3';
  const plan = {
    planId,
    actions: [
      { type: 'create_task', args: { title: 'A' } },
      { type: 'create_task', args: { title: 'B' } },
      { type: 'create_task', args: { title: 'C' } },
    ],
  };

  // 第一轮：执行第一个动作后暂停（模拟执行中被终止）
  let boundaryChecks = 0;
  const r1 = await executor.execute({
    plan, sessionId: 's', signal: new AbortController().signal, startIndex: 0,
    shouldPause: () => ++boundaryChecks > 1,
  });
  assert.equal(r1.status, 'paused');
  assert.equal(r1.completed.length, 1);

  // "重启"：新 executor 实例，同一 journal 目录
  const store2 = new SandboxStore({ dataDir: path.join(dir, 'sandbox') });
  const registry2 = new ActionRegistry();
  registerActions(registry2);
  const host2 = new MockHostAdapter(store2);
  const executor2 = new Executor({ registry: registry2, host: host2, journal });

  // 推断已完成数量：journal 里 action_finish 的条数
  const entries = journal.read(planId);
  const done = entries.filter((e) => e.kind === 'action_finish').length;
  assert.equal(done, 1);

  // 用户确认恢复后从断点继续
  const r2 = await executor2.execute({ plan, sessionId: 's', signal: new AbortController().signal, startIndex: done });
  assert.equal(r2.status, 'completed');
  assert.equal(r2.completed.length, 2);
  assert.deepEqual(r2.completed.map((c) => c.actionType), ['create_task', 'create_task']);

  const tasks = store2.listTasks();
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks.map((t) => t.task).sort(), ['A', 'B', 'C'].sort());
});

test('中断动作记录：已开始未结束视为中断', () => {
  const { journal } = setup();
  const planId = 'plan_j4';
  journal.startAction({ planId, sessionId: 's', actionType: 'create_task', args: { title: 'x' } });
  // 无 finish/cancel 记录
  const summary = journal.summarize(planId, [{ actionType: 'create_task' }]);
  assert.equal(summary.interrupted.length, 1);
  assert.equal(summary.interrupted[0].interrupted, true);
  assert.equal(summary.completed.length, 0);
});
