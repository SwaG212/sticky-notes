'use strict';

const { AppError, ERROR_CODES } = require('../shared/errors');

const RISK_LEVELS = { low: 1, medium: 2, high: 3 };

const PLAN_LIMITS = {
  maxActions: 5,          // 单计划动作数上限（10.7）
  maxTitleLength: 200,    // 与 plan-schema 保持一致
  maxContentLength: 5000,
};

/**
 * 风险策略（文档 10.8、21）。
 * 首版动作全部为 low（无删除/覆盖/外发），机制保留用于后续扩展。
 */
class RiskPolicy {
  /**
   * 检查计划是否允许进入确认阶段。
   * @param {{actions: Array<{type: string, args: object}>}} plan
   * @param {{get: (type: string) => object|null}} registry
   * @returns {{ok: true}|{ok: false, reasons: string[], highRiskTypes: string[]}}
   */
  assess(plan, registry) {
    if (!plan || !Array.isArray(plan.actions) || plan.actions.length === 0) {
      return { ok: false, reasons: ['计划没有动作'], highRiskTypes: [] };
    }
    const reasons = [];
    const highRiskTypes = [];
    if (plan.actions.length > PLAN_LIMITS.maxActions) {
      reasons.push(`动作数量超过上限 ${PLAN_LIMITS.maxActions}`);
    }
    for (const a of plan.actions) {
      const def = registry.get(a.type);
      if (!def) {
        reasons.push(`未注册动作：${a.type}`);
        continue;
      }
      if (RISK_LEVELS[def.risk] >= RISK_LEVELS.high) {
        highRiskTypes.push(a.type);
        reasons.push(`高风险动作需额外确认：${a.type}`);
      }
      if (a.args) {
        if (typeof a.args.title === 'string' && a.args.title.length > PLAN_LIMITS.maxTitleLength) {
          reasons.push(`标题过长：${a.type}`);
        }
        if (typeof a.args.content === 'string' && a.args.content.length > PLAN_LIMITS.maxContentLength) {
          reasons.push(`内容过长：${a.type}`);
        }
      }
    }
    if (reasons.length > 0) return { ok: false, reasons, highRiskTypes };
    return { ok: true, highRiskTypes };
  }

  riskOf(type, registry) {
    const def = registry.get(type);
    return def ? def.risk : 'unknown';
  }

  throwIfNotAllowed(plan, registry) {
    const r = this.assess(plan, registry);
    if (!r.ok) {
      throw new AppError(ERROR_CODES.PLAN_RISK_REJECTED, '计划未通过风险检查', { details: { reasons: r.reasons } });
    }
    return r;
  }
}

module.exports = { RiskPolicy, PLAN_LIMITS, RISK_LEVELS };
