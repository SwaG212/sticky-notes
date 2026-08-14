'use strict';

/**
 * 状态机事件（文档 7.2：所有状态变化通过 orchestrator.dispatch(event)）。
 * 事件定义与 payload 契约集中于此。
 */
const EVENTS = {
  // 用户输入
  USER_TEXT_INPUT: 'user_text_input',       // payload: { text }
  USER_RESPONSE: 'user_response',           // CLARIFYING 中用户补充回答：{ text }
  USER_CONFIRM: 'user_confirm',             // AWAITING_CONFIRMATION 中用户话语：{ text }
  USER_CANCEL: 'user_cancel',               // 显式取消/否定：{ source }
  WAKE_WORD: 'wake_word',                   // 阶段 2：{ source: 'wake_word' }
  ASR_RESULT: 'asr_result',                 // 阶段 2：{ text }

  // 控制
  STOP_REQUESTED: 'stop_requested',         // 停止（语音/按钮/Esc 汇合）：{ source }
  PAUSE_REQUESTED: 'pause_requested',       // 暂停（仅动作边界生效）
  RESUME_REQUESTED: 'resume_requested',     // 继续
  TIMEOUT: 'timeout',                       // 状态超时：{ state }

  // 内部（仅供 orchestrator 使用）
  LLM_DECISION: 'llm_decision',             // planner 返回决策
  ACTION_RESULT: 'action_result',           // 单动作执行结果
  EXECUTION_FINISHED: 'execution_finished', // 计划执行完毕
  RETRY: 'retry',                           // ERROR 态重试
};

module.exports = { EVENTS };
