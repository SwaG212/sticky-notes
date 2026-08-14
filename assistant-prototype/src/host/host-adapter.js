'use strict';

const { AppError, ERROR_CODES } = require('../shared/errors');

/**
 * 宿主适配器契约。原型阶段用 MockHostAdapter 操作沙盒数据；
 * 接入便利贴时实现 StickyNotesAdapter，动作定义不变。
 *
 * 所有方法返回统一结构：
 *   { ok: true, data, effect: { summary, reversible } }
 * 业务失败返回：
 *   { ok: false, error: { code, message, details } }
 *
 * 文档 11.2。执行结果只能来自 HostAdapter 的结构化返回值，
 * 不得相信模型自述的"已完成"。
 */
class HostAdapter {
  /**
   * @returns {Promise<{ok: true, data: {actions: string[]}}>}
   */
  async getCapabilities({ signal } = {}) {
    void signal;
    throw new AppError(ERROR_CODES.NOT_IMPLEMENTED, '宿主能力未实现');
  }

  /** 创建任务 args: { title, project?, dueDate?, alarmTime? } */
  async createTask(args, { signal, actionRunId } = {}) {
    void args; void signal; void actionRunId;
    throw new AppError(ERROR_CODES.NOT_IMPLEMENTED, '宿主能力未实现');
  }

  /** 修改任务 args: { taskId?, title?, dueDate?, project?, completed? } */
  async updateTask(args, { signal, actionRunId } = {}) {
    void args; void signal; void actionRunId;
    throw new AppError(ERROR_CODES.NOT_IMPLEMENTED, '宿主能力未实现');
  }

  /** 完成任务 args: { taskId?, title? } */
  async completeTask(args, { signal, actionRunId } = {}) {
    void args; void signal; void actionRunId;
    throw new AppError(ERROR_CODES.NOT_IMPLEMENTED, '宿主能力未实现');
  }

  /** 创建或修改提醒 args: { title, time, dueDate? } */
  async setReminder(args, { signal, actionRunId } = {}) {
    void args; void signal; void actionRunId;
    throw new AppError(ERROR_CODES.NOT_IMPLEMENTED, '宿主能力未实现');
  }

  /** 创建笔记 args: { title, content } */
  async createNote(args, { signal, actionRunId } = {}) {
    void args; void signal; void actionRunId;
    throw new AppError(ERROR_CODES.NOT_IMPLEMENTED, '宿主能力未实现');
  }

  /** 追加笔记 args: { noteId?, title?, append } */
  async appendNote(args, { signal, actionRunId } = {}) {
    void args; void signal; void actionRunId;
    throw new AppError(ERROR_CODES.NOT_IMPLEMENTED, '宿主能力未实现');
  }

  /** 搜索笔记 args: { query }（只读，无 actionRunId） */
  async searchNotes(args, { signal } = {}) {
    void args; void signal;
    throw new AppError(ERROR_CODES.NOT_IMPLEMENTED, '宿主能力未实现');
  }

  /** 整理当天任务 args: { project? } */
  async organizeTodayTasks(args, { signal, actionRunId } = {}) {
    void args; void signal; void actionRunId;
    throw new AppError(ERROR_CODES.NOT_IMPLEMENTED, '宿主能力未实现');
  }

  /** 生成日报 args: { date? } */
  async generateDailyReport(args, { signal, actionRunId } = {}) {
    void args; void signal; void actionRunId;
    throw new AppError(ERROR_CODES.NOT_IMPLEMENTED, '宿主能力未实现');
  }

  /** 打开便利贴页面 args: { page: 'tasks'|'notepad'|'tools' }（只读） */
  async openPage(args, { signal } = {}) {
    void args; void signal;
    throw new AppError(ERROR_CODES.NOT_IMPLEMENTED, '宿主能力未实现');
  }
}

module.exports = { HostAdapter };
