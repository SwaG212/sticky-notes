'use strict';

const { ACTION_SCHEMAS } = require('../../planning/plan-schema');
const { callHost } = require('./common');

module.exports = {
  type: 'organize_today_tasks',
  risk: 'low',
  cancellable: true,
  idempotent: true,
  readOnly: false,
  schema: ACTION_SCHEMAS.organize_today_tasks,
  execute({ args, host, signal, context }) {
    return callHost(host.organizeTodayTasks.bind(host), args, { signal, actionRunId: context.actionRunId });
  },
};
