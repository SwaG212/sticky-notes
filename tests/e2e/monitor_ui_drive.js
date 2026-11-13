'use strict';

// Real Electron renderer (360x500) monitor dispatch UI acceptance driver.
// Injects TEST dispatch data into renderer state via CDP, drives the real render
// functions, and asserts: bottom-line tab filtering, card expand to full window,
// Esc collapse, no residue after page switch, status/progress/runtime display.
//
// Usage: node tests/e2e/monitor_ui_drive.js [--port 9223] [--out .e2e/shots]
// Precondition: a real Electron instance is running with --remote-debugging-port.
// Only touches renderer memory state; writes no data files, never touches real userData.

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

// TEST dispatch data: clearly marked, injected into renderer memory only.
function testDispatches(nowIso) {
  const base = Date.parse(nowIso);
  const mk = (id, status, progress, minutesAgo) => ({
    id: 'dispatch_2026-11-13_' + id,
    intentId: 'intent-test-' + id,
    task: 'TEST dispatch ' + id.slice(0, 4),
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
    project: null,
    goal: null,
    tokenUsage: null
  });
  return [
    mk('aaaa1111-1111-4111-8111-111111111111', 'running', 45, 22),
    mk('bbbb2222-2222-4222-8222-222222222222', 'waiting', null, 5),
    mk('cccc3333-3333-4333-8333-333333333333', 'completed', 100, 90),
    mk('dddd4444-4444-4444-8444-444444444444', 'failed', 30, 120),
    mk('eeee5555-5555-4555-8555-555555555555', 'blocked', null, 60)
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
  c.sock.on('data', (d) => {
    const r = parseFrames(Buffer.concat([c.take(), d]));
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
    if (r.exceptionDetails) throw new Error('EVAL: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  };
  // Screenshot: the app window lives in another session and is not composited, so
  // Page.captureScreenshot can block indefinitely. Use a bounded timeout and fall back
  // to DOM/geometry evidence; never let capture hang the acceptance run.
  const shot = async (name) => {
    try {
      const r = await Promise.race([
        send('Page.captureScreenshot', { format: 'png', fromSurface: false, captureBeyondViewport: false }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('SCREENSHOT_TIMEOUT')), 4000))
      ]);
      if (!r || !r.data) return null;
      const p = path.join(OUT, name + '.png');
      fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
      return p;
    } catch (e) {
      console.log('  [NOTE] screenshot ' + name + ' unavailable: ' + e.message);
      return null;
    }
  };

  console.log('Real renderer info');
  const info = JSON.parse(await ev(`JSON.stringify({
    w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
    ua: navigator.userAgent.slice(0,80),
    hasRender: typeof renderDispatchMonitor,
    hasExpand: typeof expandDispatchDetail,
    hasCollapse: typeof collapseMonitorTask
  })`));
  console.log('  viewport=' + info.w + 'x' + info.h + ' dpr=' + info.dpr);
  equal(info.w, 360, 'real window width is 360');
  equal(info.h, 500, 'real window height is 500');
  ok(info.hasRender === 'function' && info.hasExpand === 'function' && info.hasCollapse === 'function',
    'dispatch render functions available in real renderer');

  console.log('Inject TEST dispatch data and render');
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
    return JSON.stringify({ cards: document.querySelectorAll('#monitor-list .monitor-dispatch-card').length });
  })()`));
  equal(inject.cards, 5, '5 dispatch cards rendered into real DOM');
  await shot('01-monitor-list');

  console.log('Bottom-line tab filter: selected bold + bottom line');
  const tabStates = JSON.parse(await ev(`(() => {
    const tabs = Array.from(document.querySelectorAll('.monitor-filter-tab'));
    const read = () => tabs.map(t => {
      const cs = getComputedStyle(t);
      return {
        filter: t.dataset.filter,
        active: t.classList.contains('active') || t.classList.contains('is-active'),
        color: cs.color,
        weight: cs.fontWeight,
        borderBottom: cs.borderBottomWidth + ' ' + cs.borderBottomStyle + ' ' + cs.borderBottomColor
      };
    });
    const before = read();
    const runningTab = tabs.find(t => (t.dataset.filter || '') === 'running');
    if (runningTab) runningTab.click();
    const after = read();
    return JSON.stringify({ before: before, after: after, cards: document.querySelectorAll('#monitor-list .monitor-dispatch-card').length });
  })()`));
  const activeBefore = tabStates.before.filter((t) => t.active).map((t) => t.filter);
  const activeAfter = tabStates.after.filter((t) => t.active).map((t) => t.filter);
  equal(activeBefore.join(','), 'all', 'initially "all" tab selected');
  equal(activeAfter.join(','), 'running', 'after click only "running" tab selected');
  const runningStyle = tabStates.after.find((t) => t.filter === 'running');
  const allStyle = tabStates.after.find((t) => t.filter === 'all');
  ok(Number(runningStyle.weight) >= 600, 'selected tab is bold (font-weight=' + runningStyle.weight + ')');
  ok(runningStyle.borderBottom.startsWith('2px') || runningStyle.borderBottom.startsWith('3px'),
    'selected tab has bottom line (' + runningStyle.borderBottom + ')');
  ok(runningStyle.color !== allStyle.color,
    'selected tab color differs from unselected (' + runningStyle.color + ' vs ' + allStyle.color + ')');
  equal(tabStates.cards, 1, 'running filter leaves exactly 1 card');
  await shot('02-filter-running');

  await ev(`(() => { const t = Array.from(document.querySelectorAll('.monitor-filter-tab')).find(x => (x.dataset.filter||'')==='all'); if (t) t.click(); })()`);

  console.log('Click card to expand: fill window, others fade');
  const expand = JSON.parse(await ev(`(() => {
    const card = document.querySelector('#monitor-list .monitor-dispatch-card');
    if (!card) return JSON.stringify({ error: 'NO_CARD' });
    card.click();
    const layer = document.querySelector('#monitor-expand-card');
    if (!layer) return JSON.stringify({ error: 'NO_LAYER', expandedId: state.monitorExpandedId });
    const r = layer.getBoundingClientRect();
    const cs = getComputedStyle(layer);
    const list = document.querySelector('#monitor-list');
    const listCs = list ? getComputedStyle(list) : null;
    return JSON.stringify({
      expandedId: state.monitorExpandedId,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      position: cs.position,
      display: cs.display,
      visibility: cs.visibility,
      listOpacity: listCs ? listCs.opacity : null,
      listVisibility: listCs ? listCs.visibility : null,
      winW: innerWidth, winH: innerHeight
    });
  })()`));
  ok(!expand.error, 'card click shows detail layer (' + (expand.error || 'ok') + ')');
  equal(Math.round(expand.rect.x), 0, 'detail layer left edge at 0');
  equal(Math.round(expand.rect.y), 0, 'detail layer top edge at 0');
  equal(Math.round(expand.rect.w), 360, 'detail layer fills window width 360');
  equal(Math.round(expand.rect.h), 500, 'detail layer fills window height 500');
  equal(expand.position, 'fixed', 'detail layer uses fixed to fill window');
  ok(expand.listOpacity === '0' || expand.listVisibility === 'hidden' || Number(expand.listOpacity) < 1,
    'other content faded (list opacity=' + expand.listOpacity + ' visibility=' + expand.listVisibility + ')');
  await shot('03-expanded-detail');

  console.log('Esc collapses detail layer');
  const esc = JSON.parse(await ev(`(() => {
    const evt = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(evt);
    const layer = document.querySelector('#monitor-expand-card');
    const list = document.querySelector('#monitor-list');
    const cs = layer ? getComputedStyle(layer) : null;
    return JSON.stringify({
      expandedId: state.monitorExpandedId,
      layerHiddenAttr: layer ? layer.hidden : null,
      layerDisplay: cs ? cs.display : null,
      listOpacity: list ? getComputedStyle(list).opacity : null,
      cards: document.querySelectorAll('#monitor-list .monitor-dispatch-card').length
    });
  })()`));
  equal(esc.expandedId, null, 'Esc clears expandedId');
  ok(esc.layerHiddenAttr === true || esc.layerDisplay === 'none', 'Esc hides detail layer');
  ok(Number(esc.listOpacity) === 1 || esc.listOpacity === null, 'Esc restores list opacity');
  equal(esc.cards, 5, 'Esc restores list cards');
  await shot('04-after-esc');

  console.log('No detail-layer residue after page switch');
  const switchPage = JSON.parse(await ev(`(() => {
    const card = document.querySelector('#monitor-list .monitor-dispatch-card');
    card.click();
    const expandedBefore = state.monitorExpandedId;
    switchToMain();
    const layer = document.querySelector('#monitor-expand-card');
    const cs = layer ? getComputedStyle(layer) : null;
    const visible = layer ? (cs.display !== 'none' && cs.visibility !== 'hidden' && !layer.hidden) : false;
    return JSON.stringify({
      expandedBefore: expandedBefore,
      expandedAfter: state.monitorExpandedId,
      layerVisible: visible,
      layerHiddenAttr: layer ? layer.hidden : null,
      activePage: document.querySelector('.page.active') ? document.querySelector('.page.active').className : null,
      focusInLayer: layer ? layer.contains(document.activeElement) : false
    });
  })()`));
  ok(switchPage.expandedBefore !== null, 'detail layer was expanded before switch');
  equal(switchPage.expandedAfter, null, 'page switch clears expandedId');
  ok(switchPage.layerVisible === false || switchPage.layerHiddenAttr === true, 'no detail residue after switch');
  ok(/page-main/.test(switchPage.activePage || ''), 'actually switched to main page');
  equal(switchPage.focusInLayer, false, 'focus not trapped in collapsed layer');
  await shot('05-after-page-switch');

  console.log('Status / progress / runtime display');
  const display = JSON.parse(await ev(`(() => {
    switchToMonitor();
    state.monitorSource='dispatches'; state.monitorStatus='ready'; state.monitorFilter='all';
    state.monitorDispatches = ${JSON.stringify(testDispatches(nowIso))};
    state.monitorSnapshotMeta = { complete: true, staleFileCount: 0, unreadDates: [], errors: [] };
    renderDispatchMonitor();
    const cards = Array.from(document.querySelectorAll('#monitor-list .monitor-dispatch-card'));
    const texts = cards.map(c => c.textContent.replace(/\\s+/g,' ').trim());
    return JSON.stringify({
      count: cards.length,
      texts: texts,
      hasRunning: texts.some(t => /\\u8fd0\\u884c\\u4e2d|\\u8fdb\\u884c\\u4e2d/.test(t)),
      hasCompleted: texts.some(t => /\\u5df2\\u5b8c\\u6210/.test(t)),
      hasWaiting: texts.some(t => /\\u7b49\\u5f85/.test(t)),
      hasProgress45: texts.some(t => /45\\s*%/.test(t)),
      hasProgress100: texts.some(t => /100\\s*%/.test(t)),
      hasRuntime: texts.some(t => /\\u5206\\u949f|\\u5c0f\\u65f6|\\u79d2/.test(t))
    });
  })()`));
  equal(display.count, 5, 'all 5 cards restored');
  ok(display.hasRunning, 'shows running status');
  ok(display.hasCompleted, 'shows completed status');
  ok(display.hasWaiting, 'shows waiting status');
  ok(display.hasProgress45, 'shows 45% progress');
  ok(display.hasProgress100, 'shows 100% progress');
  ok(display.hasRuntime, 'shows runtime/elapsed time');
  await shot('06-status-progress-runtime');

  console.log('360x500 pixel checks');
  const dprInfo = JSON.parse(await ev(`(() => {
    const cards = Array.from(document.querySelectorAll('#monitor-list .monitor-dispatch-card'));
    const tabs = Array.from(document.querySelectorAll('.monitor-filter-tab'));
    const measure = (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, x: r.x, y: r.y }; };
    const overflowX = document.documentElement.scrollWidth > innerWidth;
    const tabRects = tabs.map(t => measure(t));
    const tooNarrow = tabRects.filter(r => r.w < 40).length;
    const cardRects = cards.map(c => measure(c));
    const zeroH = cardRects.filter(r => r.h <= 0).length;
    return JSON.stringify({
      dpr: devicePixelRatio,
      scrollW: document.documentElement.scrollWidth,
      innerW: innerWidth,
      overflowX: overflowX,
      tabCount: tabs.length,
      tabTooNarrow: tooNarrow,
      cardCount: cards.length,
      zeroHeightCards: zeroH,
      fractionalTabWidths: tabRects.map(r => Math.round(r.w * 100) / 100)
    });
  })()`));
  console.log('  dpr=' + dprInfo.dpr + ' scrollW=' + dprInfo.scrollW + ' innerW=' + dprInfo.innerW);
  equal(dprInfo.overflowX, false, 'no horizontal overflow at width 360');
  equal(dprInfo.zeroHeightCards, 0, 'no zero-height cards (layout not collapsed)');
  ok(dprInfo.tabTooNarrow === 0, 'bottom-line tabs not squeezed below 40px');
  console.log('  tab widths: ' + dprInfo.fractionalTabWidths.join(', '));

  console.log('');
  console.log('passed ' + passed + ' failed ' + failed);
  console.log('screenshots: ' + OUT);
  c.sock.end();
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('ERR ' + e.message);
  process.exit(2);
});
