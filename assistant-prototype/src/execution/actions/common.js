'use strict';

const { AppError, CancelledError } = require('../../shared/errors');

/** 动作执行前检查取消信号（文档 12.1：每个动作开始前检查 AbortSignal）。 */
function assertNotCancelled(signal) {
  if (signal && signal.aborted) {
    throw new CancelledError(signal.reason && signal.reason.source ? signal.reason.source : 'executor');
  }
}

/**
 * 调用 HostAdapter 方法并统一错误转换。
 * 业务失败（ok:false）→ AppError；模型自述"已完成"永远不采信，只认返回值。
 */
async function callHost(hostMethod, args, opts) {
  assertNotCancelled(opts.signal);
  const res = await hostMethod(args, { signal: opts.signal, actionRunId: opts.actionRunId });
  if (!res || typeof res.ok !== 'boolean') {
    throw new AppError('HOST_BAD_RESULT', '宿主返回结果不合法', { details: { actionRunId: opts.actionRunId } });
  }
  if (!res.ok) {
    throw new AppError(res.error.code || 'ACTION_FAILED', res.error.message || '操作失败', {
      details: res.error.details || null,
    });
  }
  assertNotCancelled(opts.signal);
  return res;
}

module.exports = { assertNotCancelled, callHost };
