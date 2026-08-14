'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { RiskPolicy, PLAN_LIMITS } = require('../../src/planning/risk-policy');

function fakeRegistry(defs) {
  return { get: (t) => defs[t] || null };
}

const defs = {
  create_task: { type: 'create_task', risk: 'low' },
  append_note: { type: 'append_note', risk: 'low' },
  delete_data: { type: 'delete_data', risk: 'high' },
};

test('低风险计划通过', () => {
  const policy = new RiskPolicy();
  const r = policy.assess({ actions: [{ type: 'create_task', args: { title: 'x' } }] }, fakeRegistry(defs));
  assert.equal(r.ok, true);
  assert.deepEqual(r.highRiskTypes, []);
});

test('未注册动作被拒绝', () => {
  const policy = new RiskPolicy();
  const r = policy.assess({ actions: [{ type: 'rm_rf', args: {} }] }, fakeRegistry(defs));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('rm_rf')));
});

test('高风险动作要求额外确认（机制保留）', () => {
  const policy = new RiskPolicy();
  const r = policy.assess({ actions: [{ type: 'delete_data', args: {} }] }, fakeRegistry(defs));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('高风险')));
  assert.deepEqual(r.highRiskTypes, ['delete_data']);
});

test('动作数量超过上限被拒绝', () => {
  const policy = new RiskPolicy();
  const actions = Array.from({ length: PLAN_LIMITS.maxActions + 1 }, () => ({ type: 'create_task', args: { title: 'x' } }));
  const r = policy.assess({ actions }, fakeRegistry(defs));
  assert.equal(r.ok, false);
});

test('恰好等于上限通过', () => {
  const policy = new RiskPolicy();
  const actions = Array.from({ length: PLAN_LIMITS.maxActions }, () => ({ type: 'create_task', args: { title: 'x' } }));
  const r = policy.assess({ actions }, fakeRegistry(defs));
  assert.equal(r.ok, true);
});

test('超长标题被拒绝', () => {
  const policy = new RiskPolicy();
  const r = policy.assess({ actions: [{ type: 'create_task', args: { title: '长'.repeat(201) } }] }, fakeRegistry(defs));
  assert.equal(r.ok, false);
});

test('超长笔记内容被拒绝', () => {
  const policy = new RiskPolicy();
  const r = policy.assess({ actions: [{ type: 'create_note', args: { title: 't', content: 'x'.repeat(5001) } }] }, fakeRegistry(defs));
  assert.equal(r.ok, false);
});

test('空计划被拒绝', () => {
  const policy = new RiskPolicy();
  assert.equal(policy.assess({ actions: [] }, fakeRegistry(defs)).ok, false);
  assert.equal(policy.assess(null, fakeRegistry(defs)).ok, false);
});
