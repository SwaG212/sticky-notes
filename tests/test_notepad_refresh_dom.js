// 笔记页刷新后窗口拖动区与设置按钮回归测试
// 运行: node_modules\electron\dist\electron.exe tests\test_notepad_refresh_dom.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const preloadPath = path.join(__dirname, '.notepad-refresh-preload.js');
  fs.writeFileSync(preloadPath, `
const { contextBridge } = require('electron');
let page = 'notepad';
contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => Promise.resolve({ winFixed: false, pagesEnabled: { tasks: true, tools: true } }),
  getPage: () => Promise.resolve(page),
  setPage: (next) => { page = next; return Promise.resolve(); },
  loadTasks: () => Promise.resolve([]),
  saveTasks: () => Promise.resolve(),
  listNotes: () => Promise.resolve([{ filename: 'refresh-test.md' }]),
  readNote: () => Promise.resolve('refresh test'),
  saveNote: () => Promise.resolve(),
  getPinnedNotes: () => Promise.resolve([]),
  hasApiKey: () => Promise.resolve(false),
  getLoginSettings: () => Promise.resolve(false),
  setSettingsOpen: () => Promise.resolve(),
  onOpenConfig: () => {}, onWindowShown: () => {}, onWindowBlur: () => {}, onWindowWillHide: () => {},
});
`);

  const win = new BrowserWindow({
    show: true,
    width: 360,
    height: 500,
    frame: false,
    webPreferences: { preload: preloadPath, contextIsolation: true },
  });
  const run = (code) => win.webContents.executeJavaScript(code);
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await wait(500);

  await win.webContents.reload();
  await wait(700);

  const refreshed = JSON.parse(await run(`(() => {
    const handle = document.querySelector('#window-drag-handle');
    const rect = handle.getBoundingClientRect();
    const style = getComputedStyle(handle);
    return JSON.stringify({
      onNotepad: pagesContainer.classList.contains('on-notepad') && state.currentPage === 'notepad',
      outsideSlider: handle.parentElement === app,
      displayed: style.display === 'block',
      draggable: style.webkitAppRegion === 'drag',
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
    });
  })()`));
  assert(refreshed.onNotepad, '刷新后恢复笔记页状态');
  assert(refreshed.outsideSlider, '拖动区位于滑动页面容器外');
  assert(refreshed.displayed && refreshed.draggable, '刷新后拖动区仍为原生 drag 区域');

  const settingsPoint = JSON.parse(await run(`(() => {
    const rect = document.querySelector('#btn-settings').getBoundingClientRect();
    return JSON.stringify({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) });
  })()`));
  win.focus();
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...settingsPoint });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...settingsPoint });
  await wait(150);
  assert(await run(`!settingsOverlay.classList.contains('hidden')`), '刷新后设置按钮仍可点击');

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  await win.close();
  fs.unlinkSync(preloadPath);
  app.exit(failed ? 1 : 0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
