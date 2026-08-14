'use strict';

const { ACTION_SCHEMAS } = require('../../planning/plan-schema');
const { callHost } = require('./common');

module.exports = {
  type: 'set_reminder',
  risk: 'low',
  cancellable: true,
  idempotent: true,
  readOnly: false,
  schema: ACTION_SCHEMAS.set_reminder,
  execute({ args, host, signal, context }) {
    return callHost(host.setReminder.bind(host), args, { signal, actionRunId: context.actionRunId });
  },
};
