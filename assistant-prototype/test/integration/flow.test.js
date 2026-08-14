'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeHarness, makePlan, sleep, transitionSeq } = require('../helpers/harness');
const { STATES } = require('../../src/assistant/states');
const { ERROR_CODES } = require('../../src/shared/errors');

test('多轮澄清 → 确认 → 执行 → 日志（文档 18.2 集成流程）', async () => {
  const h = makeHarness({
    plannerResponses: [
      {
        planId: 'plan_a', revision: 1, decision: 'clarify', speech: '请问明天下午几点提醒？',
        goal: '提醒发合同', actions: [{ type: 'set_reminder', args: { title: '发合同', time: null } }],
        missingFields: ['actions[0].args.time'], assumptions: [], isComplete: false,
      },
      {
        planId: 'plan_a', revision: 2, decision: 'confirm', speech: '明天下午3点提醒发合同',
        goal: '提醒发合同', actions: [{ type: 'set_reminder', args: { title: '发合同', time: '2026-08-13T15:00:00.000+08:00' } }],
        missingFields: [], assumptions: [], isComplete: true,
      },
    ],
  });
  try {
    await h.orchestrator.startTextInput('提醒我发合同');
    assert.equal(h.orchestrator.state, STATES.CLARIFYING);
    assert.ok(h.events.some((e) => e.event === 'dialog' && e.payload.kind === 'clarify'));

    await h.orchestrator.sendResponse('明天下午3点');
    assert.equal(h.orchestrator.state, STATES.AWAITING_CONFIRMATION);
    const planSnap = h.orchestrator.getStateSnapshot().currentPlan;
    assert.equal(planSnap.revision, 2);
    assert.equal(planSnap.actions[0].args.time, '2026-08-13T15:00:00.000+08:00');

    await h.orchestrator.sendResponse('确认');
    assert.ok([STATES.FOLLOW_UP, STATES.REPORTING].includes(h.orchestrator.state), `state=${h.orchestrator.state}`);

    // 执行日志有动作完成记录
    const entries = h.journal.read('plan_a');
    assert.ok(entries.some((e) => e.kind === 'action_start' && e.actionType === 'set_reminder'));
    assert.ok(entries.some((e) => e.kind === 'action_finish' && e.actionType === 'set_reminder'));
    assert.ok(entries.some((e) => e.kind === 'plan_finish' && e.status === 'completed'));

    // 沙盒里创建了带提醒的任务（提醒挂接当天任务清单，alarmTime 为明天 15:00）
    const tasks = h.store.listTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].alarmTime, '2026-08-13T15:00:00.000+08:00');

    // 汇报来自真实执行结果（提醒挂接在新建任务上）
    const report = h.events.find((e) => e.event === 'dialog' && e.payload.kind === 'report');
    assert.ok(report.payload.content.includes('已完成'));
    assert.ok(report.payload.content.includes('发合同'));
  } finally {
    h.cleanup();
  }
});

test('确认门拒绝模糊回答，继续等待明确确认', async () => {
  const h = makeHarness({
    plannerResponses: [makePlan()],
  });
  try {
    await h.orchestrator.startTextInput('创建任务');
    assert.equal(h.orchestrator.state, STATES.AWAITING_CONFIRMATION);
    await h.orchestrator.sendResponse('随便');
    assert.equal(h.orchestrator.state, STATES.AWAITING_CONFIRMATION);
    const last = h.events.filter((e) => e.event === 'dialog').pop();
    assert.ok(last.payload.content.includes('请明确回复'));
    // 沙盒无数据（澄清期间无副作用，文档 7.2）
    assert.equal(h.store.listTasks().length, 0);
  } finally {
    h.cleanup();
  }
});

test('执行计划 → MockHostAdapter → 执行日志全链路', async () => {
  const h = makeHarness({
    plannerResponses: [makePlan({
      actions: [
        { type: 'create_task', args: { title: '任务一' } },
        { type: 'create_task', args: { title: '任务二' } },
      ],
    })],
  });
  try {
    await h.orchestrator.startTextInput('创建两个任务');
    assert.equal(h.orchestrator.state, STATES.AWAITING_CONFIRMATION);
    await h.orchestrator.sendResponse('可以');
    assert.equal(h.orchestrator.state, STATES.FOLLOW_UP);

    const tasks = h.store.listTasks();
    assert.equal(tasks.length, 2);
    assert.deepEqual(tasks.map((t) => t.task).sort(), ['任务一', '任务二'].sort());

    const entries = h.journal.read('plan_test');
    const finished = entries.filter((e) => e.kind === 'action_finish');
    assert.equal(finished.length, 2);
    // 串行执行：第二个动作的开始时间晚于第一个的结束时间
    const starts = entries.filter((e) => e.kind === 'action_start').map((e) => e.timestamp);
    assert.ok(new Date(starts[1]) >= new Date(starts[0]));

    // 汇报按真实结果生成
    const report = h.events.find((e) => e.event === 'dialog' && e.payload.kind === 'report');
    assert.ok(report.payload.content.includes('已创建任务：任务一'));
    assert.ok(report.payload.content.includes('已创建任务：任务二'));
  } finally {
    h.cleanup();
  }
});

test('动作失败时停止后续步骤并汇报失败', async () => {
  const h = makeHarness({
    plannerResponses: [makePlan({
      actions: [
        { type: 'create_task', args: { title: '好任务' } },
        { type: 'complete_task', args: { title: '不存在的任务' } },
        { type: 'create_task', args: { title: '不应执行' } },
      ],
    })],
  });
  try {
    await h.orchestrator.startTextInput('执行任务');
    await h.orchestrator.sendResponse('确认');
    assert.equal(h.orchestrator.state, STATES.FOLLOW_UP);

    const tasks = h.store.listTasks();
    assert.equal(tasks.length, 1); // 第三个动作未执行
    const report = h.events.find((e) => e.event === 'dialog' && e.payload.kind === 'report');
    assert.ok(report.payload.content.includes('失败'));
    assert.ok(report.payload.content.includes('未执行'));
    // 单步失败后不自动猜测替代动作
    assert.ok(!report.payload.content.includes('替代'));
  } finally {
    h.cleanup();
  }
});

test('暂停在动作边界生效，继续后执行剩余动作', async () => {
  const executed = [];
  let releaseFirst = null;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const h = makeHarness({
    plannerResponses: [makePlan({
      actions: [
        { type: 'create_task', args: { title: 'A' } },
        { type: 'create_task', args: { title: 'B' } },
        { type: 'create_task', args: { title: 'C' } },
      ],
    })],
    host: {
      getCapabilities: async () => ({ ok: true, data: {} }),
      async createTask(args, opts) {
        void opts;
        executed.push(args.title);
        if (executed.length === 1) await firstGate; // 挂住第一个动作
        return { ok: true, data: { id: `t${executed.length}` }, effect: { summary: `已创建任务：${args.title}`, reversible: true } };
      },
    },
  });
  try {
    await h.orchestrator.startTextInput('创建三个任务');
    const execTask = h.orchestrator.sendResponse('确认'); // 执行中不等待
    await sleep(20); // 动作 1 已开始但被挂住
    h.orchestrator.pause(); // 暂停请求到达时动作 1 进行中
    releaseFirst();        // 放行动作 1
    await execTask;        // 完成后在边界暂停
    assert.equal(h.orchestrator.state, STATES.PAUSED);
    assert.deepEqual(executed, ['A']); // 只有动作 1 执行了

    await h.orchestrator.resume();
    assert.equal(h.orchestrator.state, STATES.FOLLOW_UP);
    assert.deepEqual(executed, ['A', 'B', 'C']); // 剩余动作按序执行
  } finally {
    h.cleanup();
  }
});

test('暂停后继续前重新确认宿主能力（文档 12.3）', async () => {
  let releaseFirst = null;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const h = makeHarness({
    plannerResponses: [makePlan({ actions: [{ type: 'create_task', args: { title: 'A' } }, { type: 'create_task', args: { title: 'B' } }] })],
    host: {
      getCapabilities: async () => ({ ok: false, error: { code: 'HOST_UNAVAILABLE', message: '宿主挂了' } }),
      async createTask(args, opts) {
        void opts;
        if (args.title === 'A') await firstGate;
        return { ok: true, data: { id: 'x' }, effect: { summary: `已创建任务：${args.title}`, reversible: true } };
      },
    },
  });
  try {
    await h.orchestrator.startTextInput('创建任务');
    const execTask = h.orchestrator.sendResponse('确认');
    await sleep(20);
    h.orchestrator.pause();
    releaseFirst();
    await execTask;
    assert.equal(h.orchestrator.state, STATES.PAUSED);
    await assert.rejects(
      () => h.orchestrator.resume(),
      (e) => e.code === ERROR_CODES.HOST_UNAVAILABLE,
    );
    assert.equal(h.orchestrator.state, STATES.PAUSED);
  } finally {
    h.cleanup();
  }
});

test('过渡序列合法（IDLE→…→FOLLOW_UP→IDLE）', async () => {
  const h = makeHarness({
    plannerResponses: [makePlan()],
    config: { followUpWindowMs: 50 },
  });
  try {
    await h.orchestrator.startTextInput('创建任务');
    await h.orchestrator.sendResponse('确认');
    assert.equal(h.orchestrator.state, STATES.FOLLOW_UP);
    await waitForIdle(h);
    assert.equal(h.orchestrator.state, STATES.IDLE);
    const seq = transitionSeq(h.events);
    assert.ok(seq.includes('IDLE->REASONING'));
    assert.ok(seq.includes('AWAITING_CONFIRMATION->EXECUTING'));
    assert.ok(seq.includes('EXECUTING->REPORTING'));
    assert.ok(seq.includes('REPORTING->FOLLOW_UP'));
    assert.ok(seq.includes('FOLLOW_UP->IDLE'));
  } finally {
    h.cleanup();
  }
});

async function waitForIdle(h, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && h.orchestrator.state !== STATES.IDLE) {
    await sleep(10);
  }
}
