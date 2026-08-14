'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

const SENSITIVE_KEYS = new Set(['apiKey', 'apikey', 'authorization', 'key', 'token', 'password']);
// 音频内容键：日志默认不记录原始音频（文档 16 节）
const AUDIO_KEYS = new Set(['rawaudio', 'audiodata', 'audio', 'audiocontent', 'pcm', 'waveform', 'samples']);
const REDACTED = '[REDACTED]';

/** 递归深拷贝对象并脱敏敏感键；非对象原样返回。 */
function redact(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (typeof value === 'string') {
    // 默认截断长文本；明显是密钥形态的串直接打码
    if (value.length > 0 && value.length <= 64 && /^[A-Za-z0-9_-]{20,}$/.test(value)) {
      return value.slice(0, 4) + '…(len=' + value.length + ')';
    }
    return value.length > 200 ? value.slice(0, 200) + '…(truncated)' : value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const key = String(k).toLowerCase();
      if (SENSITIVE_KEYS.has(key) || AUDIO_KEYS.has(key)) {
        out[k] = REDACTED;
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/** 把任意负载整理为可安全落日志的结构，过滤多余字段。 */
function scrub(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined || v === null) continue;
    const key = String(k).toLowerCase();
    if (SENSITIVE_KEYS.has(key) || AUDIO_KEYS.has(key)) {
      out[k] = REDACTED;
      continue;
    }
    out[k] = redact(v);
  }
  return out;
}

class Logger {
  /**
   * @param {object} [opts]
   * @param {string} [opts.file] 日志文件路径；缺省只输出到控制台
   * @param {number} [opts.maxBytes] 单文件轮转阈值，默认 10MB
   * @param {number} [opts.maxFiles] 保留轮转份数，默认 3
   * @param {string} [opts.level] 最低级别，默认 INFO
   */
  constructor(opts = {}) {
    this.level = LEVELS[opts.level || 'INFO'] ?? LEVELS.INFO;
    this.maxBytes = opts.maxBytes || 10 * 1024 * 1024;
    this.maxFiles = opts.maxFiles || 3;
    if (opts.file) {
      fs.mkdirSync(path.dirname(opts.file), { recursive: true });
      this._fd = fs.openSync(opts.file, 'a');
      this._file = opts.file;
    } else {
      this._fd = null;
    }
  }

  _rotate() {
    if (!this._fd) return;
    const stat = fs.fstatSync(this._fd);
    if (stat.size < this.maxBytes) return;
    fs.closeSync(this._fd);
    for (let i = this.maxFiles; i > 0; i--) {
      const from = i === 1 ? this._file : `${this._file}.${i - 1}`;
      const to = `${this._file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    this._fd = fs.openSync(this._file, 'a');
  }

  /**
   * 写一条结构化事件日志。
   * @param {object} entry 必须含 event，其余可选：
   *   level, sessionId, planId, actionRunId, state, durationMs, details
   */
  log(entry) {
    const lv = LEVELS[entry.level] ?? LEVELS.INFO;
    if (lv < this.level) return;
    const record = {
      timestamp: new Date().toISOString(),
      level: entry.level || 'INFO',
      event: entry.event,
      sessionId: entry.sessionId || null,
      planId: entry.planId || null,
      actionRunId: entry.actionRunId || null,
      state: entry.state || null,
      durationMs: entry.durationMs ?? null,
      ...scrub(entry.details),
    };
    const line = JSON.stringify(record);
    if (this._fd) {
      this._rotate();
      fs.writeSync(this._fd, line + '\n');
    } else {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  }

  debug(event, details) { this.log({ level: 'DEBUG', event, details }); }
  info(event, details) { this.log({ level: 'INFO', event, details }); }
  warn(event, details) { this.log({ level: 'WARN', event, details }); }
  error(event, details) { this.log({ level: 'ERROR', event, details }); }

  close() {
    if (this._fd) {
      try { fs.closeSync(this._fd); } catch { /* already closed */ }
      this._fd = null;
    }
  }
}

/** 默认单例；测试可自行 new Logger({file: null}) 注入。 */
const defaultLogger = new Logger();

module.exports = { Logger, defaultLogger, redact, scrub };
