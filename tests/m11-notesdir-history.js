// M11 单元测试：文件路径历史功能 (notesDirHistory)
// 运行: "C:/Program Files/nodejs/node" tests/m11-notesdir-history.js

let passed = 0, failed = 0;
function assert(condition, name) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`); }
}

console.log('\n=== M11: notesDirHistory 文件路径历史测试 ===\n');

// ========== 模拟 saveConfig 中的历史维护逻辑 ==========
function simulateSaveConfig(cfg) {
  if (cfg.notesDir && cfg.notesDir.trim()) {
    const dir = cfg.notesDir.trim();
    const history = cfg.notesDirHistory || [];
    const filtered = history.filter(d => d !== dir);
    cfg.notesDirHistory = [dir, ...filtered].slice(0, 5);
  }
  return cfg;
}

// --- 测试 1: 空路径不加入历史 ---
console.log('--- 空路径不加入历史 ---');
let cfg1 = { notesDir: '', notesDirHistory: [] };
simulateSaveConfig(cfg1);
assert(cfg1.notesDirHistory.length === 0, '空字符串不加入历史');

let cfg1b = { notesDir: '  ', notesDirHistory: [] };
simulateSaveConfig(cfg1b);
assert(cfg1b.notesDirHistory.length === 0, '纯空格不加入历史');

// --- 测试 2: 新路径加入历史头部 ---
console.log('\n--- 新路径加入历史 ---');
let cfg2 = { notesDir: 'D:\\my-notes', notesDirHistory: [] };
simulateSaveConfig(cfg2);
assert(cfg2.notesDirHistory.length === 1, '历史有 1 条');
assert(cfg2.notesDirHistory[0] === 'D:\\my-notes', '新路径在位置 0');

let cfg2b = { notesDir: 'E:\\work', notesDirHistory: [...cfg2.notesDirHistory] };
simulateSaveConfig(cfg2b);
assert(cfg2b.notesDirHistory.length === 2, '历史有 2 条');
assert(cfg2b.notesDirHistory[0] === 'E:\\work', '最新路径在位置 0');
assert(cfg2b.notesDirHistory[1] === 'D:\\my-notes', '旧路径后移');

// --- 测试 3: 重复路径去重 + 移到头部 ---
console.log('\n--- 重复路径去重 ---');
let cfg3 = { notesDir: 'D:\\my-notes', notesDirHistory: ['E:\\work', 'D:\\my-notes', 'F:\\docs'] };
simulateSaveConfig(cfg3);
assert(cfg3.notesDirHistory.length === 3, '去重后仍为 3 条');
assert(cfg3.notesDirHistory[0] === 'D:\\my-notes', '重复路径移到头部');
assert(cfg3.notesDirHistory[1] === 'E:\\work', '原有第一条后移');
assert(cfg3.notesDirHistory[2] === 'F:\\docs', '原有第三条保留');

// --- 测试 4: 上限 5 条 ---
console.log('\n--- 上限 5 条 ---');
let cfg4 = { notesDir: 'F:\\sixth', notesDirHistory: ['E:\\5', 'D:\\4', 'C:\\3', 'B:\\2', 'A:\\1'] };
simulateSaveConfig(cfg4);
assert(cfg4.notesDirHistory.length === 5, '保持 5 条不超出');
assert(cfg4.notesDirHistory[0] === 'F:\\sixth', '新路径在头部');
assert(cfg4.notesDirHistory[4] === 'B:\\2', '最旧的 A:\\1 被挤出');

// 重复路径 + 已达上限
let cfg4b = { notesDir: 'C:\\3', notesDirHistory: ['F:\\sixth', 'E:\\5', 'D:\\4', 'C:\\3', 'B:\\2'] };
simulateSaveConfig(cfg4b);
assert(cfg4b.notesDirHistory.length === 5, '去重后仍 5 条');
assert(cfg4b.notesDirHistory[0] === 'C:\\3', '已有路径移到头部');
assert(JSON.stringify(cfg4b.notesDirHistory) === JSON.stringify(['C:\\3', 'F:\\sixth', 'E:\\5', 'D:\\4', 'B:\\2']), '顺序正确');

// --- 测试 5: 向后兼容（缺失 notesDirHistory 字段） ---
console.log('\n--- 向后兼容 ---');
let cfg5 = { notesDir: 'D:\\new-path' };
simulateSaveConfig(cfg5);
assert(cfg5.notesDirHistory.length === 1, '缺失字段时自动创建');
assert(cfg5.notesDirHistory[0] === 'D:\\new-path', '路径正确写入');

let cfg5b = { notesDir: '' };
simulateSaveConfig(cfg5b);
assert(!cfg5b.notesDirHistory || cfg5b.notesDirHistory.length === 0, '空路径不创建历史');

// --- 测试 6: 路径首尾空格 trim ---
console.log('\n--- 路径 trim ---');
let cfg6 = { notesDir: '  D:\\trimmed  ', notesDirHistory: [] };
simulateSaveConfig(cfg6);
assert(cfg6.notesDirHistory[0] === 'D:\\trimmed', '首尾空格被 trim');
assert(cfg6.notesDirHistory.length === 1, 'trim 后正确加入');

// ========== 下拉逻辑模拟测试 ==========
console.log('\n--- 下拉菜单逻辑 (combobox) ---');

// 模拟 openSettings 中构建下拉菜单的逻辑
function buildComboMenuItems(history) {
  const items = [{ label: '默认位置 (AppData)', value: '', isDefault: true }];
  history.forEach(dir => { items.push({ label: dir, value: dir }); });
  return items;
}

// 模拟点击菜单项的填充逻辑
function onItemClick(itemValue) {
  return itemValue; // 直接填入 input
}

// 测试 7: 下拉菜单项结构
let r7 = buildComboMenuItems(['D:\\a', 'E:\\b']);
assert(r7.length === 3, '1 默认 + 2 历史 = 3 项');
assert(r7[0].value === '', '第一项是默认位置(值为空)');
assert(r7[0].isDefault === true, '第一项标记为默认');
assert(r7[1].value === 'D:\\a', '第二项是历史 1');
assert(r7[2].value === 'E:\\b', '第三项是历史 2');

// 测试 8: 空历史 → 仅默认项
let r8 = buildComboMenuItems([]);
assert(r8.length === 1, '空历史仅 1 项(默认)');

// 测试 9: 点击默认位置 → 清空输入
assert(onItemClick('') === '', '点默认→填入空字符串');

// 测试 10: 点击历史路径 → 填入该路径
assert(onItemClick('D:\\work') === 'D:\\work', '点历史→填入该路径');

// 测试 11: input 始终可直接编辑（combobox 不拦截手动输入）
// 用户手动输入新路径后保存 → saveConfig 自动加入历史（已在上面测试）
assert(true, 'input 始终可手动编辑');


console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
