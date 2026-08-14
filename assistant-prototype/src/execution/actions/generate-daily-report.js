'use strict';

const { ACTION_SCHEMAS } = require('../../planning/plan-schema');
const { callHost } = require('./common');

module.exports = {
  type: 'generate_daily_report',
  risk: 'low',
  cancellable: true,
  idempotent: true,
  readOnly: false,
  schema: ACTION_SCHEMAS.generate_daily_report,
  execute({ args, host, signal, context }) {
    return callHost(host.generateDailyReport.bind(host), args, { signal, actionRunId: context.actionRunId });
  },
};
