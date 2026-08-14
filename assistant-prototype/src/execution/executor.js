'use strict';

const { CancelledError, AppError, ERROR_CODES } = require('../shared/errors');

/**
 * 执行器（文档 12 节）：
 * - 默认按计划顺序串行执行；只有显式声明互不依赖的只读动作才允许并行（首版全串行）；
 * - 每个动作开始前检查 AbortSignal；
 * - 每个动作结束后立即写执行日志；
 * - 单步失败默认停止后续并汇报，不自动猜测替代动作；
 * - 暂停只在动作边界生效；
 * - 非幂等动作不自动重试，幂等动作默认最多重试 1 次。
 */
class Executor {
  /**
   * @param {{registry: import('./action-registry').ActionRegistry, host: object, journal: import('./execution-journal').ExecutionJournal}} deps
   */
  constructor({ registry, host, journal }) {
    this.registry = registry;
    this.host = host;
    this.journal = journal;
  }

  /**
   * 执行候选计划。
   * @param {object} opts
   * @param {object} opts.plan {planId, actions: [{type, args}]}
   * @param {string} opts.sessionId
   * @param {AbortSignal} opts.signal 全局取消信号
   * @param {number} [opts.startIndex] 从第几个动作开始（恢复用）
   * @param {() => boolean} [opts.shouldPause] 动作边界暂停检测
   * @returns {Promise<{status: string, completed: Array, failed: Array, interrupted: Array, notExecuted: Array, stoppedAt: number}>}
   */
  async execute({ plan, sessionId, signal, startIndex = 0, shouldPause = null }) {
    const { planId, actions } = plan;
    const completed = [];
    const failed = [];
    const interrupted = [];
    let status = 'completed';
    let stoppedAt = startIndex;

    for (let i = startIndex; i < actions.length; i++) {
      const action = actions[i];
      stoppedAt = i;

      if (signal.aborted) break; // 停止后阻止任何新动作开始（文档 12.2 第 5 步）

      if (shouldPause && shouldPause()) {
        status = 'paused';
        break;
      }

      const actionRunId = this.journal.startAction({
        planId, sessionId, actionType: action.type, args: action.args, index: i,
      });
      const startedAt = Date.now();
      let durationMs = 0;

      try {
        const result = await this.executeAction(action, { planId, sessionId, actionRunId, signal });
        durationMs = Date.now() - startedAt;
        this.journal.finishAction({
          planId, sessionId, actionRunId, actionType: action.type,
          result: result.data, effect: result.effect, durationMs,
        });
        completed.push({ actionRunId, actionType: action.type, summary: result.effect && result.effect.summary });
        this.emitActionEnd && this.emitActionEnd({ actionRunId, actionType: action.type, ok: true, result });
      } catch (err) {
        durationMs = Date.now() - startedAt;
        if (err instanceof CancelledError || signal.aborted) {
          this.journal.cancelAction({
            planId, sessionId, actionRunId, actionType: action.type,
            source: signal.reason && signal.reason.source, durationMs,
          });
          interrupted.push({ actionRunId, actionType: action.type, cancelled: true });
          status = 'cancelled';
          break;
        }
        const code = err.code || ERROR_CODES.ACTION_FAILED;
        this.journal.failAction({
          planId, sessionId, actionRunId, actionType: action.type,
          code, message: err.message, durationMs,
        });
        failed.push({ actionRunId, actionType: action.type, code });
        status = 'failed';
        break; // 单步失败默认停止后续（文档 12.1）
      }
    }

    if (status === 'completed' && stoppedAt < actions.length - 1) {
      status = 'cancelled';
    }

    const notExecuted = actions.slice(stoppedAt + 1).map((a) => a.type);
    if (signal.aborted && status === 'completed') status = 'cancelled';

    return { status, completed, failed, interrupted, notExecuted, stoppedAt };
  }

  /** 单动作执行（含幂等动作的一次自动重试）。 */
  async executeAction(action, { planId, sessionId, actionRunId, signal }) {
    const def = this.registry.get(action.type);
    const maxRetries = def && def.idempotent ? 1 : 0;
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal.aborted) throw new CancelledError(signal.reason && signal.reason.source);
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 300)); // 固定退避，首版不配置化
      }
      try {
        return await this.registry.execute(action.type, action.args, {
          host: this.host,
          signal,
          context: { actionRunId, sessionId, planId },
        });
      } catch (err) {
        lastErr = err;
        if (err instanceof CancelledError) throw err;
        if (attempt >= maxRetries) throw err;
      }
    }
    throw lastErr;
  }
}

module.exports = { Executor };
