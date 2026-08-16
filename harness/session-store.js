const fs = require('fs');
const path = require('path');

// 会话日志是 append-only 的，长时间任务会让它增长到很大。之前这里用 5MB 的
// 硬上限，一旦超限就直接丢弃整个会话（列表里消失、详情也读不出来），这正是
// “长任务跑一会儿后整段对话消失”的根因。现在不再丢弃：小于 FULL_PARSE_BYTES
// 的日志整体读取；更大的日志则读取「头部 + 尾部」来恢复（UI 本来也只展示最后
// MAX_MESSAGES 条消息）。
const FULL_PARSE_BYTES = 32 * 1024 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;
const MAX_SESSIONS = 30;
const MAX_MESSAGES = 100;
const MAX_DIFFS = 50;

function textBlocks(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
    .trim();
}

function toolResultText(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return '';
  const texts = [];
  for (const block of blocks) {
    if (block?.type !== 'tool-result' || !Array.isArray(block.content)) continue;
    for (const item of block.content) {
      if (item?.type === 'text' && typeof item.text === 'string') texts.push(item.text);
    }
  }
  return texts.join('\n').trim().slice(0, 3000);
}

function validDiffs(meta) {
  if (!Array.isArray(meta?.diffs)) return [];
  return meta.diffs.filter(diff => (
    diff && typeof diff.path === 'string'
    && (diff.oldText === null || typeof diff.oldText === 'string')
    && typeof diff.newText === 'string'
  )).map(diff => ({
    path: diff.path.slice(0, 1024),
    oldText: diff.oldText === null ? null : diff.oldText.slice(0, 12000),
    newText: diff.newText.slice(0, 12000),
  }));
}

function fallbackDiff(call) {
  if (!call || !['write', 'edit'].includes(call.name)) return [];
  let args;
  try { args = JSON.parse(call.arguments); }
  catch { return []; }
  if (typeof args?.file_path !== 'string') return [];
  if (call.name === 'write' && typeof args.content === 'string') {
    return [{ path: args.file_path, oldText: null, newText: args.content.slice(0, 12000) }];
  }
  if (call.name === 'edit' && typeof args.old_string === 'string' && typeof args.new_string === 'string') {
    return [{ path: args.file_path, oldText: args.old_string.slice(0, 12000), newText: args.new_string.slice(0, 12000) }];
  }
  return [];
}

// 读取会话日志为「行数组」。超大的日志不再整体读入，而是保留头部（含会话头、
// 标题、首个用户消息）与一个受限的尾部，这样列表与详情仍能工作，而不是把整个
// 会话当作不存在。头部与尾部之间被跳过的中间段对 UI 无影响（UI 只展示最后
// MAX_MESSAGES 条消息）。
function readSessionLines(filePath, stat) {
  if (stat.size <= FULL_PARSE_BYTES) {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(Math.min(stat.size, HEAD_BYTES));
    fs.readSync(fd, head, 0, head.length, 0);
    const headLines = head.toString('utf8').split(/\r?\n/);
    // 头部读到的最后一行可能被截断（未到换行符），丢弃以避免 JSON 解析出半行。
    if (head.length === HEAD_BYTES && headLines[headLines.length - 1] !== '') {
      headLines.pop();
    }

    const tailStart = Math.max(0, stat.size - TAIL_BYTES);
    const tail = Buffer.alloc(stat.size - tailStart);
    fs.readSync(fd, tail, 0, tail.length, tailStart);
    const tailLines = tail.toString('utf8').split(/\r?\n/);
    if (tailStart > 0) tailLines.shift(); // 丢弃尾部第一条可能被截断的行
    return [...headLines, ...tailLines];
  } finally {
    fs.closeSync(fd);
  }
}

function parseSessionFile(filePath, includeDetails = false) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return null;
  const lines = readSessionLines(filePath, stat);
  let header = null;
  let title = '';
  let updatedAt = stat.mtimeMs;
  let outcome = 'idle';
  let turnEnds = 0;
  let messageCount = 0;
  let todos = [];
    let elapsedMs = null;
    let turnStartedAt = null;
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    };
  const messages = [];
  const diffs = [];
  const calls = new Map();

  for (const line of lines) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); }
    catch { continue; }
    if (!header && event?.type === 'session') {
      if (typeof event.id !== 'string' || typeof event.createdAt !== 'number') return null;
      header = event;
      continue;
    }
    if (!header || typeof event?.type !== 'string') continue;
    if (Number.isFinite(event.time)) updatedAt = Math.max(updatedAt, event.time);
      if (event.type === 'turn/start' && Number.isFinite(event.time)) {
        turnStartedAt = event.time;
      }
    if (event.type === 'session/title' && typeof event.data?.title === 'string') {
      title = event.data.title.trim().slice(0, 80);
    } else if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      const text = textBlocks(event.data.content);
      if (!text) continue;
      messageCount++;
      if (!title) title = text.slice(0, 32);
      if (includeDetails) messages.push({ role: 'user', text: text.slice(0, 12000), time: event.time });
    } else if (event.type === 'assistant/message') {
        const nextUsage = event.data?.usage;
        if (nextUsage) {
          usage.inputTokens += Number.isFinite(nextUsage.inputTokens) ? nextUsage.inputTokens : 0;
          usage.outputTokens += Number.isFinite(nextUsage.outputTokens) ? nextUsage.outputTokens : 0;
          usage.cacheReadTokens += Number.isFinite(nextUsage.cacheReadTokens) ? nextUsage.cacheReadTokens : 0;
          usage.cacheWriteTokens += Number.isFinite(nextUsage.cacheWriteTokens) ? nextUsage.cacheWriteTokens : 0;
          usage.reasoningTokens += Number.isFinite(nextUsage.reasoningTokens) ? nextUsage.reasoningTokens : 0;
        }
      const text = textBlocks(event.data?.message?.content);
      if (!text) continue;
      messageCount++;
      if (includeDetails) messages.push({ role: 'assistant', text: text.slice(0, 12000), time: event.time });
    } else if (event.type === 'tool/call') {
      calls.set(event.data?.callId, {
        name: event.data?.name || 'tool',
        arguments: typeof event.data?.arguments === 'string' ? event.data.arguments : '',
      });
      if (includeDetails) messages.push({
        role: 'tool',
        text: event.data?.name || 'tool',
        callId: event.data?.callId,
        detail: typeof event.data?.arguments === 'string' ? event.data.arguments.slice(0, 3000) : '',
        pending: true,
        time: event.time,
      });
    } else if (event.type === 'tool/result') {
      const callId = event.data?.message?.source?.callId;
      const failed = Boolean(event.data?.error);
      if (includeDetails) {
        const row = [...messages].reverse().find(item => item.role === 'tool' && item.callId === callId);
        if (row) {
          row.pending = false;
          row.failed = failed;
          row.output = toolResultText(event.data?.message);
        }
        const eventDiffs = validDiffs(event.data?.meta);
        diffs.push(...(eventDiffs.length ? eventDiffs : fallbackDiff(calls.get(callId))));
      }
    } else if (event.type === 'todo/write' && Array.isArray(event.data?.todos)) {
      todos = event.data.todos.filter(item => (
        item && typeof item.content === 'string'
        && ['pending', 'in_progress', 'completed'].includes(item.status)
      )).slice(0, 30);
    } else if (event.type === 'turn/end') {
      turnEnds++;
      outcome = event.data?.reason?.kind || 'idle';
        if (Number.isFinite(event.time) && Number.isFinite(turnStartedAt)) {
          elapsedMs = Math.max(0, event.time - turnStartedAt);
        }
    }
  }
  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;

  if (!header) return null;
  const result = {
    id: header.id,
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    title: title || '未命名任务',
    createdAt: header.createdAt,
    updatedAt,
    outcome,
    turnEnds,
    messageCount,
    elapsedMs,
    usage,
  };
  if (includeDetails) {
    // 长任务的消息行数会超过展示窗口。若直接取最后 MAX_MESSAGES 行，任务一长，
    // 开头的用户发言就会被裁掉，出现「这轮对话的开头消失」。裁剪时永远保留全部
    // 用户消息（按时间顺序），只对非用户消息（工具调用/中间输出）取最近的一段。
    if (messages.length > MAX_MESSAGES) {
      const tail = messages.filter(item => item.role !== 'user').slice(-MAX_MESSAGES);
      const tailSet = new Set(tail);
      result.messages = messages.filter(item => item.role === 'user' || tailSet.has(item));
    } else {
      result.messages = messages;
    }
    result.todos = todos;
    result.diffs = diffs.slice(-MAX_DIFFS);
  }
  return result;
}

function sessionFiles(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  for (const project of fs.readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectPath = path.join(root, project.name);
    for (const session of fs.readdirSync(projectPath, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const filePath = path.join(projectPath, session.name, 'session.jsonl');
      if (fs.existsSync(filePath)) found.push(filePath);
    }
  }
  return found;
}

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function listSessions(root, workspace) {
  return sessionFiles(root)
    .map(filePath => {
      try { return { filePath, session: parseSessionFile(filePath) }; }
      catch { return null; }
    })
    .filter(item => item?.session && samePath(item.session.cwd, workspace))
    .sort((a, b) => b.session.updatedAt - a.session.updatedAt)
    .slice(0, MAX_SESSIONS)
    .map(item => item.session);
}

function loadSession(root, workspace, sessionId) {
  const match = sessionFiles(root).find(filePath => {
    try {
      const session = parseSessionFile(filePath);
      return session?.id === sessionId && samePath(session.cwd, workspace);
    } catch { return false; }
  });
  return match ? parseSessionFile(match, true) : null;
}

module.exports = { listSessions, loadSession, parseSessionFile, textBlocks, validDiffs };
