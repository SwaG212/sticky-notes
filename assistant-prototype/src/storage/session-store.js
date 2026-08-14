'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 会话持久化（阶段 1 文字闭环用）。存储非敏感对话记录，供重启后查看与恢复。
 * 明文不落任何密钥。
 */
class SessionStore {
  constructor({ sessionsDir }) {
    this.sessionsDir = sessionsDir;
  }

  init() {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  _file(sessionId) {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  save(session) {
    this.init();
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    const tmp = `${this._file(session.sessionId)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
    fs.renameSync(tmp, this._file(session.sessionId));
  }

  load(sessionId) {
    try {
      const raw = fs.readFileSync(this._file(sessionId), 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  list() {
    if (!fs.existsSync(this.sessionsDir)) return [];
    return fs.readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length));
  }
}

module.exports = { SessionStore };
