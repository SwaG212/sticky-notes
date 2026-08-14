'use strict';

const { ACTION_SCHEMAS } = require('../../planning/plan-schema');
const { callHost } = require('./common');

module.exports = {
  type: 'create_task',
  risk: 'low',
  cancellable: true,
  idempotent: true,
  readOnly: false,
  schema: ACTION_SCHEMAS.create_task,
  execute({ args, host, signal, context }) {
    return callHost(host.createTask.bind(host), args, { signal, actionRunId: context.actionRunId });
  },
  compensate({ result, host, signal, context }) {
    // 创建任务可撤销：完成它
    return callHost(host.completeTask.bind(host), { taskId: result.data.id }, { signal, actionRunId: context.actionRunId });
  },
};
