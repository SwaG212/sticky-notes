// 缺陷 1 回归（可运行版）：切页必须收起派活详情层。
// 真实行为断言在 tests/test_monitor_dispatch_dom.js 的 M4b（Electron DOM，需交互式桌面）。
// 这里用源码契约兜底：三个切页入口都必须在改 currentPage 之前调 collapseMonitorTask，
// 且收起时释放覆盖层内的焦点。Electron 起不来的环境仍能跑这一条。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

function bodyOf(name) {
  const start = src.indexOf('async function ' + name + '(');
  assert.ok(start >= 0, name + ' 存在');
  const nextFn = src.indexOf('\nasync function ', start + 1);
  const nextSync = src.indexOf('\nfunction ', start + 1);
  const candidates = [nextFn, nextSync].filter((i) => i > 0);
  return src.slice(start, Math.min.apply(null, candidates));
}

for (const fn of ['switchToMain', 'switchToNotepad', 'switchToTools']) {
  const body = bodyOf(fn);
  const collapseAt = body.indexOf('collapseMonitorTask(true)');
  const pageAt = body.indexOf("state.currentPage = '");
  assert.ok(collapseAt >= 0, fn + ' 调用 collapseMonitorTask(true)');
  assert.ok(pageAt >= 0, fn + ' 有 currentPage 赋值');
  assert.ok(collapseAt < pageAt, fn + ' 先收起详情层再切页');
}

const collapseStart = src.indexOf('function collapseMonitorTask(');
const collapseBody = src.slice(collapseStart, src.indexOf('\nfunction ', collapseStart + 1));
assert.match(collapseBody, /contains\(document\.activeElement\)[\s\S]*?blur\(\)/, '收起时释放覆盖层内焦点');

console.log('切页详情层清理契约通过（3 个入口 + 焦点释放）');
