'use strict';

const { HostAdapter } = require('./host-adapter');
const { AppError, ERROR_CODES } = require('../shared/errors');
const { ok } = require('../shared/result');
const { newId } = require('../shared/ids');
const { todayKey, nowIso } = require('../shared/time');

/**
 * 沙盒宿主适配器：所有写操作落到 sandbox-data/，结构对齐便利贴数据模型。
 * 供阶段 0/1 开发验证交互闭环，接入阶段替换为 StickyNotesAdapter。
 */
class MockHostAdapter extends HostAdapter {
  /** @param {import('../storage/sandbox-store').SandboxStore} store */
  constructor(store) {
    super();
    this.store = store;
    // 按 actionRunId 去重，避免重复请求重复创建（文档 11.1）
    this._createdByRun = new Map();
  }

  async getCapabilities() {
    return ok({
      actions: [
        'create_task', 'update_task', 'complete_task', 'set_reminder',
        'create_note', 'append_note', 'search_notes', 'organize_today_tasks',
        'generate_daily_report', 'open_page',
      ],
    });
  }

  async createTask(args, { actionRunId } = {}) {
    // 幂等：同一 actionRunId 重复请求返回既有任务（文档 11.1）
    if (actionRunId && this._createdByRun.has(actionRunId)) {
      const taskId = this._createdByRun.get(actionRunId);
      const found = this.store.findTask({ taskId });
      if (!found.error) {
        return ok(found.task, { summary: `已创建任务：${args.title}（重复请求，未新建）`, reversible: true });
      }
    }
    const now = nowIso();
    const task = {
      id: newId('task'),
      task: args.title,
      project: args.project || null,
      dueDate: args.dueDate || null,
      alarmTime: args.alarmTime || null,
      completed: false,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    };
    const dateKey = args.dueDate || todayKey();
    const tasks = this.store.listTasks(dateKey);
    task.sortOrder = tasks.length;
    tasks.push(task);
    this.store.saveTasks(dateKey, tasks);
    if (actionRunId) this._createdByRun.set(actionRunId, task.id);
    return ok(task, {
      summary: `已创建任务：${args.title}`,
      reversible: true,
    });
  }

  async updateTask(args) {
    const found = this.store.findTask({ taskId: args.taskId, title: args.title });
    if (found.error) return { ok: false, error: found.error.toJSON() };
    const { dateKey, task } = found;
    const tasks = this.store.listTasks(dateKey);
    const index = tasks.findIndex((t) => t.id === task.id);
    if (index < 0) return { ok: false, error: { code: ERROR_CODES.TASK_NOT_FOUND, message: '找不到对应任务' } };
    if (args.taskTitle) tasks[index].task = args.taskTitle;
    if (args.dueDate !== undefined) tasks[index].dueDate = args.dueDate;
    if (args.project !== undefined) tasks[index].project = args.project;
    if (args.completed !== undefined) tasks[index].completed = Boolean(args.completed);
    tasks[index].updatedAt = nowIso();
    this.store.saveTasks(dateKey, tasks);
    return ok(tasks[index], {
      summary: `已修改任务：${tasks[index].task}`,
      reversible: true,
    });
  }

  async completeTask(args) {
    const found = this.store.findTask({ taskId: args.taskId, title: args.title });
    if (found.error) return { ok: false, error: found.error.toJSON() };
    const { dateKey, task } = found;
    const tasks = this.store.listTasks(dateKey);
    const index = tasks.findIndex((t) => t.id === task.id);
    if (index < 0) return { ok: false, error: { code: ERROR_CODES.TASK_NOT_FOUND, message: '找不到对应任务' } };
    tasks[index].completed = true;
    tasks[index].updatedAt = nowIso();
    this.store.saveTasks(dateKey, tasks);
    return ok(tasks[index], {
      summary: `已完成任务：${tasks[index].task}`,
      reversible: true,
    });
  }

  async setReminder(args) {
    // 便利贴提醒挂接在任务的 alarmTime 上：按标题定位任务，找不到则创建
    const found = this.store.findTask({ title: args.title });
    if (found.error) {
      return this.createTask({ title: args.title, dueDate: args.dueDate || null, alarmTime: args.time });
    }
    const { dateKey, task } = found;
    const tasks = this.store.listTasks(dateKey);
    const index = tasks.findIndex((t) => t.id === task.id);
    if (index < 0) return { ok: false, error: { code: ERROR_CODES.TASK_NOT_FOUND, message: '找不到对应任务' } };
    if (tasks[index].alarmTime) {
      return { ok: false, error: { code: ERROR_CODES.REMINDER_CONFLICT, message: '该任务已有提醒', details: { existing: tasks[index].alarmTime } } };
    }
    tasks[index].alarmTime = args.time;
    if (args.dueDate) tasks[index].dueDate = args.dueDate;
    tasks[index].updatedAt = nowIso();
    this.store.saveTasks(dateKey, tasks);
    return ok(tasks[index], {
      summary: `已设置提醒：${args.title} ${args.time}`,
      reversible: true,
    });
  }

  async createNote(args) {
    const note = this.store.createNote({ title: args.title, content: args.content });
    return ok(note, {
      summary: `已创建笔记：${args.title}`,
      reversible: true,
    });
  }

  async appendNote(args) {
    const found = this.store.findNote({ noteId: args.noteId, title: args.title });
    if (found.error) return { ok: false, error: found.error.toJSON() };
    const res = this.store.appendToNote({ noteId: found.id, append: args.append });
    if (!res.ok) return { ok: false, error: { code: ERROR_CODES.NOTE_NOT_FOUND, message: '追加失败' } };
    return ok(res.data, {
      summary: `已向笔记「${found.note.title}」追加内容`,
      reversible: false,
    });
  }

  async searchNotes(args) {
    const hits = this.store.searchNotes(args.query);
    return ok(hits, {
      summary: `搜索到 ${hits.length} 条笔记`,
      reversible: true,
    });
  }

  async organizeTodayTasks(args) {
    const dateKey = todayKey();
    const tasks = this.store.listTasks(dateKey);
    let list = tasks;
    if (args.project) {
      list = tasks.filter((t) => t.project === args.project);
    }
    const pending = list.filter((t) => !t.completed);
    const done = list.filter((t) => t.completed);
    return ok({
      date: dateKey,
      total: list.length,
      pending: pending.map((t) => t.task),
      completed: done.map((t) => t.task),
    }, {
      summary: `当天共 ${list.length} 项任务：${pending.length} 项未完成，${done.length} 项已完成`,
      reversible: true,
    });
  }

  async generateDailyReport(args) {
    const dateKey = args.date || todayKey();
    const tasks = this.store.listTasks(dateKey);
    const done = tasks.filter((t) => t.completed);
    const pending = tasks.filter((t) => !t.completed);
    const lines = [
      `## ${dateKey} 日报`,
      '',
      `- 完成：${done.length} 项`,
      ...done.map((t) => `  - [x] ${t.task}`),
      `- 未完成：${pending.length} 项`,
      ...pending.map((t) => `  - [ ] ${t.task}`),
    ];
    return ok({ date: dateKey, report: lines.join('\n') }, {
      summary: `已生成 ${dateKey} 日报`,
      reversible: true,
    });
  }

  async openPage(args) {
    const pages = ['tasks', 'notepad', 'tools'];
    if (!pages.includes(args.page)) {
      return { ok: false, error: { code: ERROR_CODES.INVALID_ARGUMENT, message: '未知页面', details: { page: args.page } } };
    }
    return ok({ page: args.page }, {
      summary: `将打开便利贴页面：${args.page}`,
      reversible: true,
    });
  }
}

module.exports = { MockHostAdapter };
