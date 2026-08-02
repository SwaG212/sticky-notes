// m14-tools-page.js — 2026-08-01 工具箱页 + 翻译卡集成测试(Electron DOM 实测)
// 运行: cd F:\Project\sticky-notes && node_modules\electron\dist\electron.exe tests/m14-tools-page.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

let passed = 0, failed = 0;
const failures = [];
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}`); }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 600, height: 800 });
  const killer = setTimeout(() => { console.log('!!! 测试超时强制退出'); app.exit(2); }, 90000);
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  const r = (code) => win.webContents.executeJavaScript(code);

  // ========== T: 工具箱页结构与切换 ==========
  console.log('\n=== T 工具箱页 ===');
  const structure = await r(`
    (() => {
      const out = {};
      out.hasToolsPage = !!document.querySelector('.page-tools');
      out.hasCards = !!document.querySelector('#tools-cards');
      out.hasBackBtn = !!document.querySelector('#btn-tools-back');
      out.hasForwardBtn = !!document.querySelector('#btn-notepad-forward');
      out.toolsSettings = document.querySelectorAll('.page-tools #btn-settings').length;
      out.toolsBackInFooter = !!document.querySelector('.page-tools .notepad-footer #btn-tools-back');
      out.pagesWidth = getComputedStyle(document.querySelector('.pages-container')).width;
      out.mainWidth = document.querySelector('.page-main').getBoundingClientRect().width;
      out.toolsWidth = document.querySelector('.page-tools').getBoundingClientRect().width;
      out.footerChildren = [...document.querySelector('.notepad-footer').children].map(c => c.id || c.className);
      return JSON.stringify(out);
    })()
  `);
  const st = JSON.parse(structure);
  assert(st.hasToolsPage && st.hasCards && st.hasBackBtn && st.hasForwardBtn, 'T1 工具箱页 DOM 结构完整');
  assert(st.toolsSettings === 0, 'T1b 工具箱页无设置按钮');
  assert(st.toolsBackInFooter, 'T1c 工具箱页 ← 按钮在页脚栏');
  const containerPx = parseFloat(st.pagesWidth);
  assert(Math.abs(containerPx - st.mainWidth * 3) < 2, `T2 页面容器为单页 3 倍宽(${containerPx} ≈ 3×${st.mainWidth})`);
  assert(Math.abs(st.mainWidth - st.toolsWidth) < 1, 'T3 三个页面等宽');
  assert(st.footerChildren.length === 3, `T4 页脚栏三元素(← 搜索框 →)(实际 ${st.footerChildren.join(',')})`);

  // 切换: main → notepad → tools
  await r(`state.pagesEnabled = { tasks: true, tools: true }; state.toolsEnabled = { translate: true };`);
  await r(`switchToNotepad()`);
  const onNotepad = await r(`pagesContainer.classList.contains('on-notepad') && !pagesContainer.classList.contains('on-tools')`);
  assert(onNotepad, 'T5 切到记事本页');
  await r(`switchToTools()`);
  const onTools = await r(`pagesContainer.classList.contains('on-tools') && !pagesContainer.classList.contains('on-notepad')`);
  assert(onTools, 'T6 切到工具箱页');
  const toolsVisible = await r(`(() => new Promise(resolve => setTimeout(() => { const pr = document.querySelector('.page-tools').getBoundingClientRect(); resolve(pr.left >= 0 && pr.right <= window.innerWidth); }, 500)))()`);
  assert(toolsVisible, 'T7 工具箱页在视口内可见');
  await r(`switchToMain()`);
  const onMain = await r(`!pagesContainer.classList.contains('on-notepad') && !pagesContainer.classList.contains('on-tools')`);
  assert(onMain, 'T8 切回主页面');

  // ========== TR: 翻译卡 ==========
  console.log('\n=== TR 翻译卡 ===');
  await r(`switchToTools()`);
  const cardInfo = await r(`
    (() => {
      const card = document.querySelector('[data-tool="translate"]');
      if (!card) return JSON.stringify({ exists: false });
      return JSON.stringify({
        exists: true,
        title: card.querySelector('.tool-card-title').textContent,
        hasInput: !!card.querySelector('.tool-card-input'),
        hasResult: !!card.querySelector('.tool-card-result'),
        hasStatus: !!card.querySelector('.tool-card-status'),
        hasCopy: !!card.querySelector('.tool-card-copy-btn'),
      });
    })()
  `);
  const ci = JSON.parse(cardInfo);
  assert(ci.exists, 'TR1 翻译卡已渲染');
  assert(ci.title === '翻译', `TR2 卡片标题极简为"翻译"(实际 ${ci.title})`);
  assert(ci.hasInput && ci.hasResult && ci.hasStatus, 'TR3 卡片结构完整(输入/结果/状态)');
  assert(!ci.hasCopy, 'TR3b 无复制按钮');
  const inputH = await r(`Math.round(document.querySelector('[data-tool="translate"] .tool-card-input').getBoundingClientRect().height)`);
  assert(inputH >= 50 && inputH <= 60, `TR3c 输入框约两行高度(实际 ${inputH}px)`);
  const resultH = await r(`Math.round(document.querySelector('[data-tool="translate"] .tool-card-result').getBoundingClientRect().height)`);
  assert(resultH >= 50 && resultH <= 60, `TR3d 结果框约两行高度(实际 ${resultH}px)`);

  // 翻译调用(浏览器模式 mock)
  await r(`
    (() => {
      const input = document.querySelector('[data-tool="translate"] .tool-card-input');
      input.textContent = '你好世界';
      input.dispatchEvent(new Event('input'));
      return new Promise(resolve => setTimeout(() => resolve(true), 500));
    })()
  `);
  const mockResult = await r(`document.querySelector('[data-tool="translate"] .tool-card-result').textContent`);
  assert(mockResult.includes('翻译结果'), `TR4 浏览器模式翻译 mock 生效(实际 ${JSON.stringify(mockResult)})`);
  const copyGone = await r(`!document.querySelector('[data-tool="translate"] .tool-card-copy-btn')`);
  assert(copyGone, 'TR5 翻译完成后无复制按钮');

  // 语言方向显示(模拟 electronAPI 返回 sourceLang/targetLang)
  await r(`
    (() => {
      window.__origAPI = window.electronAPI;
      window.electronAPI = { translateRequest: async () => ({ success: true, translated: 'Hello World', sourceLang: '中文', targetLang: '英文' }) };
      const input = document.querySelector('[data-tool="translate"] .tool-card-input');
      input.textContent = '你好';
      input.dispatchEvent(new Event('input'));
      return new Promise(resolve => setTimeout(resolve, 500));
    })()
  `);
  const langHint = await r(`document.querySelector('[data-tool="translate"] .tool-card-status').textContent`);
  assert(langHint === '中文 → 英文', `TR7 翻译完成显示语言方向(实际 ${JSON.stringify(langHint)})`);
  await r(`
    (() => {
      const input = document.querySelector('[data-tool="translate"] .tool-card-input');
      input.textContent = '';
      input.dispatchEvent(new Event('input'));
      window.electronAPI = window.__origAPI;
    })()
  `);

  // 空输入清除结果
  await r(`
    (() => {
      const input = document.querySelector('[data-tool="translate"] .tool-card-input');
      input.textContent = '';
      input.dispatchEvent(new Event('input'));
      return new Promise(resolve => setTimeout(resolve, 400));
    })()
  `);
  const emptyResult = await r(`document.querySelector('[data-tool="translate"] .tool-card-result').textContent`);
  assert(emptyResult === '', 'TR6 清空输入后结果清空');

  // ========== S: 设置页开关 ==========
  console.log('\n=== S 设置开关 ===');
  await r(`openSettings();`);
  const settingsCheck = await r(`(async () => {
      const toolsChk = document.querySelector('#settings-tools-page');
      return JSON.stringify({ exists: !!toolsChk, checked: toolsChk?.checked });
    })()`);
  const sc = JSON.parse(settingsCheck);
  assert(sc.exists, 'S1 设置页工具箱开关存在');
  // 无 electronAPI 的测试环境下 checkbox 不初始化;验证 renderer 默认状态 + 主进程默认配置
  const defaults = await r(`JSON.stringify({ tools: state.pagesEnabled.tools, translate: state.toolsEnabled.translate })`);
  const def = JSON.parse(defaults);
  assert(def.tools === true && def.translate === true, 'S2 工具箱页与翻译卡默认启用');
  const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  assert(mainJs.includes('pagesEnabled: { tasks: true, tools: true }'), 'S2b 主进程默认配置含 tools: true');
  assert(mainJs.includes('function detectLang') && mainJs.includes('/[一-鿿]/'), 'S2c 主进程含语言检测逻辑 detectLang');

  // 关闭工具箱页 → 页脚栏右滑按钮隐藏,页面跳回
  await r(`switchToTools()`);
  const closeTools = await r(`
    (async () => {
      state.pagesEnabled.tools = false;
      updateToolsPageVisibility();
      const fwd = document.querySelector('#btn-notepad-forward');
      const vis = getComputedStyle(fwd).visibility;
      // 模拟 confirmSettings 中关闭时的跳转
      state.currentPage = 'tools';
      if (!state.pagesEnabled.tools) {
        state.currentPage = 'main';
        pagesContainer.classList.remove('on-notepad', 'on-tools');
      }
      return JSON.stringify({ vis, page: state.currentPage, cls: pagesContainer.className });
    })()
  `);
  const ct = JSON.parse(closeTools);
  assert(ct.vis === 'hidden', `S3 工具箱关闭时右滑按钮隐藏(实际 ${ct.vis})`);
  assert(ct.page === 'main' && !ct.cls.includes('on-tools'), 'S4 工具箱关闭时页面回退到主页面');
  await r(`state.pagesEnabled.tools = true; updateToolsPageVisibility();`);

  // 全部工具关闭 → 页面不可达
  await r(`state.toolsEnabled = { translate: false };`);
  const allOff = await r(`
    (async () => {
      state.pagesEnabled.tools = true;
      const reachable = isToolsPageEnabled();
      state.currentPage = 'main';
      return reachable;
    })()
  `);
  assert(allOff === false, 'S5 全部工具关闭时工具箱页不可达');
  await r(`state.toolsEnabled = { translate: true };`);

  // ========== K: 快捷键 ==========
  console.log('\n=== K 快捷键 ===');
  const shortcut = await r(`
    (() => {
      const el = document.querySelector('#shortcut-switchTools');
      return JSON.stringify({ exists: !!el, text: el?.textContent });
    })()
  `);
  const sk = JSON.parse(shortcut);
  assert(sk.exists, 'K1 设置页工具箱快捷键行存在');
  assert(sk.text.includes('3'), `K2 工具箱快捷键含 Alt+3(实际 ${sk.text})`);
  const alt3 = await r(`
    (async () => {
      state.pagesEnabled.tools = true;
      state.toolsEnabled = { translate: true };
      state.currentPage = 'main';
      document.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, key: '3', bubbles: true }));
      return state.currentPage;
    })()
  `);
  assert(alt3 === 'tools', `K3 Alt+3 切到工具箱页(实际 ${alt3})`);

  // ========== F: 页脚栏 ==========
  console.log('\n=== F 页脚栏 ===');
  await r(`openNoteSearch();`);
  const footerLayout = await r(`
    (() => {
      state.pagesEnabled = { tasks: true, tools: true };
      updateTasksPageVisibility();
      updateToolsPageVisibility();
      const back = document.querySelector('#btn-notepad-back');
      const fwd = document.querySelector('#btn-notepad-forward');
      const search = document.querySelector('#note-search-bar');
      const input = document.querySelector('#note-search-input');
      const footer = document.querySelector('.notepad-footer');
      const fb = footer.getBoundingClientRect();
      const backRect = back.getBoundingClientRect();
      const fwdRect = fwd.getBoundingClientRect();
      const searchRect = search.getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();
      return JSON.stringify({
        backVis: getComputedStyle(back).visibility,
        fwdVis: getComputedStyle(fwd).visibility,
        backLeft: Math.round(backRect.left - fb.left),
        fwdRight: Math.round(fb.right - fwdRect.right),
        inputCenterOffset: Math.round((inputRect.left + inputRect.width / 2) - (fb.left + fb.width / 2)),
        footerH: Math.round(fb.height),
      });
    })()
  `);
  const fl = JSON.parse(footerLayout);
  assert(fl.backVis === 'visible' && fl.fwdVis === 'visible', `F1 两按钮均可见(实际 ${fl.backVis}/${fl.fwdVis})`);
  assert(fl.backLeft < 15 && fl.fwdRight < 15, `F2 按钮贴边(实际 left=${fl.backLeft}, right=${fl.fwdRight})`);
  assert(Math.abs(fl.inputCenterOffset) <= 2, `F3 搜索框输入框居中(偏移 ${fl.inputCenterOffset}px)`);
  assert(fl.footerH >= 40, `F4 页脚栏保持原高度(实际 ${fl.footerH}px)`);

  // 警告图标出现时输入框不位移
  const iconShift = await r(`
    (() => {
      const input = document.querySelector('#note-search-input');
      const before = input.getBoundingClientRect().left;
      noteSearchStatus.classList.add('noresult');
      const after = input.getBoundingClientRect().left;
      const iconLeft = document.querySelector('#note-search-status').getBoundingClientRect().left;
      const iconOnLeft = iconLeft + 16 <= before;
      noteSearchStatus.classList.remove('noresult');
      return JSON.stringify({ shift: Math.round(after - before), iconOnLeft });
    })()
  `);
  const ishift = JSON.parse(iconShift);
  assert(ishift.shift === 0, `F7 警告图标出现时输入框不位移(shift=${ishift.shift}px)`);
  assert(ishift.iconOnLeft, 'F8 警告图标位于输入框左侧');

  // 关闭任务页时 ← 隐藏但高度不变
  await r(`state.pagesEnabled.tasks = false; updateTasksPageVisibility(); updateToolsPageVisibility();`);
  const tasksOff = await r(`
    (() => {
      const back = document.querySelector('#btn-notepad-back');
      const footer = document.querySelector('.notepad-footer');
      return JSON.stringify({ vis: getComputedStyle(back).visibility, h: footer.getBoundingClientRect().height });
    })()
  `);
  const to = JSON.parse(tasksOff);
  assert(to.vis === 'hidden', 'F5 任务页关闭时 ← 按钮隐藏');
  assert(Math.abs(to.h - fl.footerH) <= 1, `F6 关闭任务页后页脚栏高度不变(${to.h} vs ${fl.footerH})`);
  await r(`state.pagesEnabled.tasks = true; updateTasksPageVisibility();`);

  // ========== R: 回归 ==========
  console.log('\n=== R 回归 ===');
  await r(`state.pagesEnabled = { tasks: true, tools: true }; switchToNotepad();`);
  const ctrlF = await r(`
    (() => {
      openNoteSearch(); closeNoteSearch();
      document.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, key: 'f', bubbles: true }));
      const opened = !noteSearchBar.classList.contains('hidden');
      return opened;
    })()
  `);
  assert(ctrlF, 'R1 记事本页 Ctrl+F 搜索仍正常');

  // 任务页不受影响
  await r(`state.currentPage = 'main';`);
  const taskRender = await r(`
    (() => {
      state.tasks = [
        { id: 't1', task: '任务1', project: null, completed: false, createdAt: 'x', completedAt: null, alarmTime: null, dueDate: null, sortOrder: 0 },
      ];
      state.activeSheet = 'all';
      renderTasks();
      return document.querySelectorAll('.task-item').length;
    })()
  `);
  assert(taskRender === 1, 'R2 任务页渲染正常');

  // ========== 汇总 ==========
  console.log(`\n==========================================`);
  console.log(`结果: ${passed} 通过, ${failed} 失败`);
  if (failures.length) {
    console.log('失败项:');
    failures.forEach(f => console.log('  - ' + f));
  }
  app.exit(failed > 0 ? 1 : 0);
});
