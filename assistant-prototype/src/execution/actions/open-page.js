'use strict';

const { ACTION_SCHEMAS } = require('../../planning/plan-schema');
const { callHost } = require('./common');

module.exports = {
  type: 'open_page',
  risk: 'low',
  cancellable: true,
  idempotent: true,
  readOnly: true,
  schema: ACTION_SCHEMAS.open_page,
  execute({ args, host, signal, context }) {
    return callHost(host.openPage.bind(host), args, { signal, actionRunId: null });
  },
};
