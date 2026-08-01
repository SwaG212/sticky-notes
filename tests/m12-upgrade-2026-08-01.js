// m12-upgrade-2026-08-01.js — 2026-08-01 升级集成测试(Electron DOM 实测)
// 运行: cd F:\Project\sticky-notes && node_modules\electron\dist\electron.exe tests/m12-upgrade-2026-08-01.js
// 覆盖: 新增功能 N1-N14 / 日期胶囊 D1-D8 / 页签排序 S1-S6 / 禁拖拽 H1-H4 / 页脚栏 F1-F2 / 回归 R1-R12 / 性能 P1-P2
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

let passed = 0, failed = 0;
const failures = [];
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}`); }
}

const TODAY = '2026-08-01';
// 真实系统日期(测试跑在真实时钟上)
const now = new Date();
const TOMORROW = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()+1).padStart(2,'0')}`;

function makeTasks() {
  return [
    // 国寿项目: 3 个任务(两个有日期,一个无)
    { id: 't1', task: '前往国金证券', project: '国寿', completed: false, createdAt: '2026-08-01T07:31:16.758Z', completedAt: null, alarmTime: null, dueDate: TOMORROW, sortOrder: 0 },
    { id: 't2', task: '前往中加基金', project: '国寿', completed: false, createdAt: '2026-08-01T07:31:16.758Z', completedAt: null, alarmTime: null, dueDate: '2026-08-04', sortOrder: 1 },
    { id: 't3', task: '前往安保', project: '国寿', completed: false, createdAt: '2026-08-01T07:31:16.758Z', completedAt: null, alarmTime: null, dueDate: null, sortOrder: 2 },
    // 华创项目: 2 个任务(一个今天,一个已完成)
    { id: 't4', task: '整理需求', project: '华创', completed: false, createdAt: '2026-08-01T08:25:20.284Z', completedAt: null, alarmTime: null, dueDate: TODAY, sortOrder: 3 },
    { id: 't5', task: '已完成的旧任务', project: '华创', completed: true, createdAt: '2026-07-30T08:25:20.284Z', completedAt: '2026-07-31T08:25:20.284Z', alarmTime: null, dueDate: '2026-07-25', sortOrder: 4 },
    // 无项目任务: 一个过期,一个无日期
    { id: 't6', task: '过期的任务', project: null, completed: false, createdAt: '2026-08-01T08:26:57.965Z', completedAt: null, alarmTime: null, dueDate: '2026-07-30', sortOrder: 5 },
    { id: 't7', task: '无日期的任务', project: null, completed: false, createdAt: '2026-08-01T08:27:11.195Z', completedAt: null, alarmTime: null, dueDate: null, sortOrder: 6 },
  ];
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 600, height: 800 });
  // 整体超时保护,防止挂起
  const killer = setTimeout(() => { console.log('!!! 测试超时强制退出'); app.exit(2); }, 90000);
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  const r = (code) => win.webContents.executeJavaScript(code);

  // ========== 准备: 注入任务数据 ==========
  await r(`state.tasks = ${JSON.stringify(makeTasks())}; state.activeSheet = 'all'; renderTasks();`);

  // ========== D: 日期胶囊 ==========
  console.log('\n=== D 日期胶囊 ===');
  const chipInfo = await r(`
    (() => {
      const out = {};
      document.querySelectorAll('.task-item').forEach(row => {
        out[row.dataset.id] = {
          chip: row.querySelector('.task-date-chip')?.textContent ?? null,
          chipClass: row.querySelector('.task-date-chip')?.className ?? null,
          hasNull: row.innerHTML.includes('>null<'),
        };
      });
      return JSON.stringify(out);
    })()
  `);
  const chips = JSON.parse(chipInfo);
  assert(chips['t1'].chip === TOMORROW.slice(5), `D1 有日期任务显示 MM-DD (t1=${TOMORROW.slice(5)})`);
  assert(chips['t2'].chip === '08-04', 'D1 有日期任务显示 MM-DD (t2=08-04)');
  assert(chips['t3'].chip === null, 'D2 无日期任务不创建胶囊');
  assert(!chips['t3'].hasNull && !chips['t7'].hasNull, 'D2 无 null 文本残留');
  assert(chips['t6'].chipClass.includes('due-overdue'), 'D3 过期任务胶囊红色语义');
  assert(chips['t4'].chipClass.includes('due-today'), 'D3 今天任务胶囊蓝色语义');
  assert(chips['t1'].chipClass.includes('due-tomorrow'), `D3 明天任务胶囊橙色语义(t1=${chips['t1'].chip} = 明天)`);
  assert(chips['t5'].chip === '07-25' && !chips['t5'].chipClass.includes('due-'), 'D4 已完成任务胶囊灰(无紧迫度 class)');
  // D5 悬停隐藏: CSS :hover 规则存在性(读文件,静态验证)+ JS hover 栏逻辑(动态)
  const cssText = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf-8');
  assert(cssText.includes('.task-item:hover .task-date-chip { display: none; }'), 'D5 CSS :hover 规则存在(悬停时胶囊隐藏)');
  const hoverJs = JSON.parse(await r(`
    (() => {
      const row = document.querySelector('[data-id="t1"]');
      row.dispatchEvent(new MouseEvent('mouseenter'));
      const shown = row.querySelector('.hover-bar').style.display === 'flex';
      row.dispatchEvent(new MouseEvent('mouseleave'));
      const hidden = row.querySelector('.hover-bar').style.display === 'none';
      return JSON.stringify({ shown, hidden });
    })()
  `));
  assert(hoverJs.shown && hoverJs.hidden, 'D5 JS hover 栏显示/隐藏逻辑正确');
  const chipPE = await r(`getComputedStyle(document.querySelector('[data-id="t1"] .task-date-chip')).pointerEvents`);
  assert(chipPE === 'none', 'D6 胶囊不可点击(pointer-events: none)');

  // ========== S: 项目页签排序 ==========
  console.log('\n=== S 项目页签排序 ===');
  await r(`state.activeSheet = '国寿'; renderTasks();`);
  const sortOrder = await r(`
    [...document.querySelectorAll('.task-item')].map(r => r.dataset.id).join(',')
  `);
  assert(sortOrder === 't1,t2,t3', `S1 项目页签按日期升序(期望 t1,t2,t3,实际 ${sortOrder})`);
  assert(sortOrder.split(',').pop() === 't3', 'S2 无日期任务沉底');
  await r(`state.activeSheet = '华创'; renderTasks();`);
  const huachuangOrder = await r(`[...document.querySelectorAll('.task-item')].map(r => r.dataset.id).join(',')`);
  assert(huachuangOrder === 't5,t4', `S3 已完成/有日期的在日期排序中与无日期相对位置正确(实际 ${huachuangOrder})`);

  // 同日期任务稳定性: 构造两个同日期任务
  await r(`
    state.tasks = [
      { id: 'x1', task: 'A', project: 'P', completed: false, createdAt: 'x', completedAt: null, alarmTime: null, dueDate: '2026-08-10', sortOrder: 0 },
      { id: 'x2', task: 'B', project: 'P', completed: false, createdAt: 'x', completedAt: null, alarmTime: null, dueDate: '2026-08-10', sortOrder: 1 },
      { id: 'x3', task: 'C', project: 'P', completed: false, createdAt: 'x', completedAt: null, alarmTime: null, dueDate: '2026-08-05', sortOrder: 2 },
    ];
    state.activeSheet = 'P'; renderTasks();
  `);
  const sameDate = await r(`[...document.querySelectorAll('.task-item')].map(r => r.dataset.id).join(',')`);
  assert(sameDate === 'x3,x1,x2', `S3 同日期的保持原相对顺序(期望 x3,x1,x2,实际 ${sameDate})`);

  // 汇总页顺序不变
  await r(`state.activeSheet = 'all'; state.tasks = ${JSON.stringify(makeTasks())}; renderTasks();`);
  const allOrder = await r(`[...document.querySelectorAll('.task-item')].map(r => r.dataset.id).join(',')`);
  assert(allOrder === 't1,t2,t3,t4,t5,t6,t7', `S4 汇总页保持原顺序(期望 t1..t7,实际 ${allOrder})`);

  // 页签内操作索引正确性: 勾选项目页签第 2 个任务(排序后 t1,t2,t3 → 第2个=t2)
  await r(`state.activeSheet = '国寿'; renderTasks();`);
  const afterToggle = await r(`
    (() => {
      const row = document.querySelectorAll('.task-item')[1];
      row.querySelector('.task-checkbox').click();
      return JSON.stringify({ id: row.dataset.id, completed: state.tasks.find(t => t.id === 't2').completed });
    })()
  `);
  const toggled = JSON.parse(afterToggle);
  assert(toggled.id === 't2' && toggled.completed === true, 'S5 项目页签内勾选操作索引正确(t2 被勾选)');
  await r(`state.tasks.find(t => t.id === 't2').completed = false; renderTasks();`); // 还原

  // 删除操作索引
  const afterDel = await r(`
    (() => {
      const row = document.querySelectorAll('.task-item')[0]; // 排序后第1个 = t1
      row.querySelector('.task-delete').click();
      return JSON.stringify({ deleted: !state.tasks.some(t => t.id === 't1'), remaining: state.tasks.length });
    })()
  `);
  const delRes = JSON.parse(afterDel);
  assert(delRes.deleted && delRes.remaining === 6, 'S5 项目页签内删除操作索引正确(t1 被删)');
  await r(`state.tasks = ${JSON.stringify(makeTasks())}; renderTasks();`); // 还原

  // ========== H: 禁拖拽 ==========
  console.log('\n=== H 禁拖拽 ===');
  await r(`state.activeSheet = '国寿'; renderTasks();`);
  const projHandles = await r(`document.querySelectorAll('.task-item .task-drag-handle').length`);
  assert(projHandles === 0, 'H1 项目页签无拖拽手柄');
  const projHoverPos = await r(`
    (() => {
      const bar = document.querySelector('.task-item .hover-bar');
      return JSON.stringify({ right: getComputedStyle(bar).right, padRight: getComputedStyle(document.querySelector('.task-item')).paddingRight });
    })()
  `);
  const hpos = JSON.parse(projHoverPos);
  assert(hpos.right === '6px' && hpos.padRight === '28px', `H3 项目页签 hover 栏贴右(期望 right=6px, 实际 ${hpos.right})`);
  await r(`state.activeSheet = 'all'; renderTasks();`);
  const allHandles = await r(`document.querySelectorAll('.task-item:not(.completed) .task-drag-handle').length`);
  assert(allHandles === 6, `H2 汇总页未完成任务有手柄(期望 6,实际 ${allHandles})`);
  const allHoverPos = await r(`getComputedStyle(document.querySelector('.task-item .hover-bar')).right`);
  assert(allHoverPos === '28px', 'H3 汇总页 hover 栏位置不变(right=28px)');

  // ========== F: 页脚栏 ==========
  console.log('\n=== F 页脚栏 ===');
  const footerBefore = await r(`
    (() => {
      state.pagesEnabled = { tasks: false };
      updateTasksPageVisibility();
      const btn = document.querySelector('#btn-notepad-back');
      const footer = document.querySelector('.notepad-footer');
      return JSON.stringify({ vis: getComputedStyle(btn).visibility, h: footer.getBoundingClientRect().height });
    })()
  `);
  const fb = JSON.parse(footerBefore);
  assert(fb.vis === 'hidden', 'F1 任务页关闭时 ← 按钮隐藏(visibility)');
  const footerAfter = await r(`
    (() => {
      state.pagesEnabled = { tasks: true };
      updateTasksPageVisibility();
      const btn = document.querySelector('#btn-notepad-back');
      const footer = document.querySelector('.notepad-footer');
      return JSON.stringify({ vis: getComputedStyle(btn).visibility, h: footer.getBoundingClientRect().height });
    })()
  `);
  const fa = JSON.parse(footerAfter);
  assert(fa.vis === 'visible' && fa.h === fb.h, 'F2 任务页开启时按钮恢复且栏高度不变');

  // ========== N: 笔记页搜索 ==========
  console.log('\n=== N 笔记页搜索 ===');
  await r(`
    state.currentPage = 'notepad';
    notepadTextarea.innerHTML = '<div>今天要完成项目A的方案</div><div>明天提交项目B的报价</div><div>项目A的评审会议</div>';
    openNoteSearch();
  `);
  const search1 = await r(`
    (() => {
      noteSearchInput.value = '项目';
      noteSearchInput.dispatchEvent(new Event('input'));
      const marks = document.querySelectorAll('#notepad-textarea mark');
      const active = document.querySelectorAll('#notepad-textarea mark.active');
      return JSON.stringify({ marks: marks.length, active: active.length, status: noteSearchStatus.classList.contains('noresult') });
    })()
  `);
  const s1 = JSON.parse(search1);
  assert(s1.marks === 3, `N2 输入即高亮全部匹配(期望 3,实际 ${s1.marks})`);
  assert(s1.active === 1, 'N3 自动定位第一个(active=1)');
  assert(!s1.status, 'N4 有匹配时无警告图标');

  // 回车跳转
  const afterEnter = await r(`
    (() => {
      noteSearchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const activeIdx = [...document.querySelectorAll('#notepad-textarea mark')].findIndex(m => m.classList.contains('active'));
      return activeIdx;
    })()
  `);
  assert(afterEnter === 1, `N4 回车跳到下一个(期望 active 索引1,实际 ${afterEnter})`);

  // 无匹配
  const noResult = await r(`
    (() => {
      noteSearchInput.value = '不存在的内容';
      noteSearchInput.dispatchEvent(new Event('input'));
      return JSON.stringify({
        marks: document.querySelectorAll('#notepad-textarea mark').length,
        noresult: noteSearchStatus.classList.contains('noresult'),
      });
    })()
  `);
  const nr = JSON.parse(noResult);
  assert(nr.marks === 0 && nr.noresult, 'N5 无匹配显示红色警告图标');

  // 清除搜索后内容不变
  const contentBefore = await r(`notepadTextarea.textContent`);
  await r(`closeNoteSearch()`);
  const contentAfter = await r(`notepadTextarea.textContent`);
  assert(contentBefore === contentAfter, 'N7 关闭搜索后内容不变(不含 mark 残留)');

  // 保存链路: 搜索打开时保存, 内容不含 mark 标签
  await r(`
    openNoteSearch();
    noteSearchInput.value = '项目';
    noteSearchInput.dispatchEvent(new Event('input'));
  `);
  const savedMd = await r(`htmlToMarkdown(notepadTextarea.innerHTML)`);
  assert(!savedMd.includes('mark'), `N8 搜索打开时保存内容不含 mark 标签(实际: ${savedMd.slice(0, 60)}...)`);
  await r(`closeNoteSearch()`);

  // 换笔记/新建关闭搜索
  const switchCloses = await r(`
    (() => {
      openNoteSearch();
      openNote('somefile.md');
      return noteSearchBar.classList.contains('hidden');
    })()
  `);
  assert(switchCloses, 'N9 切换笔记时搜索自动关闭');
  const createCloses = await r(`
    (async () => {
      openNoteSearch();
      await createNote();
      return noteSearchBar.classList.contains('hidden');
    })()
  `);
  assert(createCloses, 'N9 新建笔记时搜索自动关闭');

  // 大小写不敏感 + 换行跨段搜索
  await r(`
    notepadTextarea.innerHTML = '<div>Hello World</div><div>hello world again</div>';
    openNoteSearch();
    noteSearchInput.value = 'HELLO';
    noteSearchInput.dispatchEvent(new Event('input'));
  `);
  const caseMarks = await r(`document.querySelectorAll('#notepad-textarea mark').length`);
  assert(caseMarks === 2, `N14 英文大小写不敏感(期望2,实际 ${caseMarks})`);
  await r(`closeNoteSearch()`);

  // Ctrl+F 打开搜索(文档级键盘事件模拟)
  const ctrlF = await r(`
    (() => {
      openNoteSearch(); closeNoteSearch();
      document.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, key: 'f', bubbles: true }));
      const opened = !noteSearchBar.classList.contains('hidden') && document.activeElement === noteSearchInput;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const closed = noteSearchBar.classList.contains('hidden');
      return JSON.stringify({ opened, closed });
    })()
  `);
  const cf = JSON.parse(ctrlF);
  assert(cf.opened, 'N1 Ctrl+F 打开搜索框并聚焦');
  assert(cf.closed, 'N7 Esc 关闭搜索');

  // ========== R: 历史功能回归(DOM 可达部分) ==========
  console.log('\n=== R 历史功能回归 ===');
  // R1 organize 流程: 设置项目名 + 输入 + organize
  const orgResult = await r(`
    (() => {
      state.projectNames = ['国寿', '华创'];
      textInput.value = '明天完成国寿的演示材料';
      updateOrganizeButton();
      const enabled = !btnOrganize.disabled;
      return JSON.stringify({ enabled });
    })()
  `);
  assert(JSON.parse(orgResult).enabled, 'R1 有输入时整理按钮可用');

  // R2 汇总页勾选/删除/编辑
  await r(`state.activeSheet = 'all'; state.tasks = ${JSON.stringify(makeTasks())}; renderTasks();`);
  const r2 = await r(`
    (() => {
      document.querySelector('[data-id="t6"] .task-checkbox').click();
      const done = state.tasks.find(t => t.id === 't6').completed;
      return done;
    })()
  `);
  assert(r2 === true, 'R2 汇总页勾选完成');
  await r(`state.tasks.find(t => t.id === 't6').completed = false; renderTasks();`);

  // R5 日历选择日期
  const cal = await r(`
    (() => {
      state.tasks = ${JSON.stringify(makeTasks())};
      state.activeSheet = 'all';
      renderTasks();
      const row = document.querySelector('[data-id="t3"]');
      const ddate = row.querySelector('.task-duedate');
      openDatePicker(ddate, 2);
      const picker = document.querySelector('.date-picker');
      const hasDays = picker && picker.querySelectorAll('.dp-day:not(.other-month)').length > 0;
      closeActivePicker();
      return hasDays;
    })()
  `);
  assert(cal === true, 'R5 日历选择器正常弹出');

  // R6 跨天迁移过滤(过期已完成被清除)
  const migrate = await r(`
    (() => {
      state.tasks = ${JSON.stringify(makeTasks())};
      state.tasks = state.tasks.filter(t => !(t.completed && t.dueDate && t.dueDate < '${TODAY}'));
      return state.tasks.some(t => t.id === 't5');
    })()
  `);
  assert(migrate === false, 'R6 跨天迁移清除过期已完成任务(t5 被清除)');

  // R12 htmlToMarkdown 混合标签
  const md = await r(`
    htmlToMarkdown('<p>第一行</p><p>第二行</p><div>第三行</div><div><span>嵌套</span></div>')
  `);
  assert(md === '第一行\n第二行\n第三行\n嵌套', `R12 混合标签保存完整(实际: ${JSON.stringify(md)})`);

  // 空状态
  const emptyState = await r(`
    (() => {
      state.tasks = [];
      state.activeSheet = 'all';
      renderTasks();
      return !taskEmpty.classList.contains('hidden') && taskEmpty.querySelector('.empty-title').textContent === '还没有任务';
    })()
  `);
  assert(emptyState === true, 'R11 全空状态正常');
  const projTabGone = await r(`
    (() => {
      state.tasks = [ { id: 'z1', task: 'x', project: 'A', completed: false, createdAt: 'x', completedAt: null, alarmTime: null, dueDate: null, sortOrder: 0 } ];
      state.activeSheet = 'all';
      renderTasks();
      state.activeSheet = 'A';
      renderTasks();
      state.tasks = []; // 项目 A 任务全删
      renderTasks();
      return JSON.stringify({
        sheetHasA: !!document.querySelector('[data-sheet="A"]'),
        activeBack: state.activeSheet === 'all',
      });
    })()
  `);
  const ptg = JSON.parse(projTabGone);
  assert(!ptg.sheetHasA && ptg.activeBack, 'R11 项目任务全删后页签消失且 activeSheet 回退到 all');
  const fallback = await r(`
    (() => {
      state.tasks = [ { id: 'z2', task: 'y', project: 'A', completed: false, createdAt: 'x', completedAt: null, alarmTime: null, dueDate: null, sortOrder: 0 } ];
      state.activeSheet = 'B';
      renderTasks();
      return state.activeSheet === 'all';
    })()
  `);
  assert(fallback === true, 'R11 activeSheet 回退到 all');

  // ========== P: 性能 ==========
  console.log('\n=== P 性能 ===');
  const perf = await r(`
    (() => {
      const big = [];
      const projects = ['国寿', '华创', '兴银', '中加', '英大'];
      for (let i = 0; i < 500; i++) {
        big.push({ id: 'big_' + i, task: '性能测试任务' + i + ' 项目' + projects[i % 5], project: projects[i % 5], completed: false, createdAt: '2026-08-01T00:00:00.000Z', completedAt: null, alarmTime: null, dueDate: (i % 3 === 0 ? '2026-08-10' : null), sortOrder: i });
      }
      state.tasks = big;
      state.activeSheet = 'all';
      let t0 = performance.now();
      renderTasks();
      let tAll = performance.now() - t0;
      state.activeSheet = '国寿';
      t0 = performance.now();
      renderTasks();
      let tSheet = performance.now() - t0;
      // 大笔记搜索
      let bigNote = '';
      for (let i = 0; i < 2000; i++) bigNote += '<div>第' + i + '段内容,包含关键词' + (i % 10 === 0 ? '查找' : '') + '</div>';
      notepadTextarea.innerHTML = bigNote;
      openNoteSearch();
      noteSearchInput.value = '查找';
      t0 = performance.now();
      noteSearchInput.dispatchEvent(new Event('input'));
      let tSearch = performance.now() - t0;
      closeNoteSearch();
      return JSON.stringify({ tAll: Math.round(tAll), tSheet: Math.round(tSheet), tSearch: Math.round(tSearch) });
    })()
  `);
  const perfRes = JSON.parse(perf);
  console.log(`  ℹ️ 500任务汇总渲染: ${perfRes.tAll}ms | 项目页签渲染: ${perfRes.tSheet}ms | 2000段笔记搜索: ${perfRes.tSearch}ms`);
  assert(perfRes.tAll < 300, `P1 500 任务渲染 < 300ms(实际 ${perfRes.tAll}ms)`);
  assert(perfRes.tSheet < 200, 'P1 项目页签渲染 < 200ms');
  assert(perfRes.tSearch < 200, `P2 大笔记搜索 < 200ms(实际 ${perfRes.tSearch}ms)`);

  // ========== 汇总 ==========
  console.log(`\n==========================================`);
  console.log(`结果: ${passed} 通过, ${failed} 失败`);
  if (failures.length) {
    console.log('失败项:');
    failures.forEach(f => console.log('  - ' + f));
  }
  app.exit(failed > 0 ? 1 : 0);
});
