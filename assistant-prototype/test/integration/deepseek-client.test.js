'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DeepSeekClient } = require('../../src/llm/deepseek-client');
const { CancelledError, AppError } = require('../../src/shared/errors');

function makeClient({ fetchImpl, timeoutMs = 5000 } = {}) {
  return new DeepSeekClient({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-test-key',
    model: 'deepseek-chat',
    timeoutMs,
    fetchImpl,
  });
}

function okResponse(body) {
  return { status: 200, ok: true, json: async () => body };
}

test('成功返回内容与耗时', async () => {
  const calls = [];
  const client = makeClient({
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      assert.ok(opts.headers.Authorization.startsWith('Bearer '));
      assert.ok(!opts.body.includes('sk-test-key'), '请求体不含密钥');
      return okResponse({ choices: [{ message: { content: '{"decision":"answer"}' } }], usage: { total_tokens: 10 } });
    },
  });
  const r = await client.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(r.content, '{"decision":"answer"}');
  assert.equal(r.usage.total_tokens, 10);
  assert.ok(r.durationMs >= 0);
  assert.ok(calls[0].url.endsWith('/chat/completions'));
});

test('取消：外部 AbortSignal 触发 CancelledError（文档 12.2 中止 DeepSeek 请求）', async () => {
  let aborted = false;
  const client = makeClient({
    fetchImpl: async (_url, opts) => {
      await new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => {
          aborted = true;
          const e = new Error('fetch aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    },
  });
  const controller = new AbortController();
  const promise = client.chat([{ role: 'user', content: 'x' }], { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => promise, (e) => e instanceof CancelledError);
  assert.equal(aborted, true);
});

test('超时抛 LLM_TIMEOUT（可配置 timeoutMs）', async () => {
  const client = makeClient({
    timeoutMs: 50,
    fetchImpl: async (_url, opts) => {
      await new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('timeout');
          e.name = 'TimeoutError';
          reject(e);
        });
      });
    },
  });
  await assert.rejects(
    () => client.chat([{ role: 'user', content: 'x' }]),
    (e) => e instanceof AppError && e.code === 'LLM_TIMEOUT',
  );
});

test('401 抛 LLM_AUTH_FAILED', async () => {
  const client = makeClient({ fetchImpl: async () => ({ status: 401, ok: false, json: async () => ({}) }) });
  await assert.rejects(
    () => client.chat([{ role: 'user', content: 'x' }]),
    (e) => e instanceof AppError && e.code === 'LLM_AUTH_FAILED',
  );
});

test('429 抛 LLM_RATE_LIMITED 且可重试', async () => {
  const client = makeClient({ fetchImpl: async () => ({ status: 429, ok: false, json: async () => ({}) }) });
  await assert.rejects(
    () => client.chat([{ role: 'user', content: 'x' }]),
    (e) => e instanceof AppError && e.code === 'LLM_RATE_LIMITED' && e.retryable === true,
  );
});

test('网络错误（fetch 拒绝）抛 LLM_NETWORK', async () => {
  const client = makeClient({
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  await assert.rejects(
    () => client.chat([{ role: 'user', content: 'x' }]),
    (e) => e instanceof AppError && e.code === 'LLM_NETWORK',
  );
});

test('空响应抛 LLM_EMPTY_RESPONSE', async () => {
  const client = makeClient({ fetchImpl: async () => okResponse({ choices: [{ message: { content: '' } }] }) });
  await assert.rejects(
    () => client.chat([{ role: 'user', content: 'x' }]),
    (e) => e instanceof AppError && e.code === 'LLM_EMPTY_RESPONSE',
  );
});
