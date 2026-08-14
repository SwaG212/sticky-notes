'use strict';

const { AppError, ERROR_CODES } = require('../shared/errors');
const { newPlanId } = require('../shared/ids');
const { parseRelativeTime } = require('../shared/time');
const { buildSystemPrompt, buildRepairPrompt } = require('./prompts');
const { ResponseParser } = require('./response-parser');

const TIME_KEYS = new Set(['time', 'dueDate', 'alarmTime']);

/**
 * 规划器：调用 DeepSeek 生成"对话决策 + 候选计划"（文档 3.2/9 节）。
 * 只产出候选计划，不产生任何副作用；是否进入执行由确认门决定。
 *
 * 输出 CandidatePlan：
 * {
 *   planId, revision, decision, speech, goal, actions,
 *   missingFields, assumptions, isComplete
 * }
 */
class Planner {
  /**
   * @param {{client: import('./deepseek-client').DeepSeekClient, maxHistory?: number}} deps
   */
  constructor({ client, maxHistory = 12 }) {
    this.client = client;
    this.maxHistory = maxHistory;
    this._parser = new ResponseParser();
  }

  /**
   * @param {object} ctx
   * @param {object} ctx.session 会话（含 history、currentPlan）
   * @param {AbortSignal} [ctx.signal]
   * @returns {Promise<CandidatePlan>}
   */
  async plan({ session, signal }) {
    const messages = this._buildMessages(session);
    const raw = await this.client.chat(messages, { signal });
    let parsed = this._parser.parse(raw.content);
    if (!parsed.ok) {
      // 最多一次格式修复请求（文档 9 节）
      const repair = await this.client.chat(
        [...messages, { role: 'assistant', content: raw.content }, { role: 'user', content: buildRepairPrompt(raw.content) }],
        { signal },
      );
      parsed = this._parser.parse(repair.content);
      if (!parsed.ok) {
        throw new AppError(ERROR_CODES.LLM_INVALID_RESPONSE, '助手返回了无法理解的内容', {
          details: { parseError: parsed.error },
        });
      }
    }

    return this._toCandidatePlan(parsed.value, session);
  }

  _buildMessages(session) {
    const messages = [{ role: 'system', content: buildSystemPrompt() }];
    const history = session.getHistoryForPlanner(this.maxHistory);
    for (const m of history) {
      messages.push({ role: m.role, content: m.content });
    }
    return messages;
  }

  /** 把解析结果转成候选计划；相对时间转绝对，转换失败计入 missingFields。 */
  _toCandidatePlan(parsed, session) {
    const { decision, speech, draft, missingFields, assumptions } = parsed;
    const base = {
      decision,
      speech,
      missingFields: [...missingFields],
      assumptions: [...assumptions],
      goal: draft && draft.goal ? draft.goal : '',
      actions: draft ? [...draft.actions] : [],
    };

    // 时间参数本地二次转换（文档 9 节"对日期、时间做本地二次验证"）
    for (const [i, action] of base.actions.entries()) {
      for (const key of Object.keys(action.args || {})) {
        if (!TIME_KEYS.has(key)) continue;
        const value = action.args[key];
        if (value === null || value === undefined) continue;
        if (typeof value !== 'string') continue;
        if (isAbsoluteIso(value)) continue;
        const converted = parseRelativeTime(value);
        if (converted.ok) {
          action.args[key] = converted.value;
        } else {
          action.args[key] = null;
          const field = `actions[${i}].args.${key}`;
          if (!base.missingFields.includes(field)) base.missingFields.push(field);
        }
      }
    }

    const plan = {
      planId: this._planIdFor(session, base.goal),
      revision: this._revisionFor(session, base.goal),
      ...base,
    };
    plan.isComplete = decision === 'confirm'
      && plan.missingFields.length === 0
      && plan.assumptions.length === 0
      && plan.actions.length > 0;
    return plan;
  }

  /** 同一目标演化复用 planId，否则新 planId（文档 7.2：每份计划唯一 planId）。 */
  _planIdFor(session, goal) {
    const prev = session.currentPlan;
    if (prev && goal === prev.goal) return prev.planId;
    return newPlanId();
  }

  _revisionFor(session, goal) {
    const prev = session.currentPlan;
    if (prev && goal === prev.goal) return prev.revision + 1;
    return 1;
  }
}

function isAbsoluteIso(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:\d{2}|Z)$/.test(value);
}

module.exports = { Planner };
