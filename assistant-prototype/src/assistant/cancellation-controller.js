'use strict';

const { CancelledError } = require('../shared/errors');

/**
 * 全局取消控制器（文档 3.3）：
 * - 停止指令不依赖大模型理解，语音/按钮/Esc 汇合到此；
 * - 每次网络调用、子进程、TTS 播放和动作执行都持有其 signal；
 * - 取消后汇报真实状态（由编排器基于执行日志生成，本类不编造结果）。
 */
class CancellationController {
  constructor() {
    this.reset();
  }

  reset() {
    this._controller = new AbortController();
    this._source = null;
    this._listeners = new Set();
  }

  /** 触发全局取消。幂等：已有来源则保留首个来源。 */
  cancel(source) {
    if (this._controller.signal.aborted) return;
    this._source = source || 'unknown';
    this._controller.abort(new CancelledError(this._source));
    for (const fn of this._listeners) {
      try {
        fn(this._source);
      } catch {
        // 监听器异常不影响取消流程
      }
    }
    this._listeners.clear();
  }

  get signal() {
    return this._controller.signal;
  }

  get source() {
    return this._source;
  }

  isCancelled() {
    return this._controller.signal.aborted;
  }

  /** 注册取消回调（如立即停 TTS）。返回注销函数。 */
  onCancel(fn) {
    if (this._controller.signal.aborted) {
      fn(this._source);
      return () => {};
    }
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
}

module.exports = { CancellationController };
