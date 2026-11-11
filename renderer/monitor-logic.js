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
    Astra: { label: 'Astra', color: '#7c3aed' }
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
    isValidTaskDateFilename: isValidTaskDateFilename
  };
});
