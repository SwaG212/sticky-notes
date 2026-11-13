(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  // nodeIntegration 渲染层里 module 存在,旧写法只走 CommonJS 分支就不挂 window,
  // 导致 window.MonitorLogic 未定义;两种环境都挂上,主进程 require 不受影响。
  root.MonitorLogic = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PAGE_IDS = ['main', 'notepad', 'tools', 'monitor'];
  var PAGE_NAMES = { main: '便利贴', notepad: '记事本', tools: '工具', monitor: '监控台' };
  var DEFAULT_PAGE_ORDER = ['main', 'notepad', 'tools', 'monitor'];
  var VALID_STATUSES = ['waiting', 'running', 'completed', 'blocked', 'failed'];

  var MODEL_META = {
    Muse: { label: 'Muse', color: '#2563eb' },
    Sol: { label: 'Sol', color: '#16a34a' },
    DeepSeek: { label: 'DeepSeek', color: '#1e40af' },
    Astra: { label: 'Astra', color: '#7c3aed' },
    GLM: { label: 'GLM', color: '#0F766E', bg: '#F0FDFA' }
  };
  var MODEL_UNKNOWN = { label: '未知模型', color: '#64748B' };
  var MODEL_UNSPECIFIED = { label: '未指定', color: '#64748B' };

  var STATUS_META = {
    waiting: { label: '等待中', color: '#92400E', bg: '#FFFBEB', progressColor: '#B45309' },
    running: { label: '运行中', color: '#15803D', bg: '#F0FDF4', progressColor: '#15803D' },
    completed: { label: '已完成', color: '#64748B', bg: '#F1F5F9', progressColor: '#64748B' },
    blocked: { label: '阻塞', color: '#B91C1C', bg: '#FEF2F2', progressColor: '#B91C1C' },
    failed: { label: '失败', color: '#B91C1C', bg: '#FEF2F2', progressColor: '#B91C1C' }
  };

  var DISPATCH_STATUSES = ['waiting', 'running', 'blocked', 'completed', 'failed', 'cancelled'];

  var DISPATCH_STATUS_META = {
    waiting: { label: '已派·等待中', color: '#92400E', bg: '#FFFBEB', progressColor: '#B45309' },
    running: { label: '运行中', color: '#15803D', bg: '#F0FDF4', progressColor: '#15803D' },
    blocked: { label: '阻塞', color: '#B91C1C', bg: '#FEF2F2', progressColor: '#B91C1C' },
    completed: { label: '已完成', color: '#64748B', bg: '#F1F5F9', progressColor: '#64748B' },
    failed: { label: '失败', color: '#B91C1C', bg: '#FEF2F2', progressColor: '#B91C1C' },
    cancelled: { label: '已取消', color: '#64748B', bg: '#F1F5F9', progressColor: '#64748B' }
  };

  function isTaskObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isValidDateString(value) {
    return typeof value === 'string' && !isNaN(new Date(value).getTime());
  }

  function parseDateMs(value) {
    if (!isValidDateString(value)) return null;
    return new Date(value).getTime();
  }

  function pad2(value) {
    value = Number(value);
    return (value < 10 ? '0' : '') + value;
  }

  function pad4(value) {
    value = String(value);
    while (value.length < 4) value = '0' + value;
    return value;
  }

  function hasId(task) {
    return !!task && typeof task === 'object' && task.id !== undefined && task.id !== null && task.id !== '';
  }

  function shallowCopyTask(task) {
    return (task && typeof task === 'object' && !Array.isArray(task)) ? Object.assign({}, task) : task;
  }

  function normalizeProgressValue(value) {
    var warnings = [];
    if (value === undefined || value === null) return { progress: 0, warnings: warnings };
    if (typeof value === 'number' && isFinite(value)) {
      return { progress: Math.round(Math.min(100, Math.max(0, value))), warnings: warnings };
    }
    warnings.push('progress-invalid');
    return { progress: 0, warnings: warnings };
  }

  function normalizeModelValue(value) {
    var warnings = [];
    if (value === null || value === undefined || value === '') return { model: null, warnings: warnings };
    if (typeof value === 'string') {
      if (Object.prototype.hasOwnProperty.call(MODEL_META, value)) return { model: value, warnings: warnings };
      warnings.push('model-unknown');
      return { model: value, warnings: warnings };
    }
    warnings.push('model-unknown');
    return { model: null, warnings: warnings };
  }

  function normalizeProgress(raw) {
    return normalizeProgressValue(isTaskObject(raw) ? raw.progress : raw);
  }

  function normalizeModel(raw) {
    return normalizeModelValue(isTaskObject(raw) ? raw.model : raw);
  }

  function deriveStatus(raw) {
    var r = (raw && typeof raw === 'object') ? raw : {};
    var warnings = [];
    var hasStatus = r.status !== undefined;

    if (r.completed === true) {
      if (hasStatus) {
        if (VALID_STATUSES.indexOf(r.status) !== -1) {
          if (r.status !== 'completed') warnings.push('completed-status-conflict');
        } else {
          warnings.push('status-unknown');
        }
      }
      return { status: 'completed', warnings: warnings };
    }

    if (r.status === 'completed') {
      return { status: 'completed', warnings: ['completed-status-conflict'] };
    }

    if (hasStatus && VALID_STATUSES.indexOf(r.status) !== -1) {
      return { status: r.status, warnings: warnings };
    }

    if (!hasStatus) return { status: 'waiting', warnings: warnings };

    warnings.push('status-unknown');
    return { status: 'waiting', warnings: warnings };
  }

  function normalizeTask(raw) {
    if (!isTaskObject(raw)) return { task: null, warnings: ['not-an-object'] };

    var warnings = [];
    var task = Object.assign({}, raw);

    if (raw.source === 'muse') {
      task.source = 'muse';
    } else {
      task.source = 'local';
      if (raw.source !== undefined && raw.source !== 'muse' && raw.source !== 'local') {
        warnings.push('source-unknown');
      }
    }

    var modelResult = normalizeModelValue(raw.model);
    task.model = modelResult.model;
    for (var i = 0; i < modelResult.warnings.length; i++) warnings.push(modelResult.warnings[i]);

    var progressResult = normalizeProgressValue(raw.progress);
    task.progress = progressResult.progress;
    for (var j = 0; j < progressResult.warnings.length; j++) warnings.push(progressResult.warnings[j]);

    var statusResult = deriveStatus(raw);
    task.status = statusResult.status;
    for (var k = 0; k < statusResult.warnings.length; k++) warnings.push(statusResult.warnings[k]);

    if (isValidDateString(raw.createdAt)) {
      task.createdAt = raw.createdAt;
    } else {
      task.createdAt = null;
      warnings.push('createdAt-invalid');
    }

    task.completed = raw.completed === true;

    if (task.completed) {
      if (isValidDateString(raw.completedAt)) {
        task.completedAt = raw.completedAt;
      } else {
        task.completedAt = null;
        warnings.push('completedAt-invalid');
      }
    }

    return { task: task, warnings: warnings };
  }

  function isMuseTask(raw) {
    return !!(raw && raw.source === 'muse');
  }

  function displayProgress(task) {
    if (!task) return 0;
    if (task.status === 'completed') return 100;
    return (task.progress === undefined || task.progress === null) ? 0 : task.progress;
  }

  function filterMonitorTasks(tasks, filter) {
    if (!Array.isArray(tasks)) return [];
    if (filter !== 'running' && filter !== 'waiting' && filter !== 'completed') return tasks.slice();
    return tasks.filter(function (task) {
      return task && task.status === filter;
    });
  }

  function countByStatus(tasks) {
    var list = Array.isArray(tasks) ? tasks : [];
    var counts = { all: list.length, running: 0, waiting: 0, completed: 0, blockedFailed: 0 };
    for (var i = 0; i < list.length; i++) {
      var status = list[i] && list[i].status;
      if (status === 'running') counts.running++;
      else if (status === 'waiting') counts.waiting++;
      else if (status === 'completed') counts.completed++;
      else if (status === 'blocked' || status === 'failed') counts.blockedFailed++;
    }
    return counts;
  }

  function statusGroup(status) {
    if (status === 'running') return 0;
    if (status === 'blocked') return 1;
    if (status === 'failed') return 2;
    if (status === 'completed') return 4;
    return 3;
  }

  function sortMonitorTasks(tasks) {
    if (!Array.isArray(tasks)) return [];
    var list = tasks.slice();
    list.sort(function (a, b) {
      var ga = statusGroup(a && a.status);
      var gb = statusGroup(b && b.status);
      if (ga !== gb) return ga - gb;

      var va = parseDateMs(a && a.createdAt);
      var vb = parseDateMs(b && b.createdAt);
      if (va === null && vb !== null) return 1;
      if (va !== null && vb === null) return -1;
      if (va !== null && vb !== null && va !== vb) return vb - va;

      var ida = (a && a.id !== undefined && a.id !== null) ? String(a.id) : '';
      var idb = (b && b.id !== undefined && b.id !== null) ? String(b.id) : '';
      if (ida < idb) return -1;
      if (ida > idb) return 1;
      return 0;
    });
    return list;
  }

  function formatRuntime(task, nowMs) {
    if (!task || typeof task !== 'object') return '—';
    var created = parseDateMs(task.createdAt);
    if (created === null) return '—';

    var duration;
    if (task.status === 'completed') {
      var completed = parseDateMs(task.completedAt);
      if (completed === null || completed < created) return '—';
      duration = completed - created;
    } else {
      if (nowMs === undefined) nowMs = Date.now();
      if (created > nowMs) return '—';
      duration = nowMs - created;
    }

    var totalMinutes = Math.floor(duration / 60000);
    if (totalMinutes < 1) return '不足 1 分钟';
    if (totalMinutes < 60) return totalMinutes + ' 分钟';

    if (totalMinutes < 1440) {
      var h = Math.floor(totalMinutes / 60);
      var m = totalMinutes % 60;
      return h + ' 小时 ' + pad2(m) + ' 分钟';
    }

    var d = Math.floor(totalMinutes / 1440);
    var rem = totalMinutes % 1440;
    var hh = Math.floor(rem / 60);
    var mm = rem % 60;
    return d + ' 天 ' + pad2(hh) + ' 小时 ' + pad2(mm) + ' 分钟';
  }

  function formatCreatedAt(iso) {
    if (typeof iso !== 'string') return '未知';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '未知';
    return pad4(d.getFullYear()) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function normalizePageOrder(value) {
    var defaultOrder = ['main', 'notepad', 'tools', 'monitor'];
    if (!Array.isArray(value) || value.length !== 4) {
      return { order: defaultOrder.slice(), valid: false };
    }
    var expected = { main: true, notepad: true, tools: true, monitor: true };
    var seen = {};
    var i;
    for (i = 0; i < value.length; i++) {
      var item = value[i];
      if (typeof item !== 'string' || !Object.prototype.hasOwnProperty.call(expected, item) || seen[item]) {
        return { order: defaultOrder.slice(), valid: false };
      }
      seen[item] = true;
    }
    return { order: value.slice(), valid: true };
  }

  function mergeTaskArrays(disk, incoming, base) {
    var diskArr = Array.isArray(disk) ? disk : [];
    var incomingArr = Array.isArray(incoming) ? incoming : [];
    var baseArr = Array.isArray(base) ? base : null;
    var result = [];
    var diskIndexById = {};
    var i;
    var task;
    var copy;
    var id;

    for (i = 0; i < diskArr.length; i++) {
      task = diskArr[i];
      copy = shallowCopyTask(task);
      result.push(copy);
      if (hasId(task)) {
        id = String(task.id);
        diskIndexById[id] = result.length - 1;
      }
    }

    var incomingIds = {};
    for (i = 0; i < incomingArr.length; i++) {
      task = incomingArr[i];
      if (hasId(task)) {
        incomingIds[String(task.id)] = true;
      }
    }

    var baseIds = {};
    if (baseArr) {
      for (i = 0; i < baseArr.length; i++) {
        task = baseArr[i];
        if (hasId(task)) {
          baseIds[String(task.id)] = true;
        }
      }
    }

    var resultById = diskIndexById;
    for (i = 0; i < incomingArr.length; i++) {
      task = incomingArr[i];
      copy = shallowCopyTask(task);
      if (hasId(task)) {
        id = String(task.id);
        if (Object.prototype.hasOwnProperty.call(resultById, id)) {
          result[resultById[id]] = copy;
        } else {
          resultById[id] = result.length;
          result.push(copy);
        }
      } else {
        result.push(copy);
      }
    }

    var filtered = [];
    for (i = 0; i < result.length; i++) {
      task = result[i];
      if (hasId(task)) {
        id = String(task.id);
        if (Object.prototype.hasOwnProperty.call(diskIndexById, id) &&
            !Object.prototype.hasOwnProperty.call(incomingIds, id) &&
            baseArr &&
            Object.prototype.hasOwnProperty.call(baseIds, id)) {
          continue;
        }
      }
      filtered.push(task);
    }

    return {
      tasks: filtered,
      changed: JSON.stringify(filtered) !== JSON.stringify(diskArr)
    };
  }

  function dedupeTaskEntries(entries) {
    var list = Array.isArray(entries) ? entries : [];
    var groups = Object.create(null);
    var order = [];
    var i;
    var entry;
    var task;
    var id;

    for (i = 0; i < list.length; i++) {
      entry = list[i] || {};
      task = entry.task;
      if (task && hasId(task)) {
        id = String(task.id);
        if (!Object.prototype.hasOwnProperty.call(groups, id)) {
          groups[id] = { items: [] };
          order.push({ type: 'id', id: id });
        }
        groups[id].items.push({
          task: task,
          fileDate: entry.fileDate,
          warnings: entry.warnings,
          index: i
        });
      } else {
        order.push({ type: 'no-id', entry: entry, index: i });
      }
    }

    var result = [];
    var totalGroups = 0;
    var j;
    for (i = 0; i < order.length; i++) {
      var orderItem = order[i];
      if (orderItem.type === 'no-id') {
        entry = orderItem.entry || {};
        var missingWarnings = (entry.warnings || []).slice();
        missingWarnings.push('missing-id');
        result.push({
          task: entry.task,
          fileDate: entry.fileDate,
          warnings: missingWarnings
        });
        totalGroups++;
      } else {
        var group = groups[orderItem.id];
        var items = group.items;
        var firstKey = null;
        var sameKey = true;
        for (j = 0; j < items.length; j++) {
          var keyCopy = shallowCopyTask(items[j].task);
          delete keyCopy._fileDate;
          delete keyCopy.updatedAt;
          var key = JSON.stringify(keyCopy);
          if (j === 0) {
            firstKey = key;
          } else if (key !== firstKey) {
            sameKey = false;
          }
        }

        var best = null;
        if (sameKey) {
          for (j = 0; j < items.length; j++) {
            var current = items[j];
            var currentFd = current.fileDate == null ? '' : String(current.fileDate);
            if (best === null) {
              best = current;
            } else {
              var bestFd = best.fileDate == null ? '' : String(best.fileDate);
              if (currentFd > bestFd || (currentFd === bestFd && current.index < best.index)) {
                best = current;
              }
            }
          }
          var sameWarnings = (best.warnings || []).slice();
          result.push({
            task: best.task,
            fileDate: best.fileDate,
            warnings: sameWarnings
          });
        } else {
          for (j = 0; j < items.length; j++) {
            var cur = items[j];
            if (best === null) {
              best = cur;
            } else {
              var curU = parseDateMs(cur.task.updatedAt);
              if (curU === null) curU = -Infinity;
              var bestU = parseDateMs(best.task.updatedAt);
              if (bestU === null) bestU = -Infinity;
              var better = false;
              if (curU > bestU) {
                better = true;
              } else if (curU === bestU) {
                var curFd = cur.fileDate == null ? '' : String(cur.fileDate);
                var bestFd2 = best.fileDate == null ? '' : String(best.fileDate);
                if (curFd > bestFd2) {
                  better = true;
                } else if (curFd === bestFd2) {
                  if (cur.index < best.index) better = true;
                }
              }
              if (better) best = cur;
            }
          }
          var conflictWarnings = (best.warnings || []).slice();
          conflictWarnings.push('duplicate-conflict');
          result.push({
            task: best.task,
            fileDate: best.fileDate,
            warnings: conflictWarnings
          });
        }
        totalGroups++;
      }
    }

    return { entries: result, totalGroups: totalGroups };
  }

  function isValidTaskDateFilename(name) {
    if (typeof name !== 'string') return false;
    var match = name.match(/^(\d{4})-(\d{2})-(\d{2})\.json$/);
    if (!match) return false;
    var y = parseInt(match[1], 10);
    var m = parseInt(match[2], 10);
    var d = parseInt(match[3], 10);
    var dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  function isTerminalDispatchStatus(status) {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
  }

  function normalizeDispatch(raw, fileDate, index) {
    var warnings = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { dispatch: null, warnings: ['not-an-object'] };
    }
    var out = Object.assign({}, raw);
    if (typeof out.id !== 'string' || out.id === '') {
      warnings.push('id-missing');
      out.id = '_noid_' + (fileDate || 'unknown') + '_' + (index || 0);
    } else {
      var idMatch = /^dispatch_(\d{4})-(\d{2})-(\d{2})_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.exec(out.id);
      if (!idMatch) {
        warnings.push('id-invalid');
      } else {
        var iy = parseInt(idMatch[1], 10);
        var im = parseInt(idMatch[2], 10) - 1;
        var iday = parseInt(idMatch[3], 10);
        var idt = new Date(iy, im, iday);
        if (idt.getFullYear() !== iy || idt.getMonth() !== im || idt.getDate() !== iday) {
          warnings.push('id-invalid');
        }
      }
    }
    if (typeof out.model === 'string' && out.model !== '') {
      if (!Object.prototype.hasOwnProperty.call(MODEL_META, out.model)) {
        warnings.push('model-unknown');
      }
    } else {
      out.model = null;
      warnings.push('model-missing');
    }
    if (typeof out.status === 'string' && DISPATCH_STATUSES.indexOf(out.status) >= 0) {
      // 保留
    } else {
      warnings.push('status-unknown');
      if (typeof out.status !== 'string' || out.status === '') {
        out.status = null;
      }
    }
    var p = out.progress;
    if (p === null || typeof p === 'undefined') {
      out.progress = null;
    } else if (typeof p === 'number' && isFinite(p)) {
      if (Math.floor(p) !== p) {
        p = Math.round(p);
      }
      if (p < 0) { p = 0; }
      if (p > 100) { p = 100; }
      out.progress = p;
    } else {
      warnings.push('progress-invalid');
      out.progress = null;
    }
    if (out.progress !== null) {
      if (out.status === 'completed') {
        if (out.progress !== 100) {
          warnings.push('progress-invalid');
          out.progress = null;
        }
      } else if (out.progress === 100) {
        warnings.push('progress-invalid');
        out.progress = null;
      }
    }
    if (typeof out.dispatchedAt !== 'string' || !isValidDateString(out.dispatchedAt)) {
      out.dispatchedAt = null;
      warnings.push('dispatchedAt-invalid');
    }
    if (out.finishedAt === null || typeof out.finishedAt === 'undefined') {
      out.finishedAt = null;
    } else if (typeof out.finishedAt !== 'string' || !isValidDateString(out.finishedAt)) {
      out.finishedAt = null;
      warnings.push('finishedAt-invalid');
    }
    if (typeof out.recordedAt !== 'string' || !isValidDateString(out.recordedAt)) {
      out.recordedAt = null;
      warnings.push('recordedAt-invalid');
    }
    if (isTerminalDispatchStatus(out.status) && out.finishedAt === null) {
      warnings.push('finishedAt-missing');
    }
    if (out.observationHealth !== 'fresh' && out.observationHealth !== 'stale' && out.observationHealth !== 'unknown') {
      out.observationHealth = 'fresh';
      warnings.push('observation-invalid');
    }
    if (typeof out.observationDetail !== 'string' && out.observationDetail !== null) {
      out.observationDetail = null;
    }
    if (typeof out.task !== 'string' || out.task === '') {
      out.task = '';
      warnings.push('task-missing');
    }
    var textFields = ['project', 'goal', 'statusDetail', 'executorRef'];
    for (var fi = 0; fi < textFields.length; fi++) {
      var fv = out[textFields[fi]];
      if (typeof fv !== 'string' && fv !== null) {
        out[textFields[fi]] = null;
      }
    }
    if (out.tokenUsage === null || typeof out.tokenUsage === 'undefined') {
      out.tokenUsage = null;
    } else if (typeof out.tokenUsage === 'object' && !Array.isArray(out.tokenUsage)) {
      var tu = out.tokenUsage;
      var tuOk = true;
      var tuKeys = ['inputTokens', 'outputTokens', 'totalTokens'];
      for (var ti = 0; ti < tuKeys.length; ti++) {
        var tv = tu[tuKeys[ti]];
        if (!(tv === null || typeof tv === 'undefined' || (typeof tv === 'number' && isFinite(tv) && Math.floor(tv) === tv && tv >= 0 && tv <= 9007199254740991))) {
          tuOk = false;
        }
      }
      if (tuOk) {
        out.tokenUsage = {
          inputTokens: typeof tu.inputTokens === 'number' ? tu.inputTokens : null,
          outputTokens: typeof tu.outputTokens === 'number' ? tu.outputTokens : null,
          totalTokens: typeof tu.totalTokens === 'number' ? tu.totalTokens : null
        };
      } else {
        out.tokenUsage = null;
        warnings.push('tokenUsage-invalid');
      }
    } else {
      out.tokenUsage = null;
      warnings.push('tokenUsage-invalid');
    }
    if (!(typeof out.clockSource === 'string' || (out.clockSource && typeof out.clockSource === 'object' && !Array.isArray(out.clockSource)))) {
      out.clockSource = null;
    }
    return { dispatch: out, warnings: warnings };
  }

  function displayDispatchProgress(dispatch) {
    if (!dispatch || typeof dispatch !== 'object') {
      return null;
    }
    if (dispatch.progress === null || typeof dispatch.progress === 'undefined') {
      return null;
    }
    if (dispatch.status === 'completed') {
      return 100;
    }
    return dispatch.progress;
  }

  function formatDispatchProgressLabel(dispatch) {
    var value = displayDispatchProgress(dispatch);
    if (value === null) {
      return '暂不可估算';
    }
    return 'Muse 估算约 ' + value + '%';
  }

  function filterDispatches(records, filter) {
    if (!Array.isArray(records)) {
      return [];
    }
    if (filter === 'running' || filter === 'waiting' || filter === 'completed') {
      return records.filter(function (record) {
        return record && record.status === filter;
      });
    }
    return records.slice();
  }

  function countDispatches(records) {
    var counts = { all: 0, running: 0, waiting: 0, completed: 0, blocked: 0, failed: 0, cancelled: 0, unknown: 0 };
    if (!Array.isArray(records)) {
      return counts;
    }
    for (var i = 0; i < records.length; i++) {
      var status = records[i] && records[i].status;
      counts.all += 1;
      if (DISPATCH_STATUSES.indexOf(status) >= 0) {
        counts[status] += 1;
      } else {
        counts.unknown += 1;
      }
    }
    return counts;
  }

  function dispatchSortGroup(status) {
    if (status === 'running') { return 0; }
    if (status === 'blocked') { return 1; }
    if (status === 'failed') { return 2; }
    if (status === 'waiting') { return 4; }
    if (status === 'completed') { return 5; }
    if (status === 'cancelled') { return 6; }
    return 3;
  }

  function sortDispatches(records) {
    var arr = Array.isArray(records) ? records.slice() : [];
    arr.sort(function (a, b) {
      var ga = dispatchSortGroup(a && a.status);
      var gb = dispatchSortGroup(b && b.status);
      if (ga !== gb) {
        return ga - gb;
      }
      var ma = parseDateMs(a && a.dispatchedAt);
      var mb = parseDateMs(b && b.dispatchedAt);
      var va = ma === null;
      var vb = mb === null;
      if (va !== vb) {
        return va ? 1 : -1;
      }
      if (!va && ma !== mb) {
        return mb - ma;
      }
      var ia = a && typeof a.id === 'string' ? a.id : '';
      var ib = b && typeof b.id === 'string' ? b.id : '';
      if (ia < ib) { return -1; }
      if (ia > ib) { return 1; }
      return 0;
    });
    return arr;
  }

  function getDispatchClockSource(record, key) {
    var cs = record && record.clockSource;
    if (typeof cs === 'string') {
      return cs;
    }
    if (cs && typeof cs === 'object' && !Array.isArray(cs)) {
      return typeof cs[key] === 'string' ? cs[key] : null;
    }
    return null;
  }

  function formatDurationText(ms) {
    if (ms < 60000) {
      return '不足 1 分钟';
    }
    var totalMinutes = Math.floor(ms / 60000);
    if (totalMinutes < 60) {
      return totalMinutes + ' 分钟';
    }
    var totalHours = Math.floor(totalMinutes / 60);
    var minutes = totalMinutes % 60;
    if (totalHours < 24) {
      return totalHours + ' 小时 ' + pad2(minutes) + ' 分钟';
    }
    var days = Math.floor(totalHours / 24);
    var hours = totalHours % 24;
    return days + ' 天 ' + pad2(hours) + ' 小时 ' + pad2(minutes) + ' 分钟';
  }

  // §2.5：只有两端时钟来源一致且可核实才能相减；不同来源、缺失或 unknown 一律
  // 标“时间不确定”，不能把 Muse 派出 + PC 结束强行算成耗时。
  function clockSourcesComparable(startSource, endSource) {
    if (!startSource || !endSource) {
      return false;
    }
    if (startSource === 'unknown' || endSource === 'unknown') {
      return false;
    }
    return startSource === endSource;
  }

  function formatTotalElapsed(record, nowMs) {
    if (!record || typeof record !== 'object') {
      return '—';
    }
    nowMs = typeof nowMs === 'number' ? nowMs : Date.now();
    var startMs = parseDateMs(record.dispatchedAt);
    if (isTerminalDispatchStatus(record.status)) {
      var endMs = parseDateMs(record.finishedAt);
      if (startMs === null || endMs === null || endMs < startMs) {
        return '—';
      }
      if (!clockSourcesComparable(getDispatchClockSource(record, 'dispatchedAt'), getDispatchClockSource(record, 'finishedAt'))) {
        return '时间不确定';
      }
      return formatDurationText(endMs - startMs);
    }
    if (startMs === null || startMs > nowMs) {
      return '—';
    }
    if (getDispatchClockSource(record, 'dispatchedAt') === 'unknown') {
      return '时间不确定';
    }
    return formatDurationText(nowMs - startMs);
  }

  function formatDispatchTime(iso) {
    var ms = parseDateMs(iso);
    if (ms === null) {
      return '未知';
    }
    var dt = new Date(ms);
    return pad4(dt.getFullYear()) + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate()) + ' ' + pad2(dt.getHours()) + ':' + pad2(dt.getMinutes());
  }

  function paginateDispatches(records, page, pageSize) {
    var arr = Array.isArray(records) ? records : [];
    var size = typeof pageSize === 'number' && pageSize > 0 ? Math.floor(pageSize) : 50;
    if (size <= 0) {
      size = 50;
    }
    var total = arr.length;
    var totalPages = Math.max(1, Math.ceil(total / size));
    var current = parseInt(page, 10);
    if (!isFinite(current)) {
      current = 1;
    }
    if (current < 1) { current = 1; }
    if (current > totalPages) { current = totalPages; }
    var start = (current - 1) * size;
    return { pageRecords: arr.slice(start, start + size), page: current, totalPages: totalPages, total: total };
  }

  function dispatchSummary(counts) {
    counts = counts || {};
    return '进行中 ' + (counts.running || 0) + ' / 已完成 ' + (counts.completed || 0) + ' / 等待 ' + (counts.waiting || 0);
  }

  function formatTokenUsage(usage) {
    if (usage === null || typeof usage === 'undefined') {
      return '未提供';
    }
    function v(value) {
      if (value === null || typeof value === 'undefined') {
        return '—';
      }
      return String(value);
    }
    return '输入 ' + v(usage.inputTokens) + ' / 输出 ' + v(usage.outputTokens) + ' / 合计 ' + v(usage.totalTokens);
  }

  function computeDispatchObservation(record, nowMs) {
    if (!record || typeof record !== 'object') {
      return 'fresh';
    }
    nowMs = typeof nowMs === 'number' ? nowMs : Date.now();
    var stored = record.observationHealth;
    if (stored !== 'fresh' && stored !== 'stale' && stored !== 'unknown') {
      stored = 'fresh';
    }
    if (isTerminalDispatchStatus(record.status)) {
      return stored;
    }
    if (stored === 'unknown') {
      return 'unknown';
    }
    var lastMs = parseDateMs(record.lastFactAt);
    if (lastMs !== null && nowMs - lastMs > 15 * 60 * 1000) {
      return 'stale';
    }
    return stored;
  }

  function observationLabel(record, nowMs) {
    var health = computeDispatchObservation(record, nowMs);
    if (health === 'stale') {
      return { health: 'stale', label: '最后已知状态', detail: (record && record.observationDetail) || '超过 15 分钟没有新的执行事实' };
    }
    if (health === 'unknown') {
      return { health: 'unknown', label: '执行状态待核实', detail: (record && record.observationDetail) || '启动结果或当前状态无法核实' };
    }
    return { health: 'fresh', label: '', detail: '' };
  }

  function formatLastUpdate(record) {
    if (!record || typeof record !== 'object') {
      return '';
    }
    var ms = parseDateMs(record.lastFactAt || record.updatedAt);
    if (ms === null) {
      return '';
    }
    var dt = new Date(ms);
    return 'Muse 最近更新 ' + pad2(dt.getHours()) + ':' + pad2(dt.getMinutes());
  }

  function dispatchCardWarnings(warnings) {
    if (!Array.isArray(warnings)) {
      return [];
    }
    var map = {
      'model-unknown': '未知模型',
      'model-missing': '未指定模型',
      'status-unknown': '状态未识别',
      'progress-invalid': '进度格式异常',
      'dispatchedAt-invalid': '派出时间未知',
      'finishedAt-invalid': '结束时间异常',
      'finishedAt-missing': '缺少结束时间',
      'recordedAt-invalid': '记录时间未知',
      'id-missing': '缺少记录 ID',
      'id-invalid': '记录 ID 格式异常',
      'task-missing': '缺少任务内容',
      'tokenUsage-invalid': '用量数据异常',
      'observation-invalid': '观测状态异常',
      'not-an-object': '记录不是对象'
    };
    var out = [];
    for (var i = 0; i < warnings.length; i++) {
      var code = warnings[i];
      out.push(Object.prototype.hasOwnProperty.call(map, code) ? map[code] : code);
    }
    return out;
  }

  return {
    PAGE_IDS: PAGE_IDS,
    PAGE_NAMES: PAGE_NAMES,
    DEFAULT_PAGE_ORDER: DEFAULT_PAGE_ORDER,
    MODEL_META: MODEL_META,
    STATUS_META: STATUS_META,
    VALID_STATUSES: VALID_STATUSES,
    MODEL_UNKNOWN: MODEL_UNKNOWN,
    MODEL_UNSPECIFIED: MODEL_UNSPECIFIED,
    normalizeTask: normalizeTask,
    isMuseTask: isMuseTask,
    deriveStatus: deriveStatus,
    normalizeProgress: normalizeProgress,
    normalizeModel: normalizeModel,
    displayProgress: displayProgress,
    filterMonitorTasks: filterMonitorTasks,
    countByStatus: countByStatus,
    sortMonitorTasks: sortMonitorTasks,
    formatRuntime: formatRuntime,
    formatCreatedAt: formatCreatedAt,
    normalizePageOrder: normalizePageOrder,
    mergeTaskArrays: mergeTaskArrays,
    dedupeTaskEntries: dedupeTaskEntries,
    isValidTaskDateFilename: isValidTaskDateFilename,
    DISPATCH_STATUSES: DISPATCH_STATUSES,
    DISPATCH_STATUS_META: DISPATCH_STATUS_META,
    normalizeDispatch: normalizeDispatch,
    displayDispatchProgress: displayDispatchProgress,
    formatDispatchProgressLabel: formatDispatchProgressLabel,
    filterDispatches: filterDispatches,
    countDispatches: countDispatches,
    sortDispatches: sortDispatches,
    formatTotalElapsed: formatTotalElapsed,
    formatDispatchTime: formatDispatchTime,
    paginateDispatches: paginateDispatches,
    dispatchSummary: dispatchSummary,
    formatTokenUsage: formatTokenUsage,
    computeDispatchObservation: computeDispatchObservation,
    observationLabel: observationLabel,
    formatLastUpdate: formatLastUpdate,
    dispatchCardWarnings: dispatchCardWarnings
  };
});
