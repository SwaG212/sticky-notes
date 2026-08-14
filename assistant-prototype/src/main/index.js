'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const { ConfigStore } = require('../storage/config-store');
const { SandboxStore } = require('../storage/sandbox-store');
const { SessionStore } = require('../storage/session-store');
const { ExecutionJournal } = require('../execution/execution-journal');
const { ActionRegistry } = require('../execution/action-registry');
const { Executor } = require('../execution/executor');
const { MockHostAdapter } = require('../host/mock-host-adapter');
const { DeepSeekClient } = require('../llm/deepseek-client');
const { Planner } = require('../llm/planner');
const { PlanValidator } = require('../planning/plan-validator');
const { ConfirmationGate } = require('../planning/confirmation-gate');
const { RiskPolicy } = require('../planning/risk-policy');
const { AssistantOrchestrator } = require('../assistant/orchestrator');
const { Logger } = require('../shared/logger');
const { registerIpcHandlers } = require('./ipc-handlers');
const { registerActions } = require('./register-actions');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    title: '小智桌面助手（原型 · 文字闭环）',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  return mainWindow;
}

/** 组装依赖（依赖注入，模块顶层不创建资源）并返回编排器。 */
function buildOrchestrator() {
  const logger = new Logger();
  const config = new ConfigStore();
  const cfg = config.getConfig();

  const sandboxStore = new SandboxStore({ dataDir: cfg.sandboxDataDir });
  sandboxStore.init();
  const sessionStore = new SessionStore({ sessionsDir: cfg.sessionsDir });
  const journal = new ExecutionJournal({ journalDir: cfg.journalDir });

  const registry = new ActionRegistry();
  registerActions(registry);

  const host = new MockHostAdapter(sandboxStore);
  const executor = new Executor({ registry, host, journal });

  const client = new DeepSeekClient({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
  });
  const planner = new Planner({ client });
  const validator = new PlanValidator(registry);
  const confirmationGate = new ConfirmationGate();
  const riskPolicy = new RiskPolicy();

  const orchestrator = new AssistantOrchestrator({
    planner,
    validator,
    confirmationGate,
    riskPolicy,
    executor,
    registry,
    host,
    journal,
    sessionStore,
    logger,
    config: cfg,
    emit: (event, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('assistant:event', { event, payload });
      }
    },
  });

  return { orchestrator, config, logger };
}

app.whenReady().then(() => {
  const { orchestrator, config, logger } = buildOrchestrator();
  createWindow();
  registerIpcHandlers({ orchestrator, config, logger });
  logger.info('app_ready', { details: { hasApiKey: config.hasApiKey() } });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

module.exports = { buildOrchestrator, createWindow };
