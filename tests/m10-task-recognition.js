// M10 单元测试：任务识别 —— 项目名提取 + 内容整理
// 运行: "C:/Program Files/nodejs/node" tests/m10-task-recognition.js

let passed = 0, failed = 0;
function assert(condition, name) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`); }
}

console.log('\n=== M10: 任务识别（项目名提取）单元测试 ===\n');

// ========== 1. 子串匹配逻辑（Path A：无 API Key 离线模式） ==========
console.log('--- 子串匹配（离线 fallback） ---');

function matchProject(text, projectNames) {
  const lower = text.toLowerCase();
  for (const name of projectNames) {
    if (lower.includes(name.toLowerCase())) return name;
  }
  return null;
}

// 1.1 精确匹配
assert(matchProject('本地国寿环境测试', ['国寿', '中加', '华创']) === '国寿', '子串匹配: 国寿');
assert(matchProject('要做中加巡检', ['国寿', '中加', '华创']) === '中加', '子串匹配: 中加');
assert(matchProject('华创找bug', ['国寿', '中加', '华创']) === '华创', '子串匹配: 华创');

// 1.2 用户输入颠倒顺序也能匹配
assert(matchProject('测本地国寿环境', ['国寿', '中加', '华创']) === '国寿', '颠倒顺序仍匹配: 测本地→国寿');
assert(matchProject('跟一下中加权季度那个', ['国寿', '中加', '华创']) === '中加', '中间位置匹配');

// 1.3 首个匹配优先（项目名有包含关系时取第一个匹配到的）
assert(matchProject('国寿测试', ['国寿', '国寿财险']) === '国寿', '多项目包含关系: 优先命中第一个');

// 1.4 无匹配
assert(matchProject('买咖啡', ['国寿', '中加', '华创']) === null, '无匹配: 买咖啡');
assert(matchProject('下午开会', []) === null, '空项目列表: 不匹配');
assert(matchProject('', ['国寿']) === null, '空输入: 不匹配');

// 1.5 边界：项目名在首尾
assert(matchProject('国寿环境测试', ['国寿', '中加']) === '国寿', '项目名在开头');
assert(matchProject('环境测试国寿', ['国寿', '中加']) === '国寿', '项目名在结尾');

// 1.6 大小写不敏感（若用户配置了英文项目名）
assert(matchProject('Test ABC', ['abc']) === 'abc', '大小写不敏感: abc');

// ========== 2. 文本拆分 + 项目注入（Path A 离线完整流程） ==========
console.log('\n--- fallbackOrganize + 项目识别 ---');

function fallbackOrganizeWithProject(text, imgs, projectNames) {
  const tasks = [];
  if (imgs.length > 0) tasks.push({ task: '【截图识别】请编辑此任务补充详情' });

  if (text) {
    const project = matchProject(text, projectNames);

    // 先从文本中移除项目名，剩下的作为内容
    let contentText = text;
    if (project) {
      const idx = text.toLowerCase().indexOf(project.toLowerCase());
      contentText = (text.slice(0, idx) + text.slice(idx + project.length)).trim();
      // 清理可能残留的多余空格
      contentText = contentText.replace(/\s+/g, '');
    }

    // 按标点拆分（保留现有逻辑）
    const parts = contentText.split(/[\n\r。，；;,.。、]+/).map(s => s.trim()).filter(s => s.length > 1);

    if (project) {
      if (parts.length > 1) {
        parts.forEach(p => tasks.push({ task: p, project }));
      } else if (parts.length === 1) {
        tasks.push({ task: parts[0], project });
      } else {
        // 只有项目名，内容为空
        tasks.push({ task: '', project });
      }
    } else {
      // 无项目匹配，维持原逻辑
      if (parts.length > 1) parts.forEach(p => tasks.push({ task: p }));
      else if (parts.length === 1) tasks.push({ task: parts[0] });
      else tasks.push({ task: text });
    }
  }
  return tasks;
}

// 2.1 基础：匹配 + 拆分
const fb1 = fallbackOrganizeWithProject('测本地国寿环境', [], ['国寿', '中加', '华创']);
assert(fb1.length === 1, 'fallback: 1条任务');
assert(fb1[0].task === '测本地环境', 'fallback: task=测本地环境');
assert(fb1[0].project === '国寿', 'fallback: project字段=国寿');

// 2.2 用户原始案例：测本地国寿环境 → 国寿本地环境测试（离线只能做到子串提取，不能"测→测试"补全）
const fb1b = fallbackOrganizeWithProject('测本地国寿环境', [], ['国寿']);
// 离线模式：移除"国寿"→剩余"测本地环境"，不能自动补全"测"为"测试"
assert(fb1b[0].task === '测本地环境', '离线模式不做语义补全，仅做子串提取');

// 2.3 多条拆分
const fb2 = fallbackOrganizeWithProject('中加要做巡检，还得看报表', [], ['国寿', '中加', '华创']);
assert(fb2.length === 2, 'fallback: 2条任务（逗号拆分）');
assert(fb2[0].task === '要做巡检', 'fallback: 第1条保留task内容');
assert(fb2[1].task === '还得看报表', 'fallback: 第2条保留task内容');
assert(fb2.every(t => t.project === '中加'), 'fallback: 所有任务project一致');

// 2.4 无项目匹配：行为不变
const fb3 = fallbackOrganizeWithProject('买咖啡，取快递', [], ['国寿']);
assert(fb3.length === 2, '无项目匹配: 2条任务');
assert(fb3[0].task === '买咖啡', '无项目: 不加前缀');
assert(fb3[1].task === '取快递', '无项目: 不加前缀');
assert(!('project' in fb3[0]), '无项目: 无project字段');

// 2.5 仅项目名无内容
const fb4 = fallbackOrganizeWithProject('国寿', [], ['国寿']);
assert(fb4.length === 1, '仅项目名: 1条');
assert(fb4[0].task === '', '仅项目名: task为空');
assert(fb4[0].project === '国寿', '仅项目名: project=国寿');

// 2.6 有空项目列表
const fb5 = fallbackOrganizeWithProject('测本地国寿环境', [], []);
assert(fb5.length === 1, '空项目列表: 1条');
assert(fb5[0].task === '测本地国寿环境', '空项目列表: 原文保留');
assert(!('project' in fb5[0]), '空项目列表: 无project字段');

// 2.7 有截图 + 文本
const fb6 = fallbackOrganizeWithProject('国寿环境测试', ['fake-data-url'], ['国寿']);
assert(fb6.length === 2, '含截图: 2条（截图占位+文本）');
assert(fb6[0].task.includes('截图识别'), '第一条是截图占位');
assert(fb6[1].task === '环境测试', '文本任务正常识别');

// ========== 3. Prompt 构造（Path B：有 API Key，LLM 模式） ==========
console.log('\n--- Prompt 构造（LLM 模式） ---');

const BASE_PROMPT = `你是一个任务整理助手。用户会给你一段杂乱的想法或文字，可能包含 OCR 识别的聊天截图内容。
请从中提取出所有独立的待办任务，每项用简洁的一句话表述。

润色规则：
- 去掉口语化的动词前缀（如"去""跟""找一下"等），保留核心动作
- 将口语转化为书面表达（如"碰一下"→"沟通"、"看一下"→"查看"、"弄一下"→"处理"）
- 精简冗余词汇，保持任务表述专业、清晰

返回严格的 JSON 数组格式，不要输出任何其他内容。
格式示例：[{"task":"周三前出合同"},{"task":"找运维要服务器账号"}]
如果用户输入本身已是单一任务，也返回单条数组。
如果用户的输入无法提取出任何任务，返回空数组 []。

用户输入：
`;

function buildOrganizePrompt(project) {
  if (project) {
    return `你是一个任务整理助手。用户会给你一段杂乱的想法或文字，可能包含 OCR 识别的聊天截图内容。
请从中提取出所有独立的待办任务，每项用简洁的一句话表述。

润色规则：
- 去掉口语化的动词前缀（如"去""跟""找一下"等），保留核心动作
- 将口语转化为书面表达（如"碰一下"→"沟通"、"看一下"→"查看"、"弄一下"→"处理"）
- 精简冗余词汇，保持任务表述专业、清晰

【重要】以下任务的所属项目已确定为「${project}」。请在每条 JSON 中添加 "project":"${project}" 字段，task 字段只写润色后的任务内容。

返回严格的 JSON 数组格式，不要输出任何其他内容。
格式示例：[{"task":"本地环境测试","project":"国寿"},{"task":"季度巡检","project":"中加"}]
如果用户输入本身已是单一任务，也返回单条数组。
如果用户的输入无法提取出任何任务，返回空数组 []。

用户输入：
`;
  }

  return `你是一个任务整理助手。用户会给你一段杂乱的想法或文字，可能包含 OCR 识别的聊天截图内容。
请从中提取出所有独立的待办任务，每项用简洁的一句话表述。

润色规则：
- 去掉口语化的动词前缀（如"去""跟""找一下"等），保留核心动作
- 将口语转化为书面表达（如"碰一下"→"沟通"、"看一下"→"查看"、"弄一下"→"处理"）
- 精简冗余词汇，保持任务表述专业、清晰

返回严格的 JSON 数组格式，不要输出任何其他内容。
格式示例：[{"task":"周三前出合同"},{"task":"找运维要服务器账号"}]
如果用户输入本身已是单一任务，也返回单条数组。
如果用户的输入无法提取出任何任务，返回空数组 []。

用户输入：
`;
}

const prompt0 = buildOrganizePrompt(null);
const prompt3 = buildOrganizePrompt('中加');

// 3.1 无项目时 prompt 包含润色规则
assert(prompt0.includes('润色规则'), '无项目: 包含润色规则');
assert(prompt0.includes('口语转化为书面表达'), '无项目: 包含润色示例');
assert(!prompt0.includes('project'), '无项目: 不含project关键字');

// 3.2 有已匹配项目时，明确告知 LLM 项目名 + 润色规则
assert(prompt3.includes('已确定为「中加」'), '有项目: 明确告知LLM项目名');
assert(prompt3.includes('"project":"中加"'), '有项目: 格式示例包含project');
assert(prompt3.includes('润色后的任务内容'), '有项目: 要求task须经润色');
assert(prompt3.includes('润色规则'), '有项目: 包含润色规则');

// 3.3 格式示例包含多个 project 示例
assert(prompt3.includes('"project":"国寿"'), '格式示例含国寿');
assert(prompt3.includes('"project":"中加"'), '格式示例含中加');

// ========== 3b. 前端预提取项目名（organize 核心流程） ==========
console.log('\n--- organize 前端预提取流程 ---');

function extractProject(text, projectNames) {
  if (!projectNames || projectNames.length === 0) return { project: null, cleanedText: text };
  const lower = text.toLowerCase();
  for (const name of projectNames) {
    const idx = lower.indexOf(name.toLowerCase());
    if (idx !== -1) {
      return {
        project: name,
        cleanedText: (text.slice(0, idx) + text.slice(idx + name.length)).replace(/\s+/g, ''),
      };
    }
  }
  return { project: null, cleanedText: text };
}

// 用户输入 "去中加做巡检" → 提取 "中加" → 剩余 "去做巡检"
const ext1 = extractProject('去中加做巡检', ['国寿', '中加', '华创']);
assert(ext1.project === '中加', '预提取: project=中加');
assert(ext1.cleanedText === '去做巡检', '预提取: cleanedText=去做巡检');

// 用户输入 "用户持仓调整华创" → 提取 "华创" → 剩余 "用户持仓调整"
const ext2 = extractProject('用户持仓调整华创', ['国寿', '中加', '华创']);
assert(ext2.project === '华创', '预提取: project=华创');
assert(ext2.cleanedText === '用户持仓调整', '预提取: cleanedText=用户持仓调整');

// 用户输入 "测本地国寿环境" → 提取 "国寿" → 剩余 "测本地环境"
const ext3 = extractProject('测本地国寿环境', ['国寿', '中加', '华创']);
assert(ext3.project === '国寿', '预提取: project=国寿');
assert(ext3.cleanedText === '测本地环境', '预提取: cleanedText=测本地环境');

// 无匹配
const ext4 = extractProject('买咖啡', ['国寿', '中加']);
assert(ext4.project === null, '预提取: 无匹配project=null');
assert(ext4.cleanedText === '买咖啡', '预提取: 无匹配原文不变');

// ========== 4. JSON 解析兼容性（parseTaskJSON 支持 project 字段） ==========
console.log('\n--- JSON 解析兼容性 ---');

function parseTaskJSON(content) {
  try {
    const arr = JSON.parse(content);
    if (Array.isArray(arr)) return arr.filter(t => t.task && typeof t.task === 'string');
  } catch (e) { /* fall through */ }
  const match = content.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr)) return arr.filter(t => t.task && typeof t.task === 'string');
    } catch (e) { /* fall through */ }
  }
  throw new Error('PARSE_ERROR');
}

// 4.1 LLM 返回含 project 字段
const pr1 = parseTaskJSON('[{"task":"本地环境测试","project":"国寿"},{"task":"季度巡检","project":"中加"}]');
assert(pr1.length === 2, '含project: 2条');
assert(pr1[0].task === '本地环境测试' && pr1[0].project === '国寿', '含project: 第1条完整');
assert(pr1[1].task === '季度巡检' && pr1[1].project === '中加', '含project: 第2条完整');

// 4.2 LLM 返回混合（部分有 project，部分没有）
const pr2 = parseTaskJSON('[{"task":"买咖啡"},{"task":"本地环境测试","project":"国寿"}]');
assert(pr2.length === 2, '混合: 2条');
assert(!pr2[0].project, '混合: 第1条无project');
assert(pr2[1].project === '国寿', '混合: 第2条有project');

// 4.3 完全无 project（向后兼容）
const pr3 = parseTaskJSON('[{"task":"任务A"},{"task":"任务B"}]');
assert(pr3.length === 2, '无project: 兼容旧格式');
assert(pr3.every(t => typeof t.task === 'string'), '无project: 所有字段正常');

// 4.4 LLM 返回不含项目名的 task，渲染层只设置 project
const pr4 = parseTaskJSON('[{"task":"与客户沟通上线事宜","project":"英大"}]');
assert(pr4[0].task === '与客户沟通上线事宜', 'LLM: task=润色后内容');
assert(pr4[0].project === '英大', 'LLM: project=英大');

// 4.5 渲染层只设置 project，不拼接 task
function prependProject(tasks, project) {
  if (project) tasks.forEach(t => { t.project = project; });
  return tasks;
}
const pr5 = prependProject([{ task: '与客户沟通上线事宜' }], '英大');
assert(pr5[0].task === '与客户沟通上线事宜', '拼接: task保持原样，不拼接项目名');
assert(pr5[0].project === '英大', '拼接: project设置正确');

// 4.6 无项目不拼接
const pr6 = prependProject([{ task: '买咖啡' }], null);
assert(pr6[0].task === '买咖啡', '无项目: task不变');
assert(!pr6[0].project, '无项目: 无project字段');

// ========== 5. addTasks 去重逻辑（project 字段不影响去重） ==========
console.log('\n--- addTasks 去重 + project ---');

function addTasks(existing, incoming) {
  const existingTexts = new Set(existing.map(t => t.task));
  const unique = incoming.filter(t => !existingTexts.has(t.task));
  if (unique.length === 0) return { added: [], tasks: [...existing] };
  const items = unique.map((t, i) => ({
    id: 't_' + i,
    task: t.task,
    project: t.project || null,
    completed: false,
    createdAt: new Date().toISOString(),
    completedAt: null,
    alarmTime: null,
    sortOrder: existing.length + i,
  }));
  return { added: items, tasks: [...items, ...existing] };
}

// 5.1 project 不影响去重（去重只看 task 字段）
const r51 = addTasks(
  [{ id: 'old', task: '本地环境测试', project: null }],
  [{ task: '本地环境测试', project: '国寿' }]
);
assert(r51.added.length === 0, '去重: 同task不同project视为重复');

// 5.2 正常添加
const r52 = addTasks([], [{ task: '巡检', project: '中加' }]);
assert(r52.added.length === 1, '正常添加: 1条');
assert(r52.added[0].project === '中加', '正常添加: project保留');
assert(r52.added[0].task === '巡检', '正常添加: task保留');

// ========== 6. 配置管理：projectNames 增删 ==========
console.log('\n--- 配置管理: projectNames ---');

const defaultConfig = {
  apiKey: '', baseUrl: 'https://api.deepseek.com', reportName: '',
  notesDir: '', projectNames: [],
  shortcuts: { toggle: 'Alt+`', organize: 'Ctrl+Enter', switchTask: 'Alt+1', switchNotepad: 'Alt+2' }
};

// 6.1 默认值
assert(Array.isArray(defaultConfig.projectNames), '默认: projectNames是数组');
assert(defaultConfig.projectNames.length === 0, '默认: projectNames为空');

// 6.2 添加项目名
function addProjectName(config, name) {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (config.projectNames.includes(trimmed)) return false;
  config.projectNames.push(trimmed);
  return true;
}
assert(addProjectName(defaultConfig, '国寿') === true, '添加: 国寿成功');
assert(defaultConfig.projectNames.length === 1, '添加: 长度为1');
assert(addProjectName(defaultConfig, '国寿') === false, '添加: 重复国寿 → false');
assert(addProjectName(defaultConfig, '') === false, '添加: 空字符串 → false');
assert(addProjectName(defaultConfig, '   ') === false, '添加: 空白 → false');
assert(addProjectName(defaultConfig, '中加') === true, '添加: 中加成功');
assert(addProjectName(defaultConfig, '华创') === true, '添加: 华创成功');
assert(defaultConfig.projectNames.length === 3, '添加: 最终3个');

// 6.3 删除项目名
function removeProjectName(config, name) {
  const idx = config.projectNames.indexOf(name);
  if (idx === -1) return false;
  config.projectNames.splice(idx, 1);
  return true;
}
assert(removeProjectName(defaultConfig, '中加') === true, '删除: 中加成功');
assert(defaultConfig.projectNames.length === 2, '删除: 剩2个');
assert(defaultConfig.projectNames.includes('国寿') && defaultConfig.projectNames.includes('华创'), '删除: 正确保留');
assert(removeProjectName(defaultConfig, '不存在') === false, '删除: 不存在的 → false');

// 6.4 配置读写（模拟加密存储的纯逻辑层）
function serializeConfig(cfg) { return JSON.stringify(cfg); }
function deserializeConfig(json) {
  try { return JSON.parse(json); } catch (e) { return null; }
}

const origJson = serializeConfig(defaultConfig);
const restored = deserializeConfig(origJson);
assert(restored.projectNames.length === 2, '序列化: 往返后projectNames=2');
assert(restored.projectNames[0] === '国寿', '序列化: 第1个是国寿');
assert(restored.projectNames[1] === '华创', '序列化: 第2个是华创');

// 6.5 向后兼容：旧配置没有 projectNames 字段
const freshDefault = { apiKey: '', baseUrl: '', reportName: '', notesDir: '', projectNames: [], shortcuts: {} };
const oldConfigJson = '{"apiKey":"sk-xxx","baseUrl":"https://api.deepseek.com"}';
const oldCfg = deserializeConfig(oldConfigJson);
const merged = { ...freshDefault, ...oldCfg };
assert(Array.isArray(merged.projectNames), '旧配置兼容: projectNames自动填充为[]');
assert(merged.projectNames.length === 0, '旧配置兼容: 空数组');

// ========== 7. 边界情况 ==========
console.log('\n--- 边界情况 ---');

// 7.1 多个项目名都在输入中出现，取第一个匹配到的
assert(matchProject('国寿中加都要巡检', ['国寿', '中加']) === '国寿', '多匹配: 取第一个');

// 7.2 项目名含特殊字符 ( ) 等 —— indexOf 匹配的是子串，不受正则影响
// "测试(abc)项目" 中包含子串 "abc"，所以会被匹配到
assert(matchProject('测试(abc)项目', ['abc']) === 'abc', '特殊字符: 括号不影响 indexOf 子串匹配');

// 7.3 项目名是英文单词的一部分，不应误匹配（indexOf 天然会匹配，这是预期行为）
assert(matchProject('abcProject', ['abc']) === 'abc', '子串匹配: 英文单词内也匹配（预期行为）');

// 7.4 输入全是空格 + 项目名
const fb7 = fallbackOrganizeWithProject('   国寿   ', [], ['国寿']);
assert(fb7[0].task === '', '仅项目名+空格: task为空');
assert(fb7[0].project === '国寿', '仅项目名+空格: project=国寿');

// 7.5 项目名重叠（如"国寿"和"国寿财险"都在列表中）
const fb8 = fallbackOrganizeWithProject('做国寿财险的年度报告', [], ['国寿', '国寿财险']);
// matchProject 按数组顺序先匹配到 "国寿"
assert(fb8[0].project === '国寿', '重叠项目名: 按数组顺序首个命中');
// 移除第一个匹配到的项目名后，剩余文本为 "做财险的年度报告"
assert(fb8[0].task === '做财险的年度报告', '重叠项目名: 只移除第一个命中的项目名');

// ========== 结果 ==========
console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
if (failed > 0) process.exit(1);
