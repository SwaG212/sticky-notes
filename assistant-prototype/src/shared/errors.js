'use strict';

/**
 * 稳定错误码。业务层禁止依赖错误文本做分支判断，一律使用这些枚举。
 */
const ERROR_CODES = {
  // 通用
  INTERNAL: 'INTERNAL',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  BUSY: 'BUSY',

  // 配置与密钥
  CONFIG_MISSING: 'CONFIG_MISSING',
  CONFIG_INVALID: 'CONFIG_INVALID',

  // LLM / DeepSeek
  LLM_NETWORK: 'LLM_NETWORK',
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  LLM_RATE_LIMITED: 'LLM_RATE_LIMITED',
  LLM_AUTH_FAILED: 'LLM_AUTH_FAILED',
  LLM_INVALID_RESPONSE: 'LLM_INVALID_RESPONSE',
  LLM_EMPTY_RESPONSE: 'LLM_EMPTY_RESPONSE',

  // 计划与确认
  PLAN_INVALID: 'PLAN_INVALID',
  PLAN_MISSING_FIELDS: 'PLAN_MISSING_FIELDS',
  PLAN_ASSUMPTIONS_PRESENT: 'PLAN_ASSUMPTIONS_PRESENT',
  PLAN_ACTION_UNKNOWN: 'PLAN_ACTION_UNKNOWN',
  PLAN_TOO_LARGE: 'PLAN_TOO_LARGE',
  PLAN_RISK_REJECTED: 'PLAN_RISK_REJECTED',
  CONFIRMATION_MISMATCH: 'CONFIRMATION_MISMATCH',
  CONFIRMATION_STALE: 'CONFIRMATION_STALE',
  CONFIRMATION_AMBIGUOUS: 'CONFIRMATION_AMBIGUOUS',

  // 执行
  ACTION_UNKNOWN: 'ACTION_UNKNOWN',
  ACTION_ARG_INVALID: 'ACTION_ARG_INVALID',
  ACTION_FAILED: 'ACTION_FAILED',
  ACTION_NOT_CANCELLABLE: 'ACTION_NOT_CANCELLABLE',
  ACTION_ALREADY_RUNNING: 'ACTION_ALREADY_RUNNING',
  EXECUTION_BUSY: 'EXECUTION_BUSY',
  PAUSE_NOT_AT_BOUNDARY: 'PAUSE_NOT_AT_BOUNDARY',

  // 宿主适配器
  HOST_UNAVAILABLE: 'HOST_UNAVAILABLE',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  AMBIGUOUS_TARGET: 'AMBIGUOUS_TARGET',
  NOTE_NOT_FOUND: 'NOTE_NOT_FOUND',
  REMINDER_CONFLICT: 'REMINDER_CONFLICT',
  TARGET_NOT_UNIQUE: 'TARGET_NOT_UNIQUE',

  // 状态机
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
  STATE_TIMEOUT: 'STATE_TIMEOUT',
};

/** 用户可见的中文提示，按错误码映射；无映射时用通用文案。 */
const USER_MESSAGES = {
  INTERNAL: '内部错误，请稍后重试',
  CONFIG_MISSING: '缺少配置（API Key），请检查 .env',
  LLM_NETWORK: '网络连接失败，请检查网络后重试',
  LLM_TIMEOUT: '助手思考超时，已停止',
  LLM_RATE_LIMITED: '请求过于频繁，请稍后再试',
  LLM_AUTH_FAILED: 'API Key 无效，请检查配置',
  LLM_INVALID_RESPONSE: '助手返回了无法理解的内容，请换一种说法',
  CANCELLED: '已停止',
  TIMEOUT: '等待超时',
  TASK_NOT_FOUND: '找不到对应任务',
  AMBIGUOUS_TARGET: '存在多个匹配对象，需要进一步确认',
  CONFLICT: '操作冲突，请确认当前状态',
};

/** 可恢复错误，携带稳定错误码、中文提示与结构化详情。 */
class AppError extends Error {
  /**
   * @param {string} code 稳定错误码（ERROR_CODES 之一）
   * @param {string} message 用户可见中文提示
   * @param {object} [options]
   * @param {object} [options.details] 结构化技术细节（可含 candidates 等）
   * @param {Error} [options.cause] 原始异常
   * @param {boolean} [options.retryable] 是否可重试
   */
  constructor(code, message, options = {}) {
    super(message || USER_MESSAGES[code] || '发生错误');
    this.name = 'AppError';
    this.code = code;
    this.details = options.details || null;
    this.cause = options.cause || null;
    this.retryable = Boolean(options.retryable);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
    };
  }
}

/** 编程错误、非法状态或不可恢复基础设施错误。不携带给最终用户的信息。 */
class InternalError extends Error {
  constructor(message, options = {}) {
    super(message || '内部错误');
    this.name = 'InternalError';
    this.code = options.code || ERROR_CODES.INTERNAL;
    this.cause = options.cause || null;
  }
}

/** 取消信号触发的标准异常。 */
class CancelledError extends InternalError {
  constructor(source) {
    super(`操作已取消：${source || 'unknown'}`, { code: ERROR_CODES.CANCELLED });
    this.name = 'CancelledError';
    this.source = source;
  }
}

function isAppError(err) {
  return err instanceof AppError;
}

module.exports = {
  ERROR_CODES,
  USER_MESSAGES,
  AppError,
  InternalError,
  CancelledError,
  isAppError,
};
