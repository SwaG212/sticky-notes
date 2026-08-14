'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ResponseParser, extractJson } = require('../../src/llm/response-parser');

const parser = new ResponseParser();

test('解析合法 clarify 输出', () => {
  const r = parser.parse(JSON.stringify({
    decision: 'clarify',
    speech: '请问明天下午几点提醒？',
    draft: { goal: '提醒发合同', actions: [{ type: 'set_reminder', args: { title: '发合同', time: null } }] },
    missingFields: ['actions[0].args.time'],
    assumptions: [],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.value.decision, 'clarify');
  assert.deepEqual(r.value.missingFields, ['actions[0].args.time']);
});

test('容忍 ```json 代码块包裹', () => {
  const r = parser.parse('```json\n{"decision":"answer","speech":"好的","draft":null,"missingFields":[],"assumptions":[]}\n```');
  assert.equal(r.ok, true);
  assert.equal(r.value.decision, 'answer');
});

test('从夹杂自然语言中提取首个平衡 JSON', () => {
  const r = parser.parse('好的，我来处理。{"decision":"confirm","speech":"创建任务","draft":{"goal":"g","actions":[{"type":"create_task","args":{"title":"x"}}]},"missingFields":[],"assumptions":[]} 完成。');
  assert.equal(r.ok, true);
  assert.equal(r.value.decision, 'confirm');
});

test('未知 decision 被拒绝', () => {
  const r = parser.parse('{"decision":"whatever","speech":"x","draft":null,"missingFields":[],"assumptions":[]}');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BAD_DECISION');
});

test('answer/reject 不得携带 draft', () => {
  const r = parser.parse('{"decision":"answer","speech":"x","draft":{"goal":"g","actions":[]},"missingFields":[],"assumptions":[]}');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'DRAFT_FORBIDDEN');
});

test('confirm 必须有完整 draft', () => {
  const r = parser.parse('{"decision":"confirm","speech":"x","draft":null,"missingFields":[],"assumptions":[]}');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BAD_DRAFT');
});

test('confirm 的 draft.actions 为空被拒绝', () => {
  const r = parser.parse('{"decision":"confirm","speech":"x","draft":{"goal":"g","actions":[]},"missingFields":[],"assumptions":[]}');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BAD_DRAFT');
});

test('缺少 speech 被拒绝', () => {
  const r = parser.parse('{"decision":"clarify","draft":null,"missingFields":[],"assumptions":[]}');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_SPEECH');
});

test('非 JSON 输出被拒绝（不猜测动作）', () => {
  const r = parser.parse('好的，我会在明天下午3点提醒您发合同。');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_JSON');
});

test('空输出被拒绝', () => {
  assert.equal(parser.parse('').ok, false);
  assert.equal(parser.parse(null).ok, false);
  assert.equal(parser.parse('   ').ok, false);
});

test('extractJson 对嵌套对象与字符串中的花括号正确处理', () => {
  const text = '前文 {"a":{"b":"}text {"},"c":[1,2]} 后文';
  assert.equal(extractJson(text), '{"a":{"b":"}text {"},"c":[1,2]}');
});
