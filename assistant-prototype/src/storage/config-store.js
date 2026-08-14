'use strict';

const path = require('node:path');
const fs = require('node:fs');
require('dotenv').config();

const { AppError, ERROR_CODES } = require('../shared/errors');

const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  followUpWindowMs: 15000,
  maxRecordingMs: 60000,
  silenceEndMs: 1350,
};

/**
 * 集中配置读取。业务模块不得直接读 process.env。
 * 阶段 1 从 .env 读取；接入阶段改由 Electron safeStorage 加密存储。
 */
class ConfigStore {
  constructor({ env = process.env, rootDir = null } = {}) {
    this._env = env;
    this._rootDir = rootDir || path.resolve(__dirname, '..', '..');
    this._cached = null;
  }

  _load() {
    const env = this._env;
    return {
      apiKey: env.DEEPSEEK_API_KEY || '',
      baseUrl: env.DEEPSEEK_BASE_URL || DEFAULTS.baseUrl,
      model: env.DEEPSEEK_MODEL || DEFAULTS.model,
      followUpWindowMs: Number(env.FOLLOW_UP_WINDOW_MS) || DEFAULTS.followUpWindowMs,
      maxRecordingMs: Number(env.MAX_RECORDING_MS) || DEFAULTS.maxRecordingMs,
      silenceEndMs: Number(env.SILENCE_END_MS) || DEFAULTS.silenceEndMs,
      sandboxDataDir: path.join(this._rootDir, 'sandbox-data'),
      journalDir: path.join(this._rootDir, 'sandbox-data', 'journal'),
      sessionsDir: path.join(this._rootDir, 'sandbox-data', 'sessions'),
    };
  }

  /** 完整配置（含 apiKey；调用方负责不落日志） */
  getConfig() {
    if (!this._cached) this._cached = this._load();
    return this._cached;
  }

  /** 浅拷贝非敏感配置，可安全进入渲染进程/日志 */
  getPublicConfig() {
    const { apiKey, ...rest } = this.getConfig();
    return { ...rest, hasApiKey: Boolean(apiKey) };
  }

  hasApiKey() {
    return Boolean(this.getConfig().apiKey);
  }

  /** 校验配置完整性；缺失时抛 AppError 携带具体缺项 */
  assertReady() {
    const cfg = this.getConfig();
    const missing = [];
    if (!cfg.apiKey) missing.push('DEEPSEEK_API_KEY');
    if (missing.length > 0) {
      throw new AppError(ERROR_CODES.CONFIG_MISSING, '缺少必要配置', {
        details: { missing, hint: '复制 .env.example 为 .env 并填入 DEEPSEEK_API_KEY' },
      });
    }
    return cfg;
  }
}

module.exports = { ConfigStore };
