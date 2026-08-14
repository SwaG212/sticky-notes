'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { STATES, TRANSITIONS, assertTransition, canTransition, ALL_STATES } = require('../../src/assistant/states');
const { AppError } = require('../../src/shared/errors');

test('全部 12 个状态已定义（文档 7.1）', () => {
  assert.equal(ALL_STATES.length, 12);
  assert.equal(STATES.IDLE, 'IDLE');
  assert.equal(STATES.CANCELLING, 'CANCELLING');
});

test('合法迁移通过', () => {
  assert.doesNotThrow(() => assertTransition(STATES.IDLE, STATES.REASONING));
  assert.doesNotThrow(() => assertTransition(STATES.REASONING, STATES.CLARIFYING));
  assert.doesNotThrow(() => assertTransition(STATES.AWAITING_CONFIRMATION, STATES.EXECUTING));
  assert.doesNotThrow(() => assertTransition(STATES.EXECUTING, STATES.PAUSED));
  assert.doesNotThrow(() => assertTransition(STATES.PAUSED, STATES.EXECUTING));
  assert.doesNotThrow(() => assertTransition(STATES.CANCELLING, STATES.REPORTING));
  assert.doesNotThrow(() => assertTransition(STATES.CANCELLING, STATES.IDLE));
  assert.doesNotThrow(() => assertTransition(STATES.FOLLOW_UP, STATES.IDLE));
});

test('非法迁移抛 ILLEGAL_TRANSITION', () => {
  const cases = [
    [STATES.REASONING, STATES.IDLE],
    [STATES.EXECUTING, STATES.FOLLOW_UP],
    [STATES.CANCELLING, STATES.FOLLOW_UP],
    [STATES.IDLE, STATES.CANCELLING],
    [STATES.PAUSED, STATES.REPORTING],
    [STATES.AWAITING_CONFIRMATION, STATES.FOLLOW_UP],
  ];
  for (const [from, to] of cases) {
    assert.throws(
      () => assertTransition(from, to),
      (err) => err instanceof AppError && err.code === 'ILLEGAL_TRANSITION',
      `${from} → ${to} 应被拒绝`,
    );
    assert.equal(canTransition(from, to), false);
  }
});

test('STOP_REQUESTED 可从所有非 IDLE 状态进入 CANCELLING（文档 7.2）', () => {
  for (const s of ALL_STATES) {
    if (s === STATES.IDLE || s === STATES.CANCELLING) continue;
    assert.equal(
      canTransition(s, STATES.CANCELLING),
      true,
      `${s} 应可进入 CANCELLING`,
    );
  }
  // CANCELLING 自身不得再进入 CANCELLING
  assert.equal(canTransition(STATES.CANCELLING, STATES.CANCELLING), false);
});

test('迁移表只包含已定义状态', () => {
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    assert.ok(STATES[from], `未知状态 ${from}`);
    for (const to of tos) {
      assert.ok(ALL_STATES.includes(to), `未知目标状态 ${to}`);
    }
  }
});
