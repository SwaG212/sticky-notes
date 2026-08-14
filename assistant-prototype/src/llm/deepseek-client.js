'use strict';

const { AppError, CancelledError, ERROR_CODES } = require('../shared/errors');

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * DeepSeek API 客户端（OpenAI 兼容）。
 * 只负责 HTTP 往返与错误分类；不记录密钥，返回体不落日志。
 * 网络调用必须支持取消（文档 3.3）。
 */
class DeepSeekClient {
  /**
   * @param {{baseUrl: string, apiKey: string, model: string, timeoutMs?: number, fetchImpl?: Function}} opts
   */
  constructor({ baseUrl, apiKey, model, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = null }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this._fetch = fetchImpl || globalThis.fetch;
  }

  /**
   * 发送对话请求。
   * @param {Array<{role: string, content: string}>} messages
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<{content: string, usage?: object, durationMs: number}>}
   */
  async chat(messages, { signal } = {}) {
    const started = Date.now();
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    let res;
    try {
      res = await this._fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.2,
          response_format: { type: 'json_object' },
        }),
        signal: combined,
      });
    } catch (err) {
      if (signal && signal.aborted) throw new CancelledError('llm');
      if (err && err.name === 'TimeoutError') {
        throw new AppError(ERROR_CODES.LLM_TIMEOUT, '助手思考超时', { details: { timeoutMs: this.timeoutMs } });
      }
      throw new AppError(ERROR_CODES.LLM_NETWORK, '网络连接失败', {
        details: { cause: err && err.message },
        retryable: true,
      });
    }

    if (res.status === 401 || res.status === 403) {
      throw new AppError(ERROR_CODES.LLM_AUTH_FAILED, 'API Key 无效');
    }
    if (res.status === 429) {
      throw new AppError(ERROR_CODES.LLM_RATE_LIMITED, '请求过于频繁', { retryable: true });
    }
    if (res.status === 400) {
      const body = await safeText(res);
      throw new AppError(ERROR_CODES.LLM_INVALID_RESPONSE, '请求内容被拒绝', { details: { status: 400, body: body.slice(0, 200) } });
    }
    if (!res.ok) {
      throw new AppError(ERROR_CODES.LLM_NETWORK, '服务暂时不可用', {
        details: { status: res.status },
        retryable: res.status >= 500,
      });
    }

    const body = await res.json();
    const content = body && body.choices && body.choices[0] && body.choices[0].message
      ? body.choices[0].message.content
      : '';
    if (!content || typeof content !== 'string') {
      throw new AppError(ERROR_CODES.LLM_EMPTY_RESPONSE, '助手没有返回内容');
    }
    return { content, usage: body.usage || null, durationMs: Date.now() - started };
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

module.exports = { DeepSeekClient };
