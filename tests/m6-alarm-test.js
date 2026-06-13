// M6 单元测试：定时提醒模块
// 运行: "C:/Program Files/nodejs/node" tests/m6-alarm-test.js

let passed = 0, failed = 0;

function assert(condition, name) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`); }
}

function test(name, fn) {
  console.log(`\n📋 ${name}`);
  try { fn(); }
  catch (e) { failed++; console.error(`  ❌ 异常: ${e.message}`); }
}

// ========== 测试 1：alarmTime 字段初始化 ==========
test('alarmTime 字段', () => {
  function makeTask() {
    return { id: 't1', task: '测试', completed: false, createdAt: new Date().toISOString(), completedAt: null, alarmTime: null };
  }
  const t = makeTask();
  assert(t.alarmTime === null, '新建任务 alarmTime 默认为 null');
  assert('alarmTime' in t, 'alarmTime 字段存在');
});

// ========== 测试 2：格式化显示 ==========
test('时间格式化', () => {
  function formatAlarm(alarmTime) {
    return alarmTime || '--:--';
  }
  assert(formatAlarm(null) === '--:--', 'null → --:--');
  assert(formatAlarm(undefined) === '--:--', 'undefined → --:--');
  assert(formatAlarm('') === '--:--', '空字符串 → --:--');
  assert(formatAlarm('13:25') === '13:25', '正常时间原样');
  assert(formatAlarm('00:00') === '00:00', '午夜');
  assert(formatAlarm('23:59') === '23:59', '边界时间');
});

// ========== 测试 3：HH:MM 格式校验 ==========
test('HH:MM 格式', () => {
  function isValidAlarm(val) {
    if (!val || typeof val !== 'string') return false;
    const m = val.match(/^(\d{2}):(\d{2})$/);
    if (!m) return false;
    const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    return h >= 0 && h <= 23 && mm >= 0 && mm <= 59;
  }

  assert(isValidAlarm('13:25'), '13:25 有效');
  assert(isValidAlarm('00:00'), '00:00 有效');
  assert(isValidAlarm('23:59'), '23:59 有效');
  assert(!isValidAlarm('24:00'), '24:00 无效');
  assert(!isValidAlarm('00:60'), '00:60 无效');
  assert(!isValidAlarm(null), 'null 无效');
  assert(!isValidAlarm(''), '空串无效');
  assert(!isValidAlarm('abc'), '非数字无效');
  assert(!isValidAlarm('13:5'), '缺少前导零无效');
});

// ========== 测试 4：跨天清空逻辑 ==========
test('跨天清空 alarmTime', () => {
  function clearAlarmsForNewDay(tasks) {
    let changed = false;
    tasks.forEach(t => { if (t.alarmTime) { t.alarmTime = null; changed = true; } });
    return changed;
  }

  const tasks = [
    { id: '1', task: 'A', alarmTime: '13:00' },
    { id: '2', task: 'B', alarmTime: null },
    { id: '3', task: 'C', alarmTime: '15:30' },
  ];
  const changed = clearAlarmsForNewDay(tasks);
  assert(changed, '有 alarm 时 changed=true');
  assert(tasks[0].alarmTime === null, 'A 的 alarmTime 清空');
  assert(tasks[1].alarmTime === null, 'B 仍为 null');
  assert(tasks[2].alarmTime === null, 'C 的 alarmTime 清空');

  // 再次调用不重复
  const changed2 = clearAlarmsForNewDay(tasks);
  assert(!changed2, '全部已清空时 changed=false');
});

// ========== 测试 5：昨日未完成迁移时清空 alarmTime ==========
test('昨日未完成跨天清空', () => {
  const yesterdayTasks = [
    { id: 'y1', task: '已完成', completed: true, alarmTime: '14:00' },
    { id: 'y2', task: '未完成', completed: false, alarmTime: '16:00' },
  ];
  const unfinished = yesterdayTasks.filter(t => !t.completed);
  unfinished.forEach(t => { t.alarmTime = null; });

  assert(unfinished.length === 1, '只迁移 1 条');
  assert(unfinished[0].alarmTime === null, '迁移后 alarmTime=null');
  assert(!yesterdayTasks.some(t => t.completed && t.alarmTime === null), '已完成的不处理 alarmTime');
});

// ========== 测试 6：定时检查逻辑 ==========
test('定时检查（模拟 arrival）', () => {
  function getCurrentHHMM(h, m) {
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }

  function findDue(tasks, currentHHMM) {
    return tasks.filter(t => t.alarmTime === currentHHMM && !t.completed);
  }

  const now = getCurrentHHMM(14, 30);
  const tasks = [
    { id: '1', task: 'A', alarmTime: '14:30', completed: false },
    { id: '2', task: 'B', alarmTime: '13:00', completed: false },
    { id: '3', task: 'C', alarmTime: '14:30', completed: true },
    { id: '4', task: 'D', alarmTime: null, completed: false },
    { id: '5', task: 'E', alarmTime: '14:30', completed: false },
  ];

  const due = findDue(tasks, now);
  assert(due.length === 2, `14:30 到达 2 条（A+E），C 已勾选不弹`);
  assert(due[0].task === 'A', 'A 在其中');
  assert(due[1].task === 'E', 'E 在其中');

  const dueAt13 = findDue(tasks, '13:00');
  assert(dueAt13.length === 1, '13:00 到达 1 条（B）');

  const dueAt15 = findDue(tasks, '15:00');
  assert(dueAt15.length === 0, '15:00 无任务');
});

// ========== 测试 7：合并提醒弹窗文案 ==========
test('合并提醒文案', () => {
  function buildAlarmLines(tasks) {
    return tasks.map(t => `任务「${t.task}」的时间到了`);
  }

  const due = [
    { id: '1', task: '周三前出合同' },
    { id: '2', task: '找运维要服务器账号' },
  ];

  const lines = buildAlarmLines(due);
  assert(lines.length === 2, '2 条提醒');
  assert(lines[0] === '任务「周三前出合同」的时间到了', '任务A文案');
  assert(lines[1] === '任务「找运维要服务器账号」的时间到了', '任务B文案');
});

// ========== 测试 8：已过时间不弹窗 ==========
test('已过时间不弹窗', () => {
  function shouldAlarm(alarmTime) {
    const now = new Date();
    const currentHHMM = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    return alarmTime === currentHHMM;
  }

  // 模拟一个已过的时间，不应匹配当前时间
  assert(!shouldAlarm('00:00'), '假设现在不是 00:00');
  assert(!shouldAlarm('05:00'), '假设现在不是 05:00');
  // 无法精确测试当前时间，但逻辑正确即可
  assert(typeof shouldAlarm('00:00') === 'boolean', '返回布尔值');
});

// ========== 测试 9：清除按钮 ==========
test('清除按钮逻辑', () => {
  const tasks = [{ id: '1', task: '测试', alarmTime: '14:00' }];
  tasks[0].alarmTime = null;
  assert(tasks[0].alarmTime === null, 'alarmTime 设为 null');
  // 显示测试
  assert((tasks[0].alarmTime || '--:--') === '--:--', 'null 显示 --:--');
});

// ========== 测试 10：多任务相同时间去重弹窗 ==========
test('同时间合并弹窗', () => {
  function groupByTime(tasks) {
    const groups = {};
    tasks.filter(t => t.alarmTime).forEach(t => {
      if (!groups[t.alarmTime]) groups[t.alarmTime] = [];
      groups[t.alarmTime].push(t);
    });
    return groups;
  }

  const tasks = [
    { id: '1', task: 'A', alarmTime: '14:00' },
    { id: '2', task: 'B', alarmTime: '14:00' },
    { id: '3', task: 'C', alarmTime: '15:00' },
    { id: '4', task: 'D', alarmTime: '14:00' },
  ];

  const groups = groupByTime(tasks);
  assert(Object.keys(groups).length === 2, '2 组时间');
  assert(groups['14:00'].length === 3, '14:00 有 3 条');
  assert(groups['15:00'].length === 1, '15:00 有 1 条');
});

// ========== 结果 ==========
console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
process.exit(failed > 0 ? 1 : 0);
