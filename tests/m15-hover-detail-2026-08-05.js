// m15-hover-detail-2026-08-05.js — 2026-08-05 悬停热区/日期胶囊/提示条/footer搜索 详细边界测试(Electron DOM 实测)
// 运行: cd F:\Project\sticky-notes && node_modules\electron\dist\electron.exe tests/m15-hover-detail-2026-08-05.js
// 覆盖: 热区精确边界 A1-A7 / 胶囊淡出动画 B1-B4 / 提示条与拖拽 C1-C2 / 选择器钉住联动 D1-D3 / footer 搜索 E1-E3 / DOM 结构 F1-F2
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

let passed = 0, failed = 0;
const failures = [];
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}`); }
}

const now = new Date();
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TOMORROW = fmt(new Date(now.getTime() + 86400000));
const PLUS5 = fmt(new Date(now.getTime() + 5 * 86400000));

function makeTasks() {
  return [
    { id: 't1', task: '前往国金证券', project: '国寿', completed: false, createdAt: '2026-08-01T07:31:16.758Z', completedAt: null, alarmTime: null, dueDate: TOMORROW, sortOrder: 0 },
    { id: 't2', task: '前往中加基金', project: '国寿', completed: false, createdAt: '2026-08-01T07:31:16.758Z', completedAt: null, alarmTime: null, dueDate: PLUS5, sortOrder: 1 },
    { id: 't3', task: '前往安保', project: '国寿', completed: false, createdAt: '2026-08-01T07:31:16.758Z', completedAt: null, alarmTime: null, dueDate: null, sortOrder: 2 },
    { id: 't7', task: '无日期的任务', project: null, completed: false, createdAt: '2026-08-01T08:27:11.195Z', completedAt: null, alarmTime: null, dueDate: null, sortOrder: 3 },
  ];
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 600, height: 800 });
  const killer = setTimeout(() => { console.log('!!! 测试超时强制退出'); app.exit(2); }, 90000);
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  const r = (code) => win.webContents.executeJavaScript(code);

  // 真实鼠标悬停 + 条件重试(窗口未激活时 sendInputEvent 可能被吞):移到目标后轮询 predicate
  async function realHover(x, y, predicate, tries = 4) {
    for (let i = 0; i < tries; i++) {
      win.show();
      win.focus();
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      await sleep(200);
      if (await predicate()) return true;
    }
    return false;
  }

  // ========== 准备: 注入任务数据 ==========
  await r(`state.tasks = ${JSON.stringify(makeTasks())}; state.activeSheet = 'all'; renderTasks();`);

  // ========== A: 热区精确边界(合成 mousemove,与真实 :hover 无关) ==========
  console.log('\n=== A 热区精确边界 ===');
  // 行右缘坐标: t1 行足够宽, 右缘 15px 热区 / 115px 保持范围
  const a1 = await r(`
    (() => {
      const row = document.querySelector('[data-id="t1"]');
      const bar = row.querySelector('.hover-bar');
      const rect = row.getBoundingClientRect();
      // 注意:MouseEvent clientX 是 long(整数),rect.right 可能为浮点(如 585.5),
      // 取整会偏移 0-1px,用 ceil/floor 保证取整后仍落在目标区间(热区/保持区/隐藏区)
      const right = rect.right;
      const out = {};
      // 清态:先移除可能残留的 visible
      row.dispatchEvent(new MouseEvent('mouseleave'));
      // A1: 热区外 1px(取整后仍 < right-15)不触发
      row.dispatchEvent(new MouseEvent('mousemove', { clientX: Math.floor(right) - 16, clientY: rect.top + 10 }));
      out.a1 = !bar.classList.contains('visible');
      // A2: 热区边界(取整后仍 >= right-15)触发
      row.dispatchEvent(new MouseEvent('mousemove', { clientX: Math.ceil(right) - 15, clientY: rect.top + 10 }));
      out.a2 = bar.classList.contains('visible');
      // A3: 显示后移入保持区(右缘 115px 内,取整后仍 >= right-115)不误隐藏
      row.dispatchEvent(new MouseEvent('mousemove', { clientX: Math.ceil(right) - 115, clientY: rect.top + 10 }));
      out.a3 = bar.classList.contains('visible');
      // A4: 保持区外 1px(取整后仍 < right-115)隐藏
      row.dispatchEvent(new MouseEvent('mousemove', { clientX: Math.floor(right) - 116, clientY: rect.top + 10 }));
      out.a4 = !bar.classList.contains('visible');
      // A5: 显示态下在保持区内移动(right-30,非热区)仍保持显示
      row.dispatchEvent(new MouseEvent('mousemove', { clientX: Math.ceil(right) - 5, clientY: rect.top + 10 }));
      out.a5a = bar.classList.contains('visible');
      row.dispatchEvent(new MouseEvent('mousemove', { clientX: Math.ceil(right) - 30, clientY: rect.top + 10 }));
      out.a5b = bar.classList.contains('visible');
      // A6: 行间独立: t1 保持显示, t2 行热区触发只影响 t2
      const rowB = document.querySelector('[data-id="t2"]');
      const barB = rowB.querySelector('.hover-bar');
      const rectB = rowB.getBoundingClientRect();
      rowB.dispatchEvent(new MouseEvent('mousemove', { clientX: Math.ceil(rectB.right) - 5, clientY: rectB.top + 10 }));
      out.a6b = barB.classList.contains('visible');
      // 还原 t2 隐藏
      rowB.dispatchEvent(new MouseEvent('mouseleave'));
      // A7: mouseleave 清态后重进热区可再触发
      row.dispatchEvent(new MouseEvent('mouseleave'));
      out.a7a = !bar.classList.contains('visible');
      row.dispatchEvent(new MouseEvent('mousemove', { clientX: Math.ceil(right) - 5, clientY: rect.top + 10 }));
      out.a7b = bar.classList.contains('visible');
      row.dispatchEvent(new MouseEvent('mouseleave'));
      return JSON.stringify(out);
    })()
  `);
  const A = JSON.parse(a1);
  assert(A.a1, `A1 热区外 1px(right-16)不触发(实际 ${A.a1})`);
  assert(A.a2, `A2 热区边界(right-15,>=)触发(实际 ${A.a2})`);
  assert(A.a3, `A3 显示后移入保持区(right-115 内)不误隐藏(实际 ${A.a3})`);
  assert(A.a4, `A4 保持范围外 1px(right-116)隐藏(实际 ${A.a4})`);
  assert(A.a5a && A.a5b, `A5 显示态保持区移动(right-30)仍保持(实际 ${A.a5a}/${A.a5b})`);
  assert(A.a6b, `A6 各行热区独立触发(实际 ${A.a6b})`);
  assert(A.a7a && A.a7b, `A7 mouseleave 清态后重进热区可再触发(实际 ${A.a7a}/${A.a7b})`);

  // ========== B: 日期胶囊淡出动画实测 ==========
  console.log('\n=== B 日期胶囊淡出动画 ===');
  // 先清真实 :hover(移到分隔线,不落在任何行上)
  const safeY = await r(`document.querySelector('.divider').getBoundingClientRect().top + 2`);
  await realHover(300, safeY, async () => !(await r(`!!document.querySelector('.task-item:hover')`)));
  const b1 = JSON.parse(await r(`
    (() => {
      const row = document.querySelector('[data-id="t1"]');
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('mousemove', { clientX: rect.right - 5, clientY: rect.top + 10 }));
      return row.querySelector('.hover-bar').classList.contains('visible');
    })()
  `));
  assert(b1, 'B1 热区触发操作栏显示');
  await sleep(300); // 0.12s 淡出过渡 + 余量
  const b1b = JSON.parse(await r(`
    (() => {
      const chip = getComputedStyle(document.querySelector('[data-id="t1"] .task-date-chip'));
      return JSON.stringify({ o: chip.opacity, v: chip.visibility });
    })()
  `));
  assert(b1b.o === '0' && b1b.v === 'hidden', `B1 操作栏浮现后胶囊完全淡出(opacity=${b1b.o}, visibility=${b1b.v})`);
  await r(`document.querySelector('[data-id="t1"]').dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 100 }))`); // 移出热区(左部)
  await sleep(300);
  const b1c = JSON.parse(await r(`
    (() => {
      const chip = getComputedStyle(document.querySelector('[data-id="t1"] .task-date-chip'));
      const bar = document.querySelector('[data-id="t1"] .hover-bar');
      return JSON.stringify({ o: chip.opacity, v: chip.visibility, bar: bar.classList.contains('visible') });
    })()
  `));
  assert(b1c.o === '1' && b1c.v === 'visible', `B1 移出热区后胶囊恢复常显(opacity=${b1c.o}, visibility=${b1c.v})`);

  // B2 编辑态: 操作栏强制隐藏,胶囊不淡出(opacity 保持 1)
  const b2 = await r(`
    (() => {
      const row = document.querySelector('[data-id="t1"]');
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const editing = row.classList.contains('editing');
      const barV = getComputedStyle(row.querySelector('.hover-bar')).visibility;
      const chip = getComputedStyle(row.querySelector('.task-date-chip'));
      const hint = getComputedStyle(row.querySelector('.hotzone-hint'));
      const out = JSON.stringify({ editing, barV, chipO: chip.opacity, chipV: chip.visibility, hintO: hint.opacity });
      row.querySelector('.task-edit-input').blur(); // 退出编辑
      return out;
    })()
  `);
  const B2 = JSON.parse(b2);
  assert(B2.editing && B2.barV === 'hidden', `B2 编辑态操作栏隐藏(实际 ${B2.barV})`);
  assert(B2.chipO === '1' && B2.chipV === 'visible', `B2 编辑态胶囊保持常显不淡出(opacity=${B2.chipO})`);
  assert(B2.hintO === '0', `B2 编辑态提示条隐藏(opacity=${B2.hintO})`);

  // ========== C: 提示条与拖拽 ==========
  console.log('\n=== C 提示条与拖拽 ===');
  // C1 拖拽克隆: 提示条隐藏
  const C1 = JSON.parse(await r(`
    (() => {
      const row = [...document.querySelectorAll('.task-item')].find(r2 => !r2.classList.contains('completed'));
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: rect.left + 10, clientY: rect.top + 10 }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: rect.left + 10, clientY: rect.top + 70 }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: rect.left + 10, clientY: rect.top + 70 }));
      const clone = document.querySelector('.task-dragging');
      const hintO = clone ? getComputedStyle(clone.querySelector('.hotzone-hint')).opacity : 'no-clone';
      const chipD = clone ? getComputedStyle(clone.querySelector('.task-date-chip')).display : 'no-clone';
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return JSON.stringify({ hadClone: !!clone, hintO, chipD });
    })()
  `));
  assert(C1.hadClone, 'C1 拖拽克隆存在');
  assert(C1.hintO === '0', `C1 拖拽克隆提示条隐藏(opacity=${C1.hintO})`);
  assert(C1.chipD !== 'none', `C1 拖拽克隆日期胶囊保留(display=${C1.chipD})`);
  // C2 无日期任务: 有提示条、无胶囊
  const C2 = JSON.parse(await r(`
    (() => {
      const row = document.querySelector('[data-id="t3"]');
      return JSON.stringify({ hint: !!row.querySelector('.hotzone-hint'), chip: !!row.querySelector('.task-date-chip') });
    })()
  `));
  assert(C2.hint && !C2.chip, `C2 无日期任务有提示条无胶囊(hint=${C2.hint}, chip=${C2.chip})`);

  // ========== D: 选择器钉住联动 ==========
  console.log('\n=== D 选择器钉住联动 ===');
  const D1 = JSON.parse(await r(`
    (() => {
      const rowA = document.querySelector('[data-id="t1"]');
      rowA.dispatchEvent(new MouseEvent('mouseenter'));
      openDatePicker(rowA.querySelector('.task-duedate'), 0);
      return JSON.stringify({ pinned: !!activePickerRow, bar: rowA.querySelector('.hover-bar').classList.contains('visible') });
    })()
  `));
  assert(D1.pinned && D1.bar, 'D1 打开日期选择器钉住操作栏');
  await sleep(300);
  const D1b = JSON.parse(await r(`
    (() => {
      const rowA = document.querySelector('[data-id="t1"]');
      const rowB = document.querySelector('[data-id="t2"]');
      const chipA = getComputedStyle(rowA.querySelector('.task-date-chip'));
      const barB = rowB.querySelector('.hover-bar').classList.contains('visible');
      const chipB = getComputedStyle(rowB.querySelector('.task-date-chip'));
      return JSON.stringify({ oA: chipA.opacity, vA: chipA.visibility, barB, oB: chipB.opacity });
    })()
  `));
  assert(D1b.oA === '0' && D1b.vA === 'hidden', `D1 钉住时选择器行胶囊淡出(opacity=${D1b.oA})`);
  assert(!D1b.barB && D1b.oB === '1', `D1 钉住期间其他行操作栏不显示、胶囊不受影响(barB=${D1b.barB}, oB=${D1b.oB})`);
  // 关闭: 真实鼠标不在行上 → 钉住解除,胶囊恢复
  await realHover(300, safeY, async () => !(await r(`!!document.querySelector('.task-item:hover')`))); // 清真实 :hover
  await r(`closeActivePicker();`);
  const d2 = JSON.parse(await r(`(() => { const row = document.querySelector('[data-id="t1"]'); return JSON.stringify({ pinned: !!activePickerRow, bar: row.querySelector('.hover-bar').classList.contains('visible') }); })()`));
  assert(!d2.pinned && !d2.bar, 'D2 关闭选择器后钉住解除、操作栏收起');
  await sleep(300);
  const d2b = JSON.parse(await r(`(() => { const chip = getComputedStyle(document.querySelector('[data-id="t1"] .task-date-chip')); return JSON.stringify({ o: chip.opacity, v: chip.visibility }); })()`));
  assert(d2b.o === '1' && d2b.v === 'visible', `D2 关闭选择器后胶囊恢复常显(opacity=${d2b.o})`);

  // ========== E: 笔记页 footer 搜索 ==========
  console.log('\n=== E footer 搜索 ===');
  await r(`state.currentPage = 'notepad';`);
  const e1 = await r(`
    (() => {
      closeNoteSearch();
      const footer = document.querySelector('.page-notepad .notepad-footer');
      const bar = document.querySelector('#note-search-bar');
      // 点击 footer 元素本身(空白区,非按钮)
      footer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const opened = !bar.classList.contains('hidden') && document.activeElement === noteSearchInput;
      // Esc 关闭
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const closed = bar.classList.contains('hidden');
      // 关闭后再点 footer 可重开
      footer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const reopened = !bar.classList.contains('hidden');
      closeNoteSearch();
      // 工具箱页 footer 点击不触发笔记搜索
      document.querySelector('.page-tools .notepad-footer').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const toolsNoOpen = bar.classList.contains('hidden');
      closeNoteSearch();
      return JSON.stringify({ opened, closed, reopened, toolsNoOpen });
    })()
  `);
  const E = JSON.parse(e1);
  assert(E.opened, `E1 点击 footer 空白区进入搜索并聚焦(实际 ${E.opened})`);
  assert(E.closed, 'E1 Esc 关闭搜索');
  assert(E.reopened, `E1 关闭后再点 footer 可重开(实际 ${E.reopened})`);
  assert(E.toolsNoOpen, `E1 工具箱页 footer 点击不触发搜索(实际 ${E.toolsNoOpen})`);
  // E2 点击搜索栏区域本身(bar 隐藏但存在)→ 也进入搜索(监听在 footer 上冒泡)
  const e2 = JSON.parse(await r(`
    (() => {
      closeNoteSearch();
      const bar = document.querySelector('#note-search-bar');
      bar.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const opened = !bar.classList.contains('hidden');
      closeNoteSearch();
      return JSON.stringify({ opened });
    })()
  `));
  assert(e2.opened, `E2 点击隐藏搜索栏区域也进入搜索(实际 ${e2.opened})`);

  // ========== F: DOM 结构 ==========
  console.log('\n=== F DOM 结构与 CSS 层级 ===');
  const f1 = JSON.parse(await r(`
    (() => {
      const row = document.querySelector('[data-id="t1"]');
      const kids = [...row.children];
      return JSON.stringify({
        bar: kids.indexOf(row.querySelector('.hover-bar')),
        chip: kids.indexOf(row.querySelector('.task-date-chip')),
        hint: kids.indexOf(row.querySelector('.hotzone-hint')),
      });
    })()
  `));
  assert(f1.bar >= 0 && f1.chip > f1.bar && f1.hint > f1.chip, `F1 DOM 顺序 hover-bar(${f1.bar}) → chip(${f1.chip}) → hint(${f1.hint}),兄弟选择器依赖成立`);
  const cssText = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf-8');
  const zBar = cssText.match(/\.hover-bar \{[\s\S]*?z-index: (\d+);/);
  const zChip = cssText.match(/\.task-date-chip \{[\s\S]*?z-index: (\d+);/);
  const zHint = cssText.match(/\.hotzone-hint \{[\s\S]*?z-index: (\d+);/);
  assert(zBar && zChip && zHint && +zBar[1] > +zChip[1] && +zBar[1] > +zHint[1], `F2 操作栏 z-index(${zBar?.[1]}) 高于胶囊(${zChip?.[1]})与提示条(${zHint?.[1]})`);

  // ========== 汇总 ==========
  clearTimeout(killer);
  console.log(`\n==========================================`);
  console.log(`结果: ${passed} 通过, ${failed} 失败`);
  if (failures.length) {
    console.log('失败项:');
    failures.forEach(f => console.log('  - ' + f));
  }
  app.exit(failed > 0 ? 1 : 0);
});
