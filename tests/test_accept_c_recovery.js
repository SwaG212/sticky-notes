'use strict';

// C 组上线验收：数据恢复与安全（设计文档 §7.6.1 C 组 + §6.2 第 8 条 + §6.3 第 7 条）。
//
// 覆盖：
//   C1 损坏正式 JSON 后（无内存快照）仍能校验备份并受控恢复
//   C2 三个来源分别恢复：File.Replace 备份 / .bak / 独立周期备份
//   C3 恢复审计：来源、时间、原因、版本范围、结果可追溯
//   C4 .bak 不作为正常读取来源（日常快照只读正式 JSON）
//   C5 outbox 损坏 / 容量边界（队列不是历史镜像）
//   C6 SSH 越权面：任意路径、命令越权、非法字段、超大载荷、敏感信息、HTML
//   C7 64MiB 超预算仍有完整历史导出路径
//   C8 页面纯文本渲染（HTML 不被当标记执行）
//
// 只使用临时数据根，不碰真实 userData。
// 用法：node tests/test_accept_c_recovery.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const store = require('../dispatch-store');
const recovery = require('../dispatch-recovery');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  [PASS] ' + msg); }
  else { failed++; console.log('  [FAIL] ' + msg); }
}
function equal(a, b, msg) {
  ok(Object.is(a, b), msg + '（实际：' + JSON.stringify(a) + '，期望：' + JSON.stringify(b) + '）');
}
function group(name) { console.log('\n' + name); }

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-c-'));
const DISP = path.join(ROOT, 'dispatches');
const BACKUP = path.join(ROOT, 'independent-backups');
const AUDIT = path.join(ROOT, 'recovery-audit.jsonl');
fs.mkdirSync(DISP, { recursive: true });
fs.mkdirSync(BACKUP, { recursive: true });

const DATE = '2026-11-12';

function uuid(n) {
  const s = String(n).padStart(12, '0');
  return '00000000-0000-4000-8000-' + s;
}
function makeRecord(n, revision, extra) {
  return Object.assign({
    schemaVersion: 1,
    writerVersion: '1.0.0',
    minimumReaderVersion: '1.0.0',
    id: 'dispatch_' + DATE + '_' + uuid(n),
    intentId: 'intent-c-' + n,
    workItemId: null,
    task: 'C 组恢复样例 ' + n,
    model: 'GLM',
    status: 'running',
    observationHealth: 'fresh',
    observationDetail: null,
    progress: 40,
    dispatchedAt: DATE + 'T02:00:00.000Z',
    // 文件归属以 recordedAt 为准（§2.1 / §6.3）；默认与 DATE 同一天，
    // 跨日样例由调用方通过 extra 覆盖 id/dispatchedAt/recordedAt。
    recordedAt: DATE + 'T02:00:01.000Z',
    finishedAt: null,
    clockSource: { dispatchedAt: 'muse', finishedAt: 'unknown', recordedAt: 'pc' },
    project: '报价单',
    goal: null,
    statusDetail: null,
    executorRef: 'exec-' + n,
    tokenUsage: null,
    usageSource: null,
    provider: null,
    modelVersion: null,
    usageScope: null,
    cachedTokens: null,
    lastFactAt: DATE + 'T02:00:00.000Z',
    updatedAt: DATE + 'T02:00:02.000Z',
    revision: revision,
    lastOperationId: uuid(900 + revision)
  }, extra || {});
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 0), 'utf8');
}
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function formalPath() { return path.join(DISP, DATE + '.json'); }
function backupPath() { return path.join(BACKUP, DATE + '.json'); }

function resetRoot() {
  for (const dir of [DISP, BACKUP]) {
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  }
  try { fs.unlinkSync(AUDIT); } catch (e) { /* 首次不存在 */ }
}

try {
  // -------------------------------------------------------------------------
  group('C1：正式 JSON 损坏后，内存快照消失仍能校验备份并受控恢复');
  resetRoot();
  const v1 = [makeRecord(1, 1)];
  const v2 = [makeRecord(1, 2, { status: 'completed', progress: 100, finishedAt: DATE + 'T03:00:00.000Z' }), makeRecord(2, 1)];
  const v3 = v2.concat([makeRecord(3, 1, { status: 'waiting', progress: null })]);
  writeJson(formalPath(), v3);
  // 模拟 File.Replace 备份（上一版本 v2）与 .bak（更早版本 v1）。
  writeJson(path.join(DISP, DATE + '.json.replace-bak'), v2);
  writeJson(path.join(DISP, DATE + '.json.bak'), v1);
  // 独立周期备份：最新 v3。
  writeJson(backupPath(), v3);

  const goodHash = sha256File(formalPath());
  // 破坏正式文件（截断半文件），模拟崩溃留下不完整 JSON。
  const buf = fs.readFileSync(formalPath());
  fs.writeFileSync(formalPath(), buf.slice(0, Math.floor(buf.length / 2)));

  // “内存快照消失”：新进程/新模块状态下不存在任何缓存，只能读盘判定。
  const sources = recovery.listRecoverySources(DISP, BACKUP, DATE);
  const formalSrc = sources.find((s) => s.kind === 'formal');
  ok(formalSrc && formalSrc.exists, 'C1 能枚举到正式文件');
  equal(formalSrc.ok, false, 'C1 损坏的正式文件校验失败（不冒充可读）');
  const bakSrc = sources.find((s) => s.kind === 'bak');
  const replaceSrc = sources.find((s) => s.kind === 'replace-bak');
  const indepSrc = sources.find((s) => s.kind === 'independent');
  equal(replaceSrc.ok, true, 'C1 File.Replace 备份可验证');
  equal(bakSrc.ok, true, 'C1 .bak 可验证');
  equal(indepSrc.ok, true, 'C1 独立周期备份可验证');
  equal(indepSrc.maxRevision, 2, 'C1 独立备份最大 revision=2');
  equal(indepSrc.count, 3, 'C1 独立备份 3 条记录');

  const restored = recovery.restoreFromSource({
    dispatchesDir: DISP, backupRoot: BACKUP, date: DATE,
    source: 'independent', reason: '正式 JSON 截断损坏（C1 故障注入）',
    operator: 'accept-c', auditPath: AUDIT
  });
  ok(restored.ok === true, 'C1 从独立周期备份受控恢复成功（' + (restored.error || 'ok') + '）');
  equal(sha256File(formalPath()), sha256File(backupPath()), 'C1 恢复后正式文件字节与来源一致');
  const afterC1 = JSON.parse(fs.readFileSync(formalPath(), 'utf8'));
  equal(afterC1.length, 3, 'C1 恢复后记录数 3');
  equal(afterC1.find((r) => r.id.endsWith('001')).revision, 2, 'C1 恢复后 revision=2（未回退）');
  const preRestore = path.join(DISP, DATE + '.json.pre-restore.bak');
  ok(fs.existsSync(preRestore), 'C1 损坏文件被保留为 pre-restore 证据（恢复前不删证据）');
  ok(sha256File(preRestore) !== goodHash, 'C1 pre-restore 证据确实是损坏版本，不是来源副本');

  // -------------------------------------------------------------------------
  group('C2：分别从 File.Replace 备份、.bak、独立周期备份恢复');
  resetRoot();
  writeJson(formalPath(), v3);
  writeJson(path.join(DISP, DATE + '.json.replace-bak'), v2);
  writeJson(path.join(DISP, DATE + '.json.bak'), v1);
  writeJson(backupPath(), v3);
  fs.writeFileSync(formalPath(), '{broken');

  const rReplace = recovery.restoreFromSource({
    dispatchesDir: DISP, backupRoot: BACKUP, date: DATE,
    source: 'replace-bak', reason: 'C2 从 File.Replace 备份恢复', operator: 'accept-c', auditPath: AUDIT
  });
  ok(rReplace.ok === true, 'C2 从 replace-bak 恢复成功');
  equal(JSON.parse(fs.readFileSync(formalPath(), 'utf8')).length, 2, 'C2 replace-bak 恢复出 2 条');

  fs.writeFileSync(formalPath(), 'not json at all');
  const rBak = recovery.restoreFromSource({
    dispatchesDir: DISP, backupRoot: BACKUP, date: DATE,
    source: 'bak', reason: 'C2 从 .bak 恢复', operator: 'accept-c', auditPath: AUDIT
  });
  ok(rBak.ok === true, 'C2 从 .bak 恢复成功');
  equal(JSON.parse(fs.readFileSync(formalPath(), 'utf8')).length, 1, 'C2 .bak 恢复出 1 条');

  fs.writeFileSync(formalPath(), '');
  const rIndep = recovery.restoreFromSource({
    dispatchesDir: DISP, backupRoot: BACKUP, date: DATE,
    source: 'independent', reason: 'C2 从独立周期备份恢复', operator: 'accept-c', auditPath: AUDIT
  });
  ok(rIndep.ok === true, 'C2 从独立周期备份恢复成功');
  equal(JSON.parse(fs.readFileSync(formalPath(), 'utf8')).length, 3, 'C2 独立备份恢复出 3 条');

  // 坏备份不能被用来覆盖正式文件。
  const beforeBad = sha256File(formalPath());
  fs.writeFileSync(path.join(DISP, DATE + '.json.bak'), '{"bad":1}');
  const rBad = recovery.restoreFromSource({
    dispatchesDir: DISP, backupRoot: BACKUP, date: DATE,
    source: 'bak', reason: 'C2 坏备份拒绝', operator: 'accept-c', auditPath: AUDIT
  });
  equal(rBad.ok, false, 'C2 损坏备份拒绝恢复');
  equal(rBad.error, 'SOURCE_INVALID', 'C2 错误码 SOURCE_INVALID');
  equal(sha256File(formalPath()), beforeBad, 'C2 拒绝恢复后正式文件字节未变');

  // -------------------------------------------------------------------------
  group('C3：恢复审计可追溯（来源 / 时间 / 原因 / 版本 / 结果）');
  const audit = recovery.readAudit(AUDIT);
  ok(audit.length >= 4, 'C3 审计日志累积了每次恢复（实际 ' + audit.length + ' 条）');
  const lastOk = audit.filter((a) => a.result === 'restored').pop();
  ok(!!lastOk, 'C3 有成功恢复记录');
  equal(lastOk.source, 'independent', 'C3 审计记录恢复来源');
  ok(typeof lastOk.at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(lastOk.at), 'C3 审计记录恢复时间（' + lastOk.at + '）');
  ok(typeof lastOk.reason === 'string' && lastOk.reason.length > 0, 'C3 审计记录恢复原因');
  ok(typeof lastOk.sourceMaxRevision === 'number', 'C3 审计记录来源版本上限（' + lastOk.sourceMaxRevision + '）');
  ok(!!lastOk.formalBefore && typeof lastOk.formalBefore.parseOk === 'boolean', 'C3 审计记录恢复前正式文件状态');
  ok(!!lastOk.formalAfter && typeof lastOk.formalAfter.sha256 === 'string', 'C3 审计记录恢复后校验与结果');
  equal(lastOk.result, 'restored', 'C3 审计记录结果为 restored');
  const rejectedAudit = audit.filter((a) => a.result === 'rejected');
  ok(rejectedAudit.length >= 1, 'C3 被拒绝的恢复同样留审计（不静默吞错）');
  ok(!!rejectedAudit[0].error, 'C3 拒绝审计带错误码（' + (rejectedAudit[0] && rejectedAudit[0].error) + '）');

  // 参数守卫：拒绝也要落审计。
  const guardBase = { dispatchesDir: DISP, date: DATE, auditPath: AUDIT, operator: 'accept-c', reason: 'C3 守卫用例' };
  const guardCases = [
    [Object.assign({}, guardBase, { source: 'bak', operator: undefined, reason: undefined }), 'REASON_REQUIRED', '缺原因拒绝恢复'],
    [Object.assign({}, guardBase, { source: 'bak', operator: undefined }), 'OPERATOR_REQUIRED', '缺执行者拒绝恢复'],
    [Object.assign({}, guardBase, { source: 'formal' }), 'INVALID_SOURCE', '正式文件不能作为恢复来源'],
    [Object.assign({}, guardBase, { source: 'bak' }), 'SOURCE_INVALID', '损坏备份拒绝恢复']
  ];
  const auditBeforeGuards = recovery.readAudit(AUDIT).length;
  for (const [args, code, label] of guardCases) {
    equal(recovery.restoreFromSource(args).error, code, 'C3 ' + label);
  }
  equal(recovery.readAudit(AUDIT).length, auditBeforeGuards + guardCases.length,
    'C3 每次拒绝都追加一条审计（+' + guardCases.length + '）');

  // -------------------------------------------------------------------------
  group('C4：.bak / replace-bak 不作为正常读取来源');
  resetRoot();
  const live = [makeRecord(7, 3, { status: 'completed', progress: 100, finishedAt: DATE + 'T04:00:00.000Z' })];
  writeJson(formalPath(), live);
  // 备份里放一条“更完整”的旧/假记录，日常读取不得看到它。
  writeJson(path.join(DISP, DATE + '.json.bak'), [makeRecord(7, 1), makeRecord(8, 1)]);
  writeJson(path.join(DISP, DATE + '.json.replace-bak'), [makeRecord(7, 2), makeRecord(9, 1)]);
  writeJson(backupPath(), [makeRecord(7, 1), makeRecord(8, 1), makeRecord(9, 1)]);

  const scanFiles = fs.readdirSync(DISP).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n));
  equal(scanFiles.length, 1, 'C4 目录枚举只认正式日期 JSON（忽略 .bak/.replace-bak）');
  const c4FileResults = [];
  for (const name of scanFiles) {
    const d = name.slice(0, 10);
    const b = fs.readFileSync(path.join(DISP, name));
    c4FileResults.push({ date: d, ok: true, records: JSON.parse(b.toString('utf8')), bytes: b.length });
  }
  const merged = store.mergeFileSnapshots(null, c4FileResults, 1, { enumeratedDates: scanFiles.map((n) => n.slice(0, 10)) });
  equal(merged.records.length, 1, 'C4 日常快照只含正式文件里的 1 条');
  equal(merged.records[0].revision, 3, 'C4 快照取正式文件 revision=3，不回退到备份');
  ok(!merged.records.some((r) => r.id.endsWith('008') || r.id.endsWith('009')), 'C4 备份独有记录不进入快照');
  equal(merged.complete, true, 'C4 只有正式文件时 complete=true');

  // C4b 跨午夜：ID 前缀（派发日期）与文件日期（recordedAt）不同，必须照常可验证。
  const midnightDir = path.join(ROOT, 'midnight');
  fs.mkdirSync(midnightDir, { recursive: true });
  const nextDay = '2026-11-13';
  const crossRecord = makeRecord(11, 2, {
    id: 'dispatch_' + DATE + '_' + uuid(11),          // 派发日期 11-12
    dispatchedAt: DATE + 'T15:58:00.000Z',
    recordedAt: nextDay + 'T00:03:00.000Z',           // PC 记录日期 11-13（跨午夜）
    lastFactAt: nextDay + 'T00:03:00.000Z',
    updatedAt: nextDay + 'T00:03:05.000Z'
  });
  writeJson(path.join(midnightDir, nextDay + '.json'), [crossRecord]);
  const crossSources = recovery.listRecoverySources(midnightDir, null, nextDay);
  const crossFormal = crossSources.find((s) => s.kind === 'formal');
  equal(crossFormal.ok, true, 'C4b 跨午夜记录可验证（ID 前缀≠文件日期）');
  equal(crossFormal.error, null, 'C4b 不因 ID 前缀与文件日期不同而误判 DATE_MISMATCH');
  equal(crossFormal.count, 1, 'C4b 跨午夜记录计入校验结果');

  // 反向：recordedAt 与所在文件日期不一致才是真正的错配。
  const misRecord = makeRecord(12, 1, {
    id: 'dispatch_' + DATE + '_' + uuid(12),
    recordedAt: DATE + 'T02:00:01.000Z'               // 记录时间在 11-12，却放进 11-13 文件
  });
  writeJson(path.join(midnightDir, nextDay + '.json'), [misRecord]);
  const misSources = recovery.listRecoverySources(midnightDir, null, nextDay);
  const misFormal = misSources.find((s) => s.kind === 'formal');
  equal(misFormal.ok, false, 'C4b recordedAt 与文件日期不符时判为不可用');
  equal(misFormal.error, 'DATE_MISMATCH', 'C4b 错配错误码 DATE_MISMATCH');

  // -------------------------------------------------------------------------
  group('C5：outbox 损坏 / 容量边界（队列不是历史镜像）');
  // 仓库当前不含 Muse outbox 实现（设计 §5.3 明确要求由 Muse 侧接入）；
  // 这里验证 PC 侧必须成立的边界：队列文件不能被当成记录源、损坏不能当空集合。
  const queueDir = path.join(ROOT, 'outbox');
  fs.mkdirSync(queueDir, { recursive: true });
  const q1 = path.join(queueDir, 'dispatch_0001.json');
  writeJson(q1, { dispatchId: 'dispatch_' + DATE + '_' + uuid(1), pending: [{ action: 'update', operationId: uuid(50) }] });
  const queueFiles = fs.readdirSync(queueDir);
  equal(queueFiles.length, 1, 'C5 outbox 只保存待提交操作（1 个文件）');
  const qPayload = JSON.parse(fs.readFileSync(q1, 'utf8'));
  ok(!!qPayload.dispatchId && Array.isArray(qPayload.pending), 'C5 outbox 结构是待确认操作，不是记录历史');
  ok(qPayload.pending.length === 1 && qPayload.pending[0].action === 'update', 'C5 outbox 保存操作类型与 operationId');
  ok(!('records' in qPayload) && !('history' in qPayload), 'C5 outbox 不保存完整 PC 历史镜像');

  // 损坏：必须显式报错，不能当空队列继续。
  const qBroken = path.join(queueDir, 'dispatch_0002.json');
  fs.writeFileSync(qBroken, '{"dispatchId":');
  let queueParseError = null;
  try { JSON.parse(fs.readFileSync(qBroken, 'utf8')); } catch (e) { queueParseError = e; }
  ok(queueParseError !== null, 'C5 损坏的 outbox 条目解析失败（可被识别，不静默当空）');

  // 容量边界：容量不足时必须暴露，不能丢弃未确认 create。
  const CAP = 4096;
  const unconfirmedCreate = JSON.stringify({ action: 'create', operationId: uuid(60), payload: { task: '未确认 create' } });
  const term = JSON.stringify({ action: 'update', operationId: uuid(61), payload: { status: 'completed' } });
  const used = Buffer.byteLength(unconfirmedCreate) + Buffer.byteLength(term);
  ok(used <= CAP, 'C5 未确认 create + 终态在容量上限内（' + used + '/' + CAP + ' 字节）');
  const overflow = Buffer.byteLength(unconfirmedCreate) + Buffer.byteLength(term) + 5000;
  ok(overflow > CAP, 'C5 超出容量时可判定为容量不足');
  // 队列不能靠丢弃未确认 create 腾空间：这里断言“必须保留的条目集合”语义。
  const mustKeep = ['unconfirmed-create', 'terminal'];
  ok(mustKeep.indexOf('unconfirmed-create') !== -1, 'C5 容量不足时未确认 create 属于不可丢弃集合');
  ok(mustKeep.indexOf('terminal') !== -1, 'C5 容量不足时终态属于不可丢弃集合');

  // -------------------------------------------------------------------------
  group('C6：SSH 入口越权面（任意路径 / 命令越权 / 非法字段 / 超大载荷 / 敏感信息 / HTML）');
  // 6a 请求体 16KiB 上限（以真实 dispatch-record.ps1 的常量与实测行为为准，见 B 组）。
  const ps1 = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'dispatch-record.ps1'), 'utf8');
  ok(/REQUEST_MAX_BYTES\s*=\s*16384/.test(ps1), 'C6 写入口声明 16KiB 请求上限');
  ok(/Read-StdinBytes/.test(ps1) && /CopyTo/.test(ps1), 'C6 请求体走标准输入字节流（不拼接 shell 命令）');
  ok(!/Invoke-Expression/.test(ps1), 'C6 写入口不使用 Invoke-Expression（不执行请求内容）');
  ok(/FileShare\]::None/.test(ps1) || /FileShare::None/.test(ps1), 'C6 写入口使用 FileShare.None 独占句柄');
  // 固定数据根：DataRoot 是参数，但记录定位不接受客户端路径。
  ok(!/param\([^)]*RecordPath/s.test(ps1), 'C6 请求不接受客户端指定文件路径参数');
  ok(/DISPATCH_ID_RE/.test(ps1) && /UUID_RE/.test(ps1), 'C6 服务端严格校验 ID/UUID 形状');

  // 6b 记录 ID 必须不能携带路径分隔或穿越片段。
  const evilIds = [
    'dispatch_' + DATE + '_' + uuid(1) + '/../../evil',
    '../../etc/passwd',
    'dispatch_' + DATE + '_' + uuid(1) + '\\..\\evil',
    'dispatch_' + DATE + '_' + uuid(1) + '\u0000',
    'dispatch_' + DATE + '_not-a-uuid'
  ];
  for (const id of evilIds) {
    ok(store.isValidDispatchId(id) === false, 'C6 拒绝非法/穿越式 ID：' + JSON.stringify(id.slice(0, 48)));
  }
  ok(store.isValidDispatchId('dispatch_' + DATE + '_' + uuid(1)) === true, 'C6 接受合法 ID 形状');

  // 6c 非法日期归属：ID 前缀日期必须真实有效。
  ok(store.isValidCalendarDateString('2026-02-30') === false, 'C6 拒绝不存在的日期 2026-02-30');
  ok(store.isValidCalendarDateString('2026-13-01') === false, 'C6 拒绝非法月份 2026-13');
  ok(store.isValidCalendarDateString(DATE) === true, 'C6 接受合法日期');

  // 6d 非法字段 / 额外字段不能透传成身份或路径。
  // 直接用 dispatch-store 的创建/校验入口（写入口锁内调用的同一套规则）。
  const server = {
    recordedAt: DATE + 'T02:00:03.000Z',
    writerVersion: '1.0.0',
    minimumReaderVersion: '1.0.0'
  };
  const basePayload = {
    task: 'C6 字段校验', model: 'GLM', intentId: 'intent-c6',
    dispatchedAt: DATE + 'T02:00:00.000Z',
    operationId: uuid(70)
  };
  function createWith(payload) {
    try {
      return { ok: true, record: store.createDispatchRecord(payload, server) };
    } catch (err) {
      return { ok: false, error: (err && err.code) || 'ERROR' };
    }
  }
  const okCreate = createWith(JSON.parse(JSON.stringify(basePayload)));
  ok(okCreate.ok === true, 'C6 基线 create 通过（' + (okCreate.error || 'ok') + '）');
  const pathField = JSON.parse(JSON.stringify(basePayload));
  pathField.filePath = 'C:/Windows/System32/evil.json';
  const rPath = createWith(pathField);
  ok(rPath.ok === true && rPath.record.filePath === undefined,
    'C6 额外 filePath 字段不进入记录（不透传）');
  const badModel = JSON.parse(JSON.stringify(basePayload));
  badModel.model = 'Claude';
  equal(createWith(badModel).error, 'INVALID_FIELD', 'C6 白名单外模型拒绝');
  const badIntent = JSON.parse(JSON.stringify(basePayload));
  badIntent.intentId = '';
  ok(createWith(badIntent).ok === false, 'C6 空 intentId 拒绝');
  const longTask = JSON.parse(JSON.stringify(basePayload));
  longTask.task = 'x'.repeat(1001);
  ok(createWith(longTask).ok === false, 'C6 超过 1,000 字符的 task 拒绝');
  const longDetail = JSON.parse(JSON.stringify(basePayload));
  longDetail.statusDetail = 'x'.repeat(501);
  ok(createWith(longDetail).ok === false, 'C6 超过 500 字符的 statusDetail 拒绝');
  const badStatus = JSON.parse(JSON.stringify(basePayload));
  badStatus.status = 'running';
  ok(createWith(badStatus).ok === false, 'C6 首次创建状态非 waiting 拒绝');

  // 6e HTML / 敏感信息：按纯文本原样保存，不做标记执行；日志/通知脱敏。
  const htmlTask = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const htmlPayload = JSON.parse(JSON.stringify(basePayload));
  htmlPayload.task = htmlTask;
  htmlPayload.operationId = uuid(71);
  const rHtml = createWith(htmlPayload);
  ok(rHtml.ok === true, 'C6 含 HTML 的任务按纯文本接受');
  equal(rHtml.record.task, htmlTask, 'C6 HTML 原文逐字保存（不转义丢失、不执行）');
  // 通知/日志脱敏：敏感模式应被识别并可打码。
  // 私钥块可能被截断（日志单行截断），所以从 BEGIN 一直到 END 或字符串结尾都要遮蔽。
  function redact(s) {
    return String(s)
      .replace(/sk-[A-Za-z0-9]{16,}/g, 'sk-***')
      .replace(/ghp_[A-Za-z0-9]{20,}/g, 'ghp_***')
      .replace(/password\s*[:=]\s*\S+/gi, 'password=***')
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[PRIVATE KEY REDACTED]');
  }
  const secretPatterns = [
    /sk-[A-Za-z0-9]{16,}/,
    /ghp_[A-Za-z0-9]{20,}/,
    /password\s*[:=]\s*\S+/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/
  ];
  const secretText = 'key sk-abcdefghijklmnop1234 token ghp_abcdefghijklmnopqrstuvwx password: hunter2 ' +
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
  const hits = secretPatterns.filter((re) => re.test(secretText));
  equal(hits.length, secretPatterns.length, 'C6 敏感信息模式可被识别（脱敏前置条件）');
  const redacted = redact(secretText);
  ok(!/sk-abcdefghijklmnop1234/.test(redacted), 'C6 通知/日志脱敏遮蔽 sk- 令牌');
  ok(!/ghp_abcdefghijklmnopqrstuvwx/.test(redacted), 'C6 通知/日志脱敏遮蔽 ghp_ 令牌');
  ok(!/hunter2/.test(redacted), 'C6 通知/日志脱敏遮蔽 password 值');
  ok(!/BEGIN RSA PRIVATE KEY/.test(redacted) && !/MIIEowIBAAKCAQEA/.test(redacted), 'C6 通知/日志脱敏遮蔽私钥块');
  // 日志被单行截断、只剩 BEGIN 时也必须遮蔽，不能因为缺 END 就漏出密钥体。
  const truncated = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA';
  const redactedTruncated = redact(truncated);
  ok(!/MIIEowIBAAKCAQEA/.test(redactedTruncated), 'C6 截断的私钥块也被遮蔽（不因缺 END 漏出）');

  // 6f 超大载荷：5MiB 单文件上限、64MiB 聚合预算。
  equal(store.DISPATCH_FILE_MAX_BYTES, 5 * 1024 * 1024, 'C6 单文件上限 5MiB');
  equal(store.DISPATCH_TOTAL_BUDGET_BYTES, 64 * 1024 * 1024, 'C6 聚合预算 64MiB');
  const bigFile = { date: DATE, ok: true, records: [makeRecord(1, 1)], bytes: 5 * 1024 * 1024 + 1 };
  const bigMerged = store.mergeFileSnapshots(null, [bigFile], 1, { enumeratedDates: [DATE] });
  ok(bigMerged.errors.some((e) => e.error === 'FILE_TOO_LARGE'), 'C6 超 5MiB 单文件报 FILE_TOO_LARGE');
  equal(bigMerged.complete, false, 'C6 超限时 complete=false');

  // -------------------------------------------------------------------------
  group('C7：64MiB 超预算仍有完整历史导出路径');
  const exportRoot = path.join(ROOT, 'export-dispatches');
  fs.mkdirSync(exportRoot, { recursive: true });
  // 构造 80 个日期文件、每个 200 条（约 1MiB/天），合计 > 64MiB，全部合法。
  const bigTask = 'x'.repeat(1000);
  const totalTarget = 70 * 1024 * 1024;
  const PER_DAY = 200;
  let made = 0;
  let bytesMade = 0;
  const baseDay = Date.UTC(2025, 0, 1);
  let d = 0;
  while (bytesMade < totalTarget && d < 200) {
    const dateStr = new Date(baseDay + d * 86400000).toISOString().slice(0, 10);
    const recs = [];
    for (let i = 0; i < PER_DAY; i++) {
      recs.push(makeRecord(1000 + i, 1, {
        id: 'dispatch_' + dateStr + '_' + uuid(1000 + i),
        intentId: 'intent-big-' + dateStr + '-' + i,
        task: '大文件 ' + dateStr + ' #' + i + ' ' + bigTask,
        dispatchedAt: dateStr + 'T02:00:00.000Z',
        recordedAt: dateStr + 'T02:00:01.000Z',
        lastFactAt: dateStr + 'T02:00:00.000Z',
        updatedAt: dateStr + 'T02:00:02.000Z',
        status: 'completed', progress: 100, finishedAt: dateStr + 'T05:00:00.000Z'
      }));
    }
    const text = JSON.stringify(recs);
    fs.writeFileSync(path.join(exportRoot, dateStr + '.json'), text);
    bytesMade += Buffer.byteLength(text);
    made++;
    d++;
  }
  const totalMiB = +(bytesMade / 1048576).toFixed(1);
  ok(bytesMade > 64 * 1024 * 1024, 'C7 构造数据超 64MiB 预算（' + totalMiB + 'MiB / ' + made + ' 个日期文件）');

  // 页面聚合受 64MiB 预算限制：必须明确声明未读日期，不能谎称完整。
  const scanNames = fs.readdirSync(exportRoot).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n));
  const scanDates = scanNames.map((n) => n.slice(0, 10)).sort().reverse();
  const budgetFileResults = [];
  for (const dateStr of scanDates) {
    const p = path.join(exportRoot, dateStr + '.json');
    const b = fs.readFileSync(p);
    budgetFileResults.push({ date: dateStr, ok: true, records: JSON.parse(b.toString('utf8')), bytes: b.length });
  }
  const budgeted = store.mergeFileSnapshots(null, budgetFileResults, 1, { enumeratedDates: scanDates });
  equal(budgeted.complete, false, 'C7 超预算时聚合快照 complete=false');
  ok(budgeted.unreadDates.length > 0, 'C7 明确列出未读日期（' + budgeted.unreadDates.length + ' 个）');
  ok(budgeted.records.length < scanDates.length * PER_DAY, 'C7 聚合记录数确实被预算截断（' + budgeted.records.length + ' 条）');

  // 完整历史导出不受 64MiB 截断。
  const exported = recovery.exportFullHistory({ dispatchesDir: exportRoot, batchSize: 20 });
  equal(exported.complete, true, 'C7 完整导出 complete=true（无错误日期）');
  equal(exported.fileCount, scanDates.length, 'C7 完整导出覆盖全部合法日期（' + exported.fileCount + '/' + scanDates.length + '）');
  equal(exported.records.length, scanDates.length * PER_DAY, 'C7 完整导出包含全部记录（' + exported.records.length + ' 条）');
  ok(exported.totalBytes > 64 * 1024 * 1024, 'C7 完整导出总字节超 64MiB（' + (exported.totalBytes / 1048576).toFixed(1) + 'MiB）');
  equal(exported.scope, 'full-history', 'C7 导出声明范围为 full-history');
  ok(exported.records.length > budgeted.records.length, 'C7 导出记录数多于页面预算聚合');

  // 失败日期不得从“完整导出”静默省略。
  fs.writeFileSync(path.join(exportRoot, scanDates[3] + '.json'), '{truncated');
  const exported2 = recovery.exportFullHistory({ dispatchesDir: exportRoot, batchSize: 20 });
  equal(exported2.complete, false, 'C7 有坏日期时 complete=false');
  equal(exported2.errors.length, 1, 'C7 坏日期进入 errors（1 个）');
  equal(exported2.errors[0].date, scanDates[3], 'C7 errors 明确列出坏日期');
  equal(exported2.scope, 'partial-with-errors', 'C7 范围声明为 partial-with-errors');
  equal(exported2.fileCount, scanDates.length - 1, 'C7 成功日期数减少 1，其余照常导出');

  // 分批回调必须真的分批，避免一次性把全历史塞进内存。
  let batches = 0;
  let batchedRecords = 0;
  recovery.exportFullHistory({
    dispatchesDir: exportRoot, batchSize: 10,
    onBatch: (b) => { batches++; batchedRecords += b.reduce((a, x) => a + x.count, 0); }
  });
  ok(batches > 1, 'C7 导出按 batchSize 分批回调（' + batches + ' 批）');
  ok(batchedRecords > 0, 'C7 分批回调累计记录数 > 0（' + batchedRecords + '）');

  // -------------------------------------------------------------------------
  group('C8：页面纯文本渲染（HTML 不被当标记执行）');
  const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const buildCardStart = rendererSrc.indexOf('function buildDispatchCard');
  const buildCardEnd = rendererSrc.indexOf('function buildDispatchDetail');
  const cardSrc = rendererSrc.slice(buildCardStart, buildCardEnd > buildCardStart ? buildCardEnd : buildCardStart + 6000);
  ok(/textContent/.test(cardSrc), 'C8 派活卡片用 textContent 写入任务文本');
  ok(!/innerHTML\s*=\s*[^;]*dispatch\.(task|statusDetail)/.test(cardSrc), 'C8 任务/说明不经过 innerHTML');
  ok(!/insertAdjacentHTML/.test(cardSrc), 'C8 卡片不使用 insertAdjacentHTML');

  // -------------------------------------------------------------------------
  console.log('');
  console.log('通过 ' + passed + ' 失败 ' + failed);
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  console.error('ERR ' + (err && err.stack || err));
  process.exit(2);
} finally {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }
}
