'use strict';

// 360x500 @1.25 DPR 像素检查（真实渲染进程 + CDP 设备指标覆盖）。
//
// 真实窗口的 devicePixelRatio 由系统缩放决定（当前环境为 1.0），无法在不改系统设置
// 的前提下变成 1.25。这里用 CDP Emulation.setDeviceMetricsOverride 把渲染进程的
// devicePixelRatio 设为 1.25、视口固定 360x500，再读真实布局的像素结果：
//   - 是否出现横向溢出（子像素取整导致 361px 滚动宽度）
//   - 卡片/标签是否有半像素高度、被裁切
//   - 1px 边框在 1.25 缩放下是否落在半像素（视觉发虚的根因）
//
// 用法：node tests/e2e/monitor_dpr125_check.js [--port 9223]

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
    let up = false;
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!up) {
        const i = buf.indexOf('\r\n\r\n');
        if (i >= 0) { up = true; buf = buf.slice(i + 4); resolve({ sock, take: () => { const b = buf; buf = Buffer.alloc(0); return b; } }); }
      }
    });
    sock.on('error', reject);
    setTimeout(() => { if (!up) reject(new Error('ws timeout')); }, 5000);
  });
}
function encodeFrame(p) {
  const b = Buffer.from(p);
  const m = crypto.randomBytes(4);
  let h;
  if (b.length < 126) h = Buffer.from([0x81, 0x80 | b.length]);
  else if (b.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0xFE; h.writeUInt16BE(b.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0xFF; h.writeBigUInt64BE(BigInt(b.length), 2); }
  const o = Buffer.concat([h, m, Buffer.alloc(b.length)]);
  for (let i = 0; i < b.length; i++) o[h.length + 4 + i] = b[i] ^ m[i % 4];
  return o;
}
function parseFrames(buf) {
  const out = [];
  let o = 0;
  while (o + 2 <= buf.length) {
    const b2 = buf[o + 1];
    let len = b2 & 0x7f, off = o + 2;
    if (len === 126) { if (o + 4 > buf.length) break; len = buf.readUInt16BE(o + 2); off = o + 4; }
    else if (len === 127) { if (o + 10 > buf.length) break; len = Number(buf.readBigUInt64BE(o + 2)); off = o + 10; }
    if (off + len > buf.length) break;
    out.push(buf.slice(off, off + len).toString());
    o = off + len;
  }
  return { frames: out, rest: buf.slice(o) };
}

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('  [PASS] ' + m); } else { failed++; console.log('  [FAIL] ' + m); } }
function equal(a, b, m) { ok(Object.is(a, b), m + '（实际：' + JSON.stringify(a) + '，期望：' + JSON.stringify(b) + '）'); }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const list = JSON.parse(await httpGet('/json/list'));
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('NO_PAGE_TARGET');
  const c = await wsConnect(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  let rx = Buffer.alloc(0);
  c.sock.on('data', (d) => {
    rx = Buffer.concat([rx, d]);
    const r = parseFrames(rx);
    rx = r.rest;
    for (const f of r.frames) {
      try {
        const m = JSON.parse(f);
        if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      } catch (e) { /* ignore */ }
    }
  });
  function send(method, params) {
    return new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      c.sock.write(encodeFrame(JSON.stringify({ id: mid, method, params })));
    });
  }
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('EVAL: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  };

  const before = JSON.parse(await ev(`JSON.stringify({ dpr: devicePixelRatio, w: innerWidth, h: innerHeight })`));
  console.log('真实窗口（未覆盖）: ' + before.w + 'x' + before.h + ' dpr=' + before.dpr);

  // 1.25 DPR + 360x500 视口覆盖
  await send('Emulation.setDeviceMetricsOverride', {
    width: 360, height: 500, deviceScaleFactor: 1.25, mobile: false
  });
  await ev(`new Promise(r => setTimeout(r, 120))`);

  const info = JSON.parse(await ev(`JSON.stringify({ dpr: devicePixelRatio, w: innerWidth, h: innerHeight })`));
  console.log('覆盖后视口: ' + info.w + 'x' + info.h + ' dpr=' + info.dpr);
  equal(info.w, 360, '@1.25 DPR 视口宽 360');
  equal(info.h, 500, '@1.25 DPR 视口高 500');
  ok(Math.abs(info.dpr - 1.25) < 0.001, '@1.25 DPR 生效（实际 ' + info.dpr + '）');

  // 注入 TEST 数据并渲染（只改内存）
  await ev(`(() => {
    if (typeof switchToMonitor === 'function') switchToMonitor();
    setMonitorSource('dispatches');
    state.monitorStatus = 'ready';
    state.monitorFilter = 'all';
    state.monitorPage = 1;
    state.monitorPageSize = 50;
    const now = Date.now();
    const mk = (tag, status, progress, minsAgo) => ({
      id: 'dispatch_2026-11-13_dpr1' + tag + '-1111-4111-8111-111111111111',
      intentId: 'intent-dpr-' + tag,
      task: 'TEST DPR 派活 ' + tag + ' —— 一段较长的中文任务描述，用来验证 1.25 缩放下换行与卡片高度',
      model: 'GLM', status, progress,
      dispatchedAt: new Date(now - minsAgo * 60000).toISOString(),
      recordedAt: new Date(now - minsAgo * 60000 + 2000).toISOString(),
      finishedAt: status === 'completed' ? new Date(now - 60000).toISOString() : null,
      clockSource: { dispatchedAt: 'muse', finishedAt: 'pc', recordedAt: 'pc' },
      statusDetail: null, executorRef: null, observationHealth: 'fresh',
      lastFactAt: new Date(now - 60000).toISOString(),
      updatedAt: new Date(now - 60000).toISOString(),
      revision: 2, project: 'TEST 项目', goal: null, tokenUsage: null
    });
    state.monitorDispatches = [
      mk('aaaa', 'running', 45, 22), mk('bbbb', 'waiting', null, 5),
      mk('cccc', 'completed', 100, 90), mk('dddd', 'failed', 30, 120),
      mk('eeee', 'blocked', null, 60)
    ];
    state.monitorSnapshotMeta = { complete: true, staleFileCount: 0, unreadDates: [], errors: [] };
    renderDispatchMonitor();
  })()`);
  await ev(`new Promise(r => setTimeout(r, 100))`);

  const px = JSON.parse(await ev(`(() => {
    const cards = Array.from(document.querySelectorAll('#monitor-list .monitor-dispatch-card'));
    const tabs = Array.from(document.querySelectorAll('.monitor-filter-tab'));
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
    const cardRects = cards.map(rect);
    const tabRects = tabs.map(rect);
    const fractional = (v) => Math.abs(v - Math.round(v)) > 0.01;
    // 1.25 缩放下 1 CSS px = 1.25 物理像素；奇数 CSS px 的边框/高度会落在半物理像素上。
    const borderWidths = Array.from(new Set(Array.from(document.querySelectorAll('#monitor-list *'))
      .map(e => getComputedStyle(e).borderTopWidth).filter(w => w && w !== '0px')));
    return JSON.stringify({
      dpr: devicePixelRatio,
      innerW: innerWidth, innerH: innerHeight,
      scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight,
      bodyScrollW: document.body.scrollWidth,
      overflowX: document.documentElement.scrollWidth > innerWidth,
      overflowY: document.documentElement.scrollHeight > innerHeight,
      cards: cardRects.length,
      cardFractionalW: cardRects.filter(r => fractional(r.w)).length,
      cardFractionalH: cardRects.filter(r => fractional(r.h)).length,
      cardFractionalRight: cardRects.filter(r => fractional(r.right)).length,
      tabFractionalW: tabRects.filter(r => fractional(r.w)).length,
      zeroHeight: cardRects.filter(r => r.h <= 0).length,
      minCardH: cardRects.length ? Math.min.apply(null, cardRects.map(r => r.h)) : null,
      maxRight: cardRects.length ? Math.max.apply(null, cardRects.map(r => r.right)) : null,
      listRight: document.querySelector('#monitor-list').getBoundingClientRect().right,
      borderWidths,
      devicePixelRatioCss: window.devicePixelRatio
    });
  })()`));

  console.log('  dpr=' + px.dpr + ' inner=' + px.innerW + 'x' + px.innerH + ' scroll=' + px.scrollW + 'x' + px.scrollH);
  console.log('  卡片数=' + px.cards + ' 最小高=' + px.minCardH + ' 最大右边界=' + px.maxRight + ' 列表右边界=' + px.listRight);
  console.log('  边框宽度集合=' + JSON.stringify(px.borderWidths));

  equal(px.overflowX, false, '@1.25 DPR 无横向溢出');
  equal(px.zeroHeight, 0, '@1.25 DPR 无 0 高卡片');
  ok(px.minCardH !== null && px.minCardH >= 48, '@1.25 DPR 卡片高度足够点击（min=' + px.minCardH + '）');
  ok(px.maxRight !== null && px.maxRight <= px.listRight + 0.5, '@1.25 DPR 卡片不超出列表右边界（' + px.maxRight + ' <= ' + px.listRight + '）');
  ok(px.cards === 5, '@1.25 DPR 5 张卡都渲染');
  // 子像素不是失败项，但要记录：1.25 缩放下 1px 边框映射到 1.25 物理像素，
  // 视觉上会出现深浅不一；这是 Windows 缩放的固有表现，需要记录而非静默。
  console.log('  [NOTE] 半像素统计：卡片宽 ' + px.cardFractionalW + ' / 高 ' + px.cardFractionalH +
    ' / 右边界 ' + px.cardFractionalRight + '；标签宽 ' + px.tabFractionalW);
  ok(px.cardFractionalW === 0, '@1.25 DPR 卡片宽度为整数 CSS px（无半像素宽）');

  await send('Emulation.clearDeviceMetricsOverride');
  await ev(`new Promise(r => setTimeout(r, 80))`);
  const after = JSON.parse(await ev(`JSON.stringify({ dpr: devicePixelRatio, w: innerWidth, h: innerHeight })`));
  equal(after.dpr, before.dpr, '清除覆盖后 DPR 恢复原值');

  console.log('');
  console.log('通过 ' + passed + ' 失败 ' + failed);
  c.sock.end();
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('ERR ' + e.message);
  process.exit(2);
});
