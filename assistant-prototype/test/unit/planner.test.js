'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Planner } = require('../../src/llm/planner');
const { DialogueSession } = require('../../src/assistant/dialogue-session');

function stubClient(handler) {
  return { chat: async (messages, opts) => handler(messages, opts) };
}

const RAW_CONFIRM = JSON.stringify({
  decision: 'confirm',
  speech: '创建任务',
  draft: {
    goal: '提醒发合同',
    actions: [{ type: 'set_reminder', args: { title: '发合同', time: '明天下午3点' } }],
  },
  missingFields: [],
  assumptions: [],
});

test('相对时间在规划阶段转成绝对时间（+08:00）', async () => {
  const client = stubClient(() => ({ content: RAW_CONFIRM, durationMs: 1 }));
  const planner = new Planner({ client });
  const session = new DialogueSession();
  session.addUser('明天下午3点提醒我发合同');
  const plan = await planner.plan({ session });
  assert.equal(plan.decision, 'confirm');
  // 断言：明天（上海）的 15:00，带 +08:00 偏移
  const shTomorrow = new Date(Date.now() + 8 * 3600 * 1000);
  shTomorrow.setUTCDate(shTomorrow.getUTCDate() + 1);
  const ymd = `${shTomorrow.getUTCFullYear()}-${String(shTomorrow.getUTCMonth() + 1).padStart(2, '0')}-${String(shTomorrow.getUTCDate()).padStart(2, '0')}`;
  assert.equal(plan.actions[0].args.time, `${ymd}T15:00:00.000+08:00`);
  assert.equal(plan.isComplete, true);
});

test('无法解析的相对时间计入 missingFields 并置 null', async () => {
  const content = JSON.stringify({
    decision: 'confirm',
    speech: '好的',
    draft: {
      goal: '提醒发合同',
      actions: [{ type: 'set_reminder', args: { title: '发合同', time: '尽快' } }],
    },
    missingFields: [],
    assumptions: [],
  });
  const client = stubClient(() => ({ content, durationMs: 1 }));
  const planner = new Planner({ client });
  const session = new DialogueSession();
  session.addUser('尽快提醒我发合同');
  const plan = await planner.plan({ session });
  assert.equal(plan.actions[0].args.time, null);
  assert.ok(plan.missingFields.includes('actions[0].args.time'));
  assert.equal(plan.isComplete, false);
});

test('解析失败后自动发起一次格式修复请求', async () => {
  const calls = [];
  const client = stubClient(() => {
    calls.push(1);
    if (calls.length === 1) return { content: '这是无法解析的文本', durationMs: 1 };
    return { content: RAW_CONFIRM, durationMs: 1 };
  });
  const planner = new Planner({ client });
  const session = new DialogueSession();
  session.addUser('明天下午3点提醒我发合同');
  const plan = await planner.plan({ session });
  assert.equal(calls.length, 2);
  assert.equal(plan.decision, 'confirm');
});

test('两次修复仍失败则抛 LLM_INVALID_RESPONSE', async () => {
  const client = stubClient(() => ({ content: '坏输出', durationMs: 1 }));
  const planner = new Planner({ client });
  const session = new DialogueSession();
  session.addUser('hi');
  await assert.rejects(
    () => planner.plan({ session }),
    (e) => e.code === 'LLM_INVALID_RESPONSE',
  );
});

test('同一 goal 演化复用 planId 并递增 revision', async () => {
  const client = stubClient(() => ({ content: RAW_CONFIRM, durationMs: 1 }));
  const planner = new Planner({ client });
  const session = new DialogueSession();
  session.addUser('明天下午3点提醒我发合同');
  const p1 = await planner.plan({ session });
  session.setPlan(p1);
  session.addUser('改成4点');
  const p2 = await planner.plan({ session });
  assert.equal(p1.planId, p2.planId);
  assert.equal(p2.revision, p1.revision + 1);
});

test('不同 goal 生成新 planId', async () => {
  let n = 0;
  const client = stubClient(() => {
    n++;
    return { content: JSON.stringify({
      decision: 'confirm',
      speech: '好的',
      draft: { goal: n === 1 ? '任务一' : '任务二', actions: [{ type: 'create_task', args: { title: `t${n}` } }] },
      missingFields: [],
      assumptions: [],
    }), durationMs: 1 };
  });
  const planner = new Planner({ client });
  const session = new DialogueSession();
  session.addUser('a');
  const p1 = await planner.plan({ session });
  session.setPlan(p1);
  session.addUser('b');
  const p2 = await planner.plan({ session });
  assert.notEqual(p1.planId, p2.planId);
});

test('LLM 请求支持取消（AbortSignal）', async () => {
  const client = stubClient(async (_m, { signal }) => {
    await new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  });
  const planner = new Planner({ client });
  const session = new DialogueSession();
  session.addUser('hi');
  const controller = new AbortController();
  const promise = planner.plan({ session, signal: controller.signal });
  controller.abort();
  await assert.rejects(() => promise);
});
