'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Logger, redact, scrub } = require('../../src/shared/logger');

test('敏感键被脱敏', () => {
  const out = redact({ apiKey: 'sk-1234567890abcdef', Authorization: 'Bearer x', token: 't' });
  assert.equal(out.apiKey, '[REDACTED]');
  assert.equal(out.Authorization, '[REDACTED]');
  assert.equal(out.token, '[REDACTED]');
});

test('长文本默认截断', () => {
  const out = redact({ text: 'x'.repeat(500) });
  assert.ok(out.text.length < 250);
  assert.ok(out.text.endsWith('…(truncated)'));
  assert.equal(out.text.length, 200 + '…(truncated)'.length);
});

test('疑似密钥形态的短串被部分打码（保留可读前缀）', () => {
  const out = redact({ value: 'abcdef1234567890abcdef1234567890' });
  assert.notEqual(out.value, 'abcdef1234567890abcdef1234567890');
  assert.ok(out.value.includes('(len='));
});

test('嵌套对象递归处理', () => {
  const out = redact({ nested: { deep: { apiKey: 'k' } } });
  assert.equal(out.nested.deep.apiKey, '[REDACTED]');
});

test('原始音频/语音文本不落日志（验证日志条目结构）', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asst-log-'));
  const file = path.join(dir, 'test.log');
  const logger = new Logger({ file });
  logger.info('test_event', { sessionId: 's1', planId: 'p1', actionRunId: 'r1', state: 'EXECUTING', durationMs: 5, rawAudio: 'PCM-BINARY' });
  logger.close();
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  // 结构化事件字段齐全（文档 16 节）
  assert.equal(record.event, 'test_event');
  assert.equal(record.sessionId, 's1');
  assert.equal(record.planId, 'p1');
  assert.equal(record.actionRunId, 'r1');
  assert.equal(record.state, 'EXECUTING');
  assert.equal(record.durationMs, 5);
  assert.ok(record.timestamp);
  // 原始音频脱敏（文档 16：默认不记录原始音频）
  assert.equal(record.rawAudio, '[REDACTED]');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scrub 过滤 null/undefined', () => {
  const out = scrub({ a: 1, b: null, c: undefined });
  assert.deepEqual(out, { a: 1 });
});

test('文件日志追加与轮转结构（小于阈值不轮转）', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asst-log-'));
  const file = path.join(dir, 'test.log');
  const logger = new Logger({ file, maxBytes: 1024 });
  logger.info('a', {});
  logger.info('b', {});
  logger.close();
  const content = fs.readFileSync(file, 'utf8');
  const records = content.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(records.length, 2);
  assert.equal(records[0].event, 'a');
  fs.rmSync(dir, { recursive: true, force: true });
});
