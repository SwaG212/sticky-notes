'use strict';

// 真实 Electron 渲染进程（360x500）监控台派活专区验收驱动。
// 通过 CDP 连接已运行的隔离实例，向 renderer 内存注入明确标注的 TEST 派活数据，
// 驱动真实渲染函数并断言：
//   1) 底线标签页筛选：选中亮蓝 + 加粗 + 底线（box-shadow inset 0 -2px 0）
//   2) 点卡片展开：fixed 铺满 360x500、其余内容淡出
//   3) Esc 收回：覆盖层隐藏、列表恢复、焦点回卡片
//   4) 详情层切页后不残留（Alt+1 与前后按钮两条入口）
//   5) 状态 / 进度 / 运行时间显示
//   6) 360x500 @1.25 DPR 像素检查（横向溢出、子像素、可点击区域）
//
// 用法：node tests/e2e/monitor_accept_drive.js [--port 9223] [--out .e2e/shots]
// 前置：已用隔离 userData 启动真实 Electron 且开启 --remote-debugging-port。
// 只改渲染进程内存状态，不写任何数据文件，不碰真实 userData。

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? dflt : process.argv[i + 1];
}

const PORT = Number(arg('port', 9223));
const OUT = arg('out', path.join(__dirname, '..', '..', '.e2e', 'shots'));

function httpGet(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 5000 }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write('GET ' + u.pathname + ' HTTP/1.1\r\nHost: ' + u.host +
        '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key +
        '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let buf = Buffer.alloc(0);
    let upgraded = false;
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const i = buf.indexOf('\r\n\r\n');
        if (i >= 0) {
          upgraded = true;
          buf = buf.slice(i + 4);
          resolve({ sock, take: () => { const b = buf; buf = Buffer.alloc(0); return b; } });
        }
      }
    });
    sock.on('error', reject);
    setTimeout(() => { if (!upgraded) reject(new Error('ws timeout')); }, 5000);
  });
}

function encodeFrame(payload) {
  const b = Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  let hdr;
  if (b.length < 126) hdr = Buffer.from([0x81, 0x80 | b.length]);
  else if (b.length < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x81; hdr[1] = 0xFE; hdr.writeUInt16BE(b.length, 2); }
  else { hdr = Buffer.alloc(10); hdr[0] = 0x81; hdr[1] = 0xFF; hdr.writeBigUInt64BE(BigInt(b.length), 2); }
  const out = Buffer.concat([hdr, mask, Buffer.alloc(b.length)]);
  for (let i = 0; i < b.length; i++) out[hdr.length + 4 + i] = b[i] ^ mask[i % 4];
  return out;
}

function parseFrames(buf) {
  const out = [];
  let o = 0;
  while (o + 2 <= buf.length) {
    const b2 = buf[o + 1];
    let len = b2 & 0x7f;
    let off = o + 2;
    if (len === 126) { if (o + 4 > buf.length) break; len = buf.readUInt16BE(o + 2); off = o + 4; }
    else if (len === 127) { if (o + 10 > buf.length) break; len = Number(buf.readBigUInt64BE(o + 2)); off = o + 10; }
    if (off + len > buf.length) break;
    out.push(buf.slice(off, off + len).toString());
    o = off + len;
  }
  return { frames: out, rest: buf.slice(o) };
}

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  [PASS] ' + msg); }
  else { failed++; console.log('  [FAIL] ' + msg); }
}
function equal(a, b, msg) {
  ok(Object.is(a, b), msg + ' (actual: ' + JSON.stringify(a) + ', expected: ' + JSON.stringify(b) + ')');
}

// TEST 数据：ID 带 TEST 标记，只注入 renderer 内存，不写盘。
function testDispatches(nowIso) {
  const base = Date.parse(nowIso);
  const mk = (tag, status, progress, minutesAgo, extra) => Object.assign({
    id: 'dispatch_2026-11-13_tttt' + tag + '-1111-4111-8111-111111111111',
    intentId: 'intent-test-' + tag,
    task: 'TEST 派活 ' + tag + ' 监控台验收样例',
    model: 'GLM',
    status,
    progress,
    dispatchedAt: new Date(base - minutesAgo * 60000).toISOString(),
    recordedAt: new Date(base - minutesAgo * 60000 + 2000).toISOString(),
    finishedAt: status === 'completed' ? new Date(base - 60000).toISOString() : null,
    clockSource: { dispatchedAt: 'muse', finishedAt: 'pc', recordedAt: 'pc' },
    statusDetail: null,
    executorRef: null,
    observationHealth: 'fresh',
    lastFactAt: new Date(base - 60000).toISOString(),
    updatedAt: new Date(base - 60000).toISOString(),
    revision: 2,
    project: 'TEST 项目',
    goal: null,
    tokenUsage: null
  }, extra || {});
  return [
    mk('aaaa', 'running', 45, 22),
    mk('bbbb', 'waiting', null, 5),
    mk('cccc', 'completed', 100, 90),
    mk('dddd', 'failed', 30, 120),
    mk('eeee', 'blocked', null, 60)
  ];
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const list = JSON.parse(await httpGet('/json/list'));
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('NO_PAGE_TARGET');
  const c = await wsConnect(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  function send(method, params) {
    return new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      c.sock.write(encodeFrame(JSON.stringify({ id: mid, method, params })));
    });
  }
  let rx = Buffer.alloc(0);
  c.sock.on('data', (d) => {
    rx = Buffer.concat([rx, d]);
    const r = parseFrames(rx);
    rx = r.rest;
    for (const f of r.frames) {
      try {
        const m = JSON.parse(f);
        if (m.id && pending.has(m.id)) {
          const p = pending.get(m.id);
          pending.delete(m.id);
          m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
        }
      } catch (e) { /* ignore non-JSON frames */ }
    }
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('EVAL: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  };
  const shot = async (name) => {
    try {
      const r = await Promise.race([
        send('Page.captureScreenshot', { format: 'png', fromSurface: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('SCREENSHOT_TIMEOUT')), 6000))
      ]);
      if (!r || !r.data) return null;
      const p = path.join(OUT, name + '.png');
      fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
      console.log('  [SHOT] ' + p);
      return p;
    } catch (e) {
      console.log('  [NOTE] screenshot ' + name + ' unavailable: ' + e.message);
      return null;
    }
  };

  console.log('真实渲染进程信息');
  const info = JSON.parse(await ev(`JSON.stringify({
    w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
    ua: navigator.userAgent.slice(0, 90),
    hasRender: typeof renderDispatchMonitor,
    hasExpand: typeof expandDispatchDetail,
    hasCollapse: typeof collapseMonitorTask,
    hasSwitch: typeof switchToMonitor
  })`));
  console.log('  viewport=' + info.w + 'x' + info.h + ' dpr=' + info.dpr);
  equal(info.w, 360, '真实窗口宽度 360');
  equal(info.h, 500, '真实窗口高度 500');
  ok(info.hasRender === 'function' && info.hasExpand === 'function' && info.hasCollapse === 'function',
    '派活渲染/展开/收回函数在真实渲染进程可用');

  // 真实 App：先确认主进程是否注册了派活 IPC（旧主进程没有 handler）。
  // 有 handler 时走真实 IPC 打开 Flag；没有时记 NOTE 并改用渲染层等价路径，
  // 不把“旧主进程实例”当成新代码的通过证据。
  const ipc = JSON.parse(await ev(`(async () => {
    let flag = 'NO_HANDLER';
    try {
      await window.electronAPI.setMonitorDispatchSource(true);
      flag = 'OK:' + (await window.electronAPI.getMonitorDispatchSource());
    } catch (e) { flag = 'NO_HANDLER:' + e.message.slice(0, 60); }
    switchToMonitor();
    return JSON.stringify({ flag, page: state.currentPage, source: state.monitorSource });
  })()`));
  const ipcOk = String(ipc.flag).indexOf('OK:true') === 0;
  if (ipcOk) {
    ok(true, '真实 IPC 打开派活数据源（monitorDispatchesEnabled=true）');
    equal(ipc.source, 'dispatches', '监控台数据源为 dispatches');
  } else {
    console.log('  [NOTE] 当前运行实例主进程未注册派活 IPC：' + ipc.flag);
    console.log('  [NOTE] 改用渲染层等价路径（直接 setMonitorSource）验证 UI 契约；主进程 IPC 由 Electron 主进程测试覆盖');
    await ev(`(() => { setMonitorSource('dispatches'); state.monitorStatus = 'ready'; })()`);
    equal(await ev(`state.monitorSource`), 'dispatches', '渲染层等价路径切到 dispatches 数据源');
  }
  equal(ipc.page, 'monitor', '切到监控台页');

  console.log('注入 TEST 派活数据并渲染');
  const nowIso = new Date().toISOString();
  const inject = JSON.parse(await ev(`(() => {
    state.monitorSource = 'dispatches';
    state.monitorStatus = 'ready';
    state.monitorFilter = 'all';
    state.monitorPage = 1;
    state.monitorPageSize = 50;
    state.monitorDispatches = ${JSON.stringify(testDispatches(nowIso))};
    state.monitorSnapshotMeta = { complete: true, staleFileCount: 0, unreadDates: [], errors: [] };
    state.monitorLastSyncAt = Date.now();
    renderDispatchMonitor();
    return JSON.stringify({
      cards: document.querySelectorAll('#monitor-list .monitor-dispatch-card').length,
      pageActive: document.querySelector('.page.active') ? document.querySelector('.page.active').className : null
    });
  })()`));
  equal(inject.cards, 5, '5 张 TEST 派活卡片渲染进真实 DOM');
  const pageState = JSON.parse(await ev(`JSON.stringify({
    page: state.currentPage,
    onMonitor: document.querySelector('.pages-container').classList.contains('on-monitor'),
    transform: document.querySelector('.pages-container').style.transform
  })`));
  equal(pageState.page, 'monitor', '监控台页处于激活态（state.currentPage）');
  ok(pageState.onMonitor, 'pages-container 带 on-monitor 位移类（transform=' + pageState.transform + '）');
  await shot('01-monitor-list');

  console.log('底线标签页筛选：选中亮蓝 + 加粗 + 底线');
  const tabStates = JSON.parse(await ev(`(() => {
    const tabs = Array.from(document.querySelectorAll('.monitor-filter-tab'));
    const read = () => tabs.map(t => {
      const cs = getComputedStyle(t);
      return {
        filter: t.dataset.filter,
        active: t.classList.contains('active'),
        color: cs.color,
        weight: cs.fontWeight,
        shadow: cs.boxShadow,
        borderBottom: cs.borderBottomWidth + ' ' + cs.borderBottomStyle + ' ' + cs.borderBottomColor
      };
    });
    const before = read();
    const runningTab = tabs.find(t => (t.dataset.filter || '') === 'running');
    if (runningTab) runningTab.click();
    const after = read();
    return JSON.stringify({ before, after, cards: document.querySelectorAll('#monitor-list .monitor-dispatch-card').length });
  })()`));
  const activeBefore = tabStates.before.filter((t) => t.active).map((t) => t.filter);
  const activeAfter = tabStates.after.filter((t) => t.active).map((t) => t.filter);
  equal(activeBefore.join(','), 'all', '初始选中“全部”');
  equal(activeAfter.join(','), 'running', '点击后只有“运行中”选中');
  const runStyle = tabStates.after.find((t) => t.filter === 'running');
  const allStyle = tabStates.after.find((t) => t.filter === 'all');
  ok(Number(runStyle.weight) >= 600, '选中标签加粗（font-weight=' + runStyle.weight + '）');
  const hasBottomLine = /inset/.test(runStyle.shadow) && /-?2px/.test(runStyle.shadow) ||
    runStyle.borderBottom.startsWith('2px') || runStyle.borderBottom.startsWith('3px');
  ok(hasBottomLine, '选中标签有底线（box-shadow=' + runStyle.shadow + '；border=' + runStyle.borderBottom + '）');
  ok(runStyle.color !== allStyle.color, '选中/未选中颜色不同（' + runStyle.color + ' vs ' + allStyle.color + '）');
  const blue = /rgb\(10, 36, 233\)/.test(runStyle.color);
  ok(blue, '选中标签为亮蓝 #0A24E9（实际 ' + runStyle.color + '）');
  equal(tabStates.cards, 1, '“运行中”筛选后只剩 1 张卡');
  await shot('02-filter-running');

  await ev(`(() => { const t = Array.from(document.querySelectorAll('.monitor-filter-tab')).find(x => (x.dataset.filter||'')==='all'); if (t) t.click(); })()`);

  console.log('点卡片展开：铺满窗口、其余淡出');
  const expand = JSON.parse(await ev(`(() => {
    const card = document.querySelector('#monitor-list .monitor-dispatch-card');
    if (!card) return JSON.stringify({ error: 'NO_CARD' });
    card.click();
    const layer = document.querySelector('#monitor-expand-card');
    if (!layer) return JSON.stringify({ error: 'NO_LAYER', expandedId: state.monitorExpandedId });
    const overlay = layer.closest('.monitor-expand-overlay') || layer;
    const r = overlay.getBoundingClientRect();
    const cs = getComputedStyle(overlay);
    const list = document.querySelector('#monitor-list');
    const listCs = list ? getComputedStyle(list) : null;
    const bodyCs = getComputedStyle(document.body);
    return JSON.stringify({
      expandedId: state.monitorExpandedId,
      parent: overlay.parentElement ? overlay.parentElement.tagName : null,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      position: cs.position,
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      bodyOverflow: bodyCs.overflow,
      listOpacity: listCs ? listCs.opacity : null,
      listVisibility: listCs ? listCs.visibility : null,
      winW: innerWidth, winH: innerHeight
    });
  })()`));
  ok(!expand.error, '点卡片打开详情层（' + (expand.error || 'ok') + '）');
  equal(Math.round(expand.rect.x), 0, '详情层左边贴 0');
  equal(Math.round(expand.rect.y), 0, '详情层顶边贴 0');
  equal(Math.round(expand.rect.w), 360, '详情层铺满宽 360');
  equal(Math.round(expand.rect.h), 500, '详情层铺满高 500');
  equal(expand.position, 'fixed', '详情层用 position:fixed 铺满窗口');
  equal(expand.parent, 'BODY', '详情层挂在 body 上（不留在页面容器内）');
  ok(expand.listOpacity === '0' || expand.listVisibility === 'hidden' || Number(expand.listOpacity) < 1,
    '其余内容淡出（list opacity=' + expand.listOpacity + ' visibility=' + expand.listVisibility + '）');
  await shot('03-expanded-detail');

  console.log('Esc 收回');
  const esc = JSON.parse(await ev(`(() => {
    const evt = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(evt);
    const layer = document.querySelector('#monitor-expand-card');
    const overlay = layer ? (layer.closest('.monitor-expand-overlay') || layer) : null;
    const cs = overlay ? getComputedStyle(overlay) : null;
    const list = document.querySelector('#monitor-list');
    return JSON.stringify({
      expandedId: state.monitorExpandedId,
      overlayHiddenAttr: overlay ? overlay.hidden : null,
      overlayDisplay: cs ? cs.display : null,
      overlayOpacity: cs ? cs.opacity : null,
      listOpacity: list ? getComputedStyle(list).opacity : null,
      cards: document.querySelectorAll('#monitor-list .monitor-dispatch-card').length,
      focusInOverlay: overlay ? overlay.contains(document.activeElement) : false,
      activeTag: document.activeElement ? document.activeElement.tagName : null
    });
  })()`));
  equal(esc.expandedId, null, 'Esc 清空 monitorExpandedId');
  ok(esc.overlayHiddenAttr === true || esc.overlayDisplay === 'none', 'Esc 隐藏详情层（hidden=' + esc.overlayHiddenAttr + ' display=' + esc.overlayDisplay + '）');
  ok(Number(esc.listOpacity) === 1 || esc.listOpacity === null, 'Esc 恢复列表可见（opacity=' + esc.listOpacity + '）');
  equal(esc.cards, 5, 'Esc 后 5 张卡都在');
  await shot('04-after-esc');

  console.log('详情层切页后不残留');
  const switchPage = JSON.parse(await ev(`(async () => {
    switchToMonitor();
    await new Promise(r => setTimeout(r, 50));
    state.monitorSource='dispatches'; state.monitorStatus='ready'; state.monitorFilter='all';
    state.monitorDispatches = ${JSON.stringify(testDispatches(nowIso))};
    state.monitorSnapshotMeta = { complete: true, staleFileCount: 0, unreadDates: [], errors: [] };
    renderDispatchMonitor();
    const card = document.querySelector('#monitor-list .monitor-dispatch-card');
    card.click();
    const expandedBefore = state.monitorExpandedId;
    await switchToMain();
    await new Promise(r => setTimeout(r, 50));
    const layer = document.querySelector('#monitor-expand-card');
    const overlay = layer ? (layer.closest('.monitor-expand-overlay') || layer) : null;
    const cs = overlay ? getComputedStyle(overlay) : null;
    const visible = overlay ? (cs.display !== 'none' && cs.visibility !== 'hidden' && !overlay.hidden && Number(cs.opacity) > 0) : false;
    return JSON.stringify({
      expandedBefore,
      expandedAfter: state.monitorExpandedId,
      layerVisible: visible,
      overlayHiddenAttr: overlay ? overlay.hidden : null,
      currentPage: state.currentPage,
      onMain: document.querySelector('.pages-container').classList.contains('on-monitor') === false,
      focusInOverlay: overlay ? overlay.contains(document.activeElement) : false
    });
  })()`));
  ok(switchPage.expandedBefore !== null, '切页前详情层确实展开');
  equal(switchPage.expandedAfter, null, '切页清空 monitorExpandedId');
  ok(switchPage.layerVisible === false, '切页后详情层不可见（无残留）');
  equal(switchPage.currentPage, 'main', '确实切到主页面');
  ok(switchPage.onMain, 'pages-container 已离开 on-monitor 位移');
  equal(switchPage.focusInOverlay, false, '焦点未困在已收起的详情层');

  // 第二条入口：Alt+1（键盘切页）
  const altSwitch = JSON.parse(await ev(`(async () => {
    await switchToMonitor();
    await new Promise(r => setTimeout(r, 50));
    state.monitorSource='dispatches'; state.monitorStatus='ready'; state.monitorFilter='all';
    state.monitorDispatches = ${JSON.stringify(testDispatches(nowIso))};
    state.monitorSnapshotMeta = { complete: true, staleFileCount: 0, unreadDates: [], errors: [] };
    renderDispatchMonitor();
    const card = document.querySelector('#monitor-list .monitor-dispatch-card');
    if (!card) return JSON.stringify({ error: 'NO_CARD' });
    card.click();
    const before = state.monitorExpandedId;
    const evt = new KeyboardEvent('keydown', { key: '1', code: 'Digit1', altKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(evt);
    await new Promise(r => setTimeout(r, 200));
    const layer = document.querySelector('#monitor-expand-card');
    const overlay = layer ? (layer.closest('.monitor-expand-overlay') || layer) : null;
    const cs = overlay ? getComputedStyle(overlay) : null;
    const visible = overlay ? (cs.display !== 'none' && !overlay.hidden && Number(cs.opacity) > 0) : false;
    return JSON.stringify({ before, after: state.monitorExpandedId, visible, currentPage: state.currentPage });
  })()`));
  ok(!altSwitch.error, 'Alt+1 用例拿到卡片（' + (altSwitch.error || 'ok') + '）');
  ok(altSwitch.before !== null, 'Alt+1 前详情层展开');
  equal(altSwitch.after, null, 'Alt+1 切页清空 monitorExpandedId');
  ok(altSwitch.visible === false, 'Alt+1 切页后详情层无残留');
  equal(altSwitch.currentPage, 'main', 'Alt+1 确实切到主页面');
  await shot('05-after-page-switch');

  console.log('状态 / 进度 / 运行时间显示');
  const display = JSON.parse(await ev(`(() => {
    switchToMonitor();
    state.monitorSource = 'dispatches'; state.monitorStatus = 'ready'; state.monitorFilter = 'all';
    state.monitorDispatches = ${JSON.stringify(testDispatches(nowIso))};
    state.monitorSnapshotMeta = { complete: true, staleFileCount: 0, unreadDates: [], errors: [] };
    renderDispatchMonitor();
    const cards = Array.from(document.querySelectorAll('#monitor-list .monitor-dispatch-card'));
    const texts = cards.map(c => c.textContent.replace(/\\s+/g, ' ').trim());
    const badges = cards.map(c => {
      const b = c.querySelector('.monitor-model');
      return b ? b.textContent.trim() : null;
    });
    return JSON.stringify({
      count: cards.length,
      texts,
      badges,
      hasRunning: texts.some(t => /运行中|进行中/.test(t)),
      hasCompleted: texts.some(t => /已完成/.test(t)),
      hasWaiting: texts.some(t => /等待/.test(t)),
      hasFailed: texts.some(t => /失败/.test(t)),
      hasBlocked: texts.some(t => /阻塞/.test(t)),
      hasProgress45: texts.some(t => /45\\s*%/.test(t)),
      hasProgress100: texts.some(t => /100\\s*%/.test(t)),
      hasRuntime: texts.some(t => /分钟|小时|秒/.test(t))
    });
  })()`));
  equal(display.count, 5, '5 张卡全部恢复');
  ok(display.hasRunning, '显示“运行中”');
  ok(display.hasCompleted, '显示“已完成”');
  ok(display.hasWaiting, '显示“等待”');
  ok(display.hasFailed, '显示“失败”');
  ok(display.hasBlocked, '显示“阻塞”');
  ok(display.hasProgress45, '显示 45% 进度');
  ok(display.hasProgress100, '显示 100% 进度');
  ok(display.hasRuntime, '显示运行/历时时间');
  ok(display.badges.every((b) => b && b.indexOf('GLM') !== -1), '每张卡都有 GLM 模型徽标');
  await shot('06-status-progress-runtime');

  console.log('360x500 @1.25 DPR 像素检查');
  const px = JSON.parse(await ev(`(async () => {
    await switchToMonitor();
    await new Promise(r => setTimeout(r, 60));
    state.monitorSource='dispatches'; state.monitorStatus='ready'; state.monitorFilter='all';
    state.monitorDispatches = ${JSON.stringify(testDispatches(nowIso))};
    state.monitorSnapshotMeta = { complete: true, staleFileCount: 0, unreadDates: [], errors: [] };
    renderDispatchMonitor();
    const cards = Array.from(document.querySelectorAll('#monitor-list .monitor-dispatch-card'));
    const tabs = Array.from(document.querySelectorAll('.monitor-filter-tab'));
    const rect = (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, x: r.x, y: r.y }; };
    const tabRects = tabs.map(rect);
    const cardRects = cards.map(rect);
    return JSON.stringify({
      dpr: devicePixelRatio,
      scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight,
      innerW: innerWidth,
      innerH: innerHeight,
      overflowX: document.documentElement.scrollWidth > innerWidth,
      tabCount: tabs.length,
      tabTooNarrow: tabRects.filter(r => r.w < 40).length,
      tabWidths: tabRects.map(r => Math.round(r.w * 100) / 100),
      cardCount: cards.length,
      zeroHeightCards: cardRects.filter(r => r.h <= 0).length,
      subpixelCards: cardRects.filter(r => Math.abs(r.w - Math.round(r.w)) > 0.01 || Math.abs(r.h - Math.round(r.h)) > 0.01).length,
      cardMinHeight: cardRects.length ? Math.min.apply(null, cardRects.map(r => r.h)) : null,
      listHeight: document.querySelector('#monitor-list').getBoundingClientRect().height,
      fonts: Array.from(new Set(Array.from(document.querySelectorAll('#monitor-list *')).map(e => getComputedStyle(e).fontSize))).slice(0, 8)
    });
  })()`));
  console.log('  dpr=' + px.dpr + ' scroll=' + px.scrollW + 'x' + px.scrollH + ' inner=' + px.innerW + 'x' + px.innerH);
  equal(px.overflowX, false, '360 宽无横向溢出');
  equal(px.zeroHeightCards, 0, '无 0 高卡片（布局未塌陷）');
  ok(px.tabTooNarrow === 0, '底线标签页未被挤到 40px 以下');
  console.log('  标签宽度: ' + px.tabWidths.join(', '));
  console.log('  卡片最小高度: ' + px.cardMinHeight);
  ok(px.cardMinHeight !== null && px.cardMinHeight >= 48, '卡片高度足够点击（min=' + px.cardMinHeight + '）');
  ok(px.subpixelCards === 0, '卡片尺寸无子像素（@1.25 DPR 下不出现半像素线，实际 ' + px.subpixelCards + ' 张）');

  console.log('');
  console.log('passed ' + passed + ' failed ' + failed);
  console.log('screenshots: ' + OUT);
  c.sock.end();
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('ERR ' + e.message);
  process.exit(2);
});
