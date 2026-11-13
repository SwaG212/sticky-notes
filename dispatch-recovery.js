'use strict';

// dispatch-recovery.js
//
// 派活数据恢复与完整历史导出（设计文档 §6.2 第 8 条、§6.3 第 7 条）。
//
// 职责边界：
//   - 只读校验候选备份（正式文件 / File.Replace 备份 / .bak / 独立周期备份），
//     判断它能否安全用于恢复：schema、ID、日期归属、revision、内容完整性。
//   - 生成受控恢复计划：绝不静默替换，必须带来源、时间、原因、版本范围和结果，
//     并以 JSON 追加写审计日志。
//   - 完整历史导出：分批遍历全部合法日期文件，不受页面 64MiB 预算截断；
//     失败日期写入 errors，绝不从“完整导出”里静默省略。
//
// .bak 与 replace-bak 只在显式恢复时作为候选来源，日常读取绝不使用。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('./dispatch-store');

const BACKUP_KINDS = ['replace-bak', 'bak', 'independent'];
const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isValidDateFile(name) {
  const m = DATE_FILE_RE.exec(name);
  if (!m) return null;
  return store.isValidCalendarDateString(m[1]) ? m[1] : null;
}

// 读取并严格校验一个候选来源。返回 {ok, records, bytes, sha256, error, warnings}。
// 校验项：可解析、顶层数组、每条 schemaVersion 一致、ID 合法且日期前缀与文件名一致、
// revision 为正整数、无重复 ID。任何一项失败都判为不可用于恢复。
function validateCandidate(filePath, expectedDate) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    return { ok: false, error: 'READ_FAILED', detail: err.code || err.message, file: filePath };
  }
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf-8').replace(/^\uFEFF/, ''));
  } catch (err) {
    return { ok: false, error: 'PARSE_ERROR', detail: err.message, bytes: buf.length, sha256: sha256(buf), file: filePath };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'NOT_ARRAY', bytes: buf.length, sha256: sha256(buf), file: filePath };
  }
  const warnings = [];
  const seen = new Set();
  for (let i = 0; i < parsed.length; i++) {
    const rec = parsed[i];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      return { ok: false, error: 'RECORD_NOT_OBJECT', index: i, file: filePath };
    }
    if (rec.schemaVersion !== store.SCHEMA_VERSION) {
      return { ok: false, error: 'SCHEMA_INCOMPATIBLE', index: i, file: filePath };
    }
    if (!store.isValidDispatchId(rec.id)) {
      return { ok: false, error: 'ID_INVALID', index: i, file: filePath };
    }
    // §6.3 第 1 条：不能要求 ID 前缀等于文件日期。ID 前缀是 Muse 冻结的派发日期，
    // 文件日期是 PC 首次成功持久化的 recordedAt，跨午夜/时钟偏差时二者本就不同。
    // 真正要校验的是「recordedAt 与所在文件日期一致」（文件归属以 recordedAt 为准）。
    if (expectedDate) {
      const recorded = rec.recordedAt;
      if (typeof recorded !== 'string' || !store.isValidDateString(recorded)) {
        return { ok: false, error: 'RECORDED_AT_INVALID', index: i, id: rec.id, file: filePath };
      }
      const recordedDate = store.shanghaiDateString(recorded);
      if (recordedDate !== expectedDate) {
        return { ok: false, error: 'DATE_MISMATCH', index: i, id: rec.id, recordedDate: recordedDate, fileDate: expectedDate, file: filePath };
      }
    }
    if (!Number.isSafeInteger(rec.revision) || rec.revision < 1) {
      return { ok: false, error: 'REVISION_INVALID', index: i, id: rec.id, file: filePath };
    }
    if (seen.has(rec.id)) {
      return { ok: false, error: 'DUPLICATE_ID', index: i, id: rec.id, file: filePath };
    }
    seen.add(rec.id);
  }
  return {
    ok: true,
    records: parsed,
    count: parsed.length,
    bytes: buf.length,
    sha256: sha256(buf),
    warnings,
    file: filePath
  };
}

// 枚举某日期可用的候选来源，按“可信度”排序但不自动选择：
// 正式文件 > independent（独立周期备份）> replace-bak > bak。
// 调用方必须显式指定 source，恢复才可能发生。
function listRecoverySources(dispatchesDir, backupRoot, date) {
  if (!store.isValidCalendarDateString(date)) {
    throw new Error('INVALID_DATE');
  }
  const candidates = [
    { kind: 'formal', path: path.join(dispatchesDir, date + '.json') },
    { kind: 'independent', path: backupRoot ? path.join(backupRoot, date + '.json') : null },
    { kind: 'replace-bak', path: path.join(dispatchesDir, date + '.json.replace-bak') },
    { kind: 'bak', path: path.join(dispatchesDir, date + '.json.bak') }
  ];
  const out = [];
  for (const c of candidates) {
    if (!c.path) continue;
    if (!fs.existsSync(c.path)) {
      out.push({ kind: c.kind, path: c.path, exists: false });
      continue;
    }
    const stat = fs.statSync(c.path);
    const v = validateCandidate(c.path, date);
    out.push({
      kind: c.kind,
      path: c.path,
      exists: true,
      mtime: stat.mtime.toISOString(),
      bytes: stat.size,
      ok: v.ok,
      error: v.error || null,
      count: v.ok ? v.count : null,
      maxRevision: v.ok && v.records.length ? Math.max(...v.records.map((r) => r.revision)) : null,
      sha256: v.sha256 || null
    });
  }
  return out;
}

// 受控恢复：把指定来源恢复到正式文件，并追加审计记录。
// 前置：调用方必须已持该日期的写锁（本函数不拿锁，避免与写入口重复加锁）；
// 正式文件必须已损坏或显式 force。
// 返回 {ok, restoredFrom, date, audit, error}。
//
// 所有拒绝分支同样落审计（result='rejected'）：恢复是高风险动作，
// “尝试过但被拒绝”本身也是必须可追溯的事实，不能只在成功/中途失败时留痕。
function rejectRestore(options, code, extra) {
  const audit = {
    action: 'restore',
    date: (options && options.date) || null,
    at: (options && options.nowIso) || new Date().toISOString(),
    operator: (options && options.operator) || null,
    reason: (options && options.reason) || null,
    source: (options && options.source) || null,
    formalBefore: null,
    result: 'rejected',
    error: code
  };
  if (extra) {
    for (const k of Object.keys(extra)) audit[k] = extra[k];
  }
  appendAudit(options && options.auditPath, audit);
  const out = { ok: false, error: code, audit };
  if (extra) {
    for (const k of Object.keys(extra)) out[k] = extra[k];
  }
  return out;
}

function restoreFromSource(options) {
  const {
    dispatchesDir,
    date,
    source,             // 'independent' | 'replace-bak' | 'bak'
    reason,             // 必填：恢复原因
    operator,           // 必填：执行者
    auditPath,
    nowIso
  } = options || {};

  if (!store.isValidCalendarDateString(date)) {
    return rejectRestore(options, 'INVALID_DATE');
  }
  if (!reason || typeof reason !== 'string') {
    return rejectRestore(options, 'REASON_REQUIRED');
  }
  if (!operator || typeof operator !== 'string') {
    return rejectRestore(options, 'OPERATOR_REQUIRED');
  }
  if (BACKUP_KINDS.indexOf(source) === -1) {
    // formal 不是恢复来源；只接受备份种类。
    return rejectRestore(options, 'INVALID_SOURCE');
  }
  const sources = listRecoverySources(dispatchesDir, options.backupRoot, date);
  const chosen = sources.find((s) => s.kind === source);
  if (!chosen || !chosen.exists) {
    return rejectRestore(options, 'SOURCE_MISSING', { source });
  }
  if (!chosen.ok) {
    // 备份本身不可验证：拒绝恢复，不能拿坏备份覆盖正式文件。
    return rejectRestore(options, 'SOURCE_INVALID', { source, detail: chosen.error });
  }

  const formalPath = path.join(dispatchesDir, date + '.json');
  let formalBefore = null;
  try {
    const buf = fs.readFileSync(formalPath);
    formalBefore = { bytes: buf.length, sha256: sha256(buf), parseOk: (() => {
      try { return Array.isArray(JSON.parse(buf.toString('utf-8').replace(/^\uFEFF/, ''))); } catch (e) { return false; }
    })() };
  } catch (err) {
    formalBefore = { exists: false, error: err.code || err.message };
  }

  const srcBuf = fs.readFileSync(chosen.path);
  const tmpPath = path.join(dispatchesDir, date + '.json.restore-' + crypto.randomUUID() + '.tmp');
  const bakPath = path.join(dispatchesDir, date + '.json.pre-restore.bak');
  const ts = nowIso || new Date().toISOString();
  const audit = {
    action: 'restore',
    date,
    at: ts,
    operator,
    reason,
    source,
    sourcePath: chosen.path,
    sourceSha256: chosen.sha256,
    sourceMaxRevision: chosen.maxRevision,
    sourceCount: chosen.count,
    formalBefore,
    result: null
  };

  try {
    // 先把当前（损坏的）正式文件保留为 pre-restore 证据，不删任何证据。
    if (fs.existsSync(formalPath)) {
      fs.copyFileSync(formalPath, bakPath);
      audit.evidencePreservedAt = bakPath;
    }
    fs.writeFileSync(tmpPath, srcBuf);
    // 校验临时文件与来源字节一致后再发布。
    const tmpCheck = validateCandidate(tmpPath, date);
    if (!tmpCheck.ok) {
      throw Object.assign(new Error('TMP_VERIFY_FAILED'), { code: tmpCheck.error });
    }
    fs.renameSync(tmpPath, formalPath);
    const after = validateCandidate(formalPath, date);
    if (!after.ok || after.sha256 !== chosen.sha256) {
      throw Object.assign(new Error('READBACK_MISMATCH'), { code: after.error || 'HASH_MISMATCH' });
    }
    audit.result = 'restored';
    audit.formalAfter = { bytes: after.bytes, sha256: after.sha256, count: after.count, maxRevision: chosen.maxRevision };
  } catch (err) {
    audit.result = 'failed';
    audit.error = err.code || err.message;
    try { fs.unlinkSync(tmpPath); } catch (e) { /* 保留证据：删除失败不影响结论 */ }
    appendAudit(auditPath, audit);
    return { ok: false, error: audit.error, audit };
  }
  appendAudit(auditPath, audit);
  return { ok: true, restoredFrom: source, date, audit };
}

function appendAudit(auditPath, entry) {
  if (!auditPath) return false;
  try {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, JSON.stringify(entry) + '\n', 'utf8');
    return true;
  } catch (err) {
    return false;
  }
}

function readAudit(auditPath) {
  if (!auditPath || !fs.existsSync(auditPath)) return [];
  const lines = fs.readFileSync(auditPath, 'utf8').split('\n');
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (e) { out.push({ parseError: true, raw: line.slice(0, 200) }); }
  }
  return out;
}

// 完整历史导出（§6.3 第 7 条）：分批遍历全部合法日期文件，不受 64MiB 聚合预算限制。
// 每个文件独立校验；失败日期进入 errors，绝不静默省略。输出范围与错误清单。
// 返回 {ok, dates:[...], records:[...], errors:[...], totalBytes, fileCount, complete}
function exportFullHistory(options) {
  const { dispatchesDir, since, until, batchSize = 50, onBatch } = options || {};
  if (!fs.existsSync(dispatchesDir)) {
    return { ok: true, dates: [], records: [], errors: [], totalBytes: 0, fileCount: 0, complete: true, empty: true };
  }
  const dates = [];
  for (const name of fs.readdirSync(dispatchesDir)) {
    const d = isValidDateFile(name);
    if (!d) continue;                       // .lock/.tmp/.bak/.replace-bak 一律忽略
    if (since && d < since) continue;
    if (until && d > until) continue;
    dates.push(d);
  }
  dates.sort();

  const records = [];
  const errors = [];
  const exportedDates = [];
  let totalBytes = 0;
  let batch = [];
  for (const date of dates) {
    const filePath = path.join(dispatchesDir, date + '.json');
    const v = validateCandidate(filePath, date);
    if (!v.ok) {
      errors.push({ date, error: v.error, detail: v.detail || null });
      continue;
    }
    totalBytes += v.bytes;
    exportedDates.push(date);
    for (const rec of v.records) records.push(rec);
    batch.push({ date, count: v.count, bytes: v.bytes });
    if (batch.length >= batchSize) {
      if (typeof onBatch === 'function') onBatch(batch);
      batch = [];
    }
  }
  if (batch.length && typeof onBatch === 'function') onBatch(batch);
  return {
    ok: true,
    dates: exportedDates,
    records,
    errors,
    totalBytes,
    fileCount: exportedDates.length,
    complete: errors.length === 0,
    // 明确声明范围，避免把“有错误的部分导出”当成全历史。
    scope: errors.length === 0 ? 'full-history' : 'partial-with-errors'
  };
}

module.exports = {
  BACKUP_KINDS,
  sha256,
  isValidDateFile,
  validateCandidate,
  listRecoverySources,
  restoreFromSource,
  appendAudit,
  readAudit,
  exportFullHistory
};

// ---------------------------------------------------------------------------
// 命令行入口（供 PC 侧受限白名单调用；与写入口同样从 stdin 读 JSON、stdout 写 JSON）：
//   node dispatch-recovery.js sources  {dispatchesDir, backupRoot, date}
//   node dispatch-recovery.js restore  {dispatchesDir, backupRoot, date, source, reason, operator, auditPath}
//   node dispatch-recovery.js audit    {auditPath}
//   node dispatch-recovery.js export   {dispatchesDir, since, until, batchSize}
// 成功 exit 0；失败 exit 1 并输出 {ok:false, error}。
// ---------------------------------------------------------------------------
if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    let out;
    let code = 0;
    try {
      const req = JSON.parse(input || '{}');
      const command = req.command;
      if (command === 'sources') {
        out = { ok: true, sources: listRecoverySources(req.dispatchesDir, req.backupRoot, req.date) };
      } else if (command === 'restore') {
        out = restoreFromSource(req);
      } else if (command === 'audit') {
        out = { ok: true, entries: readAudit(req.auditPath) };
      } else if (command === 'export') {
        out = exportFullHistory(req);
      } else {
        out = { ok: false, error: 'UNKNOWN_COMMAND', command: String(command) };
      }
      if (!out.ok) code = 1;
    } catch (err) {
      out = { ok: false, error: 'ERROR', message: (err && err.message) || String(err) };
      code = 1;
    }
    process.stdout.write(JSON.stringify(out));
    process.exit(code);
  });
}
