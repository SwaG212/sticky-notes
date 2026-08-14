'use strict';

const { AppError, ERROR_CODES } = require('../shared/errors');

/** 对话状态机状态（文档 7.1）。 */
const STATES = {
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  TRANSCRIBING: 'TRANSCRIBING',
  REASONING: 'REASONING',
  CLARIFYING: 'CLARIFYING',
  AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
  EXECUTING: 'EXECUTING',
  PAUSED: 'PAUSED',
  REPORTING: 'REPORTING',
  FOLLOW_UP: 'FOLLOW_UP',
  CANCELLING: 'CANCELLING',
  ERROR: 'ERROR',
};

/** 合法迁移表（文档 7.1/7.2）。STOP_REQUESTED 从所有非 IDLE 状态进入 CANCELLING。 */
const TRANSITIONS = {
  [STATES.IDLE]: new Set([
    STATES.REASONING,        // 手动启动 / 文字输入
    STATES.LISTENING,        // 唤醒词（阶段 2）
    STATES.ERROR,
  ]),
  [STATES.LISTENING]: new Set([
    STATES.TRANSCRIBING,
    STATES.REASONING,        // 手动输入兜底
    STATES.CANCELLING,
    STATES.IDLE,             // 等待说话超时
  ]),
  [STATES.TRANSCRIBING]: new Set([
    STATES.REASONING,
    STATES.CANCELLING,
    STATES.ERROR,
  ]),
  [STATES.REASONING]: new Set([
    STATES.CLARIFYING,
    STATES.AWAITING_CONFIRMATION,
    STATES.REPORTING,        // answer / reject 决策
    STATES.CANCELLING,
    STATES.ERROR,
  ]),
  [STATES.CLARIFYING]: new Set([
    STATES.REASONING,        // 用户补充回答后重新规划
    STATES.CANCELLING,
    STATES.IDLE,             // 超时
  ]),
  [STATES.AWAITING_CONFIRMATION]: new Set([
    STATES.EXECUTING,        // 用户确认
    STATES.REASONING,        // 用户修改 → 重新规划
    STATES.CANCELLING,
    STATES.IDLE,             // 超时
  ]),
  [STATES.EXECUTING]: new Set([
    STATES.REPORTING,        // 执行完成
    STATES.PAUSED,           // 暂停（动作边界）
    STATES.CANCELLING,
    STATES.ERROR,
  ]),
  [STATES.PAUSED]: new Set([
    STATES.EXECUTING,        // 继续
    STATES.CANCELLING,
  ]),
  [STATES.REPORTING]: new Set([
    STATES.FOLLOW_UP,        // 播报完成
    STATES.CANCELLING,
    STATES.IDLE,
  ]),
  [STATES.FOLLOW_UP]: new Set([
    STATES.REASONING,        // 连续对话新输入
    STATES.IDLE,             // 窗口超时
    STATES.CANCELLING,
  ]),
  [STATES.CANCELLING]: new Set([
    STATES.REPORTING,        // 收敛后汇报真实结果
    STATES.IDLE,
  ]),
  [STATES.ERROR]: new Set([
    STATES.IDLE,             // 回到待机
    STATES.REASONING,        // 用户重试
    STATES.CANCELLING,
  ]),
};

/**
 * 校验状态迁移；非法迁移记录并拒绝，不静默跳转（文档 7.2）。
 * @throws {AppError} ILLEGAL_TRANSITION
 */
function assertTransition(from, to) {
  const allowed = TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    throw new AppError(ERROR_CODES.ILLEGAL_TRANSITION, `非法状态迁移：${from} → ${to}`, {
      details: { from, to },
    });
  }
}

function canTransition(from, to) {
  const allowed = TRANSITIONS[from];
  return Boolean(allowed && allowed.has(to));
}

/** 所有状态（供 UI 渲染与测试） */
const ALL_STATES = Object.values(STATES);

module.exports = { STATES, TRANSITIONS, assertTransition, canTransition, ALL_STATES };
