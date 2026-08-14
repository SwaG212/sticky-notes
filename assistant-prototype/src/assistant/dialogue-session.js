'use strict';

const { newSessionId } = require('../shared/ids');
const { nowIso } = require('../shared/time');

const MAX_HISTORY = 30;

/**
 * 对话会话状态（文档 7.2：会话状态归 DialogueSession）。
 * 持有：历史消息、当前候选计划、最近一次用户输入。
 * 历史超限时较早内容压缩为摘要，但当前草案保留完整。
 */
class DialogueSession {
  /**
   * @param {object} [opts]
   * @param {string} [opts.sessionId]
   * @param {Array} [opts.history] 恢复用
   * @param {object} [opts.currentPlan] 恢复用
   */
  constructor(opts = {}) {
    this.sessionId = opts.sessionId || newSessionId();
    this.createdAt = opts.createdAt || nowIso();
    this.history = Array.isArray(opts.history) ? opts.history : [];
    this.currentPlan = opts.currentPlan || null;
    this.summary = opts.summary || null; // 早期对话压缩摘要
    this.lastUserText = opts.lastUserText || null;
    this.confirmation = null; // { planId, revision, at }
  }

  addUser(text) {
    const entry = { role: 'user', content: text, at: nowIso() };
    this.history.push(entry);
    this.lastUserText = text;
    this.compressIfNeeded();
    return entry;
  }

  addAssistant(content, kind = 'message') {
    const entry = { role: 'assistant', content, kind, at: nowIso() };
    this.history.push(entry);
    this.compressIfNeeded();
    return entry;
  }

  setPlan(plan) {
    this.currentPlan = plan;
  }

  /** 记录本地确认（绑定 planId + revision）。 */
  setConfirmation(planId, revision) {
    this.confirmation = { planId, revision, at: nowIso() };
  }

  clearConfirmation() {
    this.confirmation = null;
  }

  /** 历史超限：最老的对话压成摘要，保留近期消息与当前草案相关记录。 */
  compressIfNeeded() {
    if (this.history.length <= MAX_HISTORY) return;
    const drop = this.history.slice(0, this.history.length - MAX_HISTORY);
    const dropped = drop.map((m) => `${m.role}: ${m.content}`).join('\n');
    this.summary = this.summary
      ? `${this.summary}\n${dropped}`.slice(-4000)
      : dropped.slice(-4000);
    this.history = this.history.slice(-MAX_HISTORY);
  }

  /**
   * 给规划器的历史：摘要（若有）置顶 + 近期消息（文档 9：当前草案不得只保留摘要）。
   * @param {number} max 给模型的最近消息上限
   */
  getHistoryForPlanner(max) {
    const out = [];
    if (this.summary) {
      out.push({ role: 'system', content: `此前对话摘要：${this.summary}` });
    }
    const recent = this.history.slice(-max);
    for (const m of recent) {
      out.push({ role: m.role, content: m.content });
    }
    return out;
  }

  /** 是否处于同一轮任务（会话开始后未重置） */
  isActive() {
    return this.history.length > 0;
  }

  toJSON() {
    return {
      sessionId: this.sessionId,
      createdAt: this.createdAt,
      history: this.history,
      summary: this.summary,
      currentPlan: this.currentPlan,
      lastUserText: this.lastUserText,
      confirmation: this.confirmation,
    };
  }

  static fromJSON(json) {
    return new DialogueSession(json);
  }
}

module.exports = { DialogueSession, MAX_HISTORY };
