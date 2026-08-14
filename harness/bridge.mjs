import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const installDir = process.env.DSH_INSTALL_DIR;
const nodePath = process.env.DSH_NODE_PATH;
const runtimePath = process.env.DSH_RUNTIME_PATH;
const configPath = process.env.DSH_CORDIS_CONFIG;
const workspace = process.env.DSH_CWD;
const sdkPath = installDir
  ? path.join(installDir, 'packages', 'sdk', 'client', 'lib', 'index.js')
  : '';

if (!installDir || !nodePath || !runtimePath || !configPath || !workspace) {
  process.stderr.write('sticky-harness-bridge: incomplete launch configuration\n');
  process.exit(1);
}

const { DeepSeekHarness } = await import(pathToFileURL(sdkPath).href);
let harness = null;
let running = false;
let stopping = false;
let generation = 0;
const SESSION_ID_PATTERN = /^sticky-[a-zA-Z0-9-]{1,80}$/;
const streamBuffers = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function launchOptions() {
  return {
    launch: {
      command: nodePath,
      args: [runtimePath],
      cwd: workspace,
      env: { ...process.env },
      shutdownTimeoutMs: 1500,
      disposeEofGraceMs: 3000,
      disposeGraceMs: 2000,
    },
    cwd: workspace,
    provider: 'deepseek-official',
    model: process.env.DSH_MODEL || 'deepseek-v4-flash',
    maxTokens: 8192,
  };
}

function getHarness() {
  harness ??= new DeepSeekHarness(launchOptions());
  return harness;
}

function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function toolResultText(message) {
  if (!Array.isArray(message?.content)) return '';
  const text = [];
  for (const block of message.content) {
    if (block?.type !== 'tool-result' || !Array.isArray(block.content)) continue;
    for (const item of block.content) {
      if (item?.type === 'text' && typeof item.text === 'string') text.push(item.text);
    }
  }
  return text.join('\n').trim().slice(0, 3000);
}

function eventDiffs(meta) {
  if (!Array.isArray(meta?.diffs)) return [];
  return meta.diffs.filter(diff => (
    diff && typeof diff.path === 'string'
    && (diff.oldText === null || typeof diff.oldText === 'string')
    && typeof diff.newText === 'string'
  )).slice(0, 20).map(diff => ({
    path: diff.path.slice(0, 1024),
    oldText: diff.oldText === null ? null : diff.oldText.slice(0, 12000),
    newText: diff.newText.slice(0, 12000),
  }));
}

function streamKey(sessionId, data) {
  return `${sessionId || ''}:${data?.turn || 0}:${data?.step || 0}`;
}

function flushStream(key) {
  const buffered = streamBuffers.get(key);
  if (!buffered) return;
  clearTimeout(buffered.timer);
  streamBuffers.delete(key);
  if (buffered.text) send({ event: { ...buffered.event, text: buffered.text } });
}

function queueStream(event) {
  const current = streamBuffers.get(event.streamKey);
  if (current) {
    current.text = (current.text + event.text).slice(-12000);
    return;
  }
  const buffered = { event, text: event.text, timer: null };
  buffered.timer = setTimeout(() => flushStream(event.streamKey), 40);
  streamBuffers.set(event.streamKey, buffered);
}

function summarizeNotification(notification) {
  const params = notification?.params;
  if (notification?.method === 'session.status') {
    return { type: 'status', sessionId: params?.sessionId, status: params?.status };
  }
  if (notification?.method === 'subagent.started') {
    return { type: 'subagent', status: 'started', sessionId: params?.childSessionId };
  }
  if (notification?.method === 'subagent.finished') {
    return { type: 'subagent', status: 'finished', sessionId: params?.childSessionId };
  }
  if (notification?.method !== 'session.event') return null;

  const event = params?.event;
  if (event?.type === 'assistant/chunk' && event.data?.chunk?.type === 'text-delta') {
    return {
      type: 'message', role: 'assistant', delta: true,
      sessionId: params.sessionId,
      streamKey: streamKey(params.sessionId, event.data),
      text: String(event.data.chunk.text || ''),
    };
  }
  if (event?.type === 'assistant/message') {
    const text = textFromBlocks(event.data?.message?.content);
    return text ? {
      type: 'message', role: 'assistant', sessionId: params.sessionId,
      streamKey: streamKey(params.sessionId, event.data), text,
    } : null;
  }
  if (event?.type === 'tool/call') {
    return {
      type: 'tool',
      phase: 'start',
      sessionId: params.sessionId,
      callId: event.data?.callId,
      name: event.data?.name || 'tool',
      detail: typeof event.data?.arguments === 'string' ? event.data.arguments.slice(0, 3000) : '',
    };
  }
  if (event?.type === 'tool/result') {
    return {
      type: 'tool',
      phase: 'finish',
      sessionId: params.sessionId,
      callId: event.data?.callId || event.data?.message?.source?.callId,
      failed: Boolean(event.data?.error),
      output: toolResultText(event.data?.message),
      diffs: eventDiffs(event.data?.meta),
    };
  }
  if (event?.type === 'todo/write' && Array.isArray(event.data?.todos)) {
    return { type: 'todos', sessionId: params.sessionId, todos: event.data.todos.slice(0, 30) };
  }
  return null;
}

async function runTask(message) {
  if (running) {
    send({ id: message.id, ok: false, error: '已有任务正在执行' });
    return;
  }
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (!text || text.length > 8000) {
    send({ id: message.id, ok: false, error: text ? '任务内容过长' : '请输入任务内容' });
    return;
  }

  const sessionId = SESSION_ID_PATTERN.test(message.sessionId || '')
    ? message.sessionId
    : `sticky-${randomUUID().replaceAll('-', '')}`;
  const runGeneration = ++generation;
  running = true;
  stopping = false;
  send({ id: message.id, ok: true, data: { sessionId } });
  send({ event: { type: 'status', status: 'starting', sessionId } });

  try {
    const result = await getHarness().run(text, {
      sessionId,
      onNotification(notification) {
        const event = summarizeNotification(notification);
        if (!event || runGeneration !== generation) return;
        if (event.delta) queueStream(event);
        else {
          if (event.streamKey) flushStream(event.streamKey);
          send({ event });
        }
      },
    });
    if (runGeneration === generation) {
      send({ event: { type: 'result', status: 'completed', sessionId, text: result.finalResponse } });
    }
  } catch (error) {
    if (runGeneration === generation && !stopping) {
      send({ event: { type: 'error', sessionId, message: error?.message || String(error) } });
    }
  } finally {
    if (runGeneration === generation) {
      running = false;
      stopping = false;
    }
  }
}

async function stopTask(message) {
  generation++;
  stopping = true;
  for (const key of streamBuffers.keys()) flushStream(key);
  const current = harness;
  harness = null;
  if (current) await current.close().catch(() => {});
  running = false;
  stopping = false;
  send({ id: message.id, ok: true, data: { stopped: true } });
  send({ event: { type: 'status', status: 'stopped' } });
}

async function handle(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'run') {
    void runTask(message);
    return;
  }
  if (message.type === 'stop') {
    await stopTask(message);
    return;
  }
  if (message.type === 'ping') {
    send({ id: message.id, ok: true, data: { ready: true } });
    return;
  }
  if (message.type === 'close') {
    await stopTask(message);
    process.exit(0);
  }
  send({ id: message.id, ok: false, error: '未知命令' });
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  try {
    void handle(JSON.parse(line));
  } catch {
    send({ event: { type: 'error', message: 'Bridge 收到无效消息' } });
  }
});
lines.on('close', async () => {
  if (harness) await harness.close().catch(() => {});
  process.exit(0);
});

send({ event: { type: 'status', status: 'ready' } });

export { summarizeNotification, textFromBlocks };
