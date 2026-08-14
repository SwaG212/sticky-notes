// 紧凑时间选择器 DOM 集成测试
// 运行: node_modules\electron\dist\electron.exe tests\test_time_picker_dom.js
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
      id: 'time-picker-task', task: '验证时间选择器', project: '测试项目', completed: false,
      createdAt: new Date().toISOString(), completedAt: null, alarmTime: '14:30',
      dueDate: '${today}', sortOrder: 0
    }];
    state.activeSheet = 'all';
    renderTasks();
    document.querySelector('[data-id="time-picker-task"] .task-alarm').click();
  `);
  await wait(60);

  const mainPicker = JSON.parse(await run(`(() => {
    const picker = document.querySelector('.time-picker');
    const appRect = document.querySelector('#app').getBoundingClientRect();
    const rect = picker.getBoundingClientRect();
    const cols = picker.querySelector('.tp-cols').getBoundingClientRect();
    const actions = picker.querySelector('.tp-actions').getBoundingClientRect();
    const labels = [...picker.querySelectorAll('.tp-actions button')].map(x => x.textContent.trim());
    const clearStyle = getComputedStyle(picker.querySelector('.tp-clear'));
    const saveStyle = getComputedStyle(picker.querySelector('.tp-save'));
    return JSON.stringify({
      exists: !!picker,
      width: rect.width,
      height: rect.height,
      inside: rect.left >= 8 && rect.right <= appRect.right - 8,
      below: picker.classList.contains('tp-place-below'),
      actionsBelow: actions.top >= cols.bottom - 0.5,
      labels,
      hours: picker.querySelectorAll('#tp-hour .tp-opt').length,
      minutes: picker.querySelectorAll('#tp-min .tp-opt').length,
      selectedHour: picker.querySelector('#tp-hour .tp-opt.active')?.textContent,
      selectedMinute: picker.querySelector('#tp-min .tp-opt.active')?.textContent,
      optionUserSelect: getComputedStyle(picker.querySelector('.tp-opt')).userSelect,
      clearColor: clearStyle.color,
      saveColor: saveStyle.color,
      clearBg: clearStyle.backgroundColor,
      saveBg: saveStyle.backgroundColor,
      hourScrollbar: getComputedStyle(picker.querySelector('#tp-hour'), '::-webkit-scrollbar').display,
      minuteScrollbar: getComputedStyle(picker.querySelector('#tp-min'), '::-webkit-scrollbar').display,
      scrim: !!document.querySelector('.time-picker-scrim'),
      scrimBg: getComputedStyle(document.querySelector('.time-picker-scrim')).backgroundColor,
      shadow: getComputedStyle(picker).boxShadow,
    });
  })()`));
  assert(mainPicker.exists && mainPicker.width <= 120.5 && mainPicker.height <= 100.5, '时间选择器缩短为 120×100px 紧凑尺寸');
  assert(mainPicker.inside && mainPicker.below, '空间充足时从下方展开并保持在应用边界内');
  assert(mainPicker.actionsBelow && mainPicker.labels.join(',') === '清除,保存', '底部操作顺序为清除、保存');
  assert(mainPicker.clearColor === mainPicker.saveColor && mainPicker.clearBg === mainPicker.saveBg, '清除与保存按钮默认样式一致');
  assert(mainPicker.hours === 24 && mainPicker.minutes === 60, '保留小时与分钟完整上下滚动列表');
  assert(mainPicker.selectedHour === '14' && mainPicker.selectedMinute === '30', '打开后原时间保持选中并居中');
  assert(mainPicker.optionUserSelect === 'none', '时间数字禁止鼠标划选');
  assert(mainPicker.hourScrollbar === 'none' && mainPicker.minuteScrollbar === 'none', '小时与分钟滚动条保持隐藏');
  assert(mainPicker.scrim && mainPicker.scrimBg !== 'rgba(0, 0, 0, 0)' && mainPicker.shadow !== 'none', '遮罩与强化阴影和日期选择器保持一致');

  const hoverRules = JSON.parse(await run(`(() => {
    const rules = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]);
    const read = selector => {
      const rule = rules.find(item => item.selectorText === selector);
      return rule ? { color: rule.style.color, background: rule.style.background } : null;
    };
    return JSON.stringify({
      clear: read('.tp-clear:hover'),
      save: read('.tp-save:hover'),
      calendarClear: read('.dp-clear-btn:hover'),
    });
  })()`));
  assert(hoverRules.clear?.color === 'var(--danger)' && hoverRules.clear.background === hoverRules.calendarClear?.background, '清除悬停状态与日期选择器一致');
  assert(hoverRules.save?.color === 'var(--accent)' && hoverRules.save.background === 'var(--bg-input)', '保存悬停时文字变为紫色');

  await run(`
    [...document.querySelectorAll('#tp-hour .tp-opt')].find(x => x.textContent === '15').click();
    [...document.querySelectorAll('#tp-min .tp-opt')].find(x => x.textContent === '45').click();
    document.querySelector('.time-picker .tp-save').click();
  `);
  await wait(80);
  const saved = JSON.parse(await run(`JSON.stringify({
    alarmTime: state.tasks[0].alarmTime,
    pickerOpen: !!document.querySelector('.time-picker'),
    scrimOpen: !!document.querySelector('.time-picker-scrim')
  })`));
  assert(saved.alarmTime === '15:45' && !saved.pickerOpen && !saved.scrimOpen, '保存时间后同步关闭选择器和遮罩');

  const toggledClosed = await run(`(() => {
    const anchor = document.querySelector('[data-id="time-picker-task"] .task-alarm');
    anchor.click();
    const opened = !!document.querySelector('.time-picker');
    anchor.click();
    return opened && !document.querySelector('.time-picker');
  })()`);
  assert(toggledClosed, '再次点击同一个时间入口可直接收起');

  const fallbackAbove = await run(`(() => {
    const row = document.createElement('div');
    row.className = 'task-item';
    row.style.cssText = 'position:absolute;right:8px;bottom:8px;width:80px;height:30px;';
    const anchor = document.createElement('span');
    anchor.className = 'task-alarm';
    row.appendChild(anchor);
    document.querySelector('#app').appendChild(row);
    openTimePicker(anchor, 0);
    const isAbove = !document.querySelector('.time-picker').classList.contains('tp-place-below');
    closeActivePicker();
    row.remove();
    return isAbove;
  })()`);
  assert(fallbackAbove, '下方空间不足时自动翻转到上方');

  await run(`(async () => {
    state.calendarDayDate = '${today}';
    await renderDayTasks(false, false);
    document.querySelector('#cal-day-list .cal-day-task-item .task-alarm').click();
  })()`);
  await wait(60);
  const dayPicker = JSON.parse(await run(`JSON.stringify({
    picker: !!document.querySelector('.time-picker'),
    row: !!document.querySelector('#cal-day-list .cal-day-task-item'),
    labels: [...document.querySelectorAll('.time-picker .tp-actions button')].map(x => x.textContent.trim()).join(',')
  })`));
  assert(dayPicker.row && dayPicker.picker && dayPicker.labels === '清除,保存', '日视图复用同一紧凑时间选择器');

  await run(`document.querySelector('.time-picker .tp-clear').click()`);
  await wait(80);
  const cleared = JSON.parse(await run(`JSON.stringify({
    alarmTime: state.tasks[0].alarmTime,
    pickerOpen: !!document.querySelector('.time-picker'),
    scrimOpen: !!document.querySelector('.time-picker-scrim')
  })`));
  assert(cleared.alarmTime === null && !cleared.pickerOpen && !cleared.scrimOpen, '日视图清除时间后同步关闭选择器和遮罩');

  const currentTimeDefault = JSON.parse(await run(`(() => {
    const now = new Date();
    const expected = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    document.querySelector('#cal-day-list .cal-day-task-item .task-alarm').click();
    const picker = document.querySelector('.time-picker');
    const [expectedH, expectedM] = expected.split(':');
    const hourCol = picker.querySelector('#tp-hour');
    const minuteCol = picker.querySelector('#tp-min');
    const hourTarget = [...hourCol.children].find(el => el.textContent === expectedH);
    const minuteTarget = [...minuteCol.children].find(el => el.textContent === expectedM);
    const isVisible = (target, col) => {
      const targetRect = target.getBoundingClientRect();
      const colRect = col.getBoundingClientRect();
      return targetRect.bottom > colRect.top && targetRect.top < colRect.bottom;
    };
    const currentVisible = isVisible(hourTarget, hourCol) && isVisible(minuteTarget, minuteCol);
    const hasActive = !!picker.querySelector('.tp-opt.active');
    const clearDisabled = picker.querySelector('.tp-clear').disabled;
    closeActivePicker();
    return JSON.stringify({ currentVisible, hasActive, clearDisabled });
  })()`));
  assert(currentTimeDefault.currentVisible, '未设置提醒时打开选择器直接显示当前时间');
  assert(!currentTimeDefault.hasActive, '当前时间仅用于定位，不显示紫色选中态');
  assert(currentTimeDefault.clearDisabled, '显示当前时间不会误判为已有提醒');

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  await win.close();
  app.exit(failed ? 1 : 0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
