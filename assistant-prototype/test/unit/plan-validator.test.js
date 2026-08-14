'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PlanValidator } = require('../../src/planning/plan-validator');
const { ActionRegistry } = require('../../src/execution/action-registry');
const { registerActions } = require('../../src/main/register-actions');

function makeValidator() {
  const registry = new ActionRegistry();
  registerActions(registry);
  return new PlanValidator(registry);
}

function plan(actions, extra = {}) {
  return { goal: '测试计划', actions, ...extra };
}

test('完整计划通过全部 8 项校验', () => {
  const v = makeValidator();
  const r = v.validate(plan([
    { type: 'create_task', args: { title: '发合同', dueDate: '2026-08-13' } },
  ]), { missingFields: [], assumptions: [] });
  assert.equal(r.valid, true);
  assert.deepEqual(r.issues, []);
});

test('条件 1：missingFields 非空则不通过', () => {
  const v = makeValidator();
  const r = v.validate(plan([{ type: 'set_reminder', args: { title: 'x', time: '2026-08-13T15:00:00+08:00' } }]), {
    missingFields: ['actions[0].args.time'],
  });
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.code === 'PLAN_MISSING_FIELDS'));
});

test('条件 2：assumptions 非空则不通过', () => {
  const v = makeValidator();
  const r = v.validate(plan([{ type: 'create_task', args: { title: 'x' } }]), {
    assumptions: ['默认在国寿项目下'],
  });
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.code === 'PLAN_ASSUMPTIONS_PRESENT'));
});

test('条件 3：未注册动作被拒绝', () => {
  const v = makeValidator();
  const r = v.validate(plan([{ type: 'send_email', args: {} }]));
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.code === 'PLAN_ACTION_UNKNOWN'));
});

test('条件 4：参数不过 Schema 被拒绝', () => {
  const v = makeValidator();
  const r = v.validate(plan([{ type: 'create_task', args: { title: 42 } }]));
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.code === 'ACTION_ARG_INVALID'));
});

test('条件 5：时间必须是绝对时间（带时区）', () => {
  const v = makeValidator();
  const r = v.validate(plan([{ type: 'set_reminder', args: { title: 'x', time: '2026-08-13 15:00' } }]));
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.code === 'TIME_NOT_ABSOLUTE'));
  // 带 +08:00 或 Z 的绝对时间通过
  const okZ = v.validate(plan([{ type: 'set_reminder', args: { title: 'x', time: '2026-08-13T07:00:00Z' } }]));
  assert.equal(okZ.valid, true);
});

test('条件 6：同一计划内既创建又完成同名任务被拒绝', () => {
  const v = makeValidator();
  const r = v.validate(plan([
    { type: 'create_task', args: { title: '巡检' } },
    { type: 'complete_task', args: { title: '巡检' } },
  ]));
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.code === 'TARGET_CONFLICT'));
});

test('条件 7：动作数超限被拒绝', () => {
  const v = makeValidator();
  const actions = Array.from({ length: 6 }, () => ({ type: 'create_task', args: { title: 'x' } }));
  const r = v.validate(plan(actions));
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.code === 'PLAN_RISK_REJECTED'));
});

test('条件 8：空计划被拒绝', () => {
  const v = makeValidator();
  assert.equal(v.validate(plan([])).valid, false);
});

test('同计划对两个不同对象各操作一次合法', () => {
  const v = makeValidator();
  const r = v.validate(plan([
    { type: 'create_task', args: { title: 'A' } },
    { type: 'create_note', args: { title: 'B', content: 'c' } },
  ]));
  assert.equal(r.valid, true);
});
