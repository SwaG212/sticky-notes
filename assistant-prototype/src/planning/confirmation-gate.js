'use strict';

const { AppError, ERROR_CODES } = require('../shared/errors');

// 明确确认语义（文档 10 节）
const POSITIVE = ['确认', '可以', '执行', '开始', '好的', '好', '对', '是', '行', '就这么办', '没问题', '同意', 'ok', 'okay', 'yes', 'y'];
// 复合句里视为确认的强词（避免"都行"含"行"、"无所谓"类误判）
const POSITIVE_STRONG = ['确认', '可以', '执行', '开始', '好的', '没问题', '同意', '就这么办', 'ok', 'okay', 'yes'];
// 不能当作确认的表达
const AMBIGUOUS = ['嗯', '随便', '应该吧', '你看着办', '都行', '无所谓', '再说', '可能'];
// 修改/否定意图词（优先于确认词判断："好的，改成4点"是修改不是确认）
const MODIFY_WORDS = ['改成', '改为', '改到', '修改', '改一下', '改', '重来', '重新', '算了', '取消', '不要', '不用', '推迟', '提前', '延后', '晚点', '早点', '不对', '等等'];

/**
 * 确认门（文档 3.2、10 节）：
 * - 确认必须绑定 planId + revision，任何修改都会生成新 revision 并使旧确认失效；
 * - "确认"只能是本地 ConfirmationGate 的判定结果，LLM 无权自设 confirmed。
 */
class ConfirmationGate {
  /**
   * 解析用户话语是否为确认。
   * @param {string} utterance
   * @returns {{kind: 'yes'|'no'|'ambiguous'}}
   */
  classify(utterance) {
    if (typeof utterance !== 'string') return { kind: 'ambiguous' };
    const text = utterance.trim().toLowerCase();
    if (!text) return { kind: 'ambiguous' };
    if (MODIFY_WORDS.some((w) => text.includes(w))) return { kind: 'no' };
    if (/^不|^别/.test(text)) return { kind: 'no' };
    if (AMBIGUOUS.some((w) => text === w || text.includes(w))) {
      // "嗯，可以" 这类复合句以强确认词为准
      if (POSITIVE_STRONG.some((w) => text.includes(w))) return { kind: 'yes' };
      return { kind: 'ambiguous' };
    }
    if (POSITIVE.some((w) => text === w || text.startsWith(w + '，') || text.startsWith(w + ',') || text.startsWith(w + '的'))) {
      return { kind: 'yes' };
    }
    return { kind: 'ambiguous' };
  }

  /**
   * 确认最终计划。
   * @param {object} plan 当前计划 {planId, revision, actions}
   * @param {string} utterance 用户话语
   * @returns {{ok: true, planId, revision}|{ok: false, error: {code}}}
   */
  confirm(plan, utterance) {
    const cls = this.classify(utterance);
    if (cls.kind !== 'yes') {
      const code = cls.kind === 'no' ? ERROR_CODES.CONFIRMATION_MISMATCH : ERROR_CODES.CONFIRMATION_AMBIGUOUS;
      return { ok: false, error: { code } };
    }
    if (!plan || !plan.planId) {
      return { ok: false, error: { code: ERROR_CODES.PLAN_INVALID } };
    }
    return { ok: true, planId: plan.planId, revision: plan.revision };
  }

  /**
   * 计划内容变更后调用：生成新 revision 并使旧确认失效（文档 10 节末段）。
   * @param {object} plan 变更后的计划（含 planId）
   * @param {number} prevRevision 旧 revision
   * @returns {number} 新 revision
   */
  nextRevision(plan, prevRevision) {
    void plan;
    return (prevRevision || 0) + 1;
  }
}

module.exports = { ConfirmationGate };
