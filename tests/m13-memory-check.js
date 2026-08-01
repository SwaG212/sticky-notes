// 内存验收: 500任务渲染 + 大笔记搜索开关 20 次, 对比内存
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 600, height: 800 });
  await win.loadFile('renderer/index.html');
  const r = (code) => win.webContents.executeJavaScript(code);

  const mainStart = Math.round(process.memoryUsage().rss / 1024);
  const heapStart = await r('(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1024) : -1))()');

  await r(`(() => {
    const big = [];
    for (let i = 0; i < 500; i++) big.push({ id: 'big_' + i, task: '性能任务' + i, project: 'P' + (i % 5), completed: false, createdAt: 'x', completedAt: null, alarmTime: null, dueDate: (i % 3 === 0 ? '2026-08-10' : null), sortOrder: i });
    state.tasks = big;
    renderTasks();
    let s = '';
    for (let i = 0; i < 2000; i++) s += '<div>第' + i + '段内容,包含关键词' + (i % 10 === 0 ? '查找' : '') + '</div>';
    notepadTextarea.innerHTML = s;
    return true;
  })()`);

  for (let i = 0; i < 20; i++) {
    await r(`(() => { openNoteSearch(); noteSearchInput.value = '查找'; noteSearchInput.dispatchEvent(new Event('input')); closeNoteSearch(); return true; })()`);
  }
  await new Promise(res => setTimeout(res, 500));

  const mainEnd = Math.round(process.memoryUsage().rss / 1024);
  const heapEnd = await r('(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1024) : -1))()');

  console.log('=== 内存验收 ===');
  console.log(`主进程 RSS: ${mainStart}KB -> ${mainEnd}KB (变化 ${mainEnd - mainStart}KB)`);
  console.log(`渲染进程 JS堆: ${heapStart}KB -> ${heapEnd}KB (变化 ${heapEnd - heapStart}KB)`);
  const ok = (mainEnd - mainStart) < 30000 && (heapEnd - heapStart) < 20000;
  console.log(ok ? '✅ 内存无异常增长(20次搜索开合 + 500任务)' : '❌ 内存增长异常');
  app.exit(ok ? 0 : 1);
});
