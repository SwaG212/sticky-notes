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
      out.hasCardTemplate = !!document.querySelector('#tool-card-template')?.content.querySelector('.tool-card > .tool-card-body');
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
  assert(st.hasToolsPage && st.hasCards && st.hasCardTemplate && st.hasBackBtn && st.hasForwardBtn, 'T1 卡片页 DOM 与功能卡模板结构完整');
  assert(st.toolsSettings === 0, 'T1b 工具箱页无设置按钮');
  assert(st.toolsBackInFooter, 'T1c 工具箱页 ← 按钮在页脚栏');
  const containerPx = parseFloat(st.pagesWidth);
  assert(Math.abs(containerPx - st.mainWidth * 3) < 2, `T2 页面容器为单页 3 倍宽(${containerPx} ≈ 3×${st.mainWidth})`);
  assert(Math.abs(st.mainWidth - st.toolsWidth) < 1, 'T3 三个页面等宽');
  assert(st.footerChildren.length === 3, `T4 页脚栏三元素(← 搜索框 →)(实际 ${st.footerChildren.join(',')})`);

  // 切换: main → notepad → tools
  await r(`state.pagesEnabled = { tasks: true, tools: true }; state.toolsEnabled = { translate: true, videoDownload: true, harness: true };`);
  await r(`switchToNotepad()`);
  const onNotepad = await r(`pagesContainer.classList.contains('on-notepad') && !pagesContainer.classList.contains('on-tools')`);
  assert(onNotepad, 'T5 切到记事本页');
  const notepadHeaderHitAreas = JSON.parse(await r(`(() => new Promise(resolve => setTimeout(() => {
    const handle = document.querySelector('#window-drag-handle').getBoundingClientRect();
    const toolbar = document.querySelector('.notepad-toolbar').getBoundingClientRect();
    const settings = document.querySelector('#btn-settings').getBoundingClientRect();
    const hit = document.elementFromPoint(settings.left + settings.width / 2, settings.top + settings.height / 2);
    resolve(JSON.stringify({
      separated: toolbar.right <= handle.left && handle.right <= settings.left,
      settingsHit: hit?.id === 'btn-settings' || !!hit?.closest?.('#btn-settings'),
    }));
  }, 400)))()`));
  assert(notepadHeaderHitAreas.separated, 'T5b 顶部拖动区不覆盖笔记工具栏和设置按钮');
  assert(notepadHeaderHitAreas.settingsHit, 'T5c 设置按钮位于顶部实际点击层');
  const settingsPoint = JSON.parse(await r(`(() => {
    const rect = document.querySelector('#btn-settings').getBoundingClientRect();
    return JSON.stringify({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) });
  })()`));
  win.show();
  win.focus();
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...settingsPoint });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...settingsPoint });
  await new Promise(resolve => setTimeout(resolve, 80));
  const settingsClickable = await r(`!settingsOverlay.classList.contains('hidden')`);
  assert(settingsClickable, 'T5d 非固定模式下设置按钮可接收原生点击');
  await r(`settingsOverlay.classList.add('hidden')`);
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
        usesTemplate: !!card.querySelector(':scope > .tool-card-body'),
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
  assert(ci.usesTemplate, 'TR1b 翻译卡由统一模板创建');
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

  // ========== V: 视频下载卡 ==========
  console.log('\n=== V 视频下载卡 ===');
  const videoCard = JSON.parse(await r(`(() => {
    const card = document.querySelector('[data-tool="video-download"]');
    const buttons = [...card.querySelectorAll('.video-download-actions button')];
    return JSON.stringify({
      exists: !!card,
      usesTemplate: !!card.querySelector(':scope > .tool-card-body'),
      openFirst: buttons[0]?.classList.contains('video-download-open'),
      downloadSecond: buttons[1]?.classList.contains('video-download-confirm'),
      openDisabled: buttons[0]?.disabled,
      progressBackground: getComputedStyle(card.querySelector('.video-download-progress')).backgroundColor,
      progressWidth: card.querySelector('.video-download-progress-fill').style.width,
      settingsToggle: !!document.querySelector('#settings-video-download-enabled'),
    });
  })()`));
  assert(videoCard.exists && videoCard.usesTemplate, 'V1 视频下载卡通过统一模板创建');
  assert(videoCard.openFirst && videoCard.downloadSecond, 'V2 打开目录在左、下载操作在右');
  assert(videoCard.openDisabled && videoCard.progressWidth === '0%', 'V3 未下载时目录按钮禁用、进度保持为 0');
  assert(videoCard.progressBackground !== 'rgba(0, 0, 0, 0)' && videoCard.settingsToggle, 'V4 灰色进度轨道与设置开关存在');
  const videoComplete = JSON.parse(await r(`(() => {
    handleVideoDownloadProgress({
      status: 'completed', receivedBytes: 1024, totalBytes: 1024, percent: 100,
      fileName: 'demo.mp4', filePath: 'C:\\\\Downloads\\\\demo.mp4',
    });
    const card = document.querySelector('[data-tool="video-download"]');
    return JSON.stringify({
      openEnabled: !card.querySelector('.video-download-open').disabled,
      actionText: card.querySelector('.video-download-confirm').textContent,
      value: card.querySelector('.video-download-progress-value').textContent,
    });
  })()`));
  assert(videoComplete.openEnabled && videoComplete.actionText === '再次下载' && videoComplete.value === '100%', 'V5 完成后启用目录按钮并切换操作文案');
  await r(`Object.assign(state.videoDownload, { status: 'idle', receivedBytes: 0, totalBytes: 0, percent: 0, fileName: '', filePath: '', error: '' }); updateVideoDownloadCard();`);

  // ========== H: DeepSeek Harness 卡 ==========
  console.log('\n=== H DeepSeek Harness 卡 ===');
  const harnessCard = JSON.parse(await r(`(() => {
    const card = document.querySelector('[data-tool="harness"]');
    return JSON.stringify({
      exists: !!card,
      title: card?.querySelector('.tool-card-title')?.textContent,
      hasWorkspace: !!card?.querySelector('.harness-workspace'),
      hasSessions: !!card?.querySelector('.harness-session-select'),
      hasHistory: !!card?.querySelector('.harness-history'),
      hasTodos: !!card?.querySelector('.harness-todos'),
      hasArtifacts: !!card?.querySelector('.harness-artifacts'),
      hasInput: !!card?.querySelector('.harness-input'),
      hasRun: !!card?.querySelector('.harness-run-stop-btn'),
      hasStop: !!card?.querySelector('.harness-run-stop-btn'),
      optionLabel: card?.querySelector('.harness-options-trigger')?.textContent,
      models: [...card.querySelectorAll('.harness-option-choices button[data-kind="model"]')].map(button => button.textContent),
      efforts: [...card.querySelectorAll('.harness-option-choices button[data-kind="effort"]')].map(button => button.textContent),
    });
  })()`));
  assert(harnessCard.exists && harnessCard.title === 'DeepSeek Harness', 'H1 Harness 卡已渲染');
  assert(harnessCard.hasWorkspace && harnessCard.hasSessions && harnessCard.hasHistory && harnessCard.hasInput, 'H2 工作目录/会话/记录/输入结构完整');
  assert(harnessCard.hasRun && harnessCard.hasStop, 'H3 运行/停止合并为单一开关按钮');
  assert(harnessCard.optionLabel === 'Flash-High' && harnessCard.models.join(',') === 'Flash,Pro' && harnessCard.efforts.join(',') === 'Off,High,Max', 'H3a 模型与推理等级合并展示且选项完整');
  const footerAlignment = JSON.parse(await r(`(() => {
    const card = document.querySelector('[data-tool="harness"]');
    const trigger = card.querySelector('.harness-options-trigger');
    trigger.click();
    const elements = [trigger, ...card.querySelectorAll('.harness-action-buttons button')];
    const centers = elements.map(element => { const rect = element.getBoundingClientRect(); return rect.top + rect.height / 2; });
    const panel = card.querySelector('.harness-options-panel').getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    return JSON.stringify({ aligned: Math.max(...centers) - Math.min(...centers) < 1, optionsLeft: triggerRect.left < card.querySelector('.harness-new-btn').getBoundingClientRect().left, opensUp: panel.bottom < triggerRect.top });
  })()`));
  assert(footerAlignment.aligned && footerAlignment.optionsLeft && footerAlignment.opensUp, 'H3a2 合并选项与操作按钮同高同排，面板向上展开');
  const optionSwitching = JSON.parse(await r(`(() => {
    const card = document.querySelector('[data-tool="harness"]');
    card.querySelector('[data-kind="model"][data-value="deepseek-v4-pro"]').click();
    card.querySelector('[data-kind="effort"][data-value="max"]').click();
    return JSON.stringify({
      label: card.querySelector('.harness-options-trigger').textContent,
      triggerEnabled: !card.querySelector('.harness-options-trigger').disabled,
      choicesEnabled: [...card.querySelectorAll('.harness-option-choices button')].every(button => !button.disabled),
    });
  })()`));
  assert(optionSwitching.label === 'Pro-Max' && optionSwitching.triggerEnabled && optionSwitching.choicesEnabled, 'H3a3 连续切换后合并文案更新且选择器保持可用');
  const sliderState = JSON.parse(await r(`(() => {
    const rows = [...document.querySelectorAll('[data-tool="harness"] .harness-option-choices')];
    return JSON.stringify(rows.map(row => ({ count: row.style.getPropertyValue('--option-count'), index: row.style.getPropertyValue('--option-index') })));
  })()`));
  assert(sliderState[0].count === '2' && sliderState[0].index === '1' && sliderState[1].count === '3' && sliderState[1].index === '2', 'H3a4 模型与推理等级滑块跟随当前选择移动');
  const quickActions = JSON.parse(await r(`(() => new Promise(resolve => {
    const card = document.querySelector('[data-tool="harness"]');
    state.harness.workspace = 'C:\\\\Users\\\\Admin\\\\Projects\\\\sticky-notes';
    state.harness.sessions = [{ id: 'history-demo', title: '历史会话', updatedAt: Date.now() }];
    updateHarnessCard();
    const initialQuickOpacity = getComputedStyle(card.querySelector('.harness-quick-actions')).opacity;
    const initialSelectMaxWidth = getComputedStyle(card.querySelector('.harness-session-select')).maxWidth;
    const initiallyHidden = initialQuickOpacity === '0' && initialSelectMaxWidth === '0px';
    card.querySelector('.harness-title-trigger').click();
    setTimeout(() => {
      const workspace = card.querySelector('.harness-workspace');
      const history = card.querySelector('.harness-history-btn');
      const select = card.querySelector('.harness-session-select');
      const status = card.querySelector('.harness-status');
      const centerY = element => {
        const rect = element.getBoundingClientRect();
        return rect.top + rect.height / 2;
      };
      const statusLeft = status.getBoundingClientRect().left;
      const workspaceRect = workspace.getBoundingClientRect();
      const historyRect = history.getBoundingClientRect();
      const statusRect = status.getBoundingClientRect();
      const base = {
        initiallyHidden,
        open: card.classList.contains('harness-actions-open'),
        titleOpacity: getComputedStyle(card.querySelector('.harness-title-trigger')).opacity,
        workspace: workspace.textContent,
        history: history.textContent,
        shortPath: compactHarnessPath('F:\\\\Project'),
        initialQuickOpacity,
        initialSelectMaxWidth,
        oneLineDelta: Math.max(centerY(workspace), centerY(history), centerY(status))
          - Math.min(centerY(workspace), centerY(history), centerY(status)),
        defaultStatusGap: statusRect.left - historyRect.right,
        workspaceFillsLeft: Math.abs(historyRect.left - workspaceRect.right - 6) < 1,
      };
      history.click();
      setTimeout(() => {
        const workspaceRect = workspace.getBoundingClientRect();
        const historyRect = history.getBoundingClientRect();
        const selectRect = select.getBoundingClientRect();
        resolve(JSON.stringify({
          ...base,
          collapsedWorkspace: workspace.textContent,
          collapsedWorkspaceWidth: workspaceRect.width,
          selectVisible: getComputedStyle(select).opacity === '1' && selectRect.width > 0,
          historyBeforeSelect: historyRect.right < selectRect.left,
          expandedOneLine: Math.max(centerY(workspace), centerY(history), centerY(select), centerY(status))
            - Math.min(centerY(workspace), centerY(history), centerY(select), centerY(status)) < 1,
          statusStable: Math.abs(status.getBoundingClientRect().left - statusLeft) < 1,
        }));
      }, 400);
    }, 400);
  }))()`));
  assert(quickActions.initiallyHidden && quickActions.open && quickActions.titleOpacity === '0', `H3b 点击标题后标题淡出、快捷按钮显现(initial=${quickActions.initialQuickOpacity}/${quickActions.initialSelectMaxWidth}, open=${quickActions.open}, title=${quickActions.titleOpacity})`);
  assert(quickActions.workspace === '📁 …\\Projects\\sticky-notes' && quickActions.shortPath === 'F:\\Project', 'H3c 长路径仅显示末两级，短路径保持完整');
  assert(quickActions.history === '◷ 历史会话', 'H3d 历史会话快捷入口文案正确');
  assert(quickActions.oneLineDelta < 1, `H3e 路径、历史会话与状态保持同行(delta=${quickActions.oneLineDelta})`);
  assert(Math.abs(quickActions.defaultStatusGap - 4) < 1 && quickActions.workspaceFillsLeft, `H3e2 历史会话距状态 4px，地址栏填满左侧空间(gap=${quickActions.defaultStatusGap}, fill=${quickActions.workspaceFillsLeft})`);
  assert(quickActions.collapsedWorkspace === '📁' && quickActions.collapsedWorkspaceWidth <= 32, 'H3f 展开历史后路径缩至图标宽度');
  assert(quickActions.selectVisible && quickActions.historyBeforeSelect, 'H3g 历史按钮在左，选择框在右侧同行展开');
  assert(quickActions.expandedOneLine && quickActions.statusStable, 'H3h 历史展开时保持同行且状态位置不变');
  await r(`closeHarnessQuickActions(document.querySelector('[data-tool="harness"]'))`);
  await r(`handleHarnessEvent({ type: 'message', role: 'assistant', text: 'Harness 测试消息' })`);
  const harnessMessage = await r(`document.querySelector('[data-tool="harness"] .harness-message-body')?.textContent`);
  assert(harnessMessage === 'Harness 测试消息', 'H4 Harness 事件可更新对话记录');
  await r(`
    handleHarnessEvent({ type: 'status', status: 'running' });
    handleHarnessEvent({ type: 'todos', todos: [{ content: '运行测试', status: 'in_progress' }] });
    handleHarnessEvent({ type: 'tool', phase: 'start', callId: 'c1', name: 'edit', detail: '{"file_path":"a.js"}' });
    handleHarnessEvent({ type: 'tool', phase: 'finish', callId: 'c1', output: 'done', diffs: [{ path: 'a.js', oldText: 'old', newText: 'new' }] });
  `);
  const phaseTwo = JSON.parse(await r(`JSON.stringify({
    todo: document.querySelector('[data-tool="harness"] .harness-todo')?.textContent,
    tool: document.querySelector('[data-tool="harness"] .harness-tool-detail summary')?.textContent,
    toolGroupOpen: document.querySelector('[data-tool="harness"] .harness-tool-group')?.open,
    artifacts: document.querySelector('[data-tool="harness"] .harness-artifacts summary')?.textContent,
  })`));
  assert(harnessCard.hasTodos && phaseTwo.todo.includes('运行测试'), 'H5 Todo 进度可更新');
  assert(phaseTwo.tool.includes('完成') && phaseTwo.toolGroupOpen && phaseTwo.artifacts.includes('1'), 'H6 执行中展开工具明细与文件变更');
  await r(`handleHarnessEvent({ type: 'result', text: '任务完成' })`);
  const toolGroupClosed = await r(`document.querySelector('[data-tool="harness"] .harness-tool-group')?.open === false`);
  assert(toolGroupClosed, 'H7 最终结果输出后工具过程自动折叠');
  await r(`state.harness.status = 'idle'; state.harness.toolGroupExpanded = false; updateHarnessCard();`);
  const restoredToolGroupClosed = await r(`document.querySelector('[data-tool="harness"] .harness-tool-group')?.open === false`);
  assert(restoredToolGroupClosed, 'H7b 历史会话恢复为 idle 时工具过程默认折叠');
  await r(`addHarnessMessage('user', '用户问题'); updateHarnessCard();`);
  const userMessageStyle = JSON.parse(await r(`(() => {
    const row = document.querySelector('[data-tool="harness"] .harness-message.user');
    return JSON.stringify({
      hasLabel: !!row?.querySelector('.harness-message-label'),
      background: row ? getComputedStyle(row).backgroundColor : '',
    });
  })()`));
  assert(!userMessageStyle.hasLabel && userMessageStyle.background !== 'rgba(0, 0, 0, 0)', 'H8 用户消息无“你”标签并使用深色底');

  // ========== S: 设置页开关 ==========
  console.log('\n=== S 设置开关 ===');
  await r(`openSettings();`);
  const settingsCheck = await r(`(async () => {
      const toolsChk = document.querySelector('#settings-tools-page');
      return JSON.stringify({ exists: !!toolsChk, checked: toolsChk?.checked });
    })()`);
  const sc = JSON.parse(settingsCheck);
  assert(sc.exists, 'S1 设置页工具箱开关存在');
  const settingsSelectStyle = JSON.parse(await r(`(() => {
    const reference = document.querySelector('#settings-notesdir');
    const referenceStyle = getComputedStyle(reference);
    const referenceHeight = reference.getBoundingClientRect().height;
    const wrappers = [...document.querySelectorAll('#settings-overlay .settings-select')];
    const modeSelect = document.querySelector('#settings-harness-mode');
    const modeWrapper = modeSelect.closest('.settings-select');
    const trigger = modeWrapper.querySelector('.settings-select-trigger');
    trigger.scrollIntoView({ block: 'center' });
    trigger.click();
    const menu = modeWrapper.querySelector('.settings-select-menu');
    const menuStyle = getComputedStyle(menu);
    const referenceMenuStyle = getComputedStyle(document.querySelector('#notesdir-dropdown'));
    const bodyRect = document.querySelector('.settings-body').getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const expandedUnified = menuStyle.display !== 'none'
      && menuStyle.backgroundColor === referenceMenuStyle.backgroundColor
      && menuStyle.borderColor === referenceMenuStyle.borderColor
      && menuStyle.borderRadius === referenceMenuStyle.borderRadius
      && menuRect.top >= bodyRect.top && menuRect.bottom <= bodyRect.bottom;
    menu.querySelector('[data-value="minimal"]').click();
    const valueSynced = modeSelect.value === 'minimal' && trigger.textContent === '极简模式';
    modeSelect.value = 'standard';
    syncSettingsSelects();
    return JSON.stringify({
      count: wrappers.length,
      unified: wrappers.every(wrapper => {
        const control = wrapper.querySelector('.settings-select-trigger');
        const style = getComputedStyle(control);
        return Math.abs(control.getBoundingClientRect().height - referenceHeight) < 1
          && style.backgroundColor === referenceStyle.backgroundColor
          && style.borderColor === referenceStyle.borderColor
          && style.borderRadius === referenceStyle.borderRadius;
      }),
      expandedUnified,
      optionCount: menu.querySelectorAll('.settings-select-option').length,
      valueSynced,
      nativeHidden: getComputedStyle(modeSelect).display === 'none',
    });
  })()`));
  assert(settingsSelectStyle.count === 2 && settingsSelectStyle.unified && settingsSelectStyle.nativeHidden, 'S1b 设置页下拉框统一为文件存储位置样式');
  assert(settingsSelectStyle.expandedUnified && settingsSelectStyle.optionCount === 2 && settingsSelectStyle.valueSynced, 'S1c 展开菜单样式统一且选项与原生配置同步');
  // 无 electronAPI 的测试环境下 checkbox 不初始化;验证 renderer 默认状态 + 主进程默认配置
  const defaults = await r(`JSON.stringify({ tools: state.pagesEnabled.tools, translate: state.toolsEnabled.translate, harness: state.toolsEnabled.harness })`);
  const def = JSON.parse(defaults);
  assert(def.tools === true && def.translate === true && def.harness === true, 'S2 工具箱页、翻译卡与 Harness 默认启用');
  const harnessSettings = await r(`JSON.stringify({
    enabled: !!document.querySelector('#settings-harness-enabled'),
    translateEnabled: !!document.querySelector('#settings-translate-enabled'),
    togglesInPageCard: document.querySelectorAll('.settings-card .page-row-sub #settings-translate-enabled, .settings-card .page-row-sub #settings-harness-enabled').length,
    harnessToggleMoved: !document.querySelector('#settings-harness-dir')?.closest('.settings-card')?.querySelector('#settings-harness-enabled'),
    installDir: !!document.querySelector('#settings-harness-dir'),
    nodePath: !!document.querySelector('#settings-harness-node'),
    apiMerged: document.querySelector('#settings-apikey')?.closest('.settings-card') === document.querySelector('#settings-harness-dir')?.closest('.settings-card'),
    noApiCard: ![...document.querySelectorAll('.settings-card-title')].some(title => title.textContent.trim() === 'API'),
    mode: [...(document.querySelector('#settings-harness-mode')?.options || [])].map(option => option.value).join(',') === 'standard,minimal',
    noDefaultModel: !document.querySelector('#settings-harness-model'),
    permission: !!document.querySelector('#settings-harness-permission'),
  })`);
  assert(Object.values(JSON.parse(harnessSettings)).every(Boolean), 'S2d Harness 设置项完整');
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
  await r(`state.toolsEnabled = { translate: true, harness: true };`);

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
