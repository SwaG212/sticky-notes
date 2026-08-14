'use strict';

const { AppError, ERROR_CODES } = require('../shared/errors');

const DECISIONS = ['clarify', 'confirm', 'answer', 'reject'];

/**
 * LLM 输出解析（文档 9 节）：
 * - 只接受 JSON 对象，不从 Markdown 或自然语言中猜测动作；
 * - 容忍 ```json ... ``` 代码块包裹（提取，而非猜测）；
 * - 解析失败由调用方决定是否发起一次格式修复请求。
 */
class ResponseParser {
  /**
   * @param {string} rawText
   * @returns {{ok: true, value: object}|{ok: false, error: {code, detail}}}
   */
  parse(rawText) {
    if (typeof rawText !== 'string' || !rawText.trim()) {
      return { ok: false, error: { code: 'EMPTY' } };
    }
    const jsonText = extractJson(rawText);
    if (jsonText === null) {
      return { ok: false, error: { code: 'NO_JSON', detail: '输出中未找到 JSON 对象' } };
    }
    let obj;
    try {
      obj = JSON.parse(jsonText);
    } catch (err) {
      return { ok: false, error: { code: 'PARSE_FAILED', detail: err.message } };
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, error: { code: 'NOT_OBJECT' } };
    }
    if (!DECISIONS.includes(obj.decision)) {
      return { ok: false, error: { code: 'BAD_DECISION', detail: `decision 必须是 ${DECISIONS.join('/')}` } };
    }
    if (typeof obj.speech !== 'string' || obj.speech.length === 0) {
      return { ok: false, error: { code: 'NO_SPEECH' } };
    }
    const missingFields = Array.isArray(obj.missingFields) ? obj.missingFields : [];
    const assumptions = Array.isArray(obj.assumptions) ? obj.assumptions : [];

    // draft 合法性：answer/reject 必须 draft 为 null；clarify/confirm 必须有 draft
    const draft = obj.draft === undefined || obj.draft === null ? null : obj.draft;
    if ((obj.decision === 'answer' || obj.decision === 'reject') && draft !== null) {
      return { ok: false, error: { code: 'DRAFT_FORBIDDEN', detail: `${obj.decision} 决策不得携带 draft` } };
    }
    if (obj.decision === 'clarify' && draft !== null) {
      // clarify 可携带部分草稿，帮助用户理解还缺什么
      const check = validateDraftShape(draft);
      if (!check.ok) return { ok: false, error: { code: 'BAD_DRAFT', detail: check.detail } };
    }
    if (obj.decision === 'confirm') {
      const check = validateDraftShape(draft);
      if (!check.ok) return { ok: false, error: { code: 'BAD_DRAFT', detail: check.detail } };
    }
    return { ok: true, value: { decision: obj.decision, speech: obj.speech, draft, missingFields, assumptions } };
  }
}

/** 提取 JSON 对象文本：优先整个文本，其次代码块，最后第一个 { ... } 平衡块。 */
function extractJson(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = trimmed.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}

function validateDraftShape(draft) {
  if (!draft || typeof draft !== 'object') return { ok: false, detail: 'draft 不是对象' };
  if (typeof draft.goal !== 'string' || !draft.goal.trim()) return { ok: false, detail: 'draft.goal 缺失' };
  if (!Array.isArray(draft.actions)) return { ok: false, detail: 'draft.actions 不是数组' };
  if (draft.actions.length === 0) return { ok: false, detail: 'draft.actions 为空' };
  for (const a of draft.actions) {
    if (!a || typeof a.type !== 'string') return { ok: false, detail: '动作缺少 type' };
    if (!a.args || typeof a.args !== 'object' || Array.isArray(a.args)) return { ok: false, detail: `动作 ${a.type} 缺少 args` };
  }
  return { ok: true };
}

/** 供 planner 使用的便捷方法：解析 + 抛类型化异常。 */
function parseOrThrow(rawText) {
  const r = new ResponseParser().parse(rawText);
  if (!r.ok) {
    throw new AppError(ERROR_CODES.LLM_INVALID_RESPONSE, '助手返回了无法理解的内容', { details: r.error });
  }
  return r.value;
}

module.exports = { ResponseParser, parseOrThrow, extractJson };
