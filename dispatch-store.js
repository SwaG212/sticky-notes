/**
 * dispatch-store.js
 *
 * 派活记录存储不变量（V1 基线，设计文档 monitor-sessions-design.md §2/§5.2/§6.3）：
 * - 纯逻辑模块，不做任何文件 I/O，不依赖 Electron；main 读入口与 PC 写入口复用。
 * - 字段、状态机、幂等、版本、去重、快照合并与预算的唯一事实来源。
 * - 写入入口严格拒绝非法记录；读取不修复文件，只归一化 + 警告。
 * - 错误对象带 .code（INVALID_FIELD / INVALID_STATUS / INVALID_TRANSITION /
 *   INVALID_PROGRESS / INVALID_TOKEN / INVALID_VERSION / MISSING_FIELD /
 *   ID_CONFLICT / REVISION_CONFLICT / OPERATION_CONFLICT / NOT_FOUND /
 *   SCHEMA_INCOMPATIBLE / FILE_TOO_LARGE），风格同 task-file-lock.js。
 *
 * 诚实限制：本模块只校验交给它的数据；绕过本模块直接改文件的一方不受约束。
 * 锁、原子替换、备份、回读由 PC 写入口 scripts/dispatch-record.ps1 包围完成。
 */
'use strict';

const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const SUPPORTED_WRITER_VERSION = '1.0.0';
const DISPATCH_MODELS = ['Muse', 'Sol', 'DeepSeek', 'Astra', 'GLM'];
const DISPATCH_STATUSES = ['waiting', 'running', 'blocked', 'completed', 'failed', 'cancelled'];
const OBSERVATION_HEALTHS = ['fresh', 'stale', 'unknown'];
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];
const DISPATCH_FILE_MAX_BYTES = 5 * 1024 * 1024;
const DISPATCH_TOTAL_BUDGET_BYTES = 64 * 1024 * 1024;
const DISPATCH_PAGE_SIZE = 50;
const OBSERVATION_STALE_MS = 15 * 60 * 1000;

const CLOCK_SOURCES = ['muse', 'pc', 'executor', 'unknown'];
const UPDATE_WHITELIST = [
  'status', 'statusDetail', 'progress', 'finishedAt', 'executorRef',
  'observationHealth', 'observationDetail',
  'tokenUsage', 'usageSource', 'provider', 'modelVersion', 'usageScope', 'cachedTokens'
];
// 首次创建后不可变的身份字段（§2.1）。recordedAt 由 PC 首次持久化时确定，
// 重试不得重置，因此不计入重复 create 的身份比对（见 transactRecords）。
// 重复 create 时比对的客户端身份字段（不含服务端定的 recordedAt）。
const CREATE_IDENTITY_FIELDS = ['id', 'intentId', 'workItemId', 'task', 'model', 'project', 'goal', 'dispatchedAt'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DISPATCH_ID_RE = /^dispatch_(\d{4}-\d{2}-\d{2})_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const SEMVER_RE = /^\d+(\.\d+){0,2}$/;

function makeError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepCopy(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isValidCalendarDateString(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    return false;
  }
  const parts = value.split('-').map(Number);
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return d.getUTCFullYear() === parts[0] &&
    d.getUTCMonth() === parts[1] - 1 &&
    d.getUTCDate() === parts[2];
}

// 完整 ISO 8601 日期时间（含时区），仅用于已持久化的时间字段。
function isValidDateString(value) {
  if (typeof value !== 'string' || !ISO_DATETIME_RE.test(value)) {
    return false;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isValidDispatchId(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const m = DISPATCH_ID_RE.exec(value);
  if (!m) {
    return false;
  }
  return isValidCalendarDateString(m[1]);
}

// ISO 时间换算为 Asia/Shanghai 日历日期（文件归属日期用）。
function shanghaiDateString(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function isNonEmptyString(value, maxLen) {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  if (typeof maxLen === 'number' && value.length > maxLen) {
    return false;
  }
  return true;
}

function isNullOrNonEmptyString(value, maxLen) {
  if (value === null || value === undefined) {
    return true;
  }
  return isNonEmptyString(value, maxLen);
}

// Token 用量：null 或 {inputTokens, outputTokens, totalTokens}，
// 各子值为非负安全整数或 null；三者齐全且同口径时 total 必须等于 input + output。
function validateTokenUsage(usage) {
  if (usage === null || usage === undefined) {
    return;
  }
  if (!isPlainObject(usage)) {
    throw makeError('INVALID_TOKEN', 'tokenUsage 必须是对象或 null');
  }
  const fields = ['inputTokens', 'outputTokens', 'totalTokens'];
  for (const f of fields) {
    const v = usage[f];
    if (v !== null && v !== undefined &&
      (!Number.isSafeInteger(v) || v < 0)) {
      throw makeError('INVALID_TOKEN', 'tokenUsage.' + f + ' 必须是非负安全整数或 null');
    }
  }
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const total = usage.totalTokens;
  if (Number.isSafeInteger(input) && Number.isSafeInteger(output) &&
    Number.isSafeInteger(total) && total !== input + output) {
    throw makeError('INVALID_TOKEN', 'tokenUsage.total 与 input + output 不一致');
  }
}

function validateClockSource(cs) {
  if (cs === null || cs === undefined) {
    return;
  }
  if (!isPlainObject(cs)) {
    throw makeError('INVALID_FIELD', 'clockSource 必须是对象或 null');
  }
  for (const k of ['dispatchedAt', 'finishedAt', 'recordedAt']) {
    if (cs[k] !== undefined && CLOCK_SOURCES.indexOf(cs[k]) === -1) {
      throw makeError('INVALID_FIELD', 'clockSource.' + k + ' 取值非法');
    }
  }
}

// 进度相对执行状态的合法性（§2.3）：
// completed 有值时为 100；非终态/非 completed 有值时限 0—99；未知为 null，绝不填 0。
function validateProgressForStatus(progress, status) {
  if (progress === null || progress === undefined) {
    return;
  }
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
    throw makeError('INVALID_PROGRESS', 'progress 必须是 null 或 0—100 整数');
  }
  if (status === 'completed' && progress !== 100) {
    throw makeError('INVALID_PROGRESS', 'completed 的 progress 有值时必须为 100');
  }
  if (status !== 'completed' && progress === 100) {
    throw makeError('INVALID_PROGRESS', '非 completed 的 progress 不能为 100');
  }
}

function compareSemver(a, b) {
  if (typeof a !== 'string' || !SEMVER_RE.test(a) ||
    typeof b !== 'string' || !SEMVER_RE.test(b)) {
    throw makeError('INVALID_VERSION', '版本号必须为 x.y.z 数字格式');
  }
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) {
      return -1;
    }
    if (x > y) {
      return 1;
    }
  }
  return 0;
}

// 记录的 schema/写入器版本是否允许本写入器处理（§2.7）。
function checkSchemaCompatible(record) {
  if (!isPlainObject(record) || record.schemaVersion !== SCHEMA_VERSION) {
    throw makeError('SCHEMA_INCOMPATIBLE', 'schemaVersion 必须为 1');
  }
  if (!isNonEmptyString(record.writerVersion) ||
    !isNonEmptyString(record.minimumReaderVersion)) {
    throw makeError('SCHEMA_INCOMPATIBLE', 'writerVersion/minimumReaderVersion 缺失');
  }
  if (compareSemver(record.minimumReaderVersion, SUPPORTED_WRITER_VERSION) > 0) {
    throw makeError('SCHEMA_INCOMPATIBLE', 'minimumReaderVersion 高于本写入器支持版本');
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 创建
// ---------------------------------------------------------------------------

// 校验首次创建的业务载荷（不含服务端字段）。返回 {ok:true}，非法时抛错。
function validateDispatchCreate(payload) {
  if (!isPlainObject(payload)) {
    throw makeError('INVALID_FIELD', '创建载荷必须是对象');
  }
  if (payload.id !== undefined && !isValidDispatchId(payload.id)) {
    throw makeError('INVALID_FIELD', 'id 格式必须为 dispatch_YYYY-MM-DD_<UUID> 且日期真实');
  }
  if (!isNonEmptyString(payload.task, 1000)) {
    throw makeError('MISSING_FIELD', 'task 必须为非空字符串且不超过 1000 字符');
  }
  if (DISPATCH_MODELS.indexOf(payload.model) === -1) {
    throw makeError('INVALID_FIELD', 'model 必须在白名单内');
  }
  if (!isNonEmptyString(payload.intentId, 256)) {
    throw makeError('MISSING_FIELD', 'intentId 必须为非空字符串且不超过 256 字符');
  }
  if (!isValidDateString(payload.dispatchedAt)) {
    throw makeError('INVALID_FIELD', 'dispatchedAt 必须是有效 ISO 时间');
  }
  if (!isValidUuid(payload.operationId)) {
    throw makeError('MISSING_FIELD', 'operationId 必须为 UUID 字符串');
  }
  if (payload.status !== undefined && payload.status !== 'waiting') {
    throw makeError('INVALID_FIELD', '首次创建状态只能为 waiting');
  }
  if (payload.workItemId !== undefined && !isNullOrNonEmptyString(payload.workItemId, 256)) {
    throw makeError('INVALID_FIELD', 'workItemId 必须为 null 或非空字符串且不超过 256 字符');
  }
  if (payload.project !== undefined && !isNullOrNonEmptyString(payload.project, 100)) {
    throw makeError('INVALID_FIELD', 'project 必须为 null 或非空字符串且不超过 100 字符');
  }
  if (payload.goal !== undefined && !isNullOrNonEmptyString(payload.goal, 300)) {
    throw makeError('INVALID_FIELD', 'goal 必须为 null 或非空字符串且不超过 300 字符');
  }
  if (payload.statusDetail !== undefined &&
    !(payload.statusDetail === null || isNonEmptyString(payload.statusDetail, 500))) {
    throw makeError('INVALID_FIELD', 'statusDetail 必须为 null 或非空字符串且不超过 500 字符');
  }
  if (payload.executorRef !== undefined && !isNullOrNonEmptyString(payload.executorRef, 256)) {
    throw makeError('INVALID_FIELD', 'executorRef 必须为 null 或非空字符串且不超过 256 字符');
  }
  validateProgressForStatus(payload.progress === undefined ? null : payload.progress, 'waiting');
  if (payload.observationHealth !== undefined &&
    OBSERVATION_HEALTHS.indexOf(payload.observationHealth) === -1) {
    throw makeError('INVALID_FIELD', 'observationHealth 取值非法');
  }
  if (payload.observationDetail !== undefined &&
    !(payload.observationDetail === null || typeof payload.observationDetail === 'string')) {
    throw makeError('INVALID_FIELD', 'observationDetail 必须为字符串或 null');
  }
  validateClockSource(payload.clockSource);
  validateTokenUsage(payload.tokenUsage);
  for (const f of ['usageSource', 'provider', 'modelVersion', 'usageScope']) {
    if (payload[f] !== undefined && payload[f] !== null && typeof payload[f] !== 'string') {
      throw makeError('INVALID_FIELD', f + ' 必须为字符串或 null');
    }
  }
  if (payload.cachedTokens !== undefined && payload.cachedTokens !== null &&
    (!Number.isSafeInteger(payload.cachedTokens) || payload.cachedTokens < 0)) {
    throw makeError('INVALID_TOKEN', 'cachedTokens 必须是非负安全整数或 null');
  }
  return { ok: true };
}

// 生成完整派活记录。payload 见 validateDispatchCreate；
// server 为 {recordedAt, writerVersion, minimumReaderVersion}，由 PC 写入口提供。
// 未传 id 时按 dispatchedAt 的 Asia/Shanghai 日期生成；重试必须传同一 id
//（含同一 dispatchedAt）才能幂等，否则会新建一条记录。
function createDispatchRecord(payload, server) {
  validateDispatchCreate(payload);
  if (!isPlainObject(server) || !isValidDateString(server.recordedAt)) {
    throw makeError('INVALID_FIELD', 'server.recordedAt 必须是有效 ISO 时间');
  }
  if (!isNonEmptyString(server.writerVersion) ||
    !isNonEmptyString(server.minimumReaderVersion)) {
    throw makeError('INVALID_VERSION', 'server 写入器版本缺失');
  }
  if (compareSemver(server.minimumReaderVersion, SUPPORTED_WRITER_VERSION) > 0) {
    throw makeError('SCHEMA_INCOMPATIBLE', 'minimumReaderVersion 高于本写入器支持版本');
  }

  const dispatchDate = shanghaiDateString(payload.dispatchedAt);
  const id = payload.id !== undefined
    ? payload.id
    : 'dispatch_' + dispatchDate + '_' + crypto.randomUUID();
  const cs = isPlainObject(payload.clockSource) ? payload.clockSource : {};
  const clockSource = {
    dispatchedAt: cs.dispatchedAt !== undefined ? cs.dispatchedAt : 'unknown',
    finishedAt: cs.finishedAt !== undefined ? cs.finishedAt : 'unknown',
    recordedAt: cs.recordedAt !== undefined ? cs.recordedAt : 'pc'
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    writerVersion: server.writerVersion,
    minimumReaderVersion: server.minimumReaderVersion,
    id: id,
    intentId: payload.intentId,
    workItemId: payload.workItemId !== undefined ? payload.workItemId : null,
    task: payload.task,
    model: payload.model,
    status: 'waiting',
    observationHealth: payload.observationHealth !== undefined ? payload.observationHealth : 'fresh',
    observationDetail: payload.observationDetail !== undefined ? payload.observationDetail : null,
    progress: payload.progress !== undefined ? payload.progress : null,
    dispatchedAt: payload.dispatchedAt,
    recordedAt: server.recordedAt,
    finishedAt: null,
    clockSource: clockSource,
    project: payload.project !== undefined ? payload.project : null,
    goal: payload.goal !== undefined ? payload.goal : null,
    statusDetail: payload.statusDetail !== undefined ? payload.statusDetail : null,
    executorRef: payload.executorRef !== undefined ? payload.executorRef : null,
    tokenUsage: payload.tokenUsage !== undefined ? deepCopy(payload.tokenUsage) : null,
    usageSource: payload.usageSource !== undefined ? payload.usageSource : null,
    provider: payload.provider !== undefined ? payload.provider : null,
    modelVersion: payload.modelVersion !== undefined ? payload.modelVersion : null,
    usageScope: payload.usageScope !== undefined ? payload.usageScope : null,
    cachedTokens: payload.cachedTokens !== undefined ? payload.cachedTokens : null,
    lastFactAt: payload.dispatchedAt,
    updatedAt: server.recordedAt,
    revision: 1,
    lastOperationId: payload.operationId
  };
}

// ---------------------------------------------------------------------------
// 状态机与更新
// ---------------------------------------------------------------------------

// 执行状态转移是否合法（结构层面；转 completed 还需成功证据，见 validateDispatchUpdate）。
function canDispatchTransition(from, to) {
  if (DISPATCH_STATUSES.indexOf(from) === -1 || DISPATCH_STATUSES.indexOf(to) === -1) {
    return false;
  }
  if (from === to) {
    return true;
  }
  if (TERMINAL_STATUSES.indexOf(from) !== -1) {
    return false;
  }
  if (from === 'waiting') {
    return to === 'running' || to === 'blocked' || to === 'failed' ||
      to === 'cancelled' || to === 'completed';
  }
  if (from === 'running') {
    return to === 'blocked' || to === 'completed' || to === 'failed' || to === 'cancelled';
  }
  // blocked：可到 running/completed/failed/cancelled；禁止回 waiting。
  return to === 'running' || to === 'completed' || to === 'failed' || to === 'cancelled';
}

// 校验单记录 update。返回 {ok:true}，非法时抛错。
// opts.successEvidence：转 completed 时必须为 true（进度 100% 本身不是证据）。
function validateDispatchUpdate(record, patch, expectedRevision, opts) {
  const options = opts || {};
  if (!isPlainObject(record) || !isNonEmptyString(record.id) ||
    !Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw makeError('INVALID_FIELD', '待更新记录缺少合法 id/revision');
  }
  if (!isPlainObject(patch)) {
    throw makeError('INVALID_FIELD', '补丁必须是对象');
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw makeError('MISSING_FIELD', 'expectedRevision 必须为正整数');
  }
  if (expectedRevision !== record.revision) {
    throw makeError('REVISION_CONFLICT', 'expectedRevision 与当前 revision 不一致');
  }
  for (const key of Object.keys(patch)) {
    if (UPDATE_WHITELIST.indexOf(key) === -1) {
      throw makeError('INVALID_FIELD', '补丁字段不允许修改：' + key);
    }
  }

  const resultingStatus = patch.status !== undefined ? patch.status : record.status;
  if (DISPATCH_STATUSES.indexOf(resultingStatus) === -1) {
    throw makeError('INVALID_STATUS', '目标状态非法');
  }
  if (patch.status !== undefined && patch.status !== record.status) {
    if (!canDispatchTransition(record.status, patch.status)) {
      throw makeError('INVALID_TRANSITION', '不允许的状态转移：' + record.status + ' -> ' + patch.status);
    }
    if (patch.status === 'completed' && options.successEvidence !== true) {
      throw makeError('INVALID_TRANSITION', '转 completed 必须有真实成功证据');
    }
  }

  const isTerminal = TERMINAL_STATUSES.indexOf(resultingStatus) !== -1;
  const effectiveFinishedAt = patch.finishedAt !== undefined ? patch.finishedAt : record.finishedAt;
  if (isTerminal) {
    if (!isValidDateString(effectiveFinishedAt)) {
      throw makeError('MISSING_FIELD', '终态必须有有效 finishedAt');
    }
  } else {
    if (effectiveFinishedAt !== null && effectiveFinishedAt !== undefined) {
      throw makeError('INVALID_FIELD', '非终态的 finishedAt 必须为 null');
    }
  }
  // 同源时 finishedAt 不得早于 dispatchedAt；不同源保留事实并标时间不确定（展示层处理）。
  if (isValidDateString(effectiveFinishedAt) && isValidDateString(record.dispatchedAt) &&
    isPlainObject(record.clockSource) &&
    record.clockSource.dispatchedAt !== undefined &&
    record.clockSource.dispatchedAt !== 'unknown' &&
    record.clockSource.dispatchedAt === record.clockSource.finishedAt &&
    Date.parse(effectiveFinishedAt) < Date.parse(record.dispatchedAt)) {
    throw makeError('INVALID_FIELD', 'finishedAt 不得早于 dispatchedAt（同源）');
  }

  const effectiveProgress = patch.progress !== undefined ? patch.progress : record.progress;
  validateProgressForStatus(effectiveProgress, resultingStatus);

  const effectiveDetail = patch.statusDetail !== undefined ? patch.statusDetail : record.statusDetail;
  if (patch.statusDetail !== undefined &&
    !(patch.statusDetail === null || isNonEmptyString(patch.statusDetail, 500))) {
    throw makeError('INVALID_FIELD', 'statusDetail 必须为 null 或非空字符串且不超过 500 字符');
  }
  if ((resultingStatus === 'blocked' || resultingStatus === 'failed' || resultingStatus === 'cancelled') &&
    !isNonEmptyString(effectiveDetail, 500)) {
    throw makeError('MISSING_FIELD', resultingStatus + ' 必须有非空 statusDetail 原因');
  }
  if (patch.executorRef !== undefined && !isNullOrNonEmptyString(patch.executorRef, 256)) {
    throw makeError('INVALID_FIELD', 'executorRef 必须为 null 或非空字符串且不超过 256 字符');
  }
  if (patch.observationHealth !== undefined &&
    OBSERVATION_HEALTHS.indexOf(patch.observationHealth) === -1) {
    throw makeError('INVALID_FIELD', 'observationHealth 取值非法');
  }
  if (patch.observationDetail !== undefined &&
    !(patch.observationDetail === null || typeof patch.observationDetail === 'string')) {
    throw makeError('INVALID_FIELD', 'observationDetail 必须为字符串或 null');
  }
  validateTokenUsage(patch.tokenUsage);
  for (const f of ['usageSource', 'provider', 'modelVersion', 'usageScope']) {
    if (patch[f] !== undefined && patch[f] !== null && typeof patch[f] !== 'string') {
      throw makeError('INVALID_FIELD', f + ' 必须为字符串或 null');
    }
  }
  if (patch.cachedTokens !== undefined && patch.cachedTokens !== null &&
    (!Number.isSafeInteger(patch.cachedTokens) || patch.cachedTokens < 0)) {
    throw makeError('INVALID_TOKEN', 'cachedTokens 必须是非负安全整数或 null');
  }
  return { ok: true };
}

// 同一 operationId 是否为已应用操作的重放。
// 重放：lastOperationId 相同且补丁与已应用结果一致 → {replay:true, record}；
// 同 operationId 但载荷不同 → 抛 OPERATION_CONFLICT；否则 {replay:false}。
function checkOperationReplay(record, operationId, patch) {
  if (!isPlainObject(record) || !isNonEmptyString(operationId) ||
    record.lastOperationId !== operationId) {
    return { replay: false };
  }
  if (!isPlainObject(patch)) {
    return { replay: false };
  }
  for (const key of Object.keys(patch)) {
    if (UPDATE_WHITELIST.indexOf(key) === -1) {
      continue;
    }
    if (!deepEqual(record[key], patch[key])) {
      throw makeError('OPERATION_CONFLICT', '同一 operationId 提交了不同载荷');
    }
  }
  return { replay: true, record: record };
}

// 应用单记录补丁。opts：{operationId（必填 UUID）, nowIso, expectedRevision, successEvidence}。
// 返回 {record: 新记录（输入不被修改）, changed}；无业务变化时不递增 revision、不改时间。
function applyDispatchPatch(record, patch, opts) {
  const options = opts || {};
  if (!isValidUuid(options.operationId)) {
    throw makeError('MISSING_FIELD', 'operationId 必须为 UUID 字符串');
  }
  const nowIso = options.nowIso !== undefined ? options.nowIso : new Date().toISOString();
  if (!isValidDateString(nowIso)) {
    throw makeError('INVALID_FIELD', 'nowIso 必须是有效 ISO 时间');
  }
  const working = deepCopy(record);
  const replay = checkOperationReplay(working, options.operationId, patch);
  if (replay.replay) {
    return { record: working, changed: false, replay: true };
  }
  const expectedRevision = options.expectedRevision !== undefined
    ? options.expectedRevision
    : working.revision;
  validateDispatchUpdate(working, patch, expectedRevision, options);

  let changed = false;
  for (const key of Object.keys(patch)) {
    if (!deepEqual(working[key], patch[key])) {
      changed = true;
      break;
    }
  }
  if (!changed) {
    return { record: working, changed: false };
  }
  for (const key of Object.keys(patch)) {
    working[key] = deepCopy(patch[key]);
  }
  // 只有 status/progress/statusDetail/executorRef 变化才算新的执行事实，
  // 推进 lastFactAt；纯 Token 补齐或观测更新不推进。
  const factFields = ['status', 'progress', 'statusDetail', 'executorRef'];
  let factChanged = false;
  for (const f of factFields) {
    if (Object.prototype.hasOwnProperty.call(patch, f) &&
      !deepEqual(record[f], patch[f])) {
      factChanged = true;
      break;
    }
  }
  if (factChanged) {
    working.lastFactAt = nowIso;
  }
  working.revision = working.revision + 1;
  working.updatedAt = nowIso;
  working.lastOperationId = options.operationId;
  return { record: working, changed: true };
}

// ---------------------------------------------------------------------------
// 读取归一化与去重（只读，永不修复文件）
// ---------------------------------------------------------------------------

// 归一化一条原始记录。永不抛错；非法值置 null 并记警告，原文保留在警告里。
// 非对象行返回 {dispatch: null, warnings: ['not-an-object'], error: 'NOT_AN_OBJECT'}。
function normalizeDispatchRecord(raw, fileDate, index) {
  if (!isPlainObject(raw)) {
    return { dispatch: null, warnings: ['not-an-object'], error: 'NOT_AN_OBJECT' };
  }
  const warnings = [];
  const dispatch = deepCopy(raw);

  if (!isNonEmptyString(dispatch.id)) {
    dispatch.id = '_noid_' + fileDate + '_' + index;
    warnings.push('id-missing');
  } else if (!isValidDispatchId(dispatch.id)) {
    warnings.push('id-invalid');
  }
  if (DISPATCH_MODELS.indexOf(dispatch.model) === -1) {
    warnings.push('model-unknown');
  }
  if (DISPATCH_STATUSES.indexOf(dispatch.status) === -1) {
    dispatch.status = null;
    warnings.push('status-unknown');
  }
  // 进度：非法值置 null；completed 之外出现 100、completed 出现 0—99 均非法。
  if (dispatch.progress !== null && dispatch.progress !== undefined) {
    let bad = !Number.isInteger(dispatch.progress) ||
      dispatch.progress < 0 || dispatch.progress > 100;
    if (!bad && dispatch.status === 'completed' && dispatch.progress !== 100) {
      bad = true;
    }
    if (!bad && dispatch.status !== 'completed' && dispatch.progress === 100) {
      bad = true;
    }
    if (bad) {
      dispatch.progress = null;
      warnings.push('progress-invalid');
    }
  }
  for (const f of ['dispatchedAt', 'recordedAt', 'updatedAt']) {
    if (dispatch[f] === undefined || dispatch[f] === null || !isValidDateString(dispatch[f])) {
      if (dispatch[f] !== undefined && dispatch[f] !== null) {
        warnings.push('date-invalid');
      } else if (f !== 'updatedAt') {
        warnings.push('date-invalid');
      }
      dispatch[f] = null;
    }
  }
  if (dispatch.finishedAt !== null && dispatch.finishedAt !== undefined &&
    !isValidDateString(dispatch.finishedAt)) {
    dispatch.finishedAt = null;
    warnings.push('date-invalid');
  }
  if (dispatch.lastFactAt !== null && dispatch.lastFactAt !== undefined &&
    !isValidDateString(dispatch.lastFactAt)) {
    dispatch.lastFactAt = null;
    warnings.push('date-invalid');
  }
  if (dispatch.observationHealth === undefined || dispatch.observationHealth === null) {
    dispatch.observationHealth = 'fresh';
    warnings.push('observationHealth-missing');
  } else if (OBSERVATION_HEALTHS.indexOf(dispatch.observationHealth) === -1) {
    dispatch.observationHealth = 'fresh';
    warnings.push('observationHealth-invalid');
  }
  if (dispatch.observationDetail !== undefined &&
    dispatch.observationDetail !== null && typeof dispatch.observationDetail !== 'string') {
    dispatch.observationDetail = null;
    warnings.push('observationDetail-invalid');
  }
  if (dispatch.tokenUsage !== null && dispatch.tokenUsage !== undefined) {
    try {
      validateTokenUsage(dispatch.tokenUsage);
    } catch (err) {
      dispatch.tokenUsage = null;
      warnings.push('token-invalid');
    }
  }
  if (dispatch.revision !== undefined && dispatch.revision !== null &&
    (!Number.isSafeInteger(dispatch.revision) || dispatch.revision < 1)) {
    dispatch.revision = null;
    warnings.push('revision-invalid');
  }
  if (dispatch.schemaVersion !== undefined && dispatch.schemaVersion !== SCHEMA_VERSION) {
    warnings.push('schema-incompatible');
  }
  if (!isNonEmptyString(dispatch.writerVersion) ||
    !isNonEmptyString(dispatch.minimumReaderVersion)) {
    warnings.push('version-missing');
  }
  return { dispatch: dispatch, warnings: warnings };
}

// 同 ID 去重：完全相同副本只计一条；冲突副本优先展示 recordedAt 与文件日期一致、
// revision 最大的有效记录，同版本不同内容按原数组位置稳定取一条。
// entries：[{dispatch, fileDate, warnings, index}]。返回 {entries, totalGroups, conflicts}。
function dedupeDispatchEntries(entries) {
  const groups = new Map();
  const order = [];
  for (const entry of entries || []) {
    if (!entry || !isPlainObject(entry.dispatch) || !isNonEmptyString(entry.dispatch.id)) {
      continue;
    }
    const id = entry.dispatch.id;
    if (!groups.has(id)) {
      groups.set(id, []);
      order.push(id);
    }
    groups.get(id).push(entry);
  }
  const kept = [];
  let conflicts = 0;
  for (const id of order) {
    const group = groups.get(id);
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    const firstJson = JSON.stringify(group[0].dispatch);
    let identical = true;
    for (let i = 1; i < group.length; i++) {
      if (JSON.stringify(group[i].dispatch) !== firstJson) {
        identical = false;
        break;
      }
    }
    if (identical) {
      const entry = group[0];
      entry.warnings = (entry.warnings || []).concat(['duplicate-identical']);
      kept.push(entry);
      continue;
    }
    conflicts++;
    let best = group[0];
    let bestScore = -1;
    for (const entry of group) {
      const recDate = entry.dispatch.recordedAt
        ? shanghaiDateString(entry.dispatch.recordedAt)
        : null;
      const matchesDate = recDate !== null && recDate === entry.fileDate;
      const rev = Number.isSafeInteger(entry.dispatch.revision) ? entry.dispatch.revision : 0;
      const score = matchesDate ? 1000000 + rev : rev;
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    best.warnings = (best.warnings || []).concat(['duplicate-conflict']);
    kept.push(best);
  }
  return { entries: kept, totalGroups: order.length, conflicts: conflicts };
}

// ---------------------------------------------------------------------------
// 快照合并（§6.3）
// ---------------------------------------------------------------------------

function flattenPrevState(prevState) {
  const entries = [];
  const byFile = (prevState && isPlainObject(prevState.byFile)) ? prevState.byFile : {};
  for (const date of Object.keys(byFile).sort().reverse()) {
    const slot = byFile[date];
    if (!slot || !Array.isArray(slot.records)) {
      continue;
    }
    slot.records.forEach((dispatch, index) => {
      entries.push({ dispatch: dispatch, fileDate: date, warnings: [], index: index });
    });
  }
  return dedupeDispatchEntries(entries).entries.map((e) => e.dispatch);
}

function computeSnapshotComplete(byFile, unreadDates, errors) {
  if (unreadDates.length > 0 || (errors && errors.length > 0)) {
    return false;
  }
  for (const date of Object.keys(byFile)) {
    const slot = byFile[date];
    if (!slot || slot.stale === true || slot.error) {
      return false;
    }
  }
  return true;
}

// 合并一批文件读取结果。prevState：{generation, byFile:{date:{records,hash,readAt,stale,error}}}。
// fileResults：[{date, ok, records, hash, bytes, error}]，调用方按日期降序提供。
// options.enumeratedDates：本次目录枚举到的合法日期文件；提供时才做“文件失踪”检测。
// options.nowMs：判定失踪间隔用的当前时间（默认 Date.now()）。
// 旧 generation 晚到不覆盖新批次。返回 {state, records, complete, staleFileCount,
// oldestSnapshotAt, unreadDates, errors, warnings, changed}。
function mergeFileSnapshots(prevState, fileResults, generation, options) {
  const prev = isPlainObject(prevState) ? prevState : { generation: 0, byFile: {} };
  const prevGeneration = Number.isSafeInteger(prev.generation) ? prev.generation : 0;
  const byFilePrev = isPlainObject(prev.byFile) ? prev.byFile : {};

  function staleStateResult(warning) {
    const records = flattenPrevState(prev);
    let staleFileCount = 0;
    let oldestSnapshotAt = null;
    for (const date of Object.keys(byFilePrev)) {
      const slot = byFilePrev[date];
      if (slot && slot.stale === true) {
        staleFileCount++;
      }
      if (slot && slot.readAt) {
        if (oldestSnapshotAt === null || slot.readAt < oldestSnapshotAt) {
          oldestSnapshotAt = slot.readAt;
        }
      }
    }
    return {
      state: prev,
      records: records,
      complete: computeSnapshotComplete(byFilePrev, [], []),
      staleFileCount: staleFileCount,
      oldestSnapshotAt: oldestSnapshotAt,
      unreadDates: [],
      errors: [],
      warnings: warning ? [warning] : [],
      changed: false
    };
  }

  if (typeof generation === 'number' && generation < prevGeneration) {
    return staleStateResult('stale-generation');
  }

  const byFile = deepCopy(byFilePrev);
  const errors = [];
  const warnings = [];
  const unreadDates = [];
  let totalBytes = 0;

  // 文件失踪（§6.3 第 4/5 条）：目录仍可访问时，先标记并保留旧快照，间隔 1 秒
  // 再次枚举仍缺失才确认移除；否则幽灵记录会永远留在 complete=true 的快照里。
  if (isPlainObject(options) && Array.isArray(options.enumeratedDates)) {
    const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
    const present = new Set(options.enumeratedDates);
    for (const date of Object.keys(byFile)) {
      if (present.has(date)) {
        if (byFile[date]) delete byFile[date].missingSince;
        continue;
      }
      const slot = byFile[date];
      if (!slot) continue;
      const since = slot.missingSince ? Date.parse(slot.missingSince) : NaN;
      if (Number.isFinite(since) && nowMs - since >= 1000) {
        delete byFile[date];
        continue;
      }
      if (!Number.isFinite(since)) slot.missingSince = new Date(nowMs).toISOString();
      slot.stale = true;
      warnings.push('file-missing:' + date);
    }
  }

  for (const fileResult of fileResults || []) {
    if (!isPlainObject(fileResult) || !isValidCalendarDateString(fileResult.date)) {
      errors.push({ date: fileResult && fileResult.date, error: 'FILE_INVALID' });
      continue;
    }
    const date = fileResult.date;
    const bytes = Number.isSafeInteger(fileResult.bytes) ? fileResult.bytes : 0;

    if (bytes > DISPATCH_FILE_MAX_BYTES) {
      errors.push({ date: date, error: 'FILE_TOO_LARGE' });
      if (byFile[date]) {
        byFile[date].stale = true;
      }
      continue;
    }
    if (totalBytes + bytes > DISPATCH_TOTAL_BUDGET_BYTES) {
      unreadDates.push(date);
      continue;
    }
    if (fileResult.ok !== true) {
      errors.push({ date: date, error: fileResult.error || 'READ_FAILED' });
      if (byFile[date]) {
        byFile[date].stale = true;
      }
      continue;
    }
    if (!Array.isArray(fileResult.records)) {
      errors.push({ date: date, error: 'FILE_INVALID' });
      if (byFile[date]) {
        byFile[date].stale = true;
      }
      continue;
    }
    // 未知 schema 的文件整体保留最后成功快照并报错，不用其中记录。
    let schemaBad = false;
    for (const raw of fileResult.records) {
      if (!isPlainObject(raw) || raw.schemaVersion !== SCHEMA_VERSION) {
        schemaBad = true;
        break;
      }
    }
    if (schemaBad) {
      errors.push({ date: date, error: 'SCHEMA_INCOMPATIBLE' });
      if (byFile[date]) {
        byFile[date].stale = true;
      }
      continue;
    }

    totalBytes += bytes;
    const normalized = [];
    let fileHasRowError = false;
    fileResult.records.forEach((raw, index) => {
      const result = normalizeDispatchRecord(raw, date, index);
      if (result.dispatch === null) {
        fileHasRowError = true;
        errors.push({ date: date, error: result.error || 'NOT_AN_OBJECT', index: index });
        return;
      }
      for (const w of result.warnings) {
        warnings.push(date + ':' + w);
      }
      normalized.push(result.dispatch);
    });
    byFile[date] = {
      records: normalized,
      hash: fileResult.hash !== undefined ? fileResult.hash : null,
      readAt: fileResult.readAt !== undefined ? fileResult.readAt : new Date().toISOString(),
      stale: false,
      error: fileHasRowError ? 'ROW_ERROR' : null
    };
  }

  const allEntries = [];
  for (const date of Object.keys(byFile).sort().reverse()) {
    const slot = byFile[date];
    if (!slot || !Array.isArray(slot.records)) {
      continue;
    }
    slot.records.forEach((dispatch, index) => {
      allEntries.push({ dispatch: dispatch, fileDate: date, warnings: [], index: index });
    });
  }
  const deduped = dedupeDispatchEntries(allEntries);
  if (deduped.conflicts > 0) {
    warnings.push('duplicate-conflict');
  }

  let staleFileCount = 0;
  let oldestSnapshotAt = null;
  for (const date of Object.keys(byFile)) {
    const slot = byFile[date];
    if (slot && slot.stale === true) {
      staleFileCount++;
    }
    if (slot && slot.readAt) {
      if (oldestSnapshotAt === null || slot.readAt < oldestSnapshotAt) {
        oldestSnapshotAt = slot.readAt;
      }
    }
  }

  let changed = false;
  const allDates = new Set(Object.keys(byFile).concat(Object.keys(byFilePrev)));
  for (const date of allDates) {
    const a = byFile[date];
    const b = byFilePrev[date];
    if (!a || !b) {
      changed = true;
      break;
    }
    if (a.hash !== b.hash || JSON.stringify(a.records) !== JSON.stringify(b.records)) {
      changed = true;
      break;
    }
  }

  return {
    state: { generation: typeof generation === 'number' ? generation : prevGeneration, byFile: byFile },
    records: deduped.entries.map((e) => e.dispatch),
    complete: computeSnapshotComplete(byFile, unreadDates, errors),
    staleFileCount: staleFileCount,
    oldestSnapshotAt: oldestSnapshotAt,
    unreadDates: unreadDates,
    errors: errors,
    warnings: warnings,
    changed: changed
  };
}

// 观测健康（§2.4）：终态永不因时间变 stale；unknown 保持；非终态按 lastFactAt 计 15 分钟。
function computeObservationHealth(record, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const stored = isPlainObject(record) && OBSERVATION_HEALTHS.indexOf(record.observationHealth) !== -1
    ? record.observationHealth
    : 'fresh';
  if (!isPlainObject(record)) {
    return stored;
  }
  if (TERMINAL_STATUSES.indexOf(record.status) !== -1) {
    return stored;
  }
  if (stored === 'unknown') {
    return 'unknown';
  }
  const lastFactMs = record.lastFactAt ? Date.parse(record.lastFactAt) : NaN;
  if (Number.isFinite(lastFactMs) && now - lastFactMs > OBSERVATION_STALE_MS) {
    return 'stale';
  }
  return stored;
}

module.exports = {
  SCHEMA_VERSION,
  SUPPORTED_WRITER_VERSION,
  DISPATCH_MODELS,
  DISPATCH_STATUSES,
  OBSERVATION_HEALTHS,
  TERMINAL_STATUSES,
  DISPATCH_FILE_MAX_BYTES,
  DISPATCH_TOTAL_BUDGET_BYTES,
  DISPATCH_PAGE_SIZE,
  OBSERVATION_STALE_MS,
  isValidDispatchId,
  isValidCalendarDateString,
  isValidDateString,
  createDispatchRecord,
  validateDispatchCreate,
  validateDispatchUpdate,
  canDispatchTransition,
  applyDispatchPatch,
  checkOperationReplay,
  normalizeDispatchRecord,
  dedupeDispatchEntries,
  mergeFileSnapshots,
  computeObservationHealth,
  compareSemver,
  checkSchemaCompatible,
  shanghaiDateString
};

// ---------------------------------------------------------------------------
// 命令行入口：供 PC 写入口 scripts/dispatch-record.ps1 复用同一校验。
// 用法：node dispatch-store.js <command>，JSON 从 stdin 读，结果 JSON 写 stdout；
// 成功 exit 0，失败 exit 1 并输出 {ok:false, code, message}。
// 命令：validate-create | transact | normalize | merge
// transact 输入：{records, request:{action, recordId, intentId, operationId,
// expectedRevision, patch, payload, successEvidence}, server, nowIso}
// ---------------------------------------------------------------------------
if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const req = JSON.parse(input || '{}');
      const command = req.command;
      let out;
      if (command === 'validate-create') {
        const record = createDispatchRecord(req.payload, req.server);
        out = { ok: true, record: record };
      } else if (command === 'transact') {
        out = transactRecords(req);
      } else if (command === 'normalize') {
        const result = normalizeDispatchRecord(req.raw, req.fileDate, req.index || 0);
        out = { ok: true, dispatch: result.dispatch, warnings: result.warnings, error: result.error || null };
      } else if (command === 'merge') {
        out = Object.assign({ ok: true }, mergeFileSnapshots(req.prevState, req.fileResults, req.generation, req.options));
      } else {
        throw makeError('INVALID_FIELD', '未知命令：' + String(command));
      }
      process.stdout.write(JSON.stringify(out));
      process.exit(0);
    } catch (err) {
      process.stdout.write(JSON.stringify({
        ok: false,
        code: (err && err.code) || 'ERROR',
        message: (err && err.message) || String(err)
      }));
      process.exit(1);
    }
  });
}

// transact：对一组记录执行一次 create/update 事务（锁内调用）。
// req.records 为已解析数组，或 req.recordsJson 为正式文件原文（须为 JSON 数组）。
// 返回 {ok:true, records, record, changed, replay}；非法时抛错（带 .code）。
function transactRecords(req) {
  if (!isPlainObject(req) || !isPlainObject(req.request)) {
    throw makeError('INVALID_FIELD', 'transact 请求必须含 request 对象');
  }
  let records;
  if (typeof req.recordsJson === 'string') {
    try {
      records = JSON.parse(req.recordsJson);
    } catch (err) {
      throw makeError('FILE_INVALID', '正式文件不是合法 JSON');
    }
    if (!Array.isArray(records)) {
      throw makeError('FILE_INVALID', '正式文件顶层必须是 JSON 数组');
    }
  } else if (Array.isArray(req.records)) {
    records = req.records;
  } else {
    throw makeError('INVALID_FIELD', 'transact 请求必须含 records 数组或 recordsJson 原文');
  }
  const request = req.request;
  const server = req.server;
  const nowIso = req.nowIso !== undefined ? req.nowIso : new Date().toISOString();
  if (!isValidDateString(nowIso)) {
    throw makeError('INVALID_FIELD', 'nowIso 必须是有效 ISO 时间');
  }
  records = deepCopy(records);
  if (request.action === 'create') {
    const payload = isPlainObject(request.payload) ? request.payload : {};
    if (request.operationId !== undefined) {
      payload.operationId = request.operationId;
    }
    const record = createDispatchRecord(payload, server);
    const existing = records.find((r) => isPlainObject(r) && r.id === record.id);
    if (existing) {
      for (const f of CREATE_IDENTITY_FIELDS) {
        if (!deepEqual(existing[f], record[f])) {
          throw makeError('ID_CONFLICT', '同 ID 固定身份字段不同，拒绝覆盖');
        }
      }
      return { ok: true, records: records, record: existing, changed: false, replay: true };
    }
    records.push(record);
    return { ok: true, records: records, record: record, changed: true, replay: false };
  }
  if (request.action === 'update') {
    if (!isNonEmptyString(request.recordId)) {
      throw makeError('MISSING_FIELD', 'update 必须提供 recordId');
    }
    const idx = records.findIndex((r) => isPlainObject(r) && r.id === request.recordId);
    if (idx === -1) {
      throw makeError('NOT_FOUND', '记录不存在：' + request.recordId);
    }
    const applied = applyDispatchPatch(records[idx], request.patch || {}, {
      operationId: request.operationId,
      nowIso: nowIso,
      expectedRevision: request.expectedRevision,
      successEvidence: request.successEvidence === true
    });
    records[idx] = applied.record;
    return { ok: true, records: records, record: applied.record, changed: applied.changed, replay: !!applied.replay };
  }
  throw makeError('INVALID_FIELD', '未知 action：' + String(request.action));
}
