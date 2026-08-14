'use strict';

const { AppError, ERROR_CODES } = require('../shared/errors');
const { validateArgs, ACTION_SCHEMAS } = require('../planning/plan-schema');

/**
 * 动作注册表（白名单，文档 11.1 / 3.5）。
 * 未注册动作一律拒绝，禁止"尽量执行"。
 */
class ActionRegistry {
  constructor() {
    this._defs = new Map();
  }

  /** @param {{type: string, risk: string, schema: object, execute: Function, compensate?: Function}} def */
  register(def) {
    if (!def || typeof def.type !== 'string' || typeof def.execute !== 'function') {
      throw new AppError(ERROR_CODES.INVALID_ARGUMENT, '动作定义不合法', { details: { type: def && def.type } });
    }
    if (this._defs.has(def.type)) {
      throw new AppError(ERROR_CODES.CONFLICT, `动作已注册：${def.type}`);
    }
    this._defs.set(def.type, def);
  }

  has(type) {
    return this._defs.has(type);
  }

  get(type) {
    return this._defs.get(type) || null;
  }

  list() {
    return [...this._defs.keys()];
  }

  /**
   * 校验并执行动作。
   * @param {string} type 动作类型（白名单）
   * @param {object} args 参数（Schema 校验）
   * @param {{host, signal, context: {actionRunId, sessionId, planId}}} deps
   */
  async execute(type, args, deps) {
    const def = this._defs.get(type);
    if (!def) {
      throw new AppError(ERROR_CODES.ACTION_UNKNOWN, '不支持该操作', { details: { type } });
    }
    const check = validateArgs(ACTION_SCHEMAS[type] || def.schema, args);
    if (!check.ok) {
      throw new AppError(ERROR_CODES.ACTION_ARG_INVALID, '操作参数不合法', { details: { type, errors: check.errors } });
    }
    return def.execute({ args, host: deps.host, signal: deps.signal, context: deps.context });
  }
}

module.exports = { ActionRegistry };
