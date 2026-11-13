const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

let win = null;
let pass = 0;
let fail = 0;
let timeout = null;

// 隔离 userData：必须在 require main.js 之前设置，main.js 在加载时读取 userDataPath。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-snap-'));
const dispDir = path.join(tmpDir, 'dispatches');
const tasksDir = path.join(tmpDir, 'tasks');
fs.mkdirSync(dispDir, { recursive: true });
fs.mkdirSync(tasksDir, { recursive: true });

function makeRecord(id, model, status, minsAgo, extra) {
  const now = Date.now();
  const base = {
    schemaVersion: 1,
    writerVersion: '1.0.0',
    minimumReaderVersion: '1.0.0',
    id: id,
    intentId: 'intent-' + id.slice(-4),
    workItemId: null,
    task: '测试派活 ' + id.slice(-4),
    model: model,
    status: status,
    observationHealth: 'fresh',
    observationDetail: null,
    progress: status === 'completed' ? 100 : 60,
    dispatchedAt: new Date(now - minsAgo * 60000).toISOString(),
    recordedAt: new Date(now - minsAgo * 60000).toISOString(),
    finishedAt: status === 'completed' ? new Date(now - 30 * 60000).toISOString() : null,
    clockSource: { dispatchedAt: 'pc', finishedAt: 'pc', recordedAt: 'pc' },
    project: '报价单',
    goal: null,
    statusDetail: '阶段：验证',
    executorRef: null,
    tokenUsage: null,
    usageSource: null,
    provider: null,
    modelVersion: null,
    usageScope: null,
    cachedTokens: null,
    updatedAt: new Date(now - 60000).toISOString(),
    revision: 1,
    lastOperationId: '11111111-1111-4111-8111-111111111111',
    lastFactAt: new Date(now - 60000).toISOString()
  };
  return Object.assign(base, extra || {});
}

const rec1 = makeRecord('dispatch_2026-11-12_00000000-0000-4000-8000-000000000001', 'GLM', 'running', 22);
const rec2 = makeRecord('dispatch_2026-11-12_00000000-0000-4000-8000-000000000002', 'DeepSeek', 'waiting', 5, { progress: null });
const rec3 = makeRecord('dispatch_2026-11-12_00000000-0000-4000-8000-000000000003', 'Astra', 'completed', 120);
const fixture12 = [rec1, rec2, rec3];
fs.writeFileSync(path.join(dispDir, '2026-11-12.json'), JSON.stringify(fixture12), 'utf-8');
fs.writeFileSync(path.join(dispDir, '2026-11-11.json'), '{invalid json', 'utf-8');
fs.writeFileSync(path.join(dispDir, '2026-11-12.json.lock'), '', 'utf-8');
fs.writeFileSync(path.join(dispDir, '2026-11-12.json.bak'), '[]', 'utf-8');
fs.writeFileSync(path.join(tasksDir, '2026-11-12.json'), JSON.stringify([
  { id: 't-muse-1', task: '今天发一篇小红书', source: 'muse', model: 'Muse', progress: 0, status: 'waiting', completed: false, createdAt: new Date().toISOString() }
]), 'utf-8');

function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('✅ ' + name);
  } else {
    fail += 1;
    console.log('❌ ' + name + (detail ? '：' + detail : ''));
  }
}

async function runInPage(fn, ...args) {
  const argText = args.map((arg) => JSON.stringify(arg)).join(', ');
  const script = '(' + fn.toString() + ')(' + argText + ')';
  return await win.webContents.executeJavaScript(script, true);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function finish(code) {
  if (timeout) clearTimeout(timeout);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 监听句柄可能占用，忽略 */ }
  console.log('通过 ' + pass + ' 失败 ' + fail);
  app.exit(code);
}

async function run() {
  timeout = setTimeout(() => {
    console.error('❌ 测试超时');
    finish(1);
  }, 90000);

  app.setPath('userData', tmpDir);
  require('../main.js');
  await app.whenReady();
  await sleep(800);

  win = new BrowserWindow({
    show: true,
    width: 360,
    height: 500,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await sleep(800);

  const hasBridge = await runInPage(function () {
    return {
      api: !!window.electronAPI,
      getDispatchSnapshot: typeof (window.electronAPI && window.electronAPI.getDispatchSnapshot),
      getMonitorDispatchSource: typeof (window.electronAPI && window.electronAPI.getMonitorDispatchSource),
      setMonitorDispatchSource: typeof (window.electronAPI && window.electronAPI.setMonitorDispatchSource),
      onDispatchChanged: typeof (window.electronAPI && window.electronAPI.onDispatchChanged),
      onMonitorChanged: typeof (window.electronAPI && window.electronAPI.onMonitorChanged),
      getMonitorSnapshot: typeof (window.electronAPI && window.electronAPI.getMonitorSnapshot)
    };
  });
  check('S1 preload 暴露派活桥', hasBridge.api && hasBridge.getDispatchSnapshot === 'function' && hasBridge.getMonitorDispatchSource === 'function' && hasBridge.setMonitorDispatchSource === 'function' && hasBridge.onDispatchChanged === 'function' && hasBridge.onMonitorChanged === 'function', JSON.stringify(hasBridge));

  const flag0 = await runInPage(async function () {
    return await window.electronAPI.getMonitorDispatchSource();
  });
  check('S2 Flag 默认关闭', flag0 === false, '实际 ' + JSON.stringify(flag0));
  const flagSet = await runInPage(async function () {
    return await window.electronAPI.setMonitorDispatchSource(true);
  });
  check('S2 setMonitorDispatchSource(true) 返回 true', flagSet === true, '实际 ' + JSON.stringify(flagSet));
  const flag1 = await runInPage(async function () {
    return await window.electronAPI.getMonitorDispatchSource();
  });
  check('S2 Flag 设置后为 true', flag1 === true, '实际 ' + JSON.stringify(flag1));

  const snap1 = await runInPage(async function () {
    return await window.electronAPI.getDispatchSnapshot();
  });
  check('S3 快照 source 为 dispatches', snap1 && snap1.source === 'dispatches', '实际 ' + JSON.stringify(snap1 && snap1.source));
  check('S3 快照含 3 条派活', snap1 && Array.isArray(snap1.records) && snap1.records.length === 3, '实际 ' + JSON.stringify(snap1 && snap1.records && snap1.records.length));
  const ids1 = (snap1.records || []).map((r) => r.id).sort();
  check('S3 快照含三条目标 ID', JSON.stringify(ids1) === JSON.stringify([
    'dispatch_2026-11-12_00000000-0000-4000-8000-000000000001',
    'dispatch_2026-11-12_00000000-0000-4000-8000-000000000002',
    'dispatch_2026-11-12_00000000-0000-4000-8000-000000000003'
  ]), JSON.stringify(ids1));
  check('S3 快照不含日程任务', !(snap1.records || []).some((r) => r.id === 't-muse-1'));
  check('S3 损坏文件使 complete=false', snap1 && snap1.complete === false, '实际 ' + JSON.stringify(snap1 && snap1.complete));
  check('S3 错误含 2026-11-11 PARSE_ERROR', !!(snap1.errors || []).some((e) => e.date === '2026-11-11' && e.error === 'PARSE_ERROR'), JSON.stringify(snap1.errors));
  check('S3 锁/备份文件未进入快照', !(snap1.errors || []).some((e) => (e.date || '').indexOf('lock') >= 0 || (e.date || '').indexOf('bak') >= 0) && (snap1.records || []).length === 3);
  check('S3 快照含 epoch/revision/lastReadAt', typeof snap1.epoch === 'number' && typeof snap1.revision === 'number' && typeof snap1.lastReadAt === 'string', JSON.stringify({ epoch: snap1.epoch, revision: snap1.revision }));
  const rev1 = snap1.revision;

  const legacy = await runInPage(async function () {
    return await window.electronAPI.getMonitorSnapshot();
  });
  check('S4 旧快照 source 为 tasks', legacy && legacy.source === 'tasks', '实际 ' + JSON.stringify(legacy && legacy.source));
  check('S4 旧快照仍含 Muse 日程任务', Array.isArray(legacy.tasks) && legacy.tasks.some((t) => t.id === 't-muse-1'), '实际 ' + JSON.stringify(legacy.tasks && legacy.tasks.length));
  check('S4 旧快照不含派活', !(legacy.tasks || []).some((t) => String(t.id || '').indexOf('dispatch_') === 0));

  // 事件只发给主窗口（main.js 的 win），探测窗口收不到：S5 用主窗口订阅。
  let mainWin = null;
  for (let i = 0; i < 40; i++) {
    mainWin = BrowserWindow.getAllWindows().find((w) => w !== win);
    if (mainWin) break;
    await sleep(250);
  }
  check('S5 主窗口存在', !!mainWin);
  async function runInMain(fn, ...args) {
    const argText = args.map((arg) => JSON.stringify(arg)).join(', ');
    const script = '(' + fn.toString() + ')(' + argText + ')';
    return await mainWin.webContents.executeJavaScript(script, true);
  }
  await runInMain(function () {
    window.__dc = 0;
    window.electronAPI.onDispatchChanged(function () { window.__dc = (window.__dc || 0) + 1; });
    return true;
  });
  const rec4 = makeRecord('dispatch_2026-11-12_00000000-0000-4000-8000-000000000004', 'Sol', 'blocked', 10, { statusDetail: '等依赖' });
  fs.writeFileSync(path.join(dispDir, '2026-11-12.json'), JSON.stringify([rec1, rec2, rec3, rec4]), 'utf-8');
  let changed = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    changed = await runInMain(function () { return window.__dc || 0; });
    if (changed >= 1) break;
  }
  check('S5 文件变化触发 dispatches:changed', changed >= 1, '实际 ' + changed);
  const snap2 = await runInPage(async function () {
    return await window.electronAPI.getDispatchSnapshot();
  });
  check('S5 变化后快照含 4 条', snap2 && Array.isArray(snap2.records) && snap2.records.length === 4, '实际 ' + JSON.stringify(snap2 && snap2.records && snap2.records.length));
  check('S5 revision 递增', typeof snap2.revision === 'number' && snap2.revision > rev1, 'rev1=' + rev1 + ' rev2=' + snap2.revision);

  const ref = await runInPage(async function () {
    return await window.electronAPI.refreshDispatchSnapshot();
  });
  check('S6 refreshDispatchSnapshot 返回 revision', ref && typeof ref.revision === 'number', JSON.stringify(ref));

  await finish(fail === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error('❌ 测试异常', e && e.stack || e);
  finish(1);
});
