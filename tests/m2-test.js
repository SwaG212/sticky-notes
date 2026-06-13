// M2 单元测试：LLM + OCR 模块
// 运行: "C:/Program Files/nodejs/node" tests/m2-test.js

let passed = 0, failed = 0;

function assert(condition, name) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`); }
}

async function test(name, fn) {
  console.log(`\n📋 ${name}`);
  try { await fn(); }
  catch (e) { failed++; console.error(`  ❌ 异常: ${e.message}`); }
}

// ========== 测试 1：OCR 模块 ==========
async function testOCR() {
  const { createWorker } = require('tesseract.js');
  console.log('  初始化 Tesseract 中文 worker（首次需下载语言包约 10MB）...');
  const worker = await createWorker('chi_sim');
  console.log('  Worker 就绪');

  // 用 1x1 白色 PNG 测试 OCR 基本可用性
  const tinyPNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
  const { data } = await worker.recognize(tinyPNG);
  console.log(`  OCR 结果: "${data.text.trim()}"`);
  assert(typeof data.text === 'string', 'OCR 返回字符串');

  await worker.terminate();
}

// ========== 测试 2：DeepSeek API 调用 ==========
async function testDeepSeek() {
  const apiKey = process.env.DEEPSEEK_KEY || '';
  if (!apiKey) {
    console.log('  ⚠️  未设置 DEEPSEEK_KEY 环境变量，跳过真实 API 测试');
    console.log('  ℹ️  设置方式: export DEEPSEEK_KEY=sk-xxxx');
    return;
  }

  const url = 'https://api.deepseek.com/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: '你好，请用JSON数组格式回复：[{"task":"测试"}]' }],
      temperature: 0.3,
      max_tokens: 256,
    }),
    signal: AbortSignal.timeout(15000),
  });

  assert(res.ok, `API 响应状态 ${res.status}`);
  const json = await res.json();
  assert(!!json.choices?.[0]?.message?.content, '返回包含 choices[0].message.content');
  console.log(`  内容: ${json.choices[0].message.content}`);
}

// ========== 测试 3：Prompt 组装 ==========
async function testPromptAssembly() {
  const ORGANIZE_PROMPT = `你是一个任务整理助手。用户会给你一段杂乱的想法或文字。
请提取独立待办任务，每项简洁表述。返回 JSON 数组：[{"task":"..."}]

用户输入：
`;

  const userText = '下午开会 取快递 写周报';
  const ocrResults = ['截图: 周三前出合同'];

  let combined = userText;
  if (ocrResults.length > 0) {
    combined += '\n\n[以下为截图OCR识别内容]\n' + ocrResults.join('\n---\n');
  }

  const prompt = ORGANIZE_PROMPT + combined;
  assert(prompt.includes('下午开会'), '包含用户输入');
  assert(prompt.includes('截图OCR'), '包含 OCR 标注');
  assert(prompt.includes('周三前出合同'), '包含 OCR 内容');
  assert(prompt.includes('[{"task":"'), '包含 JSON 格式示例');
}

// ========== 测试 4：JSON 解析容错 ==========
async function testParseJSON() {
  function parseTaskJSON(content) {
    try {
      const arr = JSON.parse(content);
      if (Array.isArray(arr)) return arr;
    } catch (e) {}
    const match = content.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const arr = JSON.parse(match[0]);
        if (Array.isArray(arr)) return arr;
      } catch (e) {}
    }
    throw new Error('PARSE_ERROR');
  }

  assert(parseTaskJSON('[{"task":"测试"}]').length === 1, '正常 JSON 解析');
  assert(parseTaskJSON('[{"task":"测试1"},{"task":"测试2"}]').length === 2, '多条 JSON 解析');

  // 带额外文字的 JSON
  const result = parseTaskJSON('好的，以下是整理结果：\n[{"task":"任务1"},{"task":"任务2"}]\n共2条');
  assert(result.length === 2, '容错：从额外文字中提取 JSON');

  // 空数组
  assert(parseTaskJSON('[]').length === 0, '空数组');

  // 异常 JSON
  try { parseTaskJSON('这不是JSON'); assert(false, '不应到达'); }
  catch (e) { assert(e.message === 'PARSE_ERROR', '异常 JSON 正确抛出 PARSE_ERROR'); }
}

// ========== 运行 ==========
(async () => {
  console.log('=== M2 单元测试：LLM + OCR ===\n');

  await test('OCR 引擎', testOCR);
  await test('Prompt 组装', testPromptAssembly);
  await test('JSON 解析容错', testParseJSON);
  await test('DeepSeek API（需 Key）', testDeepSeek);

  console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
