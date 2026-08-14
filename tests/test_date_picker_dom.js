// 紧凑周日期选择器 DOM 集成测试
// 运行: node_modules\electron\dist\electron.exe tests\test_date_picker_dom.js
const { app, BrowserWindow } = require('electron');
const path = require('path');

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 360, height: 500 });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  const run = (code) => win.webContents.executeJavaScript(code);
  const today = await run('getToday()');

  await run(`
    state.tasks = [{
      id: 'picker-task', task: '验证日期选择器', project: '测试项目', completed: false,
      createdAt: new Date().toISOString(), completedAt: null, alarmTime: null,
      dueDate: '${today}', sortOrder: 0
    }];
    state.activeSheet = 'all';
    renderTasks();
    document.querySelector('[data-id="picker-task"] .task-duedate').click();
  `);
  await wait(40);

  const actionBarLayout = JSON.parse(await run(`(() => {
    state.showCalendar = true;
    state.showDailyReport = true;
    applyCalendarVisibility();
    applyDailyReportVisibility();
    dailyReportHint.textContent = '日报内容已复制至剪切板';
    dailyReportHint.classList.add('show');
    const bar = inputActions.getBoundingClientRect();
    const left = document.querySelector('.input-left-group').getBoundingClientRect();
    const right = document.querySelector('.input-buttons').getBoundingClientRect();
    return JSON.stringify({
      inside: right.right <= bar.right + 0.5,
      separated: left.right <= right.left + 0.5,
      calendarVisible: getComputedStyle(btnCalendar).display !== 'none',
      reportVisible: getComputedStyle(btnDailyReport).display !== 'none',
    });
  })()`));
  assert(actionBarLayout.calendarVisible && actionBarLayout.reportVisible, '日历和日报按钮可同时显示');
  assert(actionBarLayout.inside && actionBarLayout.separated, '长日报提示不会把重排和右滑按钮挤出屏幕');
  await run(`dailyReportHint.classList.remove('show'); dailyReportHint.textContent = '';`);

  console.log('\n--- 任务列表日期选择器 ---');
  const mainPicker = JSON.parse(await run(`(() => {
    const picker = document.querySelector('.date-picker');
    const rect = picker.getBoundingClientRect();
    return JSON.stringify({
      exists: !!picker,
      width: rect.width,
      height: rect.height,
      inside: rect.left >= 8 && rect.right <= document.querySelector('#app').getBoundingClientRect().right - 8,
      below: picker.classList.contains('dp-place-below'),
      scrim: !!document.querySelector('.date-picker-scrim'),
      scrimBg: getComputedStyle(document.querySelector('.date-picker-scrim')).backgroundColor,
      shadow: getComputedStyle(picker).boxShadow,
      labels: [...picker.querySelectorAll('.dp-week-option')].map(x => x.textContent.trim()),
      weekdays: [...picker.querySelectorAll('.dp-weekday')].map(x => x.textContent.trim()).join(''),
      days: picker.querySelectorAll('.dp-date-option').length,
      clear: picker.querySelector('.dp-clear-btn')?.textContent.trim(),
      railGap: getComputedStyle(picker.querySelector('.dp-week-rail')).rowGap,
      dateBottomPadding: getComputedStyle(picker.querySelector('.dp-date-grid')).paddingBottom,
      clearHeight: picker.querySelector('.dp-clear-btn').getBoundingClientRect().height,
    });
  })()`));
  assert(mainPicker.exists, '任务列表可以打开新日期选择器');
  assert(mainPicker.width <= 336.5 && mainPicker.inside, '长方形选择器完整位于 360px 窗口内');
  assert(mainPicker.below, '下方空间充足时优先从任务行下方展开');
  assert(mainPicker.height <= 94.5 && mainPicker.railGap === '1px', '选择器高度与左侧按钮间隔已缩短');
  assert(mainPicker.dateBottomPadding === '1px' && mainPicker.clearHeight <= 24.5, '日期行下方空间与清除行高度已缩短');
  assert(mainPicker.scrim && mainPicker.scrimBg !== 'rgba(0, 0, 0, 0)' && mainPicker.shadow !== 'none', '遮罩和悬浮阴影将选择器与任务列表分层');
  assert(mainPicker.labels.join(',') === '上周,本周,下周', '默认左栏为上周/本周/下周');
  assert(mainPicker.weekdays === '日一二三四五六' && mainPicker.days === 7, '右侧按周日至周六横排 7 天');
  assert(mainPicker.clear === '清除', '右侧第三行提供清除按钮');

  const nextRailMotion = JSON.parse(await run(`(() => {
    document.querySelectorAll('.date-picker .dp-week-option')[2].click();
    const rail = document.querySelector('.date-picker .dp-week-rail');
    const option = rail.querySelector('.dp-week-option');
    return JSON.stringify({
      direction: rail.classList.contains('dp-scroll-next'),
      animationName: getComputedStyle(option).animationName,
    });
  })()`));
  await wait(200);
  const shiftedLabels = await run(`[...document.querySelectorAll('.date-picker .dp-week-option')].map(x => x.textContent.trim()).join(',')`);
  assert(shiftedLabels === '本周,下周,下下周', '选择下周后左栏自动向后滑动');
  assert(nextRailMotion.direction && nextRailMotion.animationName === 'dp-week-scroll-up', '选择下一周时左侧周按钮向上滚动');

  const prevRailMotion = JSON.parse(await run(`(() => {
    document.querySelectorAll('.date-picker .dp-week-option')[0].click();
    const rail = document.querySelector('.date-picker .dp-week-rail');
    const option = rail.querySelector('.dp-week-option');
    return JSON.stringify({
      direction: rail.classList.contains('dp-scroll-prev'),
      animationName: getComputedStyle(option).animationName,
    });
  })()`));
  assert(prevRailMotion.direction && prevRailMotion.animationName === 'dp-week-scroll-down', '选择上一周时左侧周按钮向下滚动');
  await wait(200);

  await run(`document.querySelectorAll('.date-picker .dp-week-option')[2].click()`);
  await wait(200);
  await run(`document.querySelectorAll('.date-picker .dp-week-option')[2].click(); document.querySelectorAll('.date-picker .dp-week-option')[2].click();`);
  await wait(200);
  const farMiddle = await run(`document.querySelector('.date-picker .dp-week-option.is-active').textContent.trim()`);
  assert(/^\d{4}-\d{4}$/.test(farMiddle), '远期周标签使用 0830-0905 格式');

  const fallbackAbove = await run(`(() => {
    closeActivePicker();
    const row = document.createElement('div');
    row.className = 'task-item';
    row.style.cssText = 'position:absolute;right:8px;bottom:8px;width:80px;height:30px;';
    const anchor = document.createElement('button');
    anchor.className = 'task-duedate';
    row.appendChild(anchor);
    document.querySelector('#app').appendChild(row);
    openDatePicker(anchor, 0);
    const isAbove = !document.querySelector('.date-picker').classList.contains('dp-place-below');
    closeActivePicker();
    row.remove();
    return isAbove;
  })()`);
  assert(fallbackAbove, '下方空间不足时自动翻转到任务行上方');

  console.log('\n--- 日视图日期选择器 ---');
  await run(`(async () => {
    closeActivePicker();
    state.tasks[0].dueDate = '${today}';
    state.calendarDayDate = '${today}';
    await renderDayTasks(false, false);
    document.querySelector('#cal-day-list .cal-day-task-item .task-duedate').click();
  })()`);
  await wait(60);
  const dayPicker = JSON.parse(await run(`(() => {
    const picker = document.querySelector('.date-picker');
    return JSON.stringify({
      exists: !!picker,
      row: !!document.querySelector('#cal-day-list .cal-day-task-item'),
      labels: [...picker.querySelectorAll('.dp-week-option')].map(x => x.textContent.trim()).join(','),
      days: picker.querySelectorAll('.dp-date-option').length,
    });
  })()`));
  assert(dayPicker.row && dayPicker.exists, '日视图任务行可以打开同一选择器');
  assert(dayPicker.labels === '上周,本周,下周' && dayPicker.days === 7, '日视图与任务列表结构一致');

  const chosenDate = await run(`(() => {
    document.querySelectorAll('.date-picker .dp-week-option')[2].click();
    const option = document.querySelectorAll('.date-picker .dp-date-option')[1];
    const date = option.dataset.date;
    option.click();
    return date;
  })()`);
  await wait(700);
  const committed = JSON.parse(await run(`JSON.stringify({
    dueDate: state.tasks[0].dueDate,
    pickerOpen: !!document.querySelector('.date-picker'),
    scrimOpen: !!document.querySelector('.date-picker-scrim')
  })`));
  assert(committed.dueDate === chosenDate, '日视图选择日期后同步更新任务日期');
  assert(!committed.pickerOpen && !committed.scrimOpen, '日视图选择日期后选择器和遮罩同步关闭');

  const dateProtection = JSON.parse(await run(`(async () => {
    updateOrganizeButton();
    const organizeBefore = !btnOrganize.disabled;
    openCalendar();
    const organizeDuring = btnOrganize.disabled;
    const organizeTransition = getComputedStyle(btnOrganize).transitionDuration;
    await new Promise(resolve => setTimeout(resolve, 360));
    const monthDay = document.querySelector('.cal-day');
    const monthUserSelect = monthDay ? getComputedStyle(monthDay).userSelect : null;
    await enterDayMode('${today}');
    await new Promise(resolve => setTimeout(resolve, 360));
    const weekDay = document.querySelector('.cal-week-day');
    const pickerProbe = document.createElement('button');
    pickerProbe.className = 'dp-date-option';
    document.body.appendChild(pickerProbe);
    const result = {
      organizeBefore,
      organizeDuring,
      organizeTransition,
      monthUserSelect,
      monthLabelUserSelect: getComputedStyle(document.querySelector('#cal-monthlabel')).userSelect,
      weekUserSelect: weekDay ? getComputedStyle(weekDay).userSelect : null,
      pickerUserSelect: getComputedStyle(pickerProbe).userSelect,
    };
    pickerProbe.remove();
    return JSON.stringify(result);
  })()`));
  assert(dateProtection.organizeBefore && dateProtection.organizeDuring, '打开日历时重排按钮沿用项目页签的置灰状态');
  assert(dateProtection.organizeTransition !== '0s', '打开日历时重排按钮保留原有过渡动画');
  assert(dateProtection.monthUserSelect === 'none', '月历中的每个日期禁止选中文字');
  assert(dateProtection.monthLabelUserSelect === 'none', '日历顶部年月标题禁止选中文字');
  assert(dateProtection.weekUserSelect === 'none', '日视图周栏中的每个日期禁止选中文字');
  assert(dateProtection.pickerUserSelect === 'none', '任务日期选择器中的每个日期禁止选中文字');

  const organizeAfterCalendar = await run(`(() => { closeCalendar(); return !btnOrganize.disabled; })()`);
  assert(organizeAfterCalendar, '关闭日历后重排按钮恢复可用状态');

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  await win.close();
  app.exit(failed ? 1 : 0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
