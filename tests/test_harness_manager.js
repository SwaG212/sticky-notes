const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  HarnessManager,
  harnessConfig,
  isBroadWriteWorkspace,
  validateHarnessConfig,
  SESSION_ID_PATTERN,
} = require('../harness/manager');

const appRoot = path.resolve(__dirname, '..');
const config = harnessConfig({
  harness: {
    installDir: 'F:\\Tools\\deepseek-harness',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    workspace: appRoot,
    mode: 'minimal',
    permission: 'read-only',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'max',
  },
}, appRoot);

async function main() {
  assert.strictEqual(validateHarnessConfig({ ...config, apiKey: 'test-key' }), null);
  assert.strictEqual(config.model, 'deepseek-v4-pro');
  assert.strictEqual(config.mode, 'minimal');
  assert.strictEqual(harnessConfig({ harness: { mode: 'creative' } }, appRoot).mode, 'standard');
  assert.strictEqual(config.reasoningEffort, 'max');
  assert.strictEqual(isBroadWriteWorkspace('F:\\'), true);
  assert.match(
    validateHarnessConfig({ ...config, workspace: 'F:\\', permission: 'workspace-write', apiKey: 'test-key' }),
    /根目录/,
  );
  assert.strictEqual(SESSION_ID_PATTERN.test('sticky-abc-123'), true);
  assert.strictEqual(SESSION_ID_PATTERN.test('../foreign-session'), false);

  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-harness-manager-test-'));
  const manager = new HarnessManager({
    appRoot,
    userDataPath,
    getConfig: () => ({ apiKey: 'test-key', harness: config }),
    emit: () => {},
  });
  try {
    const transcriptDir = path.join(userDataPath, 'harness-sessions', '--fixture--', 'sticky-fixture');
    fs.mkdirSync(transcriptDir, { recursive: true });
    const transcript = [
      { type: 'session', version: 0, id: 'sticky-fixture', cwd: appRoot, createdAt: 1000, delegationDepth: 0 },
      { type: 'user/message', seq: 0, time: 1001, data: { content: [{ type: 'text', text: '修复测试' }], source: { kind: 'user' } } },
      { type: 'session/title', seq: 1, time: 1002, data: { title: '修复测试任务' } },
      { type: 'assistant/message', seq: 2, time: 1003, data: { message: { content: [{ type: 'text', text: '开始检查' }] } } },
      { type: 'tool/call', seq: 3, time: 1004, data: { callId: 'call-1', name: 'edit', arguments: '{"file_path":"a.js","old_string":"old","new_string":"new"}' } },
      { type: 'tool/result', seq: 4, time: 1005, data: { message: { source: { callId: 'call-1' }, content: [] }, meta: { diffs: [{ path: 'a.js', oldText: 'old', newText: 'new' }] } } },
      { type: 'todo/write', seq: 5, time: 1006, data: { todos: [{ content: '运行测试', status: 'completed' }] } },
      { type: 'turn/end', seq: 6, time: 1007, data: { reason: { kind: 'completed' } } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n';
    fs.writeFileSync(path.join(transcriptDir, 'session.jsonl'), transcript, 'utf8');

    const sessions = manager.listSessions();
    assert.strictEqual(sessions[0].title, '修复测试任务');
    const restored = manager.loadSession('sticky-fixture');
    assert.deepStrictEqual(restored.todos, [{ content: '运行测试', status: 'completed' }]);
    assert.strictEqual(restored.diffs[0].path, 'a.js');
    assert.deepStrictEqual(restored.messages.map(message => message.role), ['user', 'assistant', 'tool']);

    await manager.ensureBridge({ ...config, apiKey: 'test-key' });
    assert(manager.child && manager.child.exitCode === null);
  } finally {
    await manager.request('close', {}, 5000).catch(() => {});
    manager.dispose();
  }

  const standardConfig = { ...config, mode: 'standard' };
  const standardManager = new HarnessManager({
    appRoot,
    userDataPath,
    getConfig: () => ({ apiKey: 'test-key', harness: standardConfig }),
    emit: () => {},
  });
  try {
    await standardManager.ensureBridge({ ...standardConfig, apiKey: 'test-key' });
    assert(standardManager.child && standardManager.child.exitCode === null);
  } finally {
    await standardManager.request('close', {}, 5000).catch(() => {});
    standardManager.dispose();
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }

  console.log('Harness manager validation and bridge ping passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
