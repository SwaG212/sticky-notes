const fs = require('fs');
const path = require('path');

const MAX_SESSION_BYTES = 5 * 1024 * 1024;
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

function parseSessionFile(filePath, includeDetails = false) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_SESSION_BYTES) return null;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  let header = null;
  let title = '';
  let updatedAt = stat.mtimeMs;
  let outcome = 'idle';
  let messageCount = 0;
  let todos = [];
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
    if (event.type === 'session/title' && typeof event.data?.title === 'string') {
      title = event.data.title.trim().slice(0, 80);
    } else if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      const text = textBlocks(event.data.content);
      if (!text) continue;
      messageCount++;
      if (!title) title = text.slice(0, 32);
      if (includeDetails) messages.push({ role: 'user', text: text.slice(0, 12000), time: event.time });
    } else if (event.type === 'assistant/message') {
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
      outcome = event.data?.reason?.kind || 'idle';
    }
  }

  if (!header) return null;
  const result = {
    id: header.id,
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    title: title || '未命名任务',
    createdAt: header.createdAt,
    updatedAt,
    outcome,
    messageCount,
  };
  if (includeDetails) {
    result.messages = messages.slice(-MAX_MESSAGES);
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
