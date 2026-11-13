var logic = require('../renderer/monitor-logic.js');

var pass = 0;
var fail = 0;

function ok(cond, desc) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + desc);
  } else {
    fail++;
    console.log('  ✗ ' + desc);
  }
}

function eq(actual, expected, desc) {
  ok(actual === expected, desc + (actual === expected ? '' : '（实际：' + actual + '，期望：' + expected + '）'));
}

function has(arr, item, desc) {
  ok(!!arr && arr.indexOf(item) !== -1, desc);
}

function test(desc, fn) {
  try {
    fn();
  } catch (e) {
    fail++;
    console.log('  ✗ ' + desc + '：' + e.message);
  }
}

function raw(status, extra) {
  var r = {
    id: 'd1',
    model: 'Muse',
    status: status,
    progress: null,
    task: '任务',
    dispatchedAt: '2026-11-12T10:00:00Z',
    recordedAt: '2026-11-12T10:00:00Z',
    observationHealth: 'fresh',
    clockSource: 'local'
  };
  if (extra) {
    for (var k in extra) {
      if (extra.hasOwnProperty(k)) { r[k] = extra[k]; }
    }
  }
  return r;
}

function makeRecords(n) {
  var a = [];
  for (var i = 0; i < n; i++) {
    a.push({ id: 'r' + i, status: 'running', dispatchedAt: '2026-11-12T10:00:00Z' });
  }
  return a;
}

var NOW = Date.parse('2026-11-12T12:00:00Z');

console.log('\n[1] MODEL_META');
test('GLM 元信息', function () {
  var m = logic.MODEL_META.GLM;
  ok(!!m, 'GLM 在列');
  eq(m.label, 'GLM', 'GLM label');
  eq(m.color, '#0F766E', 'GLM color');
  eq(m.bg, '#F0FDFA', 'GLM bg');
});
test('原有四款模型仍在', function () {
  var names = ['Muse', 'Sol', 'DeepSeek', 'Astra'];
  for (var i = 0; i < names.length; i++) {
    ok(!!logic.MODEL_META[names[i]], names[i] + ' 在列');
    ok(!!logic.MODEL_META[names[i]].label, names[i] + ' 有 label');
  }
});

console.log('\n[2] normalizeDispatch 正常记录');
test('running 记录字段直通且浅拷贝', function () {
  var r = raw('running', { progress: 60 });
  var out = logic.normalizeDispatch(r, '2026-11-12', 0);
  eq(out.dispatch.id, 'd1', 'id 保留');
  eq(out.dispatch.model, 'Muse', 'model 保留');
  eq(out.dispatch.status, 'running', 'status 保留');
  eq(out.dispatch.progress, 60, 'progress 保留');
  eq(out.dispatch.task, '任务', 'task 保留');
  ok(out.warnings.indexOf('status-unknown') === -1, '无 status-unknown');
  out.dispatch.task = '改';
  eq(r.task, '任务', '浅拷贝不改原对象');
});
test('六种合法状态均保留', function () {
  var sts = ['waiting', 'running', 'blocked', 'completed', 'failed', 'cancelled'];
  for (var i = 0; i < sts.length; i++) {
    var s = sts[i];
    var r = raw(s, { progress: s === 'completed' ? 100 : null });
    if (s === 'completed' || s === 'failed' || s === 'cancelled') {
      r.finishedAt = '2026-11-12T10:30:00Z';
    }
    var out = logic.normalizeDispatch(r, '2026-11-12', i);
    eq(out.dispatch.status, s, s + ' 状态保留');
    eq(out.dispatch.id, 'd1', s + ' id 保留');
  }
});

console.log('\n[3] normalizeDispatch 非法输入');
test('非对象输入', function () {
  var out = logic.normalizeDispatch('x', '2026-11-12', 0);
  eq(out.dispatch, null, 'dispatch 为 null');
  eq(out.warnings.length, 1, '仅一条警告');
  eq(out.warnings[0], 'not-an-object', '警告码');
});
test('未知模型与缺失模型', function () {
  var out = logic.normalizeDispatch(raw('running', { model: 'X' }), '2026-11-12', 0);
  eq(out.dispatch.model, 'X', '未知模型保留原值');
  has(out.warnings, 'model-unknown', '记 model-unknown');
  var r = raw('running');
  delete r.model;
  out = logic.normalizeDispatch(r, '2026-11-12', 0);
  eq(out.dispatch.model, null, '缺失模型置 null');
  has(out.warnings, 'model-missing', '记 model-missing');
});
test('未知状态、缺失状态与 completed 布尔值', function () {
  var out = logic.normalizeDispatch(raw('weird'), '2026-11-12', 0);
  eq(out.dispatch.status, 'weird', '未知状态保留原值');
  has(out.warnings, 'status-unknown', '记 status-unknown');
  var r = raw('running');
  delete r.status;
  out = logic.normalizeDispatch(r, '2026-11-12', 0);
  eq(out.dispatch.status, null, '缺失状态置 null');
  has(out.warnings, 'status-unknown', '缺失状态记 status-unknown');
  out = logic.normalizeDispatch(raw('running', { completed: true, progress: 50 }), '2026-11-12', 0);
  eq(out.dispatch.status, 'running', 'completed 布尔值不影响状态');
});

console.log('\n[4] normalizeDispatch 进度规则');
test('progress null 保持且不记进度警告', function () {
  var out = logic.normalizeDispatch(raw('running', { progress: null }), '2026-11-12', 0);
  eq(out.dispatch.progress, null, 'progress 为 null');
  ok(out.warnings.indexOf('progress-invalid') === -1, '无 progress-invalid');
});
test('running 100 与 completed 99 均置 null 记警告', function () {
  var out = logic.normalizeDispatch(raw('running', { progress: 100 }), '2026-11-12', 0);
  eq(out.dispatch.progress, null, 'running 100 置 null');
  has(out.warnings, 'progress-invalid', 'running 100 记警告');
  out = logic.normalizeDispatch(raw('completed', { progress: 99, finishedAt: '2026-11-12T10:30:00Z' }), '2026-11-12', 0);
  eq(out.dispatch.progress, null, 'completed 99 置 null');
  has(out.warnings, 'progress-invalid', 'completed 99 记警告');
});
test('completed 100 保留，60.4 舍入', function () {
  var out = logic.normalizeDispatch(raw('completed', { progress: 100, finishedAt: '2026-11-12T10:30:00Z' }), '2026-11-12', 0);
  eq(out.dispatch.progress, 100, 'completed 100 保留');
  ok(out.warnings.indexOf('progress-invalid') === -1, 'completed 100 无进度警告');
  out = logic.normalizeDispatch(raw('running', { progress: 60.4 }), '2026-11-12', 0);
  eq(out.dispatch.progress, 60, '60.4 舍入为 60');
});
test('字符串进度非法', function () {
  var out = logic.normalizeDispatch(raw('running', { progress: '60' }), '2026-11-12', 0);
  eq(out.dispatch.progress, null, '字符串进度置 null');
  has(out.warnings, 'progress-invalid', '记 progress-invalid');
});

console.log('\n[5] normalizeDispatch 时间与字段规则');
test('终态缺 finishedAt 与非法 dispatchedAt', function () {
  var out = logic.normalizeDispatch(raw('completed', { progress: 100 }), '2026-11-12', 0);
  has(out.warnings, 'finishedAt-missing', '缺 finishedAt 记警告');
  out = logic.normalizeDispatch(raw('running', { dispatchedAt: 'bad' }), '2026-11-12', 0);
  eq(out.dispatch.dispatchedAt, null, 'dispatchedAt 置 null');
  has(out.warnings, 'dispatchedAt-invalid', '记 dispatchedAt-invalid');
});
test('非法 recordedAt 与 observationHealth', function () {
  var out = logic.normalizeDispatch(raw('running', { recordedAt: 'bad' }), '2026-11-12', 0);
  eq(out.dispatch.recordedAt, null, 'recordedAt 置 null');
  has(out.warnings, 'recordedAt-invalid', '记 recordedAt-invalid');
  out = logic.normalizeDispatch(raw('running', { observationHealth: 'bad' }), '2026-11-12', 0);
  eq(out.dispatch.observationHealth, 'fresh', 'observationHealth 置 fresh');
  has(out.warnings, 'observation-invalid', '记 observation-invalid');
});
test('非法 tokenUsage', function () {
  var out = logic.normalizeDispatch(raw('running', { tokenUsage: 'bad' }), '2026-11-12', 0);
  eq(out.dispatch.tokenUsage, null, 'tokenUsage 置 null');
  has(out.warnings, 'tokenUsage-invalid', '记 tokenUsage-invalid');
});

console.log('\n[6] 进度显示');
test('displayDispatchProgress null 与 null 进度', function () {
  eq(logic.displayDispatchProgress(null), null, 'null 入参');
  eq(logic.displayDispatchProgress({ progress: null }), null, 'null 进度');
});
test('displayDispatchProgress completed 与 running', function () {
  eq(logic.displayDispatchProgress({ status: 'completed', progress: 20 }), 100, 'completed 返回 100');
  eq(logic.displayDispatchProgress({ status: 'running', progress: 60 }), 60, 'running 返回 60');
});
test('formatDispatchProgressLabel', function () {
  eq(logic.formatDispatchProgressLabel(null), '暂不可估算', 'null 入参');
  eq(logic.formatDispatchProgressLabel({ status: 'running', progress: 60 }), 'Muse 估算约 60%', 'running 60');
});

console.log('\n[7] filterDispatches');
test('running 过滤', function () {
  var records = [
    { id: 'r', status: 'running' },
    { id: 'w', status: 'waiting' },
    { id: 'c', status: 'completed' }
  ];
  var out = logic.filterDispatches(records, 'running');
  eq(out.length, 1, '仅一条');
  eq(out[0].status, 'running', '状态为 running');
});
test('waiting 与 completed 过滤', function () {
  var records = [
    { id: 'r', status: 'running' },
    { id: 'w', status: 'waiting' },
    { id: 'c', status: 'completed' }
  ];
  eq(logic.filterDispatches(records, 'waiting').length, 1, 'waiting 一条');
  eq(logic.filterDispatches(records, 'completed').length, 1, 'completed 一条');
});
test('all 包含 failed/blocked/cancelled，其他过滤排除', function () {
  var records = [
    { id: 'r', status: 'running' },
    { id: 'b', status: 'blocked' },
    { id: 'f', status: 'failed' },
    { id: 'x', status: 'cancelled' }
  ];
  var all = logic.filterDispatches(records, 'all');
  eq(all.length, 4, 'all 返回全集');
  eq(logic.filterDispatches(records, 'running').length, 1, 'running 不含其他状态');
});
test('非数组与返回拷贝', function () {
  eq(logic.filterDispatches(null, 'all').length, 0, '非数组返回空');
  var records = [{ id: 'r', status: 'running' }, { id: 'w', status: 'waiting' }];
  var out = logic.filterDispatches(records, 'all');
  out.push({ id: 'z', status: 'running' });
  eq(records.length, 2, '修改返回数组不影响原数组');
});

console.log('\n[8] countDispatches');
test('六态与 unknown 计数', function () {
  var records = [
    { status: 'waiting' }, { status: 'running' }, { status: 'blocked' },
    { status: 'completed' }, { status: 'failed' }, { status: 'cancelled' },
    { status: null }, { status: 'weird' }
  ];
  var c = logic.countDispatches(records);
  eq(c.all, 8, 'all');
  eq(c.running, 1, 'running');
  eq(c.waiting, 1, 'waiting');
  eq(c.blocked, 1, 'blocked');
  eq(c.completed, 1, 'completed');
  eq(c.failed, 1, 'failed');
  eq(c.cancelled, 1, 'cancelled');
  eq(c.unknown, 2, 'unknown');
});
test('空数组全 0', function () {
  var c = logic.countDispatches([]);
  eq(c.all, 0, 'all 0');
  eq(c.running, 0, 'running 0');
  eq(c.unknown, 0, 'unknown 0');
});

console.log('\n[9] sortDispatches');
test('组序 running/blocked/failed/未知/waiting/completed/cancelled', function () {
  var arr = [
    { id: 'c', status: 'completed', dispatchedAt: '2026-11-12T10:00:00Z' },
    { id: 'r', status: 'running', dispatchedAt: '2026-11-12T10:00:00Z' },
    { id: 'w', status: 'waiting', dispatchedAt: '2026-11-12T10:00:00Z' },
    { id: 'b', status: 'blocked', dispatchedAt: '2026-11-12T10:00:00Z' },
    { id: 'f', status: 'failed', dispatchedAt: '2026-11-12T10:00:00Z' },
    { id: 'x', status: 'cancelled', dispatchedAt: '2026-11-12T10:00:00Z' },
    { id: 'u', status: 'weird', dispatchedAt: '2026-11-12T10:00:00Z' }
  ];
  var out = logic.sortDispatches(arr);
  eq(out[0].status, 'running', '第 1 组');
  eq(out[1].status, 'blocked', '第 2 组');
  eq(out[2].status, 'failed', '第 3 组');
  eq(out[3].status, 'weird', '第 4 组未知');
  eq(out[4].status, 'waiting', '第 5 组');
  eq(out[5].status, 'completed', '第 6 组');
  eq(out[6].status, 'cancelled', '第 7 组');
});
test('同组 dispatchedAt 降序且无效时间组尾', function () {
  var arr = [
    { id: 'a', status: 'running', dispatchedAt: '2026-11-12T10:00:00Z' },
    { id: 'b', status: 'running', dispatchedAt: '2026-11-12T11:00:00Z' },
    { id: 'c', status: 'running', dispatchedAt: 'bad' }
  ];
  var out = logic.sortDispatches(arr);
  eq(out[0].id, 'b', '较晚时间在前');
  eq(out[1].id, 'a', '较早时间在后');
  eq(out[2].id, 'c', '无效时间在组尾');
});
test('同时间 id 升序', function () {
  var arr = [
    { id: 'b', status: 'running', dispatchedAt: '2026-11-12T10:00:00Z' },
    { id: 'a', status: 'running', dispatchedAt: '2026-11-12T10:00:00Z' }
  ];
  var out = logic.sortDispatches(arr);
  eq(out[0].id, 'a', 'a 在前');
  eq(out[1].id, 'b', 'b 在后');
});
test('不修改原数组', function () {
  var arr = [
    { id: 'b', status: 'running', dispatchedAt: '2026-11-12T10:00:00Z' },
    { id: 'a', status: 'running', dispatchedAt: '2026-11-12T10:00:00Z' }
  ];
  logic.sortDispatches(arr);
  eq(arr[0].id, 'b', '原数组顺序不变');
});

console.log('\n[10] formatTotalElapsed');
test('运行中 22 分钟', function () {
  var r = { status: 'running', dispatchedAt: '2026-11-12T11:38:00Z', clockSource: 'local' };
  eq(logic.formatTotalElapsed(r, NOW), '22 分钟', '22 分钟');
});
test('终态使用 finishedAt-dispatchedAt 冻结', function () {
  var r = { status: 'completed', dispatchedAt: '2026-11-12T10:00:00Z', finishedAt: '2026-11-12T10:30:00Z', clockSource: 'local' };
  eq(logic.formatTotalElapsed(r, NOW), '30 分钟', '30 分钟');
});
test('缺时间与非对象返回 —', function () {
  eq(logic.formatTotalElapsed({ status: 'running' }, NOW), '—', '缺 dispatchedAt');
  eq(logic.formatTotalElapsed(null, NOW), '—', '非对象');
});
test('结束早于派出与时钟 unknown', function () {
  var r = { status: 'completed', dispatchedAt: '2026-11-12T10:00:00Z', finishedAt: '2026-11-12T09:00:00Z', clockSource: 'local' };
  eq(logic.formatTotalElapsed(r, NOW), '—', '结束早于派出');
  r = { status: 'running', dispatchedAt: '2026-11-12T11:00:00Z', clockSource: 'unknown' };
  eq(logic.formatTotalElapsed(r, NOW), '时间不确定', 'unknown 时钟');
});
test('不足 1 分钟', function () {
  var r = { status: 'running', dispatchedAt: '2026-11-12T11:59:30Z', clockSource: 'local' };
  eq(logic.formatTotalElapsed(r, NOW), '不足 1 分钟', '不足 1 分钟');
});
test('天数格式', function () {
  var r = { status: 'completed', dispatchedAt: '2026-11-10T10:00:00Z', finishedAt: '2026-11-12T12:00:00Z', clockSource: 'local' };
  eq(logic.formatTotalElapsed(r, NOW), '2 天 02 小时 00 分钟', '2 天格式');
});

console.log('\n[11] 时间与汇总');
test('formatDispatchTime 合法格式与非法值', function () {
  var s = logic.formatDispatchTime('2026-11-12T12:34:00Z');
  ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s), '合法时间格式');
  eq(logic.formatDispatchTime('bad'), '未知', '非法返回未知');
});
test('formatLastUpdate lastFactAt 优先', function () {
  var a = logic.formatLastUpdate({ lastFactAt: '2026-11-12T12:34:00Z', updatedAt: '2026-11-12T10:00:00Z' });
  var b = logic.formatLastUpdate({ lastFactAt: '2026-11-12T12:34:00Z' });
  eq(a, b, 'lastFactAt 优先');
  ok(a.indexOf('Muse 最近更新 ') === 0, '前缀正确');
});
test('formatLastUpdate 无时间返回空', function () {
  eq(logic.formatLastUpdate({}), '', '无时间');
});
test('dispatchSummary 文案', function () {
  eq(logic.dispatchSummary({ running: 2, completed: 3, waiting: 4 }), '进行中 2 / 已完成 3 / 等待 4', '汇总文案');
});

console.log('\n[12] paginateDispatches');
test('0 条与 1 条', function () {
  var p0 = logic.paginateDispatches([], 1, 50);
  eq(p0.total, 0, '0 条 total');
  eq(p0.totalPages, 1, '0 条 totalPages');
  eq(p0.page, 1, '0 条 page');
  eq(p0.pageRecords.length, 0, '0 条记录');
  var p1 = logic.paginateDispatches(makeRecords(1), 1, 50);
  eq(p1.total, 1, '1 条 total');
  eq(p1.totalPages, 1, '1 条 totalPages');
  eq(p1.pageRecords.length, 1, '1 条记录');
});
test('50 条与 51 条', function () {
  var p50 = logic.paginateDispatches(makeRecords(50), 1, 50);
  eq(p50.totalPages, 1, '50 条一页');
  eq(p50.pageRecords.length, 50, '50 条记录');
  var p51 = logic.paginateDispatches(makeRecords(51), 1, 50);
  eq(p51.totalPages, 2, '51 条两页');
  eq(p51.pageRecords.length, 50, '51 条第一页');
  var p51b = logic.paginateDispatches(makeRecords(51), 2, 50);
  eq(p51b.pageRecords.length, 1, '51 条第二页');
});
test('101 条', function () {
  var p = logic.paginateDispatches(makeRecords(101), 1, 50);
  eq(p.total, 101, 'total');
  eq(p.totalPages, 3, 'totalPages');
});
test('页码夹取', function () {
  var p0 = logic.paginateDispatches(makeRecords(51), 0, 50);
  eq(p0.page, 1, '0 夹到 1');
  var pBig = logic.paginateDispatches(makeRecords(51), 999, 50);
  eq(pBig.page, 2, '超大夹到末页');
  eq(pBig.pageRecords.length, 1, '末页记录数');
});
test('pageSize 缺省与 <=0', function () {
  var pDef = logic.paginateDispatches(makeRecords(51), 1);
  eq(pDef.pageRecords.length, 50, '缺省 50');
  var pBad = logic.paginateDispatches(makeRecords(51), 1, 0);
  eq(pBad.pageRecords.length, 50, '<=0 按 50');
});

console.log('\n[13] 观测状态');
test('终态不因时间变 stale', function () {
  var r = { status: 'completed', observationHealth: 'fresh', lastFactAt: '2026-11-12T09:00:00Z' };
  eq(logic.computeDispatchObservation(r, NOW), 'fresh', '终态保持 stored');
});
test('16 分钟 stale，15 分钟 fresh', function () {
  var stale = { status: 'running', observationHealth: 'fresh', lastFactAt: '2026-11-12T11:44:00Z' };
  eq(logic.computeDispatchObservation(stale, NOW), 'stale', '16 分钟变 stale');
  var fresh = { status: 'running', observationHealth: 'fresh', lastFactAt: '2026-11-12T11:45:00Z' };
  eq(logic.computeDispatchObservation(fresh, NOW), 'fresh', '15 分钟内 fresh');
  var l = logic.observationLabel(fresh, NOW);
  eq(l.health, 'fresh', 'fresh health');
  eq(l.label, '', 'fresh label 空');
  eq(l.detail, '', 'fresh detail 空');
});
test('unknown 保持且标签', function () {
  var r = { status: 'running', observationHealth: 'unknown' };
  eq(logic.computeDispatchObservation(r, NOW), 'unknown', '保持 unknown');
  var l = logic.observationLabel(r, NOW);
  eq(l.health, 'unknown', 'unknown health');
  eq(l.label, '执行状态待核实', 'unknown label');
  eq(l.detail, '启动结果或当前状态无法核实', 'unknown 默认 detail');
});
test('stale 标签与 observationDetail 优先', function () {
  var r = { status: 'running', observationHealth: 'fresh', lastFactAt: '2026-11-12T11:44:00Z', observationDetail: '网络问题' };
  var l = logic.observationLabel(r, NOW);
  eq(l.health, 'stale', 'stale health');
  eq(l.label, '最后已知状态', 'stale label');
  eq(l.detail, '网络问题', 'detail 优先');
  var d = logic.observationLabel({ status: 'running', observationHealth: 'fresh', lastFactAt: '2026-11-12T11:44:00Z' }, NOW);
  eq(d.detail, '超过 15 分钟没有新的执行事实', 'stale 默认 detail');
});

console.log('\n[14] formatTokenUsage');
test('完整用量', function () {
  eq(logic.formatTokenUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }), '输入 1 / 输出 2 / 合计 3', '完整');
});
test('部分 null', function () {
  eq(logic.formatTokenUsage({ inputTokens: null, outputTokens: 5, totalTokens: null }), '输入 — / 输出 5 / 合计 —', '部分 null');
});
test('null 输入', function () {
  eq(logic.formatTokenUsage(null), '未提供', 'null');
});

console.log('\n[15] dispatchCardWarnings');
test('已知码映射', function () {
  var w = logic.dispatchCardWarnings(['model-unknown', 'status-unknown', 'id-missing']);
  eq(w.length, 3, '数量');
  eq(w[0], '未知模型', 'model-unknown');
  eq(w[1], '状态未识别', 'status-unknown');
  eq(w[2], '缺少记录 ID', 'id-missing');
});
test('未知码原样返回', function () {
  eq(logic.dispatchCardWarnings(['weird'])[0], 'weird', '原样');
});
test('非数组返回空', function () {
  eq(logic.dispatchCardWarnings(null).length, 0, '非数组');
});

console.log('\n[16] 回归');
test('normalizeTask 可调用', function () {
  ok(typeof logic.normalizeTask === 'function', 'normalizeTask 是函数');
  if (typeof logic.normalizeTask === 'function') {
    var n = logic.normalizeTask({});
    ok(n !== undefined, 'normalizeTask 返回非 undefined');
  }
});
test('filterMonitorTasks 可调用', function () {
  ok(typeof logic.filterMonitorTasks === 'function', 'filterMonitorTasks 是函数');
  if (typeof logic.filterMonitorTasks === 'function') {
    var f = logic.filterMonitorTasks([], 'all');
    ok(Array.isArray(f), 'filterMonitorTasks 返回数组');
  }
});
test('sortMonitorTasks 可调用', function () {
  ok(typeof logic.sortMonitorTasks === 'function', 'sortMonitorTasks 是函数');
  if (typeof logic.sortMonitorTasks === 'function') {
    var s = logic.sortMonitorTasks([]);
    ok(Array.isArray(s), 'sortMonitorTasks 返回数组');
  }
});
test('MODEL_META 原有四款仍在', function () {
  var names = ['Muse', 'Sol', 'DeepSeek', 'Astra'];
  for (var i = 0; i < names.length; i++) {
    ok(!!logic.MODEL_META[names[i]], names[i] + ' 存在');
  }
});

console.log('\n通过 ' + pass + ' 失败 ' + fail);
if (fail > 0) {
  process.exit(1);
}