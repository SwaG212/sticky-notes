'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ActionRegistry } = require('../../src/execution/action-registry');
const { registerActions } = require('../../src/main/register-actions');
const { AppError, ERROR_CODES } = require('../../src/shared/errors');

function makeRegistry() {
  const r = new ActionRegistry();
  registerActions(r);
  return r;
}

const stubHost = {
  async createTask(args, opts) { void opts; return { ok: true, data: { id: 't1' }, effect: { summary: '已创建', reversible: true } }; },
  async searchNotes(args, opts) { void args; void opts; return { ok: true, data: [], effect: { summary: '搜到 0 条', reversible: true } }; },
};

test('10 个动作全部注册', () => {
  const r = makeRegistry();
  assert.deepEqual(r.list().sort(), [
    'append_note', 'complete_task', 'create_note', 'create_task',
    'generate_daily_report', 'open_page', 'organize_today_tasks',
    'search_notes', 'set_reminder', 'update_task',
  ].sort());
});

test('重复注册同一动作抛 CONFLICT', () => {
  const r = makeRegistry();
  assert.throws(
    () => r.register({ type: 'create_task', execute: async () => {} }),
    (e) => e.code === ERROR_CODES.CONFLICT,
  );
});

test('执行未注册动作抛 ACTION_UNKNOWN', async () => {
  const r = makeRegistry();
  await assert.rejects(
    () => r.execute('rm_rf', {}, { host: stubHost, signal: null, context: { actionRunId: 'r' } }),
    (e) => e instanceof AppError && e.code === ERROR_CODES.ACTION_UNKNOWN,
  );
});

test('参数不合法抛 ACTION_ARG_INVALID（白名单与 Schema 双重校验）', async () => {
  const r = makeRegistry();
  await assert.rejects(
    () => r.execute('create_task', { evil: 1 }, { host: stubHost, signal: null, context: { actionRunId: 'r' } }),
    (e) => e instanceof AppError && e.code === ERROR_CODES.ACTION_ARG_INVALID,
  );
});

test('合法参数执行成功并返回宿主结果', async () => {
  const r = makeRegistry();
  const res = await r.execute('create_task', { title: '买咖啡' }, { host: stubHost, signal: null, context: { actionRunId: 'run_1' } });
  assert.equal(res.ok, true);
  assert.equal(res.data.id, 't1');
});

test('只读动作执行不传 actionRunId（search_notes）', async () => {
  const r = makeRegistry();
  const host = {
    async searchNotes(args, opts) {
      assert.equal(opts.actionRunId, null);
      return { ok: true, data: [], effect: { summary: 'ok', reversible: true } };
    },
  };
  const res = await r.execute('search_notes', { query: 'x' }, { host, signal: null, context: { actionRunId: 'run_1' } });
  assert.equal(res.ok, true);
});

test('宿主返回 ok:false 时动作抛出带稳定错误码的异常', async () => {
  const r = makeRegistry();
  const host = {
    async createTask() {
      return { ok: false, error: { code: 'TASK_NOT_FOUND', message: '找不到任务' } };
    },
  };
  await assert.rejects(
    () => r.execute('create_task', { title: 'x' }, { host, signal: null, context: { actionRunId: 'r' } }),
    (e) => e instanceof AppError && e.code === 'TASK_NOT_FOUND',
  );
});
