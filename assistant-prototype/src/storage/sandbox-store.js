'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { AppError, ERROR_CODES } = require('../shared/errors');
const { newId } = require('../shared/ids');
const { todayKey, nowIso } = require('../shared/time');

/**
 * 沙盒数据存取。数据模型与便利贴对齐：
 * - 任务：sandbox-data/tasks/YYYY-MM-DD.json，[{ id, task, project?, completed,
 *   dueDate?, alarmTime?, sortOrder, createdAt, updatedAt }]
 * - 笔记：sandbox-data/notes/*.md + sandbox-data/notes/meta.json
 * - 提醒：沙盒任务内 alarmTime 字段承载（与便利贴一致）
 *
 * 原型阶段只允许操作此目录，绝不触碰便利贴真实数据。
 */
class SandboxStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.tasksDir = path.join(dataDir, 'tasks');
    this.notesDir = path.join(dataDir, 'notes');
    this._metaFile = path.join(this.notesDir, 'meta.json');
  }

  init() {
    for (const dir of [this.dataDir, this.tasksDir, this.notesDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this._metaFile)) {
      this._writeJson(this._metaFile, {});
    }
  }

  _readJson(file) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw new AppError(ERROR_CODES.INTERNAL, '数据读取失败', {
        details: { file: path.basename(file), cause: err.message },
      });
    }
  }

  _writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  // ---------- 任务 ----------

  listTasks(dateKey = todayKey()) {
    return this._readJson(path.join(this.tasksDir, `${dateKey}.json`)) || [];
  }

  saveTasks(dateKey, tasks) {
    this._writeJson(path.join(this.tasksDir, `${dateKey}.json`), tasks);
  }

  /**
   * 按日期或任务文本定位任务；返回唯一目标或错误。
   * @returns {{dateKey, task, index}|{error: AppError}}
   */
  findTask({ dateKey = null, taskId = null, title = null }) {
    if (taskId) {
      // 按 id 搜索时不确定是哪天，扫最近 30 天
      const days = recentDayKeys(30);
      for (const d of days) {
        const tasks = this.listTasks(d);
        const i = tasks.findIndex((t) => t.id === taskId);
        if (i >= 0) return { dateKey: d, task: tasks[i], index: i };
      }
      return { error: new AppError(ERROR_CODES.TASK_NOT_FOUND, '找不到对应任务', { details: { taskId } }) };
    }
    const d = dateKey || todayKey();
    const tasks = this.listTasks(d);
    if (title) {
      const matches = tasks.filter((t) => t.task === title);
      if (matches.length === 0) {
        return { error: new AppError(ERROR_CODES.TASK_NOT_FOUND, '找不到对应任务', { details: { title } }) };
      }
      if (matches.length > 1) {
        return { error: new AppError(ERROR_CODES.AMBIGUOUS_TARGET, '存在多个同名任务', {
          details: { candidates: matches.map((t) => ({ id: t.id, task: t.task })) },
        }) };
      }
      const index = tasks.findIndex((t) => t.id === matches[0].id);
      return { dateKey: d, task: matches[0], index };
    }
    return { error: new AppError(ERROR_CODES.TASK_NOT_FOUND, '缺少定位条件', { details: {} }) };
  }

  // ---------- 笔记 ----------

  listNotes() {
    const meta = this._readJson(this._metaFile) || {};
    return Object.values(meta).map((m) => ({ ...m }));
  }

  findNote({ noteId = null, title = null }) {
    const meta = this._readJson(this._metaFile) || {};
    const entries = Object.entries(meta);
    let hit = null;
    if (noteId) {
      hit = entries.find(([id]) => id === noteId) || null;
    } else if (title) {
      const matches = entries.filter(([, m]) => m.title === title);
      if (matches.length > 1) {
        return { error: new AppError(ERROR_CODES.AMBIGUOUS_TARGET, '存在多个同名笔记', {
          details: { candidates: matches.map(([id, m]) => ({ id, title: m.title })) },
        }) };
      }
      hit = matches[0] || null;
    }
    if (!hit) {
      return { error: new AppError(ERROR_CODES.NOTE_NOT_FOUND, '找不到对应笔记', { details: { noteId, title } }) };
    }
    const [id, m] = hit;
    const body = fs.readFileSync(path.join(this.notesDir, `${m.fileName}`), 'utf8');
    return { id, note: { ...m, content: body } };
  }

  createNote({ title, content }) {
    const meta = this._readJson(this._metaFile) || {};
    const id = newId('note');
    const fileName = `${id}.md`;
    const now = nowIso();
    meta[id] = { id, title, fileName, createdAt: now, updatedAt: now };
    fs.writeFileSync(path.join(this.notesDir, fileName), content, 'utf8');
    this._writeJson(this._metaFile, meta);
    return { id, title, fileName, createdAt: now, updatedAt: now, content };
  }

  appendToNote({ noteId, append }) {
    const found = this.findNote({ noteId });
    if (found.error) return found;
    const meta = this._readJson(this._metaFile) || {};
    const file = path.join(this.notesDir, meta[noteId].fileName);
    const body = fs.readFileSync(file, 'utf8');
    const sep = body.length > 0 && !body.endsWith('\n') ? '\n' : '';
    const next = body + sep + append;
    fs.writeFileSync(file, next, 'utf8');
    meta[noteId].updatedAt = nowIso();
    this._writeJson(this._metaFile, meta);
    return { ok: true, data: { id: noteId, content: next } };
  }

  searchNotes(query) {
    const meta = this._readJson(this._metaFile) || {};
    const q = query.toLowerCase();
    const hits = [];
    for (const [id, m] of Object.entries(meta)) {
      const body = fs.readFileSync(path.join(this.notesDir, m.fileName), 'utf8');
      if (m.title.toLowerCase().includes(q) || body.toLowerCase().includes(q)) {
        hits.push({ id, title: m.title, content: body, updatedAt: m.updatedAt });
      }
    }
    return hits;
  }
}

/** 最近 n 天的日期键（含今天），按旧→新 */
function recentDayKeys(n) {
  const keys = [];
  const base = new Date(Date.now() + 8 * 3600 * 1000);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base.getTime() - i * 86400000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    keys.push(`${y}-${m}-${day}`);
  }
  return keys;
}

module.exports = { SandboxStore };
