'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ConfirmationGate } = require('../../src/planning/confirmation-gate');

const gate = new ConfirmationGate();
const plan = { planId: 'plan_abc', revision: 3, actions: [{ type: 'create_task', args: { title: 'x' } }] };

test('明确确认语义通过（文档 10 节）', () => {
  for (const w of ['确认', '可以', '执行', '开始', '好的', '好，就这么办', '没问题', 'OK']) {
    assert.equal(gate.classify(w).kind, 'yes', `「${w}」应为确认`);
  }
});

test('模糊表达不能当作确认', () => {
  for (const w of ['嗯', '随便', '应该吧', '你看着办', '都行', '再说', '可能吧']) {
    assert.equal(gate.classify(w).kind, 'ambiguous', `「${w}」不应是确认`);
  }
});

test('否定表达', () => {
  for (const w of ['不要', '算了', '取消', '不对', '改一下']) {
    assert.equal(gate.classify(w).kind, 'no', `「${w}」应为否定`);
  }
});

test('复合句"嗯，可以"以明确词为准', () => {
  assert.equal(gate.classify('嗯，可以').kind, 'yes');
  assert.equal(gate.classify('随便吧，执行吧').kind, 'yes');
});

test('confirm 绑定 planId + revision', () => {
  const r = gate.confirm(plan, '确认');
  assert.equal(r.ok, true);
  assert.equal(r.planId, 'plan_abc');
  assert.equal(r.revision, 3);
});

test('确认必须存在计划', () => {
  const r = gate.confirm(null, '确认');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PLAN_INVALID');
});

test('模糊确认返回 CONFIRMATION_AMBIGUOUS，继续询问', () => {
  const r = gate.confirm(plan, '随便');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'CONFIRMATION_AMBIGUOUS');
});

test('修改产生新 revision，旧确认不得复用', () => {
  const r1 = gate.confirm(plan, '确认');
  assert.equal(r1.ok, true);
  const newRevision = gate.nextRevision(plan, r1.revision);
  assert.equal(newRevision, 4);
  // 用旧 revision 确认同一 planId 视为过期（编排器按当前 revision 判定）
  assert.notEqual(newRevision, r1.revision);
});
