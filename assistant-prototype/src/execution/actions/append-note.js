'use strict';

const { ACTION_SCHEMAS } = require('../../planning/plan-schema');
const { callHost } = require('./common');

module.exports = {
  type: 'append_note',
  risk: 'low',
  cancellable: true,
  idempotent: false, // 追加内容天然非幂等，禁止自动重试
  readOnly: false,
  schema: ACTION_SCHEMAS.append_note,
  execute({ args, host, signal, context }) {
    return callHost(host.appendNote.bind(host), args, { signal, actionRunId: context.actionRunId });
  },
};
