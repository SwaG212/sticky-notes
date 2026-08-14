'use strict';

const { ACTION_SCHEMAS } = require('../../planning/plan-schema');
const { callHost } = require('./common');

module.exports = {
  type: 'create_note',
  risk: 'low',
  cancellable: true,
  idempotent: true,
  readOnly: false,
  schema: ACTION_SCHEMAS.create_note,
  execute({ args, host, signal, context }) {
    return callHost(host.createNote.bind(host), args, { signal, actionRunId: context.actionRunId });
  },
};
