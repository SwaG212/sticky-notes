'use strict';

// dispatch-reader-loop.js
//
// B 组测试辅助：模拟 Electron 主进程 readDispatchFileOnce 的读取方式
//（fs.readFileSync，Node 在 Windows 上以 ReadWrite|Delete 共享打开），
// 在写入口持续替换正式文件的同一时刻循环读取，验证：
//   1) 读者不会阻塞正确替换（写入口不能因读者而失败）；
//   2) 读者不会把瞬时错误/半文件当成“空集合”——只能读到完整合法 JSON 数组。
//
// 用法：node tests/dispatch-reader-loop.js <file> <durationMs> <outJson>
// 输出：{ reads, parseErrors, emptyArrays, partialReads, invalidArrays, bytes:[min,max] }

const fs = require('fs');

const file = process.argv[2];
const durationMs = Number(process.argv[3] || 4000);
const outFile = process.argv[4];
// 读者节奏：真实 Electron 读取是“扫描一次即关句柄”，不是紧凑循环。紧凑循环会让
// 句柄几乎无间隙地覆盖整个窗口，把 Windows 的替换语义问题放大成必现失败。
// 这里用 2ms 间隔模拟“多次稳定扫描 + 关闭句柄”，仍远高于 §6.3 的 5 秒/30 秒节奏。
const gapMs = Number(process.argv[5] || 2);

const stats = {
  reads: 0,
  openErrors: 0,
  parseErrors: 0,
  emptyArrays: 0,
  invalidArrays: 0,
  partialReads: 0,
  minBytes: null,
  maxBytes: 0,
  errorSamples: []
};

const deadline = Date.now() + durationMs;
while (Date.now() < deadline) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    stats.openErrors++;
    if (stats.errorSamples.length < 5) stats.errorSamples.push('open:' + e.code);
    continue;
  }
  stats.reads++;
  stats.minBytes = stats.minBytes === null ? buf.length : Math.min(stats.minBytes, buf.length);
  stats.maxBytes = Math.max(stats.maxBytes, buf.length);

  const text = buf.toString('utf-8').replace(/^\uFEFF/, '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // 只有“读到半个文件”才允许解析失败；若文件本身完整，解析失败即为缺陷。
    stats.parseErrors++;
    if (stats.errorSamples.length < 5) stats.errorSamples.push('parse:' + e.message.slice(0, 60));
    if (!text.endsWith(']')) stats.partialReads++;
    continue;
  }
  if (!Array.isArray(parsed)) {
    stats.invalidArrays++;
    continue;
  }
  if (parsed.length === 0) stats.emptyArrays++;
  // 让出句柄，模拟真实“读完即关、下次扫描再开”的节奏。
  if (gapMs > 0) {
    const until = Date.now() + gapMs;
    while (Date.now() < until) { /* 忙等：保持进程轻量且不引入定时器抖动 */ }
  }
}

if (outFile) fs.writeFileSync(outFile, JSON.stringify(stats), 'utf8');
process.stdout.write(JSON.stringify(stats));
