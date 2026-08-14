'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SandboxStore } = require('../../src/storage/sandbox-store');
const { SessionStore } = require('../../src/storage/session-store');
const { ExecutionJournal } = require('../../src/execution/execution-journal');
const { ActionRegistry } = require('../../src/execution/action-registry');
const { Executor } = require('../../src/execution/executor');
const { MockHostAdapter } = require('../../src/host/mock-host-adapter');
const { PlanValidator } = require('../../src/planning/plan-validator');
const { ConfirmationGate } = require('../../src/planning/confirmation-gate');
const { RiskPolicy } = require('../../src/planning/risk-policy');
const { AssistantOrchestrator } = require('../../src/assistant/orchestrator');
const { Logger } = require('../../src/shared/logger');
const { registerActions } = require('../../src/main/register-actions');

/** 可编程假规划器：返回预置响应序列；支持挂起以模拟 LLM 思考中。 */
class StubPlanner {
  constructor(responses = []) {
    this.responses = responses;
    this.calls = 0;
    this._blocker = null;
  }

  /** 挂起后续 plan 调用，直到 signal abort 或 release()。 */
  block() {
    this._blocker = { promise: null, release: null };
    this._blocker.promise = new Promise((resolve) => {
      this._blocker.resolve = resolve;
    });
    return this._blocker;
  }

  async plan({ session, signal }) {
    if (this._blocker) {
      await Promise.race([
        this._blocker.promise,
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { cancelled: true })), { once: true });
        }),
      ]);
      return { decision: 'answer', speech: '已唤醒', draft: null, missingFields: [], assumptions: [] };
    }
    const idx = Math.min(this.calls, this.responses.length - 1);
    this.calls++;
    const entry = this.responses[idx];
    return typeof entry === 'function' ? entry({ session, signal }) : entry;
  }
}

/** 构造完整编排器（真实组件 + StubPlanner）。 */
function makeHarness({ plannerResponses = [], config = {}, host = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asst-harness-'));
  const store = new SandboxStore({ dataDir: dir });
  store.init();
  const sessionStore = new SessionStore({ sessionsDir: path.join(dir, 'sessions') });
  const journal = new ExecutionJournal({ journalDir: path.join(dir, 'journal') });

  const registry = new ActionRegistry();
  registerActions(registry);
  const realHost = host || new MockHostAdapter(store);
  const executor = new Executor({ registry, host: realHost, journal });
  const planner = new StubPlanner(plannerResponses);

  const events = [];
  const logger = new Logger();

  const orchestrator = new AssistantOrchestrator({
    planner,
    validator: new PlanValidator(registry),
    confirmationGate: new ConfirmationGate(),
    riskPolicy: new RiskPolicy(),
    executor,
    registry,
    host: realHost,
    journal,
    sessionStore,
    logger,
    config: { followUpWindowMs: 100, ...config },
    emit: (event, payload) => events.push({ event, payload }),
  });

  return {
    dir,
    orchestrator,
    planner,
    journal,
    store,
    host: realHost,
    events,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 构造标准候选计划。 */
function makePlan(overrides = {}) {
  return {
    planId: 'plan_test',
    revision: 1,
    decision: 'confirm',
    speech: '创建任务',
    goal: '创建测试任务',
    actions: [{ type: 'create_task', args: { title: '测试任务' } }],
    missingFields: [],
    assumptions: [],
    isComplete: true,
    ...overrides,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 等待编排器进入某状态（超时则失败）。 */
async function waitForState(orchestrator, state, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (orchestrator.state === state) return true;
    await sleep(10);
  }
  return orchestrator.state === state;
}

function transitionSeq(events) {
  return events
    .filter((e) => e.event === 'state_changed')
    .map((e) => `${e.payload.from}->${e.payload.to}`);
}

module.exports = { makeHarness, makePlan, StubPlanner, sleep, waitForState, transitionSeq };
