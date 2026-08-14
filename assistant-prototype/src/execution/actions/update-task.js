'use strict';

const { ACTION_SCHEMAS } = require('../../planning/plan-schema');
const { callHost } = require('./common');

module.exports = {
  type: 'update_task',
  risk: 'low',
  cancellable: true,
  idempotent: true,
  readOnly: false,
  schema: ACTION_SCHEMAS.update_task,
  execute({ args, host, signal, context }) {
    return callHost(host.updateTask.bind(host), args, { signal, actionRunId: context.actionRunId });
  },
};
