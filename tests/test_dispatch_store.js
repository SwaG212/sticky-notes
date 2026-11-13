'use strict';

// 派活存储不变量测试（设计文档 §2/§5.2/§6.3，测试矩阵 L01-L06、W01-W06 中存储层部分）。
// 只测 dispatch-store.js 纯逻辑；文件锁、原子写入、故障注入见 tests/test_dispatch_record_ps1.ps1（须在 PC 上跑）。
// 注：受限沙箱禁止子进程管道 stdio，runCli 会自动退回临时文件句柄，断言不变。

const store = require('../dispatch-store');
const childProcess = require('child_process');
const path = require('path');

let passed = 0;
let failed = 0;

function ok(condition, message) {
  if (condition) {
    passed++;
    console.log('  ✓ ' + message);
  } else {
    failed++;
    console.error('  ✗ ' + message);
  }
}

function equal(actual, expected, message) {
  ok(
    Object.is(actual, expected),
    message + '（实际：' + JSON.stringify(actual) + '，期望：' + JSON.stringify(expected) + '）'
  );
}

function assertThrows(fn, expectedCode, message) {
  try {
    fn();
    failed++;
    console.error('  ✗ ' + message + '（未抛错）');
  } catch (err) {
    const code = err && err.code;
    if (code === expectedCode) {
      passed++;
      console.log('  ✓ ' + message);
    } else {
      failed++;
      console.error('  ✗ ' + message + '（抛错代码：' + code + '，期望：' + expectedCode + '）');
    }
  }
}

const OP1 = '11111111-1111-4111-8111-111111111111';
const OP2 = '22222222-2222-4222-8222-222222222222';
const OP3 = '33333333-3333-4333-8333-333333333333';
const SERVER = { recordedAt: '2026-11-12T06:10:05.000Z', writerVersion: '1.0.0', minimumReaderVersion: '1.0.0' };

function makePayload(overrides) {
  const base = {
    task: '执行导出功能回归测试',
    model: 'GLM',
    intentId: 'intent-1',
    dispatchedAt: '2026-11-12T06:10:00.000Z',
    operationId: OP1
  };
  return Object.assign(base, overrides || {});
}

function makeRecord(overrides, serverOverrides) {
  return store.createDispatchRecord(
    makePayload(overrides),
    Object.assign({}, SERVER, serverOverrides || {})
  );
}

console.log('常量与 ID 校验');
equal(store.SCHEMA_VERSION, 1, 'SCHEMA_VERSION=1');
equal(store.SUPPORTED_WRITER_VERSION, '1.0.0', 'SUPPORTED_WRITER_VERSION=1.0.0');
ok(store.DISPATCH_MODELS.indexOf('GLM') !== -1, '模型白名单含 GLM');
equal(store.DISPATCH_TOTAL_BUDGET_BYTES, 64 * 1024 * 1024, '读取预算 64MiB（不是 32MiB）');
equal(store.DISPATCH_FILE_MAX_BYTES, 5 * 1024 * 1024, '单文件上限 5MiB');
equal(store.DISPATCH_PAGE_SIZE, 50, '每页 50 条');
equal(store.OBSERVATION_STALE_MS, 15 * 60 * 1000, '观测 stale 阈值 15 分钟');
ok(store.isValidDispatchId('dispatch_2026-11-12_11111111-1111-4111-8111-111111111111'), '合法派活 ID 通过');
ok(!store.isValidDispatchId('dispatch_2026-02-30_11111111-1111-4111-8111-111111111111'), '不存在的日历日期拒绝');
ok(!store.isValidDispatchId('dispatch_2026-11-12_not-a-uuid'), '非法 UUID 拒绝');
ok(!store.isValidDispatchId('task_2026-11-12_11111111-1111-4111-8111-111111111111'), '错误前缀拒绝');
ok(store.isValidCalendarDateString('2026-11-12'), '合法日期字符串通过');
ok(!store.isValidCalendarDateString('2026-13-01'), '非法月份拒绝');
ok(store.isValidDateString('2026-11-12T06:10:00.000Z'), '合法 ISO 时间通过');
ok(!store.isValidDateString('2026-11-12 06:10:00'), '无时区的日期时间拒绝');
ok(!store.isValidDateString('not-a-date'), '非法时间字符串拒绝');

console.log('创建（L01/W01）');
const created = makeRecord();
equal(created.status, 'waiting', '新建状态 waiting');
equal(created.revision, 1, '新建 revision=1');
equal(created.finishedAt, null, '新建 finishedAt=null');
equal(created.lastFactAt, '2026-11-12T06:10:00.000Z', '新建 lastFactAt=dispatchedAt');
equal(created.recordedAt, SERVER.recordedAt, '新建 recordedAt 取服务端时间');
equal(created.lastOperationId, OP1, '新建 lastOperationId=operationId');
ok(created.id.indexOf('dispatch_2026-11-12_') === 0, '未传 id 时按 dispatchedAt 上海日期生成');
const explicit = makeRecord({ id: 'dispatch_2026-11-12_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
equal(explicit.id, 'dispatch_2026-11-12_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '显式 id 保留');
assertThrows(() => makeRecord({ task: '' }), 'MISSING_FIELD', '空 task 拒绝');
assertThrows(() => makeRecord({ task: 'x'.repeat(1001) }), 'MISSING_FIELD', 'task 超 1000 字符拒绝');
assertThrows(() => makeRecord({ model: 'Claude' }), 'INVALID_FIELD', '白名单外模型拒绝');
assertThrows(() => makeRecord({ progress: 100 }), 'INVALID_PROGRESS', '新建 progress=100 拒绝');
assertThrows(() => makeRecord({ operationId: 'not-a-uuid' }), 'MISSING_FIELD', '非法 operationId 拒绝');
assertThrows(
  () => makeRecord({}, { minimumReaderVersion: '1.0.1' }),
  'SCHEMA_INCOMPATIBLE',
  'minimumReaderVersion 高于支持版本拒绝'
);
const withUsage = makeRecord({
  tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  usageSource: 'executor-report',
  cachedTokens: 10
});
equal(withUsage.tokenUsage.totalTokens, 150, 'Token 求和一致通过');
assertThrows(
  () => makeRecord({ tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 999 } }),
  'INVALID_TOKEN',
  'Token total 与 input+output 不一致拒绝'
);
assertThrows(
  () => makeRecord({ tokenUsage: { inputTokens: -1 } }),
  'INVALID_TOKEN',
  '负数 Token 拒绝'
);

console.log('状态机（L02/L05）');
ok(store.canDispatchTransition('waiting', 'running'), 'waiting→running 合法');
ok(store.canDispatchTransition('waiting', 'completed'), 'waiting→completed 结构合法（仍需证据）');
ok(!store.canDispatchTransition('running', 'waiting'), 'running→waiting 禁止');
ok(!store.canDispatchTransition('blocked', 'waiting'), 'blocked→waiting 禁止');
ok(store.canDispatchTransition('blocked', 'running'), 'blocked→running 合法');
ok(!store.canDispatchTransition('completed', 'running'), '终态 completed→running 禁止');
ok(!store.canDispatchTransition('failed', 'cancelled'), '终态之间互转禁止');
ok(store.canDispatchTransition('running', 'running'), '同状态不算转移');
ok(!store.canDispatchTransition('running', 'unknown-state'), '未知状态拒绝');

console.log('更新与补丁（W02/W03/L05/L06）');
const rec1 = makeRecord();
const applied1 = store.applyDispatchPatch(rec1, { status: 'running', executorRef: 'exec-1' }, {
  operationId: OP2, nowIso: '2026-11-12T06:12:00.000Z', expectedRevision: 1
});
equal(applied1.changed, true, 'waiting→running 有变化');
equal(applied1.record.revision, 2, '变化后 revision+1');
equal(applied1.record.status, 'running', '状态已更新');
equal(applied1.record.lastFactAt, '2026-11-12T06:12:00.000Z', '执行事实变化推进 lastFactAt');
equal(applied1.record.updatedAt, '2026-11-12T06:12:00.000Z', '变化后 updatedAt 更新');
equal(rec1.revision, 1, '原记录不被修改');
assertThrows(
  () => store.applyDispatchPatch(rec1, { status: 'running' }, { operationId: OP2, expectedRevision: 99 }),
  'REVISION_CONFLICT',
  'expectedRevision 落后拒绝'
);
assertThrows(
  () => store.applyDispatchPatch(rec1, { task: '改内容' }, { operationId: OP2 }),
  'INVALID_FIELD',
  '补丁改身份字段 task 拒绝'
);
assertThrows(
  () => store.applyDispatchPatch(rec1, { status: 'completed', finishedAt: '2026-11-12T06:20:00.000Z', progress: 100 }, { operationId: OP2 }),
  'INVALID_TRANSITION',
  '转 completed 无成功证据拒绝（进度 100% 不是证据）'
);
const done = store.applyDispatchPatch(rec1, {
  status: 'completed', finishedAt: '2026-11-12T06:20:00.000Z', progress: 100
}, { operationId: OP2, successEvidence: true });
equal(done.record.status, 'completed', '有证据时 waiting→completed 通过');
equal(done.record.progress, 100, 'completed 进度 100');
assertThrows(
  () => store.applyDispatchPatch(rec1, { status: 'failed', finishedAt: '2026-11-12T06:20:00.000Z' }, { operationId: OP2 }),
  'MISSING_FIELD',
  'failed 无 statusDetail 原因拒绝'
);
assertThrows(
  () => store.applyDispatchPatch(rec1, { status: 'running', progress: 100 }, { operationId: OP2 }),
  'INVALID_PROGRESS',
  '非 completed 提交 progress=100 拒绝'
);
const blocked = store.applyDispatchPatch(rec1, {
  status: 'blocked', statusDetail: '等用户确认口径'
}, { operationId: OP2 });
equal(blocked.record.status, 'blocked', 'waiting→blocked 通过');
const backToWaiting = () => store.applyDispatchPatch(blocked.record, { status: 'waiting' }, { operationId: OP3 });
assertThrows(backToWaiting, 'INVALID_TRANSITION', 'blocked→waiting 禁止');
const tokenOnly = store.applyDispatchPatch(done.record, {
  tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
}, { operationId: OP3 });
equal(tokenOnly.changed, true, '终态后补 Token 允许');
equal(tokenOnly.record.lastFactAt, done.record.lastFactAt, '纯 Token 补齐不推进 lastFactAt');
assertThrows(
  () => store.applyDispatchPatch(done.record, { status: 'running' }, { operationId: OP3 }),
  'INVALID_TRANSITION',
  '终态后改状态拒绝'
);
const noChange = store.applyDispatchPatch(applied1.record, { status: 'running' }, { operationId: OP3 });
equal(noChange.changed, false, '无业务变化返回 changed=false');
equal(noChange.record.revision, applied1.record.revision, '无变化不递增 revision');
equal(noChange.record.updatedAt, applied1.record.updatedAt, '无变化不改 updatedAt');
const sameSource = makeRecord({ clockSource: { dispatchedAt: 'muse', finishedAt: 'muse', recordedAt: 'pc' } });
const earlyFinish = () => store.applyDispatchPatch(sameSource, {
  status: 'failed', finishedAt: '2026-11-12T06:00:00.000Z', statusDetail: '提前结束'
}, { operationId: OP2 });
assertThrows(earlyFinish, 'INVALID_FIELD', '同源 finishedAt 早于 dispatchedAt 拒绝');
const diffSource = makeRecord({ clockSource: { dispatchedAt: 'muse', finishedAt: 'pc', recordedAt: 'pc' } });
const earlyOk = store.applyDispatchPatch(diffSource, {
  status: 'failed', finishedAt: '2026-11-12T06:00:00.000Z', statusDetail: '时钟不同源'
}, { operationId: OP2 });
equal(earlyOk.record.status, 'failed', '不同源 finishedAt 早于 dispatchedAt 保留事实不拒绝');

console.log('幂等与重放（W02）');
const replayBase = makeRecord();
const firstApply = store.applyDispatchPatch(replayBase, { status: 'running' }, { operationId: OP2 });
const replay = store.applyDispatchPatch(firstApply.record, { status: 'running' }, { operationId: OP2 });
equal(replay.replay, true, '同 operationId 同载荷识别为重放');
equal(replay.changed, false, '重放不递增 revision');
equal(replay.record.revision, firstApply.record.revision, '重放 revision 不变');
assertThrows(
  () => store.applyDispatchPatch(firstApply.record, { status: 'blocked', statusDetail: '换载荷' }, { operationId: OP2 }),
  'OPERATION_CONFLICT',
  '同 operationId 换载荷拒绝'
);
const replayCheck = store.checkOperationReplay(firstApply.record, OP2, { status: 'running' });
equal(replayCheck.replay, true, 'checkOperationReplay 直接判定重放');
equal(store.checkOperationReplay(firstApply.record, OP3, { status: 'running' }).replay, false, '不同 operationId 不是重放');

console.log('归一化（L01/L02）');
const normBad = store.normalizeDispatchRecord({
  id: 'dispatch_2026-11-12_11111111-1111-4111-8111-111111111111',
  model: 'UnknownModel', status: 'weird', progress: 100,
  dispatchedAt: 'bad-date', recordedAt: '2026-11-12T06:10:05.000Z'
}, '2026-11-12', 0);
equal(normBad.dispatch.model, 'UnknownModel', '未知模型保留原文');
ok(normBad.warnings.indexOf('model-unknown') !== -1, '未知模型记警告');
equal(normBad.dispatch.status, null, '未知状态置 null');
ok(normBad.warnings.indexOf('status-unknown') !== -1, '未知状态记警告');
equal(normBad.dispatch.progress, null, '未知状态下的 progress=100 视为非法置 null');
ok(normBad.warnings.indexOf('progress-invalid') !== -1, '非法进度记警告');
equal(normBad.dispatch.dispatchedAt, null, '非法日期置 null');
const normNoId = store.normalizeDispatchRecord({ model: 'GLM', status: 'waiting' }, '2026-11-12', 3);
equal(normNoId.dispatch.id, '_noid_2026-11-12_3', '缺 ID 生成临时只读键');
ok(normNoId.warnings.indexOf('id-missing') !== -1, '缺 ID 记警告');
equal(normNoId.dispatch.observationHealth, 'fresh', '缺 observationHealth 默认为 fresh');
ok(normNoId.warnings.indexOf('observationHealth-missing') !== -1, '缺观测状态记警告');
const normNotObject = store.normalizeDispatchRecord('not-an-object', '2026-11-12', 0);
equal(normNotObject.dispatch, null, '非对象行 dispatch=null');
equal(normNotObject.error, 'NOT_AN_OBJECT', '非对象行错误码');
const normGood = store.normalizeDispatchRecord(makeRecord(), '2026-11-12', 0);
equal(normGood.warnings.length, 0, '合法记录无警告');

console.log('去重（W01/§2.6）');
const dupA = makeRecord({ intentId: 'intent-dup' });
const dupB = JSON.parse(JSON.stringify(dupA));
const dupC = JSON.parse(JSON.stringify(dupA));
dupC.statusDetail = '冲突副本';
const deduped = store.dedupeDispatchEntries([
  { dispatch: dupA, fileDate: '2026-11-12', warnings: [], index: 0 },
  { dispatch: dupB, fileDate: '2026-11-12', warnings: [], index: 1 },
  { dispatch: dupC, fileDate: '2026-11-12', warnings: [], index: 2 }
]);
equal(deduped.totalGroups, 1, '同 ID 只计一组');
equal(deduped.conflicts, 1, '冲突副本计 1');
equal(deduped.entries.length, 1, '去重后只剩一条');
ok(deduped.entries[0].warnings.indexOf('duplicate-conflict') !== -1, '冲突副本记警告');
const identical = store.dedupeDispatchEntries([
  { dispatch: dupA, fileDate: '2026-11-12', warnings: [], index: 0 },
  { dispatch: JSON.parse(JSON.stringify(dupA)), fileDate: '2026-11-12', warnings: [], index: 1 }
]);
equal(identical.entries.length, 1, '完全相同副本只计一条');
ok(identical.entries[0].warnings.indexOf('duplicate-identical') !== -1, '相同副本记警告');

console.log('快照合并（§6.3/S02）');
const fileA = [makeRecord({ intentId: 'a1' }), makeRecord({ intentId: 'a2', task: '第二条' })];
const fileB = [makeRecord({ intentId: 'b1', dispatchedAt: '2026-11-11T06:10:00.000Z' })];
const merged = store.mergeFileSnapshots({ generation: 0, byFile: {} }, [
  { date: '2026-11-12', ok: true, records: fileA, hash: 'h1', bytes: 1000, readAt: '2026-11-12T06:11:00.000Z' },
  { date: '2026-11-11', ok: true, records: fileB, hash: 'h2', bytes: 800, readAt: '2026-11-12T06:11:00.000Z' }
], 1);
equal(merged.records.length, 3, '两文件记录合并');
equal(merged.complete, true, '全部读取成功时 complete=true');
equal(merged.staleFileCount, 0, '无 stale 文件');
equal(merged.unreadDates.length, 0, '无未读日期');
equal(merged.changed, true, '首次合并 changed=true');
const staleGen = store.mergeFileSnapshots(merged.state, [
  { date: '2026-11-12', ok: true, records: [], hash: 'hX', bytes: 10 }
], 0);
equal(staleGen.changed, false, '旧 generation 晚到不覆盖');
equal(staleGen.records.length, 3, '旧 generation 保留旧记录');
ok(staleGen.warnings.indexOf('stale-generation') !== -1, '旧 generation 记警告');
const failedFile = store.mergeFileSnapshots(merged.state, [
  { date: '2026-11-12', ok: false, error: 'READ_FAILED' },
  { date: '2026-11-11', ok: true, records: fileB, hash: 'h2', bytes: 800, readAt: '2026-11-12T06:12:00.000Z' }
], 2);
equal(failedFile.complete, false, '有文件失败时 complete=false');
equal(failedFile.staleFileCount, 1, '失败文件用旧快照计 stale');
equal(failedFile.records.length, 3, '失败文件保留旧记录');
const overBudgetFiles = [];
for (let d = 1; d <= 14; d++) {
  const date = '2026-11-' + String(d).padStart(2, '0');
  overBudgetFiles.push({
    date: date, ok: true,
    records: [makeRecord({ intentId: 'budget-' + d, dispatchedAt: date + 'T06:10:00.000Z' })],
    hash: 'hb' + d, bytes: 5 * 1024 * 1024, readAt: '2026-11-12T06:11:00.000Z'
  });
}
const overBudget = store.mergeFileSnapshots({ generation: 0, byFile: {} }, overBudgetFiles, 1);
equal(overBudget.unreadDates.length, 2, '超预算日期列入 unreadDates（14×5MiB 仅前 12 个进预算）');
equal(overBudget.complete, false, '超预算时 complete=false');
equal(overBudget.records.length, 12, '超预算日期的记录不进入本次结果');
const tooLarge = store.mergeFileSnapshots({ generation: 0, byFile: {} }, [
  { date: '2026-11-12', ok: true, records: fileA, hash: 'h1', bytes: store.DISPATCH_TOTAL_BUDGET_BYTES, readAt: '2026-11-12T06:11:00.000Z' }
], 1);
equal(tooLarge.errors.length, 1, '单文件超 5MiB 记 FILE_TOO_LARGE 错误');
equal(tooLarge.errors[0].error, 'FILE_TOO_LARGE', '单文件超限错误码');
equal(tooLarge.complete, false, '单文件超限时 complete=false');
equal(tooLarge.records.length, 0, '单文件超限时记录不进入结果');
const badSchema = store.mergeFileSnapshots(merged.state, [
  { date: '2026-11-12', ok: true, records: [{ schemaVersion: 2, id: 'x' }], hash: 'h9', bytes: 100 }
], 3);
equal(badSchema.complete, false, '未知 schema 文件 complete=false');
equal(badSchema.records.length, 3, '未知 schema 文件保留旧快照');

// 回归（缺陷 2）：日期文件被删除后幽灵记录不能永久残留（§6.3 第 4/5 条）
console.log('文件失踪检测（§6.3 第 4/5 条，回归）');
const twoFiles = store.mergeFileSnapshots({ generation: 0, byFile: {} }, [
  { date: '2026-11-01', ok: true, records: [makeRecord({ intentId: 'ghost-a', dispatchedAt: '2026-11-01T06:10:00.000Z' })], hash: 'g1', bytes: 100, readAt: '2026-11-12T06:11:00.000Z' },
  { date: '2026-11-02', ok: true, records: [makeRecord({ intentId: 'keep-b', dispatchedAt: '2026-11-02T06:10:00.000Z' })], hash: 'g2', bytes: 100, readAt: '2026-11-12T06:11:00.000Z' }
], 1, { enumeratedDates: ['2026-11-01', '2026-11-02'], nowMs: Date.parse('2026-11-12T06:11:00.000Z') });
equal(twoFiles.records.length, 2, '两文件两记录');
const t0 = Date.parse('2026-11-12T06:20:00.000Z');
const firstMissing = store.mergeFileSnapshots(twoFiles.state, [
  { date: '2026-11-02', ok: true, records: [makeRecord({ intentId: 'keep-b', dispatchedAt: '2026-11-02T06:10:00.000Z' })], hash: 'g2', bytes: 100, readAt: '2026-11-12T06:20:00.000Z' }
], 2, { enumeratedDates: ['2026-11-02'], nowMs: t0 });
equal(firstMissing.records.length, 2, '失踪首轮保留旧快照');
equal(firstMissing.state.byFile['2026-11-01'].stale, true, '失踪文件标记 stale');
equal(firstMissing.complete, false, '失踪未确认时 complete=false');
ok(firstMissing.warnings.indexOf('file-missing:2026-11-01') !== -1, '记录 file-missing 警告');
const confirmedGone = store.mergeFileSnapshots(firstMissing.state, [
  { date: '2026-11-02', ok: true, records: [makeRecord({ intentId: 'keep-b', dispatchedAt: '2026-11-02T06:10:00.000Z' })], hash: 'g2', bytes: 100, readAt: '2026-11-12T06:20:01.000Z' }
], 3, { enumeratedDates: ['2026-11-02'], nowMs: t0 + 1000 });
equal(confirmedGone.records.length, 1, '间隔 1 秒后确认移除幽灵记录');
equal(confirmedGone.state.byFile['2026-11-01'], undefined, '幽灵文件槽位被清理');
equal(confirmedGone.complete, true, '清理后 complete 恢复 true');
equal(confirmedGone.changed, true, '删除文件记 changed');
// 未提供 enumeratedDates（如 CLI merge）时不做失踪判定，避免误删
const noEnumeration = store.mergeFileSnapshots(twoFiles.state, [
  { date: '2026-11-02', ok: true, records: [makeRecord({ intentId: 'keep-b', dispatchedAt: '2026-11-02T06:10:00.000Z' })], hash: 'g2', bytes: 100, readAt: '2026-11-12T06:20:00.000Z' }
], 2);
equal(noEnumeration.records.length, 2, '未提供枚举列表时保留旧快照');

console.log('观测健康与版本（L05/§2.4/§2.7）');
const healthRec = makeRecord();
equal(store.computeObservationHealth(healthRec, Date.parse('2026-11-12T06:11:00.000Z')), 'fresh', '15 分钟内为 fresh');
equal(store.computeObservationHealth(healthRec, Date.parse('2026-11-12T06:30:00.000Z')), 'stale', '超 15 分钟无新事实为 stale');
const doneHealth = store.applyDispatchPatch(healthRec, {
  status: 'completed', finishedAt: '2026-11-12T06:20:00.000Z', progress: 100
}, { operationId: OP2, successEvidence: true }).record;
equal(store.computeObservationHealth(doneHealth, Date.parse('2026-11-13T06:30:00.000Z')), 'fresh', '终态不因时间变 stale');
const unknownHealth = JSON.parse(JSON.stringify(healthRec));
unknownHealth.observationHealth = 'unknown';
equal(store.computeObservationHealth(unknownHealth, Date.parse('2026-11-12T06:11:00.000Z')), 'unknown', 'unknown 保持');
equal(store.compareSemver('1.0.0', '1.0.1'), -1, 'semver 1.0.0 < 1.0.1');
equal(store.compareSemver('1.0.0', '1.0.0'), 0, 'semver 相等');
equal(store.compareSemver('1.0', '1.0.0'), 0, 'semver 缺段按 0 补');
assertThrows(() => store.compareSemver('1.x', '1.0.0'), 'INVALID_VERSION', '非数字版本拒绝');
equal(store.checkSchemaCompatible(makeRecord()).ok, true, '合法记录版本兼容');
assertThrows(
  () => store.checkSchemaCompatible({ schemaVersion: 2, writerVersion: '1.0.0', minimumReaderVersion: '1.0.0' }),
  'SCHEMA_INCOMPATIBLE',
  'schemaVersion≠1 拒绝'
);

console.log('命令行 transact（供 dispatch-record.ps1 调用）');
function runCli(input) {
  const json = JSON.stringify(Object.assign({ command: 'transact' }, input));
  let result = childProcess.spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'dispatch-store.js')],
    { input: json, encoding: 'utf8' }
  );
  // 受限沙箱禁止子进程使用管道 stdio（EPERM），退回临时文件句柄，断言完全一致。
  if (result.error && result.error.code === 'EPERM') {
    const os = require('os');
    const fsMod = require('fs');
    const dir = fsMod.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cli-'));
    const inFile = path.join(dir, 'in.json');
    const outFile = path.join(dir, 'out.json');
    fsMod.writeFileSync(inFile, json, 'utf8');
    const fi = fsMod.openSync(inFile, 'r');
    const fo = fsMod.openSync(outFile, 'w+');
    const fdResult = childProcess.spawnSync(process.execPath, [path.join(__dirname, '..', 'dispatch-store.js')], { stdio: [fi, fo, fo] });
    fsMod.closeSync(fi);
    fsMod.closeSync(fo);
    result = { status: fdResult.status, stdout: fsMod.readFileSync(outFile, 'utf8') };
    fsMod.rmSync(dir, { recursive: true, force: true });
  }
  return { status: result.status, out: JSON.parse(result.stdout || '{}') };
}
const cliCreate = runCli({
  records: [],
  request: {
    action: 'create',
    operationId: OP1,
    payload: makePayload({ id: 'dispatch_2026-11-12_11111111-1111-4111-8111-111111111111' })
  },
  server: SERVER,
  nowIso: '2026-11-12T06:10:05.000Z'
});
equal(cliCreate.status, 0, 'CLI create 成功退出 0');
equal(cliCreate.out.ok, true, 'CLI create 返回 ok');
equal(cliCreate.out.records.length, 1, 'CLI create 后一条记录');
const cliDup = runCli({
  records: cliCreate.out.records,
  request: {
    action: 'create',
    operationId: OP1,
    payload: makePayload({ id: 'dispatch_2026-11-12_11111111-1111-4111-8111-111111111111' })
  },
  server: { recordedAt: '2026-11-12T06:15:00.000Z', writerVersion: '1.0.0', minimumReaderVersion: '1.0.0' },
  nowIso: '2026-11-12T06:15:00.000Z'
});
equal(cliDup.out.replay, true, 'CLI 重复 create 识别为重放');
equal(cliDup.out.records.length, 1, 'CLI 重复 create 不新增记录');
equal(cliDup.out.record.recordedAt, SERVER.recordedAt, 'CLI 重复 create 不重置 recordedAt');
const cliConflict = runCli({
  records: cliCreate.out.records,
  request: {
    action: 'create',
    operationId: OP1,
    payload: makePayload({ id: 'dispatch_2026-11-12_11111111-1111-4111-8111-111111111111', task: '换了内容' })
  },
  server: SERVER,
  nowIso: '2026-11-12T06:15:00.000Z'
});
equal(cliConflict.status, 1, 'CLI 同 ID 不同身份退出 1');
equal(cliConflict.out.code, 'ID_CONFLICT', 'CLI 同 ID 不同身份错误码 ID_CONFLICT');
const cliUpdate = runCli({
  records: cliCreate.out.records,
  request: {
    action: 'update',
    recordId: 'dispatch_2026-11-12_11111111-1111-4111-8111-111111111111',
    operationId: OP2,
    expectedRevision: 1,
    patch: { status: 'running' }
  },
  server: SERVER,
  nowIso: '2026-11-12T06:12:00.000Z'
});
equal(cliUpdate.out.ok, true, 'CLI update 返回 ok');
equal(cliUpdate.out.record.status, 'running', 'CLI update 状态已更新');
equal(cliUpdate.out.record.revision, 2, 'CLI update revision+1');
const cliNotFound = runCli({
  records: cliCreate.out.records,
  request: { action: 'update', recordId: 'dispatch_2026-11-12_99999999-9999-4999-8999-999999999999', operationId: OP2, expectedRevision: 1, patch: { status: 'running' } },
  server: SERVER,
  nowIso: '2026-11-12T06:12:00.000Z'
});
equal(cliNotFound.out.code, 'NOT_FOUND', 'CLI 更新不存在的记录返回 NOT_FOUND');

console.log('\n通过 ' + passed + ' 失败 ' + failed);
process.exit(failed ? 1 : 0);
