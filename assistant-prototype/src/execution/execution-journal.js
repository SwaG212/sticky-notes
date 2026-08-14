'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { newActionRunId } = require('../shared/ids');
const { nowIso } = require('../shared/time');
const { redact } = require('../shared/logger');

/**
 * 执行日志（文档 12.1/16）：每个动作开始与结束各写一条 JSONL，
 * 最终汇报只能由本日志的真实结果生成。
 * 日志位于 sandbox-data/journal/{planId}.jsonl，重启后可恢复未完成记录。
 */
class ExecutionJournal {
  /** @param {{journalDir: string}} opts */
  constructor({ journalDir }) {
    this.journalDir = journalDir;
  }

  init() {
    fs.mkdirSync(this.journalDir, { recursive: true });
  }

  _file(planId) {
    return path.join(this.journalDir, `${planId}.jsonl`);
  }

  _append(planId, entry) {
    this.init();
    fs.appendFileSync(this._file(planId), JSON.stringify(entry) + '\n', 'utf8');
  }

  /**
   * 记录动作开始，返回 actionRunId。
   * @param {object} entry { planId, sessionId, actionType, args, index? } index 为计划内序号
   */
  startAction({ planId, sessionId, actionType, args, index = null }) {
    const actionRunId = newActionRunId();
    const entry = {
      kind: 'action_start',
      timestamp: nowIso(),
      planId,
      sessionId,
      actionRunId,
      index,
      actionType,
      args: redact(args || {}),
    };
    this._append(planId, entry);
    return actionRunId;
  }

  /** 记录动作成功结束。effect 为宿主返回的副作用描述。 */
  finishAction({ planId, sessionId, actionRunId, actionType, result, effect, durationMs }) {
    this._append(planId, {
      kind: 'action_finish',
      timestamp: nowIso(),
      planId,
      sessionId,
      actionRunId,
      actionType,
      ok: true,
      result: redact(result || null),
      effect: redact(effect || null),
      durationMs,
    });
  }

  /** 记录动作失败。 */
  failAction({ planId, sessionId, actionRunId, actionType, code, message, durationMs }) {
    this._append(planId, {
      kind: 'action_fail',
      timestamp: nowIso(),
      planId,
      sessionId,
      actionRunId,
      actionType,
      ok: false,
      error: { code, message },
      durationMs,
    });
  }

  /** 记录动作被取消。 */
  cancelAction({ planId, sessionId, actionRunId, actionType, source, durationMs }) {
    this._append(planId, {
      kind: 'action_cancel',
      timestamp: nowIso(),
      planId,
      sessionId,
      actionRunId,
      actionType,
      cancelled: true,
      source,
      durationMs,
    });
  }

  /** 记录执行计划整体结束。 */
  finishPlan({ planId, sessionId, status, summary }) {
    this._append(planId, {
      kind: 'plan_finish',
      timestamp: nowIso(),
      planId,
      sessionId,
      status,
      summary: redact(summary || null),
    });
  }

  /**
   * 读取某计划的执行条目（时间正序）。
   * @returns {Array<object>}
   */
  read(planId) {
    try {
      const raw = fs.readFileSync(this._file(planId), 'utf8');
      return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * 汇总某计划的真实执行结果（文档 12.2 第 8 步）。
   * 各项尽量携带动作标题（来自 action_start 的 args.title），便于用户侧汇报。
   * @returns {{completed: string[], interrupted: string[], notExecuted: string[], irreversible: string[], actions: object[]}}
   */
  summarize(planId, plannedActions = null) {
    const entries = this.read(planId);
    const completed = [];
    const interrupted = [];
    const notExecuted = [];
    const irreversible = [];
    const actions = [];
    const started = new Set();
    const ended = new Set();
    const titleByRun = new Map();

    for (const e of entries) {
      if (e.kind === 'action_start') {
        started.add(e.actionRunId);
        titleByRun.set(e.actionRunId, e.args && e.args.title ? e.args.title : null);
        actions.push({ actionRunId: e.actionRunId, actionType: e.actionType, status: 'unknown' });
      } else if (e.kind === 'action_finish' && started.has(e.actionRunId)) {
        ended.add(e.actionRunId);
        completed.push({
          actionRunId: e.actionRunId, actionType: e.actionType,
          title: titleByRun.get(e.actionRunId), summary: e.effect && e.effect.summary,
        });
        if (e.effect && e.effect.reversible === false) {
          irreversible.push({ actionRunId: e.actionRunId, actionType: e.actionType, summary: e.effect.summary });
        }
      } else if (e.kind === 'action_fail' && started.has(e.actionRunId)) {
        ended.add(e.actionRunId);
        interrupted.push({
          actionRunId: e.actionRunId, actionType: e.actionType,
          title: titleByRun.get(e.actionRunId),
          error: e.error ? e.error.code : 'ACTION_FAILED',
        });
      } else if (e.kind === 'action_cancel' && started.has(e.actionRunId)) {
        ended.add(e.actionRunId);
        interrupted.push({
          actionRunId: e.actionRunId, actionType: e.actionType,
          title: titleByRun.get(e.actionRunId),
          cancelled: true, source: e.source,
        });
      }
    }

    // 已开始但无结束记录的（进程中断或尚未执行完）视为中断
    for (const a of actions) {
      if (!ended.has(a.actionRunId)) {
        a.status = 'interrupted';
        interrupted.push({
          actionRunId: a.actionRunId, actionType: a.actionType,
          title: titleByRun.get(a.actionRunId), interrupted: true,
        });
      } else {
        a.status = completed.some((c) => c.actionRunId === a.actionRunId) ? 'completed' : 'failed';
      }
    }

    // 计划内但从未开始的动作（按计划序号判定）
    if (plannedActions) {
      const knownIndexes = new Set(
        entries.filter((e) => e.kind === 'action_start' && e.index !== null && e.index !== undefined)
          .map((e) => e.index),
      );
      for (const planned of plannedActions) {
        if (!knownIndexes.has(planned.index)) {
          notExecuted.push({ actionType: planned.actionType, title: planned.title || null });
        }
      }
    }

    return { completed, interrupted, notExecuted, irreversible, actions };
  }
}

module.exports = { ExecutionJournal };
