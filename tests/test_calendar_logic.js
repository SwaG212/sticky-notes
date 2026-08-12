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

// 统计某日期任务数组(已按日期归属,不过滤 dueDate);按项目去重(无项目任务计 1 类)
function countDayTasks(dayTasks) {
  let undone = 0, total = 0;
  const undoneProjects = new Set();
  const doneProjects = new Set();
  for (const t of dayTasks) {
    total++;
    if (!t.completed) {
      undone++;
      undoneProjects.add(t.project || '(无项目)');
    } else {
      doneProjects.add(t.project || '(无项目)');
    }
  }
  return { undone, total, projectCount: undoneProjects.size, doneProjectCount: doneProjects.size };
}

// 合并某日期任务(按 任务+项目 去重;保留 updatedAt 最新版本,同时间戳时 done=true 优先)
function mergeDayTasks(todayOnes, historic) {
  const seen = new Map(); // key → task(保留最新)
  const order = [];
  const add = (t) => {
    const key = t.task + '|' + (t.project || '');
    if (seen.has(key)) {
      const cur = seen.get(key);
      const tNew = (t.updatedAt || t.createdAt || '');
      const curNew = (cur.updatedAt || cur.createdAt || '');
      if (tNew > curNew) {
        const i = order.indexOf(key);
        order[i] = key;
        seen.set(key, t);
      } else if (tNew === curNew && t.completed && !cur.completed) {
        // 同时间戳:勾选状态优先(旧的持久化任务无 updatedAt,createdAt 相同,勾选副本视为最新)
        const i = order.indexOf(key);
        order[i] = key;
        seen.set(key, t);
      }
      return;
    }
    seen.set(key, t);
    order.push(key);
  };
  for (const t of todayOnes) add(t);
  for (const t of (historic || [])) add(t);
  return order.map(k => seen.get(k));
}

function dotSequenceForDate(dayTasks, dateStr, todayStr) {
  const { projectCount, doneProjectCount } = countDayTasks(dayTasks);
  if (dateStr < todayStr) {
    const n1 = Math.min(projectCount, 3);
    const colors = ['cal-dot-green', 'cal-dot-yellow', 'cal-dot-red'].slice(0, n1);
    const n2 = Math.min(doneProjectCount, 3 - n1);
    for (let i = 0; i < n2; i++) colors.push('cal-dot-done');
    return colors;
  }
  return ['cal-dot-green', 'cal-dot-yellow', 'cal-dot-red'].slice(0, Math.min(projectCount, 3));
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

// --- countDayTasks:已归属任务数组统计 ---
console.log('\n--- countDayTasks 任务计数 ---');
const dayTasksList = [
  { task: 'A', dueDate: '2026-08-11', completed: false },
  { task: 'B', dueDate: '2026-08-11', completed: false },
  { task: 'C', dueDate: '2026-08-11', completed: true },
  { task: 'D', dueDate: '2026-08-12', completed: false },
  { task: 'E', dueDate: null, completed: false },
];
const c11 = countDayTasks(dayTasksList.slice(0, 3));
assert(c11.total === 3 && c11.undone === 2, '8/11:总数 3,未完成 2');
assert(countDayTasks([dayTasksList[3]]).undone === 1, '8/12:未完成 1');
assert(countDayTasks([dayTasksList[4]]).undone === 1, '无日期任务(历史文件归属)计入');
assert(countDayTasks([]).total === 0, '空列表:0');

// --- mergeDayTasks:合并去重(updatedAt 最新优先) ---
console.log('\n--- mergeDayTasks 合并 ---');
const todayOnes = [{ task: 'X', project: '国寿', completed: false, updatedAt: '2026-08-12T10:00:00Z' }, { task: 'Y', project: null, completed: true, updatedAt: '2026-08-12T09:00:00Z' }];
const historic = [
  { task: 'X', project: '国寿', completed: true, updatedAt: '2026-08-11T10:00:00Z' }, // 更旧 → 保留今天版本
  { task: 'Z', project: '腾讯', completed: true, updatedAt: '2026-08-11T10:00:00Z' }, // 仅在历史文件
  { task: 'W', project: null, completed: true, updatedAt: '2026-08-11T10:00:00Z' },   // 无项目历史
];
const merged = mergeDayTasks(todayOnes, historic);
assert(merged.length === 4, '合并去重后 4 条(今天2+历史唯一2)');
assert(merged[0].task === 'X' && merged[0].completed === false, '同名任务保留 updatedAt 最新(今天 false 覆盖历史 true)');
assert(merged.some(t => t.task === 'Z' && t.completed), '历史唯一任务保留');
const mergedNoHist = mergeDayTasks(todayOnes, []);
assert(mergedNoHist.length === 2, '无历史 → 仅今天');

// 问题1核心:取消勾选(completed=false + 最新 updatedAt)不被旧副本 true 覆盖
console.log('\n--- mergeDayTasks 取消勾选不被旧 true 覆盖 ---');
const cancelCase = mergeDayTasks([], [
  { id: 'a1', task: '安保', project: '国寿', completed: false, updatedAt: '2026-08-12T11:00:00Z' }, // 最新:已取消
  { id: 'a2', task: '安保', project: '国寿', completed: true, updatedAt: '2026-08-11T10:00:00Z' },  // 旧:已完成
]);
assert(cancelCase.length === 1 && cancelCase[0].completed === false, '取消勾选(updatedAt 最新)不被旧 true 覆盖');
assert(cancelCase[0].id === 'a1', '保留最新 updatedAt 的副本');
// 无 updatedAt 的旧数据:同 created 时 done=true 优先(兼容旧数据)
const legacyCase = mergeDayTasks([], [
  { id: 'b1', task: '浦发', project: '国寿', completed: false, createdAt: '2026-08-10T00:00:00Z' },
  { id: 'b2', task: '浦发', project: '国寿', completed: true, createdAt: '2026-08-10T00:00:00Z' },
]);
assert(legacyCase.length === 1 && legacyCase[0].completed === true, '旧数据(无 updatedAt)同 created 时勾选状态优先');
// 都有 updatedAt:最新时间戳优先(即使后者未完成)
const newerUnchecked = mergeDayTasks([], [
  { id: 'c1', task: '中加', project: '国寿', completed: true, updatedAt: '2026-08-10T00:00:00Z' },
  { id: 'c2', task: '中加', project: '国寿', completed: false, updatedAt: '2026-08-12T00:00:00Z' },
]);
assert(newerUnchecked.length === 1 && newerUnchecked[0].completed === false, '有 updatedAt 时最新时间戳优先(取消状态保留)');

// --- buildDueDateIndex:完全按日期胶囊(dueDate)归属 ---
console.log('\n--- buildDueDateIndex 按 dueDate 索引 ---');
function buildDueDateIndex(todayTasks, cachedFiles) {
  const index = new Map();
  const add = (t) => {
    if (!t || typeof t.dueDate !== 'string') return;
    const key = t.task + '|' + (t.project || '');
    const list = index.get(t.dueDate);
    if (!list) { index.set(t.dueDate, [t]); return; }
    const i = list.findIndex(x => x.task + '|' + (x.project || '') === key);
    if (i === -1) { list.push(t); return; }
    // 同名副本:保留 updatedAt 最新;同时间戳时 done=true 优先(旧数据无 updatedAt 时勾选副本视为最新)
    const cur = list[i];
    const tNew = (t.updatedAt || t.createdAt || '');
    const curNew = (cur.updatedAt || cur.createdAt || '');
    if (tNew > curNew) list[i] = t;
    else if (tNew === curNew && t.completed && !cur.completed) list[i] = t;
  };
  for (const t of todayTasks) add(t);
  for (const arr of cachedFiles) for (const t of arr) add(t);
  return index;
}
const idxToday = [
  { id: 't1', task: '今天有日期', project: '国寿', completed: false, dueDate: '2026-08-12' },
  { id: 't2', task: '无日期任务', project: '腾讯', completed: false, dueDate: null },   // 不入索引
  { id: 't3', task: '未来日期', project: '阿里', completed: false, dueDate: '2026-08-20' },
];
const idxFileA = [
  { id: 'f1', task: '历史文件任务', project: '百度', completed: true, dueDate: '2026-08-10' },
  { id: 'f2', task: '历史无日期', project: null, completed: true, dueDate: null },      // 不入索引
];
const idxFileB = [
  { id: 'f3', task: '今天有日期', project: '国寿', completed: true, dueDate: '2026-08-12' }, // 与今天同名 → 今天版本优先
  { id: 'f4', task: '跨文件任务', project: '网易', completed: false, dueDate: '2026-08-12' },
];
const dueIndex = buildDueDateIndex(idxToday, [idxFileA, idxFileB]);
assert(dueIndex.get('2026-08-12').length === 2, '8/12: 今天1 + 历史唯一1(f3 与 t1 同名被去重) = 2 条');
assert(dueIndex.get('2026-08-12')[0].id === 'f3', '同名同时间戳 → 勾选状态(true)优先');
assert(dueIndex.get('2026-08-20')[0].id === 't3', '未来日期任务按 dueDate 归位(即使来自今天文件)');
assert(dueIndex.get('2026-08-10')[0].id === 'f1', '历史文件任务按 dueDate 归位(不按文件日期)');
const allIdxTasks = [...dueIndex.values()].flat();
assert(!allIdxTasks.some(t => t.id === 'f2') && !allIdxTasks.some(t => t.id === 't2'), '无日期任务(今天/历史)不在任何日期格');
let totalCount = 0;
for (const v of dueIndex.values()) totalCount += v.length;
assert(totalCount === 4, `索引总条数 4 (实际 ${totalCount})`);

// --- 圆点规则:未完成 > 0 显示(当天/未来),历史日期完成也显示绿点 ---
console.log('\n--- 圆点显示规则 ---');
const dotDay = '2026-08-11';
const dotTasks = [
  { task: 'A', completed: false },
  { task: 'B', completed: false },
  { task: 'C', completed: true },
];
assert(countDayTasks(dotTasks).undone > 0, '有未完成任务 → 显示圆点');
assert(countDayTasks([]).undone === 0, '无任务 → 无圆点');
assert(countDayTasks([{ task: 'X', completed: true }]).undone === 0, '当天仅已完成 → 无圆点(未完成项目 0)');
assert(countDayTasks([{ task: 'X', completed: true }]).doneProjectCount === 1, '历史完成项目计入 doneProjectCount');

// 多色点:点数 = min(去重项目数, 3),颜色绿黄红
const tasks1p = [
  { task: 'A', completed: false, project: '国寿' },
  { task: 'B', completed: false, project: '国寿' },
];
const tasks2p = [
  { task: 'A', completed: false, project: '国寿' },
  { task: 'B', completed: false, project: '腾讯' },
];
const tasks3p = [
  { task: 'A', completed: false, project: '国寿' },
  { task: 'B', completed: false, project: '腾讯' },
  { task: 'C', completed: false, project: '阿里' },
];
const tasks4p = [
  ...tasks3p,
  { task: 'D', completed: false, project: '百度' },
];
const tasksNoProj = [
  { task: 'A', completed: false, project: null },
  { task: 'B', completed: false, project: null },
];
const projectCount = (ts) => countDayTasks(ts).projectCount;
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
assert(projectCount(tasks2p) === 2, '已完成任务不计入未完成项目数');
assert(countDayTasks(tasks2p).total === 2, '已完成任务计入总数');

// --- 圆点序列:历史日期完成绿点(用户需求 2026-08-12) ---
console.log('\n--- 圆点序列(历史/当天/未来) ---');
const TODAY = '2026-08-12';
const YESTERDAY = '2026-08-11';
const TOMORROW = '2026-08-13';
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// 历史日期:全部完成 → 全绿点,封顶 3
const pastAllDone = [
  { task: 'A', dueDate: YESTERDAY, completed: true, project: '国寿' },
  { task: 'B', dueDate: YESTERDAY, completed: true, project: '国寿' },
  { task: 'C', dueDate: YESTERDAY, completed: true, project: '腾讯' },
  { task: 'D', dueDate: YESTERDAY, completed: true, project: '阿里' },
  { task: 'E', dueDate: YESTERDAY, completed: true, project: '百度' },
];
assert(eq(dotSequenceForDate(pastAllDone, YESTERDAY, TODAY), ['cal-dot-done', 'cal-dot-done', 'cal-dot-done']), '历史全完成 4 项目 → 3 个绿点');
const pastOneDone = [{ task: 'A', dueDate: YESTERDAY, completed: true, project: '国寿' }];
assert(eq(dotSequenceForDate(pastOneDone, YESTERDAY, TODAY), ['cal-dot-done']), '历史 1 项目完成 → 1 个绿点');
// 历史日期:混合 → 未完成优先,完成补绿点
const pastMix = [
  { task: 'A', dueDate: YESTERDAY, completed: false, project: '国寿' },
  { task: 'B', dueDate: YESTERDAY, completed: false, project: '腾讯' },
  { task: 'C', dueDate: YESTERDAY, completed: true, project: '阿里' },
  { task: 'D', dueDate: YESTERDAY, completed: true, project: '百度' },
];
assert(eq(dotSequenceForDate(pastMix, YESTERDAY, TODAY), ['cal-dot-green', 'cal-dot-yellow', 'cal-dot-done']), '历史 2未完成+2完成 → 绿黄+绿点');
const pastMix2 = [
  { task: 'A', dueDate: YESTERDAY, completed: false, project: '国寿' },
  { task: 'B', dueDate: YESTERDAY, completed: true, project: '腾讯' },
];
assert(eq(dotSequenceForDate(pastMix2, YESTERDAY, TODAY), ['cal-dot-green', 'cal-dot-done']), '历史 1未完成+1完成 → 绿+绿点');
const pastMix3 = [
  { task: 'A', dueDate: YESTERDAY, completed: false, project: '国寿' },
  { task: 'B', dueDate: YESTERDAY, completed: true, project: '腾讯' },
  { task: 'C', dueDate: YESTERDAY, completed: true, project: '阿里' },
  { task: 'D', dueDate: YESTERDAY, completed: true, project: '百度' },
];
assert(eq(dotSequenceForDate(pastMix3, YESTERDAY, TODAY), ['cal-dot-green', 'cal-dot-done', 'cal-dot-done']), '历史 1未完成+3完成 → 绿+2绿点');
const pastMix4 = [
  { task: 'A', dueDate: YESTERDAY, completed: false, project: '国寿' },
  { task: 'B', dueDate: YESTERDAY, completed: false, project: '腾讯' },
  { task: 'C', dueDate: YESTERDAY, completed: false, project: '阿里' },
  { task: 'D', dueDate: YESTERDAY, completed: true, project: '百度' },
];
assert(eq(dotSequenceForDate(pastMix4, YESTERDAY, TODAY), ['cal-dot-green', 'cal-dot-yellow', 'cal-dot-red']), '历史 3未完成+1完成 → 全未完成色(绿点不顶替)');
assert(eq(dotSequenceForDate([], YESTERDAY, TODAY), []), '历史无任务 → 无点');
// 当天/未来:不显示绿点,仅未完成
const todayMix = [
  { task: 'A', dueDate: TODAY, completed: false, project: '国寿' },
  { task: 'B', dueDate: TODAY, completed: false, project: '腾讯' },
  { task: 'C', dueDate: TODAY, completed: true, project: '阿里' },
  { task: 'D', dueDate: TODAY, completed: true, project: '百度' },
];
assert(eq(dotSequenceForDate(todayMix, TODAY, TODAY), ['cal-dot-green', 'cal-dot-yellow']), '当天 2未完成+2完成 → 仅绿黄(无绿点)');
const todayAllDone = [
  { task: 'A', dueDate: TODAY, completed: true, project: '国寿' },
];
assert(eq(dotSequenceForDate(todayAllDone, TODAY, TODAY), []), '当天全完成 → 无点');
const futureMix = [
  { task: 'A', dueDate: TOMORROW, completed: false, project: '国寿' },
  { task: 'B', dueDate: TOMORROW, completed: true, project: '腾讯' },
];
assert(eq(dotSequenceForDate(futureMix, TOMORROW, TODAY), ['cal-dot-green']), '未来 1未完成+1完成 → 仅绿(无绿点)');

// --- 跨文件副本同步(inline 模拟 syncTaskCopies 逻辑) ---
console.log('\n--- 跨文件副本同步 ---');
// 模拟生产 syncTaskCopies 的匹配逻辑:按 id / 新身份 / 旧身份(prevKey) 匹配
function syncCopies(cache, t, prevKey) {
  const matches = (x) => {
    if (x.id && t.id && x.id === t.id) return true;
    if (x.task === t.task && (x.project || '') === (t.project || '')) return true;
    if (prevKey && (x.task + '|' + (x.project || '')) === prevKey) return true;
    return false;
  };
  const synced = [];
  for (const [d, fileArr] of cache) {
    for (const x of fileArr) {
      if (x === t) continue;
      if (matches(x)) {
        x.completed = t.completed;
        x.project = t.project;
        x.task = t.task;
        synced.push(d + ':' + x.id);
      }
    }
  }
  return synced;
}
// 场景1:勾选/取消同步同 id 或同名副本
const cache1 = new Map([
  ['2026-08-05', [{ id: 'a5', task: '安保', project: '国寿', completed: true }]],
  ['2026-08-06', [{ id: 'a6', task: '安保', project: '国寿', completed: true }]],
]);
const tCancel = { id: 'a6', task: '安保', project: '国寿', completed: false };
const synced1 = syncCopies(cache1, tCancel, null);
assert(synced1.includes('2026-08-05:a5'), '取消勾选 → 同步其他文件同名副本');
assert(cache1.get('2026-08-05')[0].completed === false, '其他文件副本状态同步为 false');
// 场景2:改名后按旧身份键(prevKey)匹配
const cache2 = new Map([
  ['2026-08-05', [{ id: 'b5', task: '旧名字', project: '国寿', completed: true }]],
  ['2026-08-06', [{ id: 'b6', task: '旧名字', project: '国寿', completed: true }]],
]);
const tRenamed = { id: 'b6', task: '新名字', project: '国寿', completed: true };
const synced2 = syncCopies(cache2, tRenamed, '旧名字|国寿');
assert(synced2.includes('2026-08-05:b5'), '改名后 → 按旧身份键匹配并同步');
assert(cache2.get('2026-08-05')[0].task === '新名字', '旧副本任务名同步为新名字');
// 场景3:改项目后按 id 匹配同步(同 id 副本直接同步,旧身份键兜底)
const cache3 = new Map([
  ['2026-08-05', [{ id: 'c5', task: '沟通', project: '旧项目', completed: false }]],
]);
const tProjChanged = { id: 'c5', task: '沟通', project: '新项目', completed: false };
const synced3 = syncCopies(cache3, tProjChanged, '沟通|旧项目');
assert(synced3.includes('2026-08-05:c5') && cache3.get('2026-08-05')[0].project === '新项目', '改项目 → 同 id 副本同步为新项目');
// 场景4:无 prevKey 且改名 → 旧副本匹配不到(说明需要 prevKey)
const cache4 = new Map([
  ['2026-08-05', [{ id: 'd5', task: '旧名', project: '国寿', completed: true }]],
]);
const tRenamedNoKey = { id: 'd6', task: '新名', project: '国寿', completed: true };
const synced4 = syncCopies(cache4, tRenamedNoKey, null);
assert(synced4.length === 0, '无 prevKey 改名 → 旧副本不匹配(prevKey 是必要参数)');

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
