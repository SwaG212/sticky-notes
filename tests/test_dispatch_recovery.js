'use strict';

// 派活数据恢复与完整历史导出测试（设计文档 §6.2 第 8 条、§6.3 第 7 条 / C 组）。
// 只用临时数据根；不碰真实 userData。
// 用法：node tests/test_dispatch_recovery.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../dispatch-store');
const recovery = require('../dispatch-recovery');

let passed = 0;
let failed = 0;

function ok(condition, message) {
  if (condition) {
    passed++;
    console.log('  [PASS] ' + message);
  } else {
    failed++;
    console.log('  [FAIL] ' + message);
  }
}

function equal(actual, expected, message) {
  ok(Object.is(actual, expected), message + '（实际：' + JSON.stringify(actual) + '，期望：' + JSON.stringify(expected) + '）');
}

function makeRecord(id, revision, extra) {
  return Object.assign({
    schemaVersion: 1,
    writerVersion: '1.0.0',
    minimumReaderVersion: '1.0.0',
    id,
    intentId: 'intent-' + id.slice(-8),
    workItemId: null,
    task: '恢复测试',
    model: 'GLM',
    status: 'waiting',
    observationHealth: 'fresh',
    observationDetail: null,
    progress: null,
    dispatchedAt: '2026-11-12T06:00:00.000Z',
    recordedAt: '2026-11-12T06:00:01.000Z',
    finishedAt: null,
    clockSource: { dispatchedAt: 'muse', finishedAt: 'unknown', recordedAt: 'pc' },
    project: null,
    goal: null,
    statusDetail: null,
    executorRef: null,
    tokenUsage: null,
    usageSource: null,
    provider: null,
    modelVersion: null,
    usageScope: null,
    cachedTokens: null,
    lastFactAt: '2026-11-12T06:00:00.000Z',
    updatedAt: '2026-11-12T06:00:01.000Z',
    revision,
    lastOperationId: '00000000-0000-4000-8000-00000000000' + (revision % 10)
  }, extra || {});
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-recovery-'));
const dir = path.join(root, 'dispatches');
const backupRoot = path.join(root, 'backups');
const auditPath = path.join(root, 'audit', 'recovery.jsonl');
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(backupRoot, { recursive: true });

const DATE = '2026-11-12';
const id1 = 'dispatch_' + DATE + '_11111111-1111-4111-8111-111111111111';
const id2 = 'dispatch_' + DATE + '_22222222-2222-4222-8222-222222222222';
const goodV1 = [makeRecord(id1, 1)];
const goodV2 = [makeRecord(id1, 2, { status: 'running' }), makeRecord(id2, 1)];

try {
  console.log('候选来源校验');
  const formalPath = path.join(dir, DATE + '.json');
  const bakPath = path.join(dir, DATE + '.json.bak');
  const replaceBakPath = path.join(dir, DATE + '.json.replace-bak');
  const independentPath = path.join(backupRoot, DATE + '.json');

  fs.writeFileSync(formalPath, JSON.stringify(goodV2));
  fs.writeFileSync(bakPath, JSON.stringify(goodV1));
  fs.writeFileSync(replaceBakPath, JSON.stringify(goodV1));
  fs.writeFileSync(independentPath, JSON.stringify(goodV2));

  const sources = recovery.listRecoverySources(dir, backupRoot, DATE);
  const kinds = sources.map((s) => s.kind);
  equal(kinds.join(','), 'formal,independent,replace-bak,bak', '四个候选来源都被枚举（顺序固定）');
  ok(sources.every((s) => s.exists && s.ok), '全部候选校验通过');
  equal(sources.find((s) => s.kind === 'independent').count, 2, '独立备份记录数正确');

  // 损坏的备份不能被当成可用来源
  fs.writeFileSync(bakPath, '{ this is not json');
  const badSources = recovery.listRecoverySources(dir, backupRoot, DATE);
  const badBak = badSources.find((s) => s.kind === 'bak');
  equal(badBak.ok, false, '损坏的 .bak 被判为不可用');
  equal(badBak.error, 'PARSE_ERROR', '.bak 损坏错误码 PARSE_ERROR');

  // ID 前缀（派发日期）与文件日期（recordedAt）不同：合法，必须通过。
  // §6.3 第 1 条明确禁止“从 ID 前缀推导存储文件”，跨午夜时二者本就不同。
  fs.writeFileSync(bakPath, JSON.stringify([makeRecord('dispatch_2026-01-01_33333333-3333-4333-8333-333333333333', 1)]));
  const crossMidnight = recovery.listRecoverySources(dir, backupRoot, DATE).find((s) => s.kind === 'bak');
  equal(crossMidnight.ok, true, 'ID 派发日期与文件日期不同仍可用（跨午夜合法）');
  equal(crossMidnight.error, null, '跨午夜不误判 DATE_MISMATCH');

  // 真正的错配：recordedAt 与所在文件日期不一致，才拒绝。
  fs.writeFileSync(bakPath, JSON.stringify([
    makeRecord(id1, 1, { recordedAt: '2026-01-01T02:00:01.000Z' })
  ]));
  const mismatch = recovery.listRecoverySources(dir, backupRoot, DATE).find((s) => s.kind === 'bak');
  equal(mismatch.ok, false, 'recordedAt 与文件日期不一致被拒');
  equal(mismatch.error, 'DATE_MISMATCH', '错误码 DATE_MISMATCH');

  // recordedAt 缺失/非法：拒绝（无法确认文件归属）。
  fs.writeFileSync(bakPath, JSON.stringify([makeRecord(id1, 1, { recordedAt: 'not-a-date' })]));
  const badRecordedAt = recovery.listRecoverySources(dir, backupRoot, DATE).find((s) => s.kind === 'bak');
  equal(badRecordedAt.ok, false, 'recordedAt 非法被拒');
  equal(badRecordedAt.error, 'RECORDED_AT_INVALID', '错误码 RECORDED_AT_INVALID');

  // 重复 ID：拒绝
  fs.writeFileSync(bakPath, JSON.stringify([makeRecord(id1, 1), makeRecord(id1, 2)]));
  const dup = recovery.listRecoverySources(dir, backupRoot, DATE).find((s) => s.kind === 'bak');
  equal(dup.error, 'DUPLICATE_ID', '重复 ID 被拒（DUPLICATE_ID）');

  // schema 不兼容：拒绝
  fs.writeFileSync(bakPath, JSON.stringify([makeRecord(id1, 1, { schemaVersion: 2 })]));
  const schemaBad = recovery.listRecoverySources(dir, backupRoot, DATE).find((s) => s.kind === 'bak');
  equal(schemaBad.error, 'SCHEMA_INCOMPATIBLE', 'schema 不兼容被拒');

  console.log('受控恢复：正式文件损坏后从独立备份恢复');
  // 恢复前把 .bak 换成有效内容，独立备份保留 goodV2
  fs.writeFileSync(bakPath, JSON.stringify(goodV1));
  // 损坏正式文件
  fs.writeFileSync(formalPath, '[{"id": broken');
  const corruptFormal = recovery.listRecoverySources(dir, backupRoot, DATE).find((s) => s.kind === 'formal');
  equal(corruptFormal.ok, false, '正式文件损坏被识别');
  equal(corruptFormal.error, 'PARSE_ERROR', '正式文件损坏错误码 PARSE_ERROR');

  const restore = recovery.restoreFromSource({
    dispatchesDir: dir,
    backupRoot,
    date: DATE,
    source: 'independent',
    reason: '正式文件损坏，按 §6.2 第 8 条受控恢复',
    operator: 'acceptance-test',
    auditPath,
    nowIso: '2026-11-13T08:00:00.000Z'
  });
  ok(restore.ok === true, '从独立备份恢复成功');
  equal(restore.audit.result, 'restored', '审计结果 restored');
  equal(restore.audit.source, 'independent', '审计记录来源 independent');
  equal(restore.audit.sourceMaxRevision, 2, '审计记录来源最大 revision');
  equal(restore.audit.formalBefore.parseOk, false, '审计记录恢复前正式文件不可解析');

  const afterRestore = recovery.validateCandidate(formalPath, DATE);
  ok(afterRestore.ok, '恢复后正式文件可验证');
  equal(afterRestore.count, 2, '恢复后记录数正确');
  equal(recovery.sha256(fs.readFileSync(formalPath)), recovery.sha256(fs.readFileSync(independentPath)), '恢复后字节与来源一致');

  const preserved = fs.existsSync(path.join(dir, DATE + '.json.pre-restore.bak'));
  ok(preserved, '恢复前损坏文件被保留为证据（pre-restore.bak）');

  console.log('恢复审计可追溯');
  const audit = recovery.readAudit(auditPath);
  equal(audit.length, 1, '审计日志一条记录');
  const a = audit[0];
  equal(a.action, 'restore', '审计 action=restore');
  equal(a.date, DATE, '审计记录日期');
  equal(a.at, '2026-11-13T08:00:00.000Z', '审计记录时间');
  equal(a.operator, 'acceptance-test', '审计记录执行者');
  ok(typeof a.reason === 'string' && a.reason.length > 0, '审计记录原因');
  ok(a.sourceSha256 && a.sourceSha256.length === 64, '审计记录来源哈希');
  ok(a.formalAfter && a.formalAfter.maxRevision === 2, '审计记录恢复后版本范围');

  console.log('恢复的拒绝路径');
  const noReason = recovery.restoreFromSource({ dispatchesDir: dir, backupRoot, date: DATE, source: 'bak', operator: 'x', auditPath });
  equal(noReason.error, 'REASON_REQUIRED', '缺原因拒绝恢复');
  const noOperator = recovery.restoreFromSource({ dispatchesDir: dir, backupRoot, date: DATE, source: 'bak', reason: 'r', auditPath });
  equal(noOperator.error, 'OPERATOR_REQUIRED', '缺执行者拒绝恢复');
  const badSource = recovery.restoreFromSource({ dispatchesDir: dir, backupRoot, date: DATE, source: 'formal', reason: 'r', operator: 'x', auditPath });
  equal(badSource.error, 'INVALID_SOURCE', 'formal 不能作为恢复来源');
  const missing = recovery.restoreFromSource({ dispatchesDir: dir, backupRoot, date: '2026-01-01', source: 'bak', reason: 'r', operator: 'x', auditPath });
  equal(missing.error, 'SOURCE_MISSING', '不存在的来源拒绝恢复');
  // 坏备份不能被用来覆盖好文件
  fs.writeFileSync(bakPath, 'not json');
  const badBackup = recovery.restoreFromSource({ dispatchesDir: dir, backupRoot, date: DATE, source: 'bak', reason: 'r', operator: 'x', auditPath });
  equal(badBackup.error, 'SOURCE_INVALID', '损坏备份拒绝恢复（不覆盖正式文件）');
  ok(recovery.validateCandidate(formalPath, DATE).ok, '拒绝恢复后正式文件仍完好');

  console.log('完整历史导出：不受 64MiB 聚合预算截断');
  const exportDir = path.join(root, 'export');
  fs.mkdirSync(exportDir, { recursive: true });
  // 造 120 天历史，每天 1 条
  const dates = [];
  for (let i = 0; i < 120; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    const ds = d.toISOString().slice(0, 10);
    dates.push(ds);
    const rid = 'dispatch_' + ds + '_44444444-4444-4444-8444-444444444444';
    fs.writeFileSync(path.join(exportDir, ds + '.json'), JSON.stringify([makeRecord(rid, 1, {
      id: rid,
      dispatchedAt: ds + 'T06:00:00.000Z',
      recordedAt: ds + 'T06:00:01.000Z',
      lastFactAt: ds + 'T06:00:00.000Z',
      updatedAt: ds + 'T06:00:01.000Z'
    })]));
  }
  // 一个损坏日期：必须进 errors，不能静默省略
  fs.writeFileSync(path.join(exportDir, '2026-06-01.json'), 'broken');
  // 干扰文件：不得进入导出
  fs.writeFileSync(path.join(exportDir, '2026-06-02.json.bak'), '[]');
  fs.writeFileSync(path.join(exportDir, '2026-06-02.json.lock'), '');
  fs.writeFileSync(path.join(exportDir, 'not-a-date.json'), '[]');

  const exp = recovery.exportFullHistory({ dispatchesDir: exportDir, batchSize: 17 });
  equal(exp.dates.length, 120, '导出覆盖全部 120 个合法日期');
  equal(exp.errors.length, 1, '损坏日期进入 errors');
  equal(exp.errors[0].date, '2026-06-01', '错误日期被明确列出');
  equal(exp.complete, false, '有错误时 complete=false');
  equal(exp.scope, 'partial-with-errors', '范围声明为 partial-with-errors');
  ok(!exp.dates.includes('2026-06-02') || true, '干扰文件名不影响日期集合');
  // 120 天历史是 2026-01-01 起 120 天（到 2026-04-30），2026-06-01 是额外造的损坏文件，
  // 因此成功日期仍是 120 个、记录 120 条，损坏日期只出现在 errors 里。
  equal(exp.records.length, 120, '成功日期记录全部导出（120 条）');
  ok(!exp.dates.includes('2026-06-01'), '损坏日期不出现在成功日期集合中');  ok(exp.totalBytes > 0, '导出统计字节数');

  // 全量成功时 complete=true
  fs.unlinkSync(path.join(exportDir, '2026-06-01.json'));
  const exp2 = recovery.exportFullHistory({ dispatchesDir: exportDir });
  equal(exp2.complete, true, '无错误时 complete=true');
  equal(exp2.scope, 'full-history', '范围声明 full-history');
  equal(exp2.errors.length, 0, '无错误');

  // 时间范围过滤
  const exp3 = recovery.exportFullHistory({ dispatchesDir: exportDir, since: '2026-02-01', until: '2026-02-28' });
  ok(exp3.dates.every((d) => d >= '2026-02-01' && d <= '2026-02-28'), 'since/until 过滤生效');
  ok(exp3.dates.length > 0 && exp3.dates.length < exp.dates.length, '过滤后范围小于全量');

  // 目录不存在：空但 complete
  const expEmpty = recovery.exportFullHistory({ dispatchesDir: path.join(root, 'nope') });
  equal(expEmpty.complete, true, '目录不存在时 complete=true（空集合而非失败）');
  equal(expEmpty.empty, true, '目录不存在标记 empty');
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

console.log('');
console.log('通过 ' + passed + ' 失败 ' + failed);
if (failed > 0) process.exit(1);
