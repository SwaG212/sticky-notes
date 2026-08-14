'use strict';

const { ipcMain } = require('electron');
const { AppError, ERROR_CODES } = require('../shared/errors');

const MAX_TEXT_LENGTH = 2000;

/**
 * IPC 处理器（文档 17 安全规则）：
 * - 校验发送方为当前主窗口、类型、长度；
 * - 只转发白名单命令，不暴露原始 ipcRenderer。
 */
function registerIpcHandlers({ orchestrator, config, logger }) {
  function isTrustedSender(event) {
    const sender = event.sender;
    const wc = sender;
    return Boolean(wc && wc.getURL && wc.getURL().startsWith('file:'));
  }

  function guard(event) {
    if (!isTrustedSender(event)) {
      logger.warn('ipc_untrusted_sender', { details: { url: event.sender && event.sender.getURL && event.sender.getURL() } });
      throw new AppError(ERROR_CODES.INVALID_ARGUMENT, '不受信任的调用来源');
    }
  }

  function validateText(text) {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new AppError(ERROR_CODES.INVALID_ARGUMENT, '输入不能为空');
    }
    if (text.length > MAX_TEXT_LENGTH) {
      throw new AppError(ERROR_CODES.INVALID_ARGUMENT, '输入过长', { details: { max: MAX_TEXT_LENGTH } });
    }
  }

  function wrap(handler) {
    return async (event, ...args) => {
      try {
        guard(event);
        return { ok: true, data: await handler(...args) };
      } catch (err) {
        const code = err.code || ERROR_CODES.INTERNAL;
        logger.warn('ipc_error', { details: { code, message: err.message } });
        return { ok: false, error: { code, message: err.message || '操作失败' } };
      }
    };
  }

  ipcMain.handle('assistant:start', wrap((text) => {
    validateText(text);
    if (!config.hasApiKey()) {
      throw new AppError(ERROR_CODES.CONFIG_MISSING, '缺少 DEEPSEEK_API_KEY，请先配置 .env');
    }
    return orchestrator.startTextInput(text);
  }));

  ipcMain.handle('assistant:response', wrap((text) => {
    validateText(text);
    return orchestrator.sendResponse(text);
  }));

  ipcMain.handle('assistant:stop', wrap((source) => {
    orchestrator.stop(source || 'ui_button');
    return { state: orchestrator.state };
  }));

  ipcMain.handle('assistant:pause', wrap(() => orchestrator.pause()));

  ipcMain.handle('assistant:resume', wrap(() => orchestrator.resume()));

  ipcMain.handle('assistant:snapshot', wrap(() => orchestrator.getStateSnapshot()));

  ipcMain.handle('assistant:config', wrap(() => config.getPublicConfig()));
}

module.exports = { registerIpcHandlers };
