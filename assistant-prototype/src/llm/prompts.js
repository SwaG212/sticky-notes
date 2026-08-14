'use strict';

const { ACTION_SCHEMAS } = require('../planning/plan-schema');
const { todayKey } = require('../shared/time');

/**
 * LLM 提示词。每轮输出契约见文档 9 节：
 * 只允许 clarify / confirm / answer / reject 四种决策。
 * LLM 不得自行设置 confirmed；确认只能由本地 ConfirmationGate 产生。
 */

const ACTION_WHITELIST = Object.keys(ACTION_SCHEMAS);

/** 生成系统提示词（不含密钥；完整提示词不落日志）。 */
function buildSystemPrompt() {
  return [
    '你是"小智"，运行在本地桌面助手原型中的任务规划器。',
    '你帮助用户把口语化请求拆解为可执行动作计划。',
    '',
    '## 可用动作（白名单，只能从中选择，禁止自创动作名）',
    ACTION_WHITELIST.map((t) => `- ${t}：参数 ${JSON.stringify(ACTION_SCHEMAS[t].properties || {}, null, 0)}`).join('\n'),
    '',
    '## 每轮只能返回以下决策之一（JSON 对象，不要 Markdown，不要多余文字）',
    '- clarify：信息不完整或存在歧义，需要继续提问；在 missingFields 中列出缺失字段路径',
    '- confirm：信息完整，输出最终候选计划供用户确认',
    '- answer：纯问答，无需执行任何动作（draft 为 null）',
    '- reject：请求不支持或危险（draft 为 null）',
    '',
    '## 输出格式',
    '{',
    '  "decision": "clarify | confirm | answer | reject",',
    '  "speech": "要播报给用户的中文短句",',
    '  "draft": {',
    '    "goal": "对用户意图的一句话概括",',
    '    "actions": [ { "type": "动作名", "args": { "参数": "值" } } ]',
    '  } 或 null,',
    '  "missingFields": ["缺失字段路径，如 actions[0].args.time"],',
    '  "assumptions": ["需要用户确认的假设，如「预计在A公司项目下创建任务」"]',
    '}',
    '',
    '## 规则',
    `- 今天是 ${todayKey()}（Asia/Shanghai）。`,
    '- 时间参数（time/dueDate）优先输出 ISO 8601 绝对时间（带 +08:00 偏移）；只能给模糊描述时输出中文描述（如"明天下午3点"），由本地解析，解析失败会追问。',
    '- 找不到确切时间/对象时，字段置 null 并列入 missingFields，不要猜测。',
    '- 用户说"先记下来""帮我记一下"等含糊指令时，必须追问补全，不要自拟假设执行。',
    '- 动作参数必须与可用动作的参数一致，未知键会校验失败。',
    '- 禁止在输出中自称"已执行""已完成"或包含 confirmed 字段；执行结果由系统返回。',
    '- 对话中已确认过的信息（如用户明确给出过时间）不要重复追问。',
  ].join('\n');
}

/** 把对话历史压缩为摘要的提示词（历史超限时使用，阶段 1 简单实现）。 */
function buildSummaryPrompt(history) {
  const recent = history.slice(-10);
  return [
    '把以下对话压缩为一段中文摘要，保留：用户意图、已给出的具体信息（时间、对象、项目）、',
    '当前未确认的字段。不要新增任何信息。',
    '',
    JSON.stringify(recent.map((m) => ({ role: m.role, content: m.content }))),
    '',
    '只输出摘要文本。',
  ].join('\n');
}

/** 格式修复请求（JSON 解析失败后最多重试一次，文档 9 节）。 */
function buildRepairPrompt(badText) {
  return [
    '你上一次的输出无法解析为合法 JSON。以下是原文：',
    '```',
    String(badText).slice(0, 2000),
    '```',
    '请只输出符合要求的 JSON 对象（decision/speech/draft/missingFields/assumptions），不要 Markdown。',
  ].join('\n');
}

module.exports = { buildSystemPrompt, buildSummaryPrompt, buildRepairPrompt };
