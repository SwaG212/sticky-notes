'use strict';

const { STATES, assertTransition } = require('./states');
const { EVENTS } = require('./events');
const { DialogueSession } = require('./dialogue-session');
const { CancellationController } = require('./cancellation-controller');
const { CancelledError, AppError, ERROR_CODES } = require('../shared/errors');

const FOLLOW_UP_MS = 15000;
const CLARIFY_TIMEOUT_MS = 60000;
const CONFIRM_TIMEOUT_MS = 60000;

/** 停止后无进行中异步任务、需主动收尾的状态。 */
const PASSIVE_STATES = new Set([
  STATES.CLARIFYING, STATES.AWAITING_CONFIRMATION, STATES.PAUSED,
  STATES.FOLLOW_UP, STATES.REPORTING,
]);

/**
 * 编排器：唯一允许推进对话状态的模块（文档 4 节）。
 * 音频、LLM、TTS 和执行器只返回事件或结果，不能自行切换全局状态。
 *
 * 文字版流程（阶段 1）：
 *   IDLE → REASONING → (CLARIFYING | AWAITING_CONFIRMATION | REPORTING)
 *   → EXECUTING → REPORTING → FOLLOW_UP → IDLE
 * 任意非 IDLE 状态可 STOP_REQUESTED → CANCELLING → REPORTING/IDLE
 * （停止收尾统一走 _finishCancel，由执行日志生成真实汇报）
 */
class AssistantOrchestrator {
  /**
   * @param {object} deps
   * @param {import('../llm/planner').Planner} deps.planner
   * @param {import('../planning/plan-validator').PlanValidator} deps.validator
   * @param {import('../planning/confirmation-gate').ConfirmationGate} deps.confirmationGate
   * @param {import('../planning/risk-policy').RiskPolicy} deps.riskPolicy
   * @param {import('../execution/executor').Executor} deps.executor
   * @param {import('../execution/action-registry').ActionRegistry} deps.registry
   * @param {object} deps.host
   * @param {import('../execution/execution-journal').ExecutionJournal} deps.journal
   * @param {import('../storage/session-store').SessionStore} deps.sessionStore
   * @param {import('../shared/logger').Logger} deps.logger
   * @param {(event: string, payload: object) => void} deps.emit
   * @param {object} [deps.tts] 阶段 2 注入；null 时 speech 仅显示为文字
   */
  constructor(deps) {
    this.planner = deps.planner;
    this.validator = deps.validator;
    this.confirmationGate = deps.confirmationGate;
    this.riskPolicy = deps.riskPolicy;
    this.executor = deps.executor;
    this.registry = deps.registry;
    this.host = deps.host;
    this.journal = deps.journal;
    this.sessionStore = deps.sessionStore;
    this.logger = deps.logger;
    this.emit = deps.emit;
    this.tts = deps.tts || null;
    this.config = deps.config || {};

    this.state = STATES.IDLE;
    this.session = null;
    this.cancellation = new CancellationController();
    this._activeTask = null;
    this._pauseRequested = false;
    this._timer = null;
  }

  // ---------- 对外命令（UI/IPC 调用） ----------

  /** 文字输入启动一轮（IDLE / FOLLOW_UP 允许）。 */
  async startTextInput(text) {
    if (typeof text !== 'string' || !text.trim()) {
      throw new AppError(ERROR_CODES.INVALID_ARGUMENT, '输入不能为空');
    }
    const input = text.trim();
    if (this.state === STATES.IDLE || this.state === STATES.FOLLOW_UP) {
      const prevState = this.state;
      if (prevState === STATES.IDLE) {
        this.session = new DialogueSession();
        this.cancellation.reset();
      }
      this._clearTimer();
      await this._transitionTo(STATES.REASONING, EVENTS.USER_TEXT_INPUT, { text: input });
      this.session.addUser(input);
      this.emit('dialog', { role: 'user', content: input });
      await this._runPlanning();
      return;
    }
    throw new AppError(ERROR_CODES.BUSY, '正在处理上一轮任务，请稍候');
  }

  /** 追问回答 / 确认话语（CLARIFYING、AWAITING_CONFIRMATION 允许）。 */
  async sendResponse(text) {
    if (typeof text !== 'string' || !text.trim()) {
      throw new AppError(ERROR_CODES.INVALID_ARGUMENT, '输入不能为空');
    }
    const input = text.trim();
    if (this.state === STATES.CLARIFYING) {
      this._clearTimer();
      await this._transitionTo(STATES.REASONING, EVENTS.USER_RESPONSE, { text: input });
      this.session.addUser(input);
      this.emit('dialog', { role: 'user', content: input });
      await this._runPlanning();
      return;
    }
    if (this.state === STATES.AWAITING_CONFIRMATION) {
      await this._handleConfirmationInput(input);
      return;
    }
    throw new AppError(ERROR_CODES.BUSY, '当前状态不能接收输入');
  }

  /** 停止（语音停止/按钮/Esc 汇合到此处）。 */
  stop(source) {
    if (this.state === STATES.IDLE) return { cancelled: false };
    const prevState = this.state;
    this.logger.info('stop_requested', { source, state: prevState });
    this._clearTimer();
    // 同步迁移到 CANCELLING（STOP 不依赖大模型理解）
    this._transitionToSync(STATES.CANCELLING, EVENTS.STOP_REQUESTED, { source });
    this.cancellation.cancel(source);
    if (this.tts) this.tts.stop();
    if (PASSIVE_STATES.has(prevState)) {
      // 等待态没有进行中的异步任务，主动收敛收尾
      this._activeTask = this._finishCancel(this.session && this.session.currentPlan)
        .catch((err) => this.logger.error('cancel_finish_failed', { message: err.message }));
    }
    return { cancelled: true };
  }

  /** 暂停（仅 EXECUTING 有效，动作边界生效）。 */
  pause() {
    if (this.state !== STATES.EXECUTING) {
      throw new AppError(ERROR_CODES.PAUSE_NOT_AT_BOUNDARY, '当前状态不能暂停', { details: { state: this.state } });
    }
    this._pauseRequested = true;
    this.emit('control', { action: 'pause_requested' });
    return { ok: true };
  }

  /** 继续执行（仅 PAUSED 有效）。 */
  async resume() {
    if (this.state !== STATES.PAUSED) {
      throw new AppError(ERROR_CODES.ILLEGAL_TRANSITION, '当前状态不能继续', { details: { state: this.state } });
    }
    // 继续前重新确认宿主可用（文档 12.3）
    let cap;
    try {
      cap = await this.host.getCapabilities({ signal: this.cancellation.signal });
    } catch (err) {
      throw new AppError(ERROR_CODES.HOST_UNAVAILABLE, '宿主不可用，无法继续', { cause: err });
    }
    if (!cap || cap.ok !== true) {
      throw new AppError(ERROR_CODES.HOST_UNAVAILABLE, '宿主不可用，无法继续', {
        details: cap && cap.error ? cap.error : null,
      });
    }
    await this._transitionTo(STATES.EXECUTING, EVENTS.RESUME_REQUESTED, {});
    await this._runExecution(this.session.currentPlan);
  }

  getStateSnapshot() {
    return {
      state: this.state,
      sessionId: this.session ? this.session.sessionId : null,
      lastRecognition: this.session ? this.session.lastUserText : null,
      currentPlan: this.session && this.session.currentPlan
        ? {
          planId: this.session.currentPlan.planId,
          revision: this.session.currentPlan.revision,
          decision: this.session.currentPlan.decision,
          goal: this.session.currentPlan.goal,
          actions: this.session.currentPlan.actions,
          missingFields: this.session.currentPlan.missingFields,
          assumptions: this.session.currentPlan.assumptions,
        }
        : null,
    };
  }

  // ---------- 内部流程 ----------

  async _runPlanning() {
    const startedAt = Date.now();
    try {
      const candidate = await this.planner.plan({
        session: this.session,
        signal: this.cancellation.signal,
      });
      if (this.state === STATES.CANCELLING) {
        await this._finishCancel(candidate);
        return;
      }

      this.logger.info('llm_decision', {
        sessionId: this.session.sessionId,
        planId: candidate.planId,
        decision: candidate.decision,
        durationMs: Date.now() - startedAt,
      });
      this.session.setPlan(candidate);
      this.emit('plan_updated', this.getStateSnapshot().currentPlan);
      this._saveSession();

      if (candidate.decision === 'clarify') {
        await this._enterClarifying(candidate);
        return;
      }
      if (candidate.decision === 'answer' || candidate.decision === 'reject') {
        await this._reportText(candidate.speech);
        this._enterFollowUp();
        return;
      }
      // confirm：本地完整性校验通过才进入确认阶段（文档 10 节）
      const check = this.validator.validate(candidate, {
        missingFields: candidate.missingFields,
        assumptions: candidate.assumptions,
      });
      if (check.valid) {
        await this._transitionTo(STATES.AWAITING_CONFIRMATION, EVENTS.LLM_DECISION, { decision: 'confirm' });
        const speech = `我打算${candidate.speech || '执行以下计划'}，确认吗？`;
        this.session.addAssistant(speech, 'ask_confirm');
        this.emit('dialog', { role: 'assistant', content: speech, kind: 'ask_confirm' });
        const confirmMs = this.config.confirmTimeoutMs || CONFIRM_TIMEOUT_MS;
        this._setTimer(STATES.AWAITING_CONFIRMATION, confirmMs, () => this._safeReturnToIdle('确认超时'));
        return;
      }
      // confirm 但本地校验不完整：按缺失内容追问（不能进入确认阶段）
      const missing = check.issues.filter(
        (i) => i.code === 'PLAN_MISSING_FIELDS' || i.code === 'PLAN_ASSUMPTIONS_PRESENT',
      );
      if (missing.length > 0) {
        const speech = `还差一些信息：${missing.map((i) => i.message).join('；')}，请补充。`;
        await this._enterClarifying({ ...candidate, speech });
        return;
      }
      throw new AppError(ERROR_CODES.PLAN_INVALID, '计划校验失败', { details: { issues: check.issues } });
    } catch (err) {
      if (err instanceof CancelledError || this.cancellation.isCancelled()) {
        await this._finishCancel(this.session.currentPlan);
        return;
      }
      await this._handlePlanningError(err);
    }
  }

  async _enterClarifying(candidate) {
    if (this.state === STATES.CANCELLING) {
      await this._finishCancel(candidate);
      return;
    }
    const missing = candidate.missingFields.map((f) => ({ code: 'PLAN_MISSING_FIELDS', message: `缺少：${f}` }));
    await this._transitionTo(STATES.CLARIFYING, EVENTS.LLM_DECISION, { decision: 'clarify', missing });
    this.session.addAssistant(candidate.speech, 'clarify');
    this.emit('dialog', { role: 'assistant', content: candidate.speech, kind: 'clarify', missingFields: missing });
    const clarifyMs = this.config.clarifyTimeoutMs || CLARIFY_TIMEOUT_MS;
    this._setTimer(STATES.CLARIFYING, clarifyMs, () => this._safeReturnToIdle('追问超时'));
  }

  async _handleConfirmationInput(input) {
    if (this.state === STATES.CANCELLING) return;
    const plan = this.session.currentPlan;
    if (!plan) {
      throw new AppError(ERROR_CODES.PLAN_INVALID, '当前没有待确认计划');
    }
    const gate = this.confirmationGate.confirm(plan, input);
    if (gate.ok) {
      this.session.addUser(input);
      this.emit('dialog', { role: 'user', content: input });
      this.session.setConfirmation(plan.planId, plan.revision);
      this._clearTimer();
      this.logger.info('plan_confirmed', {
        sessionId: this.session.sessionId, planId: plan.planId, revision: plan.revision,
      });
      await this._transitionTo(STATES.EXECUTING, EVENTS.USER_CONFIRM, { text: input });
      await this._runExecution(plan);
      return;
    }
    if (gate.error.code === ERROR_CODES.CONFIRMATION_AMBIGUOUS) {
      const msg = '我不太确定您是否同意，请明确回复"确认"或直接告诉我需要修改的地方。';
      this.session.addAssistant(msg, 'ask_confirm');
      this.emit('dialog', { role: 'assistant', content: msg, kind: 'ask_confirm' });
      return;
    }
    // 否定/修改：重新规划生成新 revision，旧确认失效（文档 10 节末段）
    this.session.addUser(input);
    this.emit('dialog', { role: 'user', content: input });
    this.session.clearConfirmation();
    await this._transitionTo(STATES.REASONING, EVENTS.USER_CONFIRM, { text: input, modified: true });
    await this._runPlanning();
  }

  async _runExecution(plan) {
    const pausedAt = plan._resumeFrom || 0;
    delete plan._resumeFrom;
    this._pauseRequested = false;
    const result = await this.executor.execute({
      plan,
      sessionId: this.session.sessionId,
      signal: this.cancellation.signal,
      startIndex: pausedAt,
      shouldPause: () => this._pauseRequested,
    });
    this.emit('execution_update', { planId: plan.planId, result });

    if (this.state === STATES.CANCELLING) {
      this.journal.finishPlan({
        planId: plan.planId, sessionId: this.session.sessionId, status: 'cancelled',
        summary: summarizeResult(result),
      });
      await this._finishCancel(plan);
      return;
    }
    if (result.status === 'paused') {
      // stoppedAt 指向暂停时被跳过的动作，继续时从该动作开始
      plan._resumeFrom = result.stoppedAt;
      await this._transitionTo(STATES.PAUSED, EVENTS.PAUSE_REQUESTED, {});
      this.session.addAssistant('已暂停，可随时让我继续。', 'paused');
      this.emit('dialog', { role: 'assistant', content: '已暂停，可随时让我继续。', kind: 'paused' });
      return;
    }

    this.journal.finishPlan({
      planId: plan.planId, sessionId: this.session.sessionId, status: result.status,
      summary: summarizeResult(result),
    });
    await this._transitionTo(STATES.REPORTING, EVENTS.EXECUTION_FINISHED, { status: result.status });

    const summary = this.journal.summarize(plan.planId, this._plannedRuns(plan));
    const report = this._buildReport(result.status, summary, result.failed);
    this.session.addAssistant(report, 'report');
    this.emit('dialog', { role: 'assistant', content: report, kind: 'report', summary });
    this._enterFollowUp();
  }

  /** CANCELLING 收敛统一出口：按执行日志生成真实汇报（文档 12.2 第 8-9 步）。幂等。 */
  async _finishCancel(plan) {
    if (this.state !== STATES.CANCELLING) return;
    let report = '已停止。';
    if (plan && plan.planId) {
      const summary = this.journal.summarize(plan.planId, this._plannedRuns(plan));
      if (summary.completed.length > 0 || summary.interrupted.length > 0) {
        report = this._buildReport('cancelled', summary, null);
      }
    }
    if (report === '已停止。') {
      await this._transitionTo(STATES.IDLE, EVENTS.STOP_REQUESTED, {});
    } else {
      await this._transitionTo(STATES.REPORTING, EVENTS.STOP_REQUESTED, {});
      this.session.addAssistant(report, 'report');
      this.emit('dialog', { role: 'assistant', content: report, kind: 'report' });
      this._enterFollowUp();
    }
  }

  async _handlePlanningError(err) {
    const code = err.code || ERROR_CODES.INTERNAL;
    this.logger.error('planning_failed', { sessionId: this.session.sessionId, code, message: err.message });
    const msg = err.message || '出错了，请重试';
    await this._transitionTo(STATES.ERROR, EVENTS.LLM_DECISION, { error: code });
    this.session.addAssistant(msg, 'error');
    this.emit('dialog', { role: 'assistant', content: msg, kind: 'error', code });
  }

  async _reportText(text) {
    if (this.state === STATES.CANCELLING) {
      await this._finishCancel(this.session.currentPlan);
      return;
    }
    await this._transitionTo(STATES.REPORTING, EVENTS.LLM_DECISION, { decision: 'answer' });
    this.session.addAssistant(text, 'answer');
    this.emit('dialog', { role: 'assistant', content: text, kind: 'answer' });
  }

  _enterFollowUp() {
    this._transitionToSync(STATES.FOLLOW_UP, EVENTS.EXECUTION_FINISHED, {});
    this._setTimer(STATES.FOLLOW_UP, this.config.followUpWindowMs || FOLLOW_UP_MS, () => this._safeReturnToIdle('连续对话窗口结束'));
  }

  _safeReturnToIdle(reason) {
    if (this.state === STATES.CANCELLING || this.state === STATES.IDLE) return;
    this.logger.info('state_timeout', { state: this.state, reason });
    this._transitionToSync(STATES.IDLE, EVENTS.TIMEOUT, { reason });
    this._saveSession();
  }

  _plannedRuns(plan) {
    return plan.actions.map((a, i) => ({
      index: i, actionRunId: null, actionType: a.type,
      title: a.args && a.args.title ? a.args.title : null,
    }));
  }

  _buildReport(status, summary, failed) {
    const parts = [];
    if (summary.completed.length > 0) {
      parts.push(`已完成：${summary.completed.map((c) => c.summary || c.title || c.actionType).join('；')}。`);
    }
    if (summary.interrupted.length > 0) {
      parts.push(`中断：${summary.interrupted.map((i) => i.title || i.actionType).join('、')}。`);
    }
    if (summary.notExecuted.length > 0) {
      parts.push(`未执行：${summary.notExecuted.map((n) => n.title || n.actionType).join('、')}。`);
    }
    if (failed && failed.length > 0) {
      parts.push(`失败：${failed.map((f) => f.title || f.actionType).join('、')}。`);
    }
    if (parts.length === 0) {
      parts.push(status === 'cancelled' ? '已停止，没有执行任何操作。' : '执行完成。');
    }
    return parts.join('');
  }

  // ---------- 状态机基础设施 ----------

  /** 异步迁移：校验 → 切换 → 记录 → 广播。 */
  async _transitionTo(to, event, payload) {
    const from = this.state;
    assertTransition(from, to);
    this.state = to;
    this._logTransition(from, to, event, payload);
    this.emit('state_changed', {
      from, to, event, sessionId: this.session && this.session.sessionId, ...payload,
    });
  }

  /** 同步迁移（CANCELLING 路径；事件循环下无并发竞争）。 */
  _transitionToSync(to, event, payload) {
    const from = this.state;
    assertTransition(from, to);
    this.state = to;
    this._logTransition(from, to, event, payload);
    this.emit('state_changed', {
      from, to, event, sessionId: this.session && this.session.sessionId, ...payload,
    });
  }

  _logTransition(from, to, event, payload) {
    this.logger.info('state_transition', {
      sessionId: this.session && this.session.sessionId,
      planId: this.session && this.session.currentPlan && this.session.currentPlan.planId,
      state: to,
      details: { from, event, payload },
    });
  }

  _setTimer(state, ms, fn) {
    this._clearTimer();
    this._timer = setTimeout(() => {
      if (this.state === state) fn();
    }, ms);
  }

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _saveSession() {
    if (this.session && this.sessionStore) {
      try {
        this.sessionStore.save(this.session.toJSON());
      } catch (err) {
        this.logger.error('session_save_failed', { message: err.message });
      }
    }
  }
}

function summarizeResult(result) {
  return {
    status: result.status,
    completed: result.completed.length,
    failed: result.failed.length,
    interrupted: result.interrupted.length,
    notExecuted: result.notExecuted.length,
  };
}

module.exports = { AssistantOrchestrator, FOLLOW_UP_MS };
