'use strict';

const { ActionRegistry } = require('../execution/action-registry');

const ACTIONS = [
  require('../execution/actions/create-task'),
  require('../execution/actions/update-task'),
  require('../execution/actions/complete-task'),
  require('../execution/actions/set-reminder'),
  require('../execution/actions/create-note'),
  require('../execution/actions/append-note'),
  require('../execution/actions/search-notes'),
  require('../execution/actions/organize-today-tasks'),
  require('../execution/actions/generate-daily-report'),
  require('../execution/actions/open-page'),
];

/** 注册全部白名单动作。 */
function registerActions(registry) {
  if (!(registry instanceof ActionRegistry)) {
    throw new TypeError('registry 必须是 ActionRegistry 实例');
  }
  for (const def of ACTIONS) {
    registry.register(def);
  }
}

module.exports = { registerActions };
