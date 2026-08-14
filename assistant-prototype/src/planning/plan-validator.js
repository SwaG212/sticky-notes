'use strict';

const { ACTION_SCHEMAS, validateArgs } = require('./plan-schema');
const { RiskPolicy } = require('./risk-policy');

/**
 * 计划完整性校验（文档 10 节 8 个条件）。计划只有全部通过才能进入确认阶段。
 *
 * 校验项：
 * 1. missingFields 为空
 * 2. assumptions 为空
 * 3. 每个动作已在 ActionRegistry 注册
 * 4. 所有参数通过对应 Schema
 * 5. 相对时间已转换为 Asia/Shanghai 绝对时间（ISO 8601）
 * 6. 操作对象唯一（同一计划内不得既创建又完成/修改同名对象；append 目标唯一）
 * 7. 动作数量、文本长度和数据规模未超过限制
 * 8. 风险策略允许
 */
class PlanValidator {
  /**
   * @param {{has: (type: string) => boolean}} registry
   */
  constructor(registry) {
    this.registry = registry;
    this.riskPolicy = new RiskPolicy();
  }

  /**
   * @param {object} plan { goal, actions: [{type, args}] }
   * @param {string[]} [missingFields]
   * @param {string[]} [assumptions]
   * @returns {{valid: boolean, issues: Array<{code, path, message}>}}
   */
  validate(plan, { missingFields = [], assumptions = [] } = {}) {
    const issues = [];
    const p = (path, code, message) => issues.push({ path, code, message });

    if (!plan || typeof plan !== 'object') {
      return { valid: false, issues: [{ path: '$', code: 'PLAN_NOT_OBJECT', message: '计划不是对象' }] };
    }
    if (!Array.isArray(plan.actions) || plan.actions.length === 0) {
      return { valid: false, issues: [{ path: 'actions', code: 'NO_ACTIONS', message: '计划没有动作' }] };
    }

    // 条件 1
    if (missingFields.length > 0) {
      p('missingFields', 'PLAN_MISSING_FIELDS', `缺少字段：${missingFields.join('、')}`);
    }
    // 条件 2
    if (assumptions.length > 0) {
      p('assumptions', 'PLAN_ASSUMPTIONS_PRESENT', `存在未确认假设：${assumptions.join('、')}`);
    }
    // 条件 3、4、5、7
    plan.actions.forEach((a, i) => {
      const base = `actions[${i}]`;
      if (!a || typeof a.type !== 'string') {
        p(`${base}.type`, 'PLAN_ACTION_UNKNOWN', '动作缺少类型');
        return;
      }
      if (!this.registry.has(a.type)) {
        p(`${base}.type`, 'PLAN_ACTION_UNKNOWN', `未注册动作：${a.type}`);
        return;
      }
      const check = validateArgs(ACTION_SCHEMAS[a.type], a.args || {});
      for (const e of check.errors) {
        p(`${base}.args.${e.path}`, 'ACTION_ARG_INVALID', e.detail || e.code);
      }
      // 条件 5：时间参数必须是绝对 ISO（含时区偏移或 Z）
      const schema = ACTION_SCHEMAS[a.type];
      for (const [key, rule] of Object.entries(schema.properties || {})) {
        if (rule.format === 'date-time' && typeof a.args[key] === 'string') {
          if (!/Z$|[+-]\d{2}:\d{2}$/.test(a.args[key])) {
            p(`${base}.args.${key}`, 'TIME_NOT_ABSOLUTE', '时间必须是带时区的绝对时间');
          }
        }
      }
      // 条件 7：文本长度（schema 已限，这里做计划级复核）
      if (typeof a.args.title === 'string' && a.args.title.length > 200) {
        p(`${base}.args.title`, 'PLAN_TOO_LARGE', '标题超过 200 字');
      }
      if (typeof a.args.content === 'string' && a.args.content.length > 5000) {
        p(`${base}.args.content`, 'PLAN_TOO_LARGE', '内容超过 5000 字');
      }
    });

    // 条件 6：操作对象唯一——同一计划内不允许对同名对象既创建又完成/修改
    const created = new Map();
    const targeted = new Map();
    plan.actions.forEach((a, i) => {
      const title = a.args && a.args.title;
      if (!title) return;
      if (a.type === 'create_task' || a.type === 'create_note') {
        created.set(title, i);
      }
      if (a.type === 'complete_task' || a.type === 'update_task' || a.type === 'set_reminder' || a.type === 'append_note') {
        if (!targeted.has(title)) targeted.set(title, []);
        targeted.get(title).push(i);
      }
    });
    for (const [title, indices] of targeted) {
      if (created.has(title)) {
        p('actions', 'TARGET_CONFLICT', `「${title}」在同一计划内既创建又修改/完成（动作 ${created.get(title)} 与 ${indices.join('、')}）`);
      }
    }

    // 条件 8：风险策略
    const risk = this.riskPolicy.assess(plan, this.registry);
    if (!risk.ok) {
      for (const reason of risk.reasons) {
        p('risk', 'PLAN_RISK_REJECTED', reason);
      }
    }

    return { valid: issues.length === 0, issues };
  }
}

module.exports = { PlanValidator };
