'use strict';

const crypto = require('node:crypto');

/**
 * 生成带前缀的短 ID（crypto 安全随机）。
 * @param {string} prefix 前缀，如 'session'、'plan'、'msg'
 * @returns {string} 如 'session_x7k2m9f4'
 */
function newId(prefix) {
  const rand = crypto.randomBytes(6).toString('base64url');
  return `${prefix}_${rand}`;
}

function newSessionId() {
  return newId('session');
}

function newPlanId() {
  return newId('plan');
}

/** 每次动作执行唯一标识，宿主侧据此做幂等去重。 */
function newActionRunId() {
  return newId('run');
}

/** IPC 消息 ID，格式按开发指南 6.2：msg_... */
function newMessageId() {
  return newId('msg');
}

module.exports = {
  newId,
  newSessionId,
  newPlanId,
  newActionRunId,
  newMessageId,
};
