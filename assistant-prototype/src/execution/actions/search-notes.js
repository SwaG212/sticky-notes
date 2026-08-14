'use strict';

const { ACTION_SCHEMAS } = require('../../planning/plan-schema');
const { callHost } = require('./common');

module.exports = {
  type: 'search_notes',
  risk: 'low',
  cancellable: true,
  idempotent: true,
  readOnly: true,
  schema: ACTION_SCHEMAS.search_notes,
  execute({ args, host, signal, context }) {
    // 只读动作不携带 actionRunId（文档 11.2）
    return callHost(host.searchNotes.bind(host), args, { signal, actionRunId: null });
  },
};
