const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const sessionStore = require('./session-store');

const DEFAULT_INSTALL_DIR = 'F:\\Tools\\deepseek-harness';
const DEFAULT_NODE_PATH = 'C:\\Program Files\\nodejs\\node.exe';
const MAX_STDERR_CHARS = 4000;
const MAX_PATH_CHARS = 1024;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,80}$/;

// 共享会话目录：与 `dsh web` 一致（$DSH_HOME 优先，否则 ~/.dsh），
// 两边读写同一批 session.jsonl 才能互通。
function dshSessionsRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'sessions');
}

function harnessConfig(config, appRoot) {
  const source = config?.harness || {};
  return {
    enabled: source.enabled !== false,
    installDir: String(source.installDir || DEFAULT_INSTALL_DIR).trim(),
    nodePath: String(source.nodePath || DEFAULT_NODE_PATH).trim(),
    workspace: String(source.workspace || '').trim(),
    mode: source.mode === 'minimal' ? 'minimal' : 'standard',
    model: ['deepseek-v4-pro', 'deepseek-v4-flash'].includes(source.model) ? source.model : 'deepseek-v4-flash',
    reasoningEffort: ['off', 'high', 'max'].includes(source.reasoningEffort) ? source.reasoningEffort : 'high',
    permission: source.permission === 'read-only' ? 'read-only' : 'workspace-write',
    bridgePath: path.join(appRoot, 'harness', 'bridge.mjs'),
    runtimePath: path.join(appRoot, 'harness', 'runtime.mjs'),
    cordisPath: path.join(appRoot, 'harness', 'sticky-harness.cordis.yml'),
  };
}

function isBroadWriteWorkspace(workspace) {
  if (!workspace) return false;
  const resolved = path.resolve(workspace);
  return resolved === path.parse(resolved).root;
}

function validateHarnessConfig(config, { requireApiKey = true } = {}) {
  if (!config.enabled) return 'DeepSeek Harness 已禁用';
  if ([config.installDir, config.nodePath, config.workspace].some(value => String(value || '').length > MAX_PATH_CHARS)) {
    return 'Harness 路径过长';
  }
  if (!path.isAbsolute(config.installDir) || !fs.existsSync(config.installDir)) return 'Harness 安装目录不存在';
  if (!fs.existsSync(path.join(config.installDir, 'packages', 'sdk', 'client', 'lib', 'index.js'))) {
    return 'Harness 尚未构建，请先在安装目录运行 pnpm run build';
  }
  if (!path.isAbsolute(config.nodePath) || !fs.existsSync(config.nodePath)) return 'Node.js 路径不存在';
  if (!config.workspace || !path.isAbsolute(config.workspace) || !fs.existsSync(config.workspace)) {
    return '请先选择工作目录';
  }
  if (!fs.statSync(config.workspace).isDirectory()) return '工作目录无效';
  if (config.permission === 'workspace-write' && isBroadWriteWorkspace(config.workspace)) {
    return '写入权限不能授予磁盘根目录';
  }
  if (!fs.existsSync(config.bridgePath) || !fs.existsSync(config.runtimePath) || !fs.existsSync(config.cordisPath)) {
    return '便利贴的 Harness 运行文件不完整';
  }
  if (requireApiKey && !config.apiKey) return '请先在设置中配置 API Key';

  const version = spawnSync(config.nodePath, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (version.error || version.status !== 0) return '无法启动配置的 Node.js';
  const major = Number(String(version.stdout || '').trim().replace(/^v/, '').split('.')[0]);
  if (!Number.isInteger(major) || major < 22) return 'DeepSeek Harness 需要 Node.js 22.19 或更高版本';
  return null;
}

class HarnessManager {
  constructor({ appRoot, userDataPath, getConfig, emit, sessionRoot }) {
    this.appRoot = appRoot;
    this.userDataPath = userDataPath;
    this.getConfig = getConfig;
    this.emit = emit;
    this.sharedSessionRoot = sessionRoot;
    this.child = null;
    this.lines = null;
    this.pending = new Map();
    this.seq = 0;
    this.stderr = '';
    this.state = { status: 'idle', sessionId: null, error: null };
  }

  snapshot() {
    const raw = this.getConfig();
    const cfg = harnessConfig(raw, this.appRoot);
    const error = validateHarnessConfig({ ...cfg, apiKey: raw.apiKey });
    return {
      ...this.state,
      enabled: cfg.enabled,
      workspace: cfg.workspace,
      mode: cfg.mode,
      permission: cfg.permission,
      model: cfg.model,
      reasoningEffort: cfg.reasoningEffort,
      configured: !error,
      configError: error,
    };
  }

  sessionRoot() {
    return this.sharedSessionRoot || dshSessionsRoot();
  }

  listSessions() {
    const cfg = harnessConfig(this.getConfig(), this.appRoot);
    return sessionStore.listSessions(this.sessionRoot(), cfg.workspace);
  }

  loadSession(sessionId) {
    if (!SESSION_ID_PATTERN.test(sessionId || '')) return null;
    const cfg = harnessConfig(this.getConfig(), this.appRoot);
    return sessionStore.loadSession(this.sessionRoot(), cfg.workspace, sessionId);
  }

  async run(text, sessionId) {
    const raw = this.getConfig();
    const cfg = { ...harnessConfig(raw, this.appRoot), apiKey: raw.apiKey };
    const error = validateHarnessConfig(cfg);
    if (error) return { success: false, error };
    if (typeof text !== 'string' || !text.trim()) return { success: false, error: '请输入任务内容' };
    if (text.length > 8000) return { success: false, error: '任务内容过长' };
    if (['starting', 'running', 'stopping'].includes(this.state.status)) {
      return { success: false, error: '已有任务正在执行' };
    }

    await this.ensureBridge(cfg);
    const id = SESSION_ID_PATTERN.test(sessionId || '')
      ? sessionId
      : `sticky-${crypto.randomUUID().replaceAll('-', '')}`;
    this.setState({ status: 'starting', sessionId: id, error: null });
    try {
      const response = await this.request('run', { text: text.trim(), sessionId: id }, 15000);
      return { success: true, sessionId: response.sessionId };
    } catch (err) {
      this.setState({ status: 'error', error: err.message });
      return { success: false, error: err.message };
    }
  }

  async stop() {
    if (!this.child) {
      this.setState({ status: 'stopped' });
      return { success: true };
    }
    this.setState({ status: 'stopping' });
    try {
      await this.request('stop', {}, 10000);
      return { success: true };
    } catch (err) {
      this.dispose();
      this.setState({ status: 'stopped', error: null });
      return { success: true };
    }
  }

  newSession() {
    if (['starting', 'running', 'stopping'].includes(this.state.status)) {
      return { success: false, error: '请先停止当前任务' };
    }
    this.setState({ status: 'idle', sessionId: null, error: null });
    return { success: true };
  }

  reset({ emitSnapshot = true } = {}) {
    this.dispose();
    const idle = { status: 'idle', sessionId: null, error: null };
    if (emitSnapshot) this.setState(idle);
    else this.state = { ...this.state, ...idle };
  }

  async ensureBridge(cfg) {
    if (this.child && this.child.exitCode === null) return;
    this.stderr = '';
    const sessionRoot = this.sessionRoot();
    fs.mkdirSync(sessionRoot, { recursive: true });
    const env = {
      ...process.env,
      DEEPSEEK_API_KEY: cfg.apiKey,
      DEEPSEEK_BASE_URL: this.getConfig().baseUrl || 'https://api.deepseek.com',
      DSH_INSTALL_DIR: cfg.installDir,
      DSH_NODE_PATH: cfg.nodePath,
      DSH_RUNTIME_PATH: cfg.runtimePath,
      DSH_CORDIS_CONFIG: cfg.cordisPath,
      DSH_CWD: cfg.workspace,
      DSH_SESSION_ROOT: sessionRoot,
      DSH_PERMISSION_MODE: cfg.permission,
      DSH_AGENT_MODE: cfg.mode,
      DSH_MODEL: cfg.model,
      DSH_REASONING_EFFORT: cfg.reasoningEffort,
    };
    const child = spawn(cfg.nodePath, [cfg.bridgePath], {
      cwd: cfg.workspace,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on('line', (line) => this.handleLine(child, line));
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-MAX_STDERR_CHARS);
    });
    child.on('error', (err) => this.handleExit(child, err));
    child.on('exit', (code) => this.handleExit(child, new Error(
      this.stderr.trim() || `Harness Bridge 已退出（${code ?? 'unknown'}）`,
    )));
    await this.request('ping', {}, 10000);
  }

  request(type, data, timeoutMs) {
    if (!this.child || this.child.exitCode !== null) return Promise.reject(new Error('Harness Bridge 未运行'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Harness Bridge 响应超时'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
    });
  }

  handleLine(child, line) {
    if (child !== this.child) return;
    let message;
    try { message = JSON.parse(line); }
    catch { return; }
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.data || {});
      else pending.reject(new Error(message.error || 'Harness 请求失败'));
      return;
    }
    if (!message.event) return;
    const event = message.event;
    if (event.type === 'status') {
      const status = event.status === 'running' ? 'running' : event.status;
      this.setState({ status, sessionId: event.sessionId || this.state.sessionId, error: null });
    } else if (event.type === 'result') {
      this.setState({ status: 'completed', sessionId: event.sessionId || this.state.sessionId, error: null });
    } else if (event.type === 'error') {
      this.setState({ status: 'error', error: event.message || 'Harness 执行失败' });
    }
    this.emit(event);
  }

  handleExit(child, error) {
    if (child !== this.child) return;
    this.child = null;
    this.lines?.close();
    this.lines = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!['idle', 'stopped'].includes(this.state.status)) {
      this.setState({ status: 'error', error: error.message });
      this.emit({ type: 'error', message: error.message });
    }
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit({ type: 'snapshot', snapshot: this.snapshot() });
  }

  dispose() {
    const child = this.child;
    this.child = null;
    this.lines?.close();
    this.lines = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Harness Bridge 已关闭'));
    }
    this.pending.clear();
    if (child && child.exitCode === null) {
      child.stdin.end();
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill();
      }, 4000);
      timer.unref();
    }
  }
}

module.exports = {
  HarnessManager,
  harnessConfig,
  isBroadWriteWorkspace,
  validateHarnessConfig,
  SESSION_ID_PATTERN,
  dshSessionsRoot,
};
