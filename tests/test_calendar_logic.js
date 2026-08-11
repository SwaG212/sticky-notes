// 日历功能单元测试:周条/月历网格/任务计数纯函数
// 运行: "C:/Program Files/nodejs/node" tests/test_calendar_logic.js

let passed = 0, failed = 0;
function assert(condition, name) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`); }
}

console.log('\n=== 日历逻辑单元测试 ===\n');

// --- 被测函数(inline 复制自 renderer.js) ---
function formatDateStr(year, month, day) {
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function buildWeekDays(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = new Date(y, m - 1, d - new Date(y, m - 1, d).getDay());
  const days = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    days.push(formatDateStr(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()));
  }
  return days;
}

function buildMonthGrid(y, m) {
  const firstDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const daysInPrev = new Date(y, m, 0).getDate();
  const cells = [];
  for (let i = firstDow - 1; i >= 0; i--) {
    const d = daysInPrev - i;
    const dt = new Date(y, m - 1, d);
    cells.push({ date: formatDateStr(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()), inMonth: false, day: d });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: formatDateStr(y, m + 1, d), inMonth: true, day: d });
  }
  const remainder = cells.length % 7 === 0 ? 0 : 7 - (cells.length % 7);
  for (let d = 1; d <= remainder; d++) {
    const dt = new Date(y, m + 1, d);
    cells.push({ date: formatDateStr(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()), inMonth: false, day: d });
  }
  return cells;
}

function countTasksByDate(tasks, dateStr) {
  let undone = 0, total = 0;
  const projects = new Set();
  for (const t of tasks) {
    if (t.dueDate === dateStr) {
      total++;
      if (!t.completed) {
        undone++;
        projects.add(t.project || '(无项目)');
      }
    }
  }
  return { undone, total, projectCount: projects.size };
}

// --- buildWeekDays:所在周 7 天(周日开头) ---
console.log('--- buildWeekDays 周条 ---');
const week = buildWeekDays('2026-08-11'); // 2026-08-11 是周二
assert(week.length === 7, '周条 7 天');
assert(week[0] === '2026-08-09', '周日开头:2026-08-09(周日)');
assert(week[6] === '2026-08-15', '周六结尾:2026-08-15');
assert(week.includes('2026-08-11'), '包含选中日 2026-08-11');

const weekMon = buildWeekDays('2026-08-03'); // 周一
assert(weekMon[0] === '2026-08-02', '周一所在周:周日起 08-02');
assert(weekMon[6] === '2026-08-08', '周一所在周:周六止 08-08');

const weekSun = buildWeekDays('2026-08-09'); // 周日
assert(weekSun[0] === '2026-08-09' && weekSun[6] === '2026-08-15', '周日为周首:整周即该周');

// 跨月周:8 月 1 日(周六)所在周跨 7 月底
const crossMonth = buildWeekDays('2026-08-01');
assert(crossMonth[0] === '2026-07-26', '跨月周起始:2026-07-26');
assert(crossMonth[6] === '2026-08-01', '跨月周结束:2026-08-01');

// 跨年周:1 月 1 日(周四)所在周跨上年 12 月
const crossYear = buildWeekDays('2026-01-01');
assert(crossYear[0] === '2025-12-28', '跨年周起始:2025-12-28');
assert(crossYear[6] === '2026-01-03', '跨年周结束:2026-01-03');

// --- buildMonthGrid:月历网格 ---
console.log('\n--- buildMonthGrid 月历网格 ---');
const grid = buildMonthGrid(2026, 7); // 2026 年 8 月(0-indexed m=7)
assert(grid.length === 42, '8 月网格 42 格(6 行)');
assert(grid[0].date === '2026-07-26' && grid[0].inMonth === false, '首格为 7/26 补格');
assert(grid.filter(c => c.inMonth).length === 31, '8 月 31 个当月格');
const aug11 = grid.find(c => c.date === '2026-08-11');
assert(aug11 && aug11.inMonth === true && aug11.day === 11, '8/11 为当月格且日号为 11');

const gridFeb = buildMonthGrid(2026, 1); // 2026 年 2 月(闰年,28 天)
assert(gridFeb.filter(c => c.inMonth).length === 28, '2026 年 2 月 28 天');
assert(gridFeb.length % 7 === 0, '网格总数为 7 的倍数');

const gridJan = buildMonthGrid(2026, 0); // 1 月,补格跨年
assert(gridJan[0].date.startsWith('2025-12-'), '1 月首补格为上年 12 月');

const gridDec = buildMonthGrid(2026, 11); // 12 月,尾补格跨年
const lastCells = gridDec.slice(-7);
assert(lastCells.some(c => c.date.startsWith('2027-01-')), '12 月尾补格为次年 1 月');

// --- countTasksByDate:任务计数 ---
console.log('\n--- countTasksByDate 任务计数 ---');
const tasks = [
  { task: 'A', dueDate: '2026-08-11', completed: false },
  { task: 'B', dueDate: '2026-08-11', completed: false },
  { task: 'C', dueDate: '2026-08-11', completed: true },
  { task: 'D', dueDate: '2026-08-12', completed: false },
  { task: 'E', dueDate: null, completed: false },
];
const c11 = countTasksByDate(tasks, '2026-08-11');
assert(c11.total === 3 && c11.undone === 2, '8/11:总数 3,未完成 2');
assert(countTasksByDate(tasks, '2026-08-12').undone === 1, '8/12:未完成 1');
assert(countTasksByDate(tasks, '2026-08-13').undone === 0, '8/13:无任务');
assert(countTasksByDate([], '2026-08-11').total === 0, '空列表:0');

// --- 圆点规则:仅未完成 > 0 显示 ---
console.log('\n--- 圆点显示规则 ---');
const dotDay = '2026-08-11';
assert(countTasksByDate(tasks, dotDay).undone > 0, '有未完成任务 → 显示圆点');
assert(countTasksByDate(tasks, '2026-08-13').undone === 0, '无任务 → 无圆点');
assert(countTasksByDate([{ task: 'X', dueDate: '2026-08-11', completed: true }], dotDay).undone === 0, '仅已完成 → 无圆点');

// 多色点:点数 = min(去重项目数, 3),颜色绿黄红
const tasks1p = [
  { task: 'A', dueDate: '2026-08-11', completed: false, project: '国寿' },
  { task: 'B', dueDate: '2026-08-11', completed: false, project: '国寿' },
];
const tasks2p = [
  { task: 'A', dueDate: '2026-08-11', completed: false, project: '国寿' },
  { task: 'B', dueDate: '2026-08-11', completed: false, project: '腾讯' },
];
const tasks3p = [
  { task: 'A', dueDate: '2026-08-11', completed: false, project: '国寿' },
  { task: 'B', dueDate: '2026-08-11', completed: false, project: '腾讯' },
  { task: 'C', dueDate: '2026-08-11', completed: false, project: '阿里' },
];
const tasks4p = [
  ...tasks3p,
  { task: 'D', dueDate: '2026-08-11', completed: false, project: '百度' },
];
const tasksNoProj = [
  { task: 'A', dueDate: '2026-08-11', completed: false, project: null },
  { task: 'B', dueDate: '2026-08-11', completed: false, project: null },
];
const projectCount = (ts) => countTasksByDate(ts, dotDay).projectCount;
const dotCount = (ts) => Math.min(projectCount(ts), 3);
assert(projectCount(tasks1p) === 1, '同项目多任务 → 1 个项目');
assert(projectCount(tasks2p) === 2, '两个项目 → 2 个项目');
assert(projectCount(tasks3p) === 3, '三个项目 → 3 个项目');
assert(projectCount(tasks4p) === 4, '四个项目 → 4 个项目(点数仍封顶 3)');
assert(dotCount(tasks1p) === 1, '1 项目 → 1 个点(绿)');
assert(dotCount(tasks2p) === 2, '2 项目 → 2 个点(绿黄)');
assert(dotCount(tasks3p) === 3, '3 项目 → 3 个点(绿黄红)');
assert(dotCount(tasks4p) === 3, '4 项目 → 仍 3 个点(封顶)');
assert(projectCount(tasksNoProj) === 1, '仅无项目任务 → 计 1 类(1 个点)');
assert(projectCount(tasks2p) === 2, '已完成任务不计入项目数');
assert(countTasksByDate(tasks2p, dotDay).total === 2, '已完成任务计入总数');

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
