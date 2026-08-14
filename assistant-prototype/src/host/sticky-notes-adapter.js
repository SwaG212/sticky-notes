'use strict';

const { HostAdapter } = require('./host-adapter');
const { AppError, ERROR_CODES } = require('../shared/errors');

/**
 * 便利贴宿主适配器（阶段 5 接入时实现）。
 * 接入方式：便利贴启动本助手为独立辅助进程，经 utility process /
 * child process IPC / JSON Lines 通信，不开放本机 HTTP 端口。
 * 通信消息格式见 DEVELOPMENT_GUIDE.md 6.2。
 *
 * 阶段 0/1 不实现；原型只允许使用 MockHostAdapter。
 */
class StickyNotesAdapter extends HostAdapter {
  async getCapabilities() {
    throw new AppError(ERROR_CODES.NOT_IMPLEMENTED, '便利贴接入尚未实现（阶段 5）');
  }
}

module.exports = { StickyNotesAdapter };
