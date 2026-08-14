'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CancellationController } = require('../../src/assistant/cancellation-controller');
const { CancelledError } = require('../../src/shared/errors');

test('初始未取消，signal 可用', () => {
  const c = new CancellationController();
  assert.equal(c.isCancelled(), false);
  assert.equal(c.signal.aborted, false);
});

test('cancel 后 signal aborted 且记录来源', () => {
  const c = new CancellationController();
  c.cancel('ui_button');
  assert.equal(c.isCancelled(), true);
  assert.equal(c.source, 'ui_button');
  assert.equal(c.signal.aborted, true);
});

test('重复 cancel 幂等，保留首个来源', () => {
  const c = new CancellationController();
  c.cancel('voice_command');
  c.cancel('ui_button');
  assert.equal(c.source, 'voice_command');
});

test('监听器收到来源（如 TTS 立即停止）', () => {
  const c = new CancellationController();
  const seen = [];
  c.onCancel((src) => seen.push(src));
  c.cancel('esc');
  assert.deepEqual(seen, ['esc']);
});

test('取消后注册的监听器立即执行', () => {
  const c = new CancellationController();
  c.cancel('esc');
  let called = false;
  c.onCancel(() => { called = true; });
  assert.equal(called, true);
});

test('reset 后可重新使用', () => {
  const c = new CancellationController();
  c.cancel('x');
  c.reset();
  assert.equal(c.isCancelled(), false);
});

test('signal.reason 是 CancelledError 且携带来源', () => {
  const c = new CancellationController();
  c.cancel('voice_command');
  const reason = c.signal.reason;
  assert.ok(reason instanceof CancelledError);
  assert.equal(reason.source, 'voice_command');
});

test('取消后取消回调内的异常不影响流程', () => {
  const c = new CancellationController();
  c.onCancel(() => { throw new Error('listener boom'); });
  assert.doesNotThrow(() => c.cancel('x'));
  assert.equal(c.isCancelled(), true);
});
