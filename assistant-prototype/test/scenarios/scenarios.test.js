'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeHarness, makePlan, sleep, waitForState } = require('../helpers/harness');
const { STATES } = require('../../src/assistant/states');

/** 文档 18.3 场景 1：信息不完整时追问。 */
test('场景 1：「明天下午提醒我发合同」→ 追问具体时间和对象', async () => {
  const h = makeHarness({
    plannerResponses: [{
      planId: 'plan_s1', revision: 1, decision: 'clarify', speech: '请问提醒发合同的具体时间是几点？',
      goal: '提醒发合同', actions: [{ type: 'set_reminder', args: { title: '发合同', time: null } }],
      missingFields: ['actions[0].args.time'], assumptions: [], isComplete: false,
    }],
  });
  try {
    await h.orchestrator.startTextInput('明天下午提醒我发合同');
    assert.equal(h.orchestrator.state, STATES.CLARIFYING);
    const clarify = h.events.find((e) => e.event === 'dialog' && e.payload.kind === 'clarify');
    assert.ok(clarify.payload.content.includes('几点'));
    // 澄清期间无任何副作用
    assert.equal(h.store.listTasks().length, 0);
    assert.equal(h.journal.read('plan_s1').length, 0);
  } finally {
    h.cleanup();
  }
});

/** 文档 18.3 场景 2：回答后又修改时间 → 旧确认失效。 */
test('场景 2：修改时间后旧确认失效，必须重新确认', async () => {
  const h = makeHarness({
    plannerResponses: [
      makePlan({
        planId: 'plan_s2', revision: 1, decision: 'confirm', goal: '提醒发合同',
        actions: [{ type: 'set_reminder', args: { title: '发合同', time: '2026-08-13T15:00:00.000+08:00' } }],
      }),
      makePlan({
        planId: 'plan_s2', revision: 2, decision: 'confirm', goal: '提醒发合同',
        actions: [{ type: 'set_reminder', args: { title: '发合同', time: '2026-08-13T16:00:00.000+08:00' } }],
      }),
    ],
  });
  try {
    await h.orchestrator.startTextInput('明天下午3点提醒我发合同');
    assert.equal(h.orchestrator.state, STATES.AWAITING_CONFIRMATION);
    await h.orchestrator.sendResponse('改成下午4点'); // 修改 → 新 revision
    assert.equal(h.orchestrator.state, STATES.AWAITING_CONFIRMATION);
    const snap = h.orchestrator.getStateSnapshot().currentPlan;
    assert.equal(snap.revision, 2);
    assert.equal(snap.actions[0].args.time, '2026-08-13T16:00:00.000+08:00');
    // 未执行任何操作
    assert.equal(h.store.listTasks().length, 0);

    await h.orchestrator.sendResponse('确认'); // 对 revision 2 的新确认
    assert.equal(h.orchestrator.state, STATES.FOLLOW_UP);
    const tasks = h.store.listTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].alarmTime, '2026-08-13T16:00:00.000+08:00');
  } finally {
    h.cleanup();
  }
});

/** 文档 18.3 场景 3：一句话多个动作 → 有序计划。 */
test('场景 3：一句话包含多个动作生成有序计划并按序执行', async () => {
  const order = [];
  const h = makeHarness({
    plannerResponses: [makePlan({
      actions: [
        { type: 'create_note', args: { title: '会议记录', content: '议题一' } },
        { type: 'create_task', args: { title: '整理会议纪要' } },
      ],
    })],
    host: {
      getCapabilities: async () => ({ ok: true, data: {} }),
      async createNote(args, opts) { void opts; order.push('note'); return { ok: true, data: { id: 'n1' }, effect: { summary: '已创建笔记', reversible: true } }; },
      async createTask(args, opts) { void opts; order.push('task'); return { ok: true, data: { id: 't1' }, effect: { summary: '已创建任务', reversible: true } }; },
    },
  });
  try {
    await h.orchestrator.startTextInput('记下会议记录，然后创建整理会议纪要的任务');
    assert.equal(h.orchestrator.state, STATES.AWAITING_CONFIRMATION);
    assert.equal(h.orchestrator.getStateSnapshot().currentPlan.actions.length, 2);
    await h.orchestrator.sendResponse('执行');
    assert.equal(h.orchestrator.state, STATES.FOLLOW_UP);
    assert.deepEqual(order, ['note', 'task']); // 严格按计划顺序串行
  } finally {
    h.cleanup();
  }
});

/** 文档 18.3 场景 4：思考时说"停止" → 请求立即取消。 */
test('场景 4：REASONING 中说停止 → LLM 请求被取消，收敛回待机', async () => {
  const h = makeHarness({ plannerResponses: [] });
  try {
    h.planner.block();
    const task = h.orchestrator.startTextInput('帮我想个方案');
    await sleep(20);
    assert.equal(h.orchestrator.state, STATES.REASONING);
    const before = Date.now();
    h.orchestrator.stop('voice_command');
    await task;
    assert.ok(waitForState(h.orchestrator, STATES.IDLE));
    assert.ok(Date.now() - before < 500, '停止应快速收敛');
    // 无任何执行记录
    assert.equal(h.store.listTasks().length, 0);
  } finally {
    h.cleanup();
  }
});

/** 文档 18.3 场景 5：执行第二步时停止 → 准确汇报已完成/中断/未执行。 */
test('场景 5：执行第二步时停止 → 汇报准确区分已完成与未执行', async () => {
  const executed = [];
  const h = makeHarness({
    plannerResponses: [makePlan({
      actions: [
        { type: 'create_task', args: { title: '第一步' } },
        { type: 'create_task', args: { title: '第二步' } },
        { type: 'create_task', args: { title: '第三步' } },
      ],
    })],
    host: {
      getCapabilities: async () => ({ ok: true, data: {} }),
      async createTask(args, { signal }) {
        executed.push(args.title);
        if (executed.length === 2) {
          // 第二步挂起直至取消
          await new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { cancelled: true })), { once: true });
          });
        }
        return { ok: true, data: { id: `t${executed.length}` }, effect: { summary: `已创建任务：${args.title}`, reversible: true } };
      },
    },
  });
  try {
    await h.orchestrator.startTextInput('创建三个任务');
    const execTask = h.orchestrator.sendResponse('确认'); // 执行中不等待
    await sleep(30); // 第一步完成，第二步进行中
    assert.deepEqual(executed, ['第一步', '第二步']);
    h.orchestrator.stop('ui_button');
    await execTask;
    assert.ok([STATES.FOLLOW_UP, STATES.IDLE].includes(h.orchestrator.state));

    const report = h.events.filter((e) => e.event === 'dialog' && e.payload.kind === 'report').pop();
    assert.ok(report.payload.content.includes('已完成'), `汇报应含已完成：${report.payload.content}`);
    assert.ok(report.payload.content.includes('第一步'));
    assert.ok(report.payload.content.includes('中断'), `汇报应含中断：${report.payload.content}`);
    assert.ok(report.payload.content.includes('第二步'));
    assert.ok(report.payload.content.includes('未执行'), `汇报应含未执行：${report.payload.content}`);
    assert.ok(report.payload.content.includes('第三步'));
    // 第三步从未开始执行（中断后不再启动新动作，文档 12.2 第 5 步）
    assert.deepEqual(executed, ['第一步', '第二步']);
  } finally {
    h.cleanup();
  }
});

/** 文档 18.3 场景 6：播报阶段说"小智停止" → 立即收敛（阶段 1 无 TTS，验证停止路径与真实汇报）。 */
test('场景 6：播报阶段停止 → 立即收敛并汇报真实结果，不撤销已完成操作', async () => {
  const h = makeHarness({
    plannerResponses: [makePlan()],
    config: { followUpWindowMs: 100 },
  });
  try {
    await h.orchestrator.startTextInput('创建任务');
    await h.orchestrator.sendResponse('确认');
    h.orchestrator.stop('voice_command');
    await waitForState(h.orchestrator, STATES.IDLE, 3000);
    const last = h.events.filter((e) => e.event === 'dialog').pop();
    // 停止不等于撤销：汇报真实执行结果（文档 12.2 末段）
    assert.equal(last.payload.kind, 'report');
    assert.ok(last.payload.content.includes('已完成'));
    assert.equal(h.store.listTasks().length, 1);
  } finally {
    h.cleanup();
  }
});

/** 文档 18.3 场景 7：长时间不回答 → 安全超时回待机。 */
test('场景 7：追问后长时间不回答 → 超时回到待机', async () => {
  const h = makeHarness({
    plannerResponses: [{
      planId: 'plan_s7', revision: 1, decision: 'clarify', speech: '请问几点？',
      goal: 'g', actions: [{ type: 'set_reminder', args: { title: 'x', time: null } }],
      missingFields: ['actions[0].args.time'], assumptions: [], isComplete: false,
    }],
    config: { clarifyTimeoutMs: 80 },
  });
  try {
    await h.orchestrator.startTextInput('提醒我');
    assert.equal(h.orchestrator.state, STATES.CLARIFYING);
    await waitForState(h.orchestrator, STATES.IDLE, 2000);
    assert.equal(h.orchestrator.state, STATES.IDLE);
  } finally {
    h.cleanup();
  }
});

/** 文档 18.3 场景 8：LLM 返回未知动作 → 拒绝执行。 */
test('场景 8：计划含未注册动作 → 拒绝执行，零副作用', async () => {
  const h = makeHarness({
    plannerResponses: [makePlan({
      actions: [{ type: 'send_email', args: { to: 'a@b.com' } }],
    })],
  });
  try {
    await h.orchestrator.startTextInput('发邮件');
    assert.equal(h.orchestrator.state, STATES.ERROR);
    const err = h.events.filter((e) => e.event === 'dialog').pop();
    assert.equal(err.payload.kind, 'error');
    assert.equal(h.store.listTasks().length, 0);
    assert.equal(h.store.listNotes().length, 0);
  } finally {
    h.cleanup();
  }
});

/** 文档 18.3 场景 9：模型说"已完成"但适配器失败 → 必须汇报失败。 */
test('场景 9：适配器失败时汇报失败，不采信模型自述', async () => {
  const h = makeHarness({
    plannerResponses: [makePlan({
      actions: [{ type: 'complete_task', args: { title: '不存在的任务' } }],
    })],
  });
  try {
    await h.orchestrator.startTextInput('完成任务');
    await h.orchestrator.sendResponse('确认');
    assert.equal(h.orchestrator.state, STATES.FOLLOW_UP);
    const report = h.events.find((e) => e.event === 'dialog' && e.payload.kind === 'report');
    assert.ok(report.payload.content.includes('失败'));
    assert.ok(!report.payload.content.includes('已完成'), '不得谎报成功');
  } finally {
    h.cleanup();
  }
});

/** 文档 18.3 场景 10：重复动作请求 → 不重复创建。 */
test('场景 10：同一 actionRunId 重复请求不重复创建任务', async () => {
  const h = makeHarness();
  try {
    const res1 = await h.host.createTask({ title: '发合同' }, { signal: null, actionRunId: 'run_dup' });
    assert.equal(res1.ok, true);
    const res2 = await h.host.createTask({ title: '发合同' }, { signal: null, actionRunId: 'run_dup' });
    assert.equal(res2.ok, true);
    assert.equal(res2.data.id, res1.data.id); // 返回同一任务
    assert.equal(h.store.listTasks().length, 1); // 只创建了一条
    assert.ok(res2.effect.summary.includes('重复请求'));
  } finally {
    h.cleanup();
  }
});

/** 场景 10 补充：确认阶段双击发送第二次 → 系统拒绝（BUSY），不产生重复执行。 */
test('场景 10b：执行期间重复发送确认被拒绝', async () => {
  const h = makeHarness({
    plannerResponses: [makePlan()],
  });
  try {
    await h.orchestrator.startTextInput('创建任务');
    await h.orchestrator.sendResponse('确认');
    await assert.rejects(
      () => h.orchestrator.sendResponse('确认'),
      (e) => e.code === 'BUSY',
    );
    assert.equal(h.store.listTasks().length, 1);
  } finally {
    h.cleanup();
  }
});
