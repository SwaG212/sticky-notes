'use strict';

// 派活读取性能测量（设计文档 §6.3 建议目标：1 年冷启动完整读取 P95 ≤1s、
// 3 年 ≤2s、单条更新 P95 ≤500ms）。
//
// 用法：node tests/bench_dispatch_read.js [--years 1|3] [--runs 20] [--perDay 12]
// 只写临时数据根，测完删除；输出 P50/P95/P99 与 §6.3 目标对比。

const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../dispatch-store');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  return process.argv[i + 1];
}

const years = Number(arg('years', 1));
const runs = Number(arg('runs', 20));
const perDay = Number(arg('perDay', 12));

function makeRecord(dateStr, i) {
  const id = 'dispatch_' + dateStr + '_' + String(i).padStart(8, '0') + '-1111-4111-8111-' + String(i).padStart(12, '0');
  return {
    schemaVersion: 1,
    writerVersion: '1.0.0',
    minimumReaderVersion: '1.0.0',
    id,
    intentId: 'intent-' + dateStr + '-' + i,
    workItemId: null,
    task: '性能样本任务 ' + dateStr + ' #' + i + ' —— 一段中等长度的中文描述，用于逼近真实记录体量',
    model: ['Muse', 'Sol', 'DeepSeek', 'Astra', 'GLM'][i % 5],
    status: ['waiting', 'running', 'blocked', 'completed', 'failed', 'cancelled'][i % 6],
    observationHealth: 'fresh',
    observationDetail: null,
    progress: i % 3 === 0 ? 40 : null,
    dispatchedAt: dateStr + 'T0' + (i % 9) + ':00:00.000Z',
    recordedAt: dateStr + 'T0' + (i % 9) + ':00:01.000Z',
    finishedAt: null,
    clockSource: { dispatchedAt: 'muse', finishedAt: 'unknown', recordedAt: 'pc' },
    project: '项目' + (i % 7),
    goal: '目标 ' + i,
    statusDetail: null,
    executorRef: null,
    tokenUsage: null,
    usageSource: null,
    provider: null,
    modelVersion: null,
    usageScope: null,
    cachedTokens: null,
    lastFactAt: dateStr + 'T0' + (i % 9) + ':00:00.000Z',
    updatedAt: dateStr + 'T0' + (i % 9) + ':00:01.000Z',
    revision: 1,
    lastOperationId: '00000000-0000-4000-8000-' + String(i).padStart(12, '0')
  };
}

// 复刻 main.js readDispatchFileOnce + mergeFileSnapshots 的读取路径（同步读、逐文件校验、
// 64MiB 预算、按日期降序）。这样测的是真实读取成本，而不是另写一套逻辑。
function readAll(dir) {
  const t0 = process.hrtime.bigint();
  const files = fs.readdirSync(dir);
  const dates = [];
  for (const name of files) {
    const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
    if (m && store.isValidCalendarDateString(m[1])) dates.push(m[1]);
  }
  dates.sort().reverse();
  const fileResults = [];
  for (const date of dates) {
    const p = path.join(dir, date + '.json');
    let stat;
    try { stat = fs.statSync(p); } catch (e) { fileResults.push({ date, ok: false, error: 'READ_FAILED', bytes: 0 }); continue; }
    if (stat.size > store.DISPATCH_FILE_MAX_BYTES) {
      fileResults.push({ date, ok: false, error: 'FILE_TOO_LARGE', bytes: stat.size });
      continue;
    }
    let buf = null;
    try { buf = fs.readFileSync(p); } catch (e) { buf = null; }
    if (!buf) { fileResults.push({ date, ok: false, error: 'READ_FAILED', bytes: stat.size }); continue; }
    let raw;
    try { raw = JSON.parse(buf.toString('utf-8').replace(/^\uFEFF/, '')); } catch (e) {
      fileResults.push({ date, ok: false, error: 'PARSE_ERROR', bytes: buf.length });
      continue;
    }
    if (!Array.isArray(raw)) {
      fileResults.push({ date, ok: false, error: 'PARSE_ERROR', bytes: buf.length });
      continue;
    }
    fileResults.push({ date, ok: true, records: raw, bytes: buf.length });
  }
  const merged = store.mergeFileSnapshots(null, fileResults, 1, { enumeratedDates: dates, nowMs: Date.now() });
  const t1 = process.hrtime.bigint();
  return {
    ms: Number(t1 - t0) / 1e6,
    records: merged.records.length,
    complete: merged.complete,
    unreadDates: merged.unreadDates,
    staleFileCount: merged.staleFileCount,
    fileCount: dates.length,
    totalBytes: fileResults.reduce((a, f) => a + (f.bytes || 0), 0)
  };
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-bench-'));
const dir = path.join(root, 'dispatches');
fs.mkdirSync(dir, { recursive: true });

const days = years * 365;
const start = Date.UTC(2023, 0, 1);
let bytes = 0;
for (let d = 0; d < days; d++) {
  const dateStr = new Date(start + d * 86400000).toISOString().slice(0, 10);
  const arr = [];
  for (let i = 0; i < perDay; i++) arr.push(makeRecord(dateStr, i));
  const text = JSON.stringify(arr);
  bytes += Buffer.byteLength(text);
  fs.writeFileSync(path.join(dir, dateStr + '.json'), text);
}

try {
  // 冷启动：每次先清掉 V8/OS 的部分缓存不现实，这里连续测量代表“稳定读取”。
  const samples = [];
  let last = null;
  for (let i = 0; i < runs; i++) {
    last = readAll(dir);
    samples.push(last.ms);
  }
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const p99 = percentile(samples, 99);
  const target = years === 1 ? 1000 : 2000;
  console.log(JSON.stringify({
    years,
    days,
    perDay,
    runs,
    fileCount: last.fileCount,
    records: last.records,
    totalMiB: +(last.totalBytes / 1048576).toFixed(2),
    complete: last.complete,
    unreadDates: last.unreadDates.length,
    p50_ms: +p50.toFixed(1),
    p95_ms: +p95.toFixed(1),
    p99_ms: +p99.toFixed(1),
    min_ms: +Math.min(...samples).toFixed(1),
    max_ms: +Math.max(...samples).toFixed(1),
    target_ms: target,
    p95_within_target: p95 <= target
  }, null, 2));
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}
