/**
 * task-file-lock.js
 *
 * 共享任务文件互斥协议（M1）：
 * - 锁文件：任务文件 tasks/<YYYY-MM-DD>.json 的同目录兄弟文件 tasks/<YYYY-MM-DD>.json.lock，
 *   一个日期文件一把锁，不同日期互不阻塞。
 * - 锁文件内容：JSON，{ owner: "app" | "muse", pid: 数字, host: "主机名", acquiredAt: "ISO 时间", token: "16 位十六进制随机串" }。
 * - 抢锁：用 fs.openSync(lockPath, 'wx') 原子创建，EEXIST 即已被占；写入锁内容后 fsync 再关闭。
 *   抢不到时读现有锁：若 acquiredAt 距今超过 30 秒视为残留锁，两次读取间隔 100ms、token 不变才删除后重试；
 *   否则每 100ms 重试一次，总等待超过 10 秒则抢锁失败。
 * - 释放：只删除 token 与自己一致的锁文件；锁文件不存在视为已释放，不报错；token 不一致时绝不删除别人的锁。
 * - 临界区：抢锁后才能读 -> 合并 -> 写 -> 回读校验，写完立即释放；任何异常路径（抛错、校验失败）都必须释放锁。
 *
 * 诚实限制：锁只约束遵守本协议的写入方。绕过锁直接改文件的一方不受约束，本协议保证不了它不覆盖。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const LOCK_STALE_AFTER_MS = 30000;
const LOCK_ACQUIRE_TIMEOUT_MS = 10000;
const LOCK_RETRY_INTERVAL_MS = 100;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function getTaskLockPath(tasksDir, dateStr) {
  if (typeof dateStr !== 'string' || !DATE_RE.test(dateStr)) {
    throw new Error('INVALID_DATE');
  }
  return path.join(tasksDir, dateStr + '.json.lock');
}

function readLockFile(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return null;
    }
    return { raw: '', parseError: true, readError: true };
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    return { raw: raw, parseError: true };
  }
}

function isLockStale(lock, nowMs) {
  if (!lock || typeof lock !== 'object' || lock.parseError) {
    return false;
  }
  if (typeof lock.acquiredAt !== 'string' || !lock.acquiredAt) {
    return false;
  }

  const acquiredMs = Date.parse(lock.acquiredAt);
  if (!Number.isFinite(acquiredMs)) {
    return false;
  }

  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  return now - acquiredMs > LOCK_STALE_AFTER_MS;
}

function sleepSync(ms) {
  const waitMs = Math.max(0, Number(ms) || 0);

  try {
    if (
      typeof Atomics === 'object' &&
      typeof Atomics.wait === 'function' &&
      typeof SharedArrayBuffer === 'function'
    ) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
      return;
    }
  } catch (err) {
    // 某些环境禁用 Atomics.wait，继续走下面的空转。
  }

  // 同步路径的无奈选择：临界区短、重试间隔小。
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    // busy wait
  }
}

function makeLockTimeoutError() {
  const err = new Error('LOCK_TIMEOUT');
  err.code = 'LOCK_TIMEOUT';
  return err;
}

function tryRemoveStaleLock(lockPath, options) {
  const opts = options || {};
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();

  const first = readLockFile(lockPath);
  if (!isLockStale(first, nowMs)) {
    return { removed: false, reason: 'NOT_STALE' };
  }

  // 两次读取间隔 100ms，防止删掉一个正在被刷新的锁。
  sleepSync(100);

  const second = readLockFile(lockPath);
  const firstToken = first && first.token;
  const secondToken = second && second.token;

  if (!second || second.parseError || secondToken !== firstToken) {
    return { removed: false, reason: 'CHANGED' };
  }

  try {
    fs.unlinkSync(lockPath);
    return { removed: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { removed: false, reason: 'GONE' };
    }
    throw err;
  }
}

function acquireTaskFileLock(tasksDir, dateStr, options) {
  // 先校验 dateStr：非法时直接抛 INVALID_DATE，绝不进入重试/残留清理逻辑。
  const lockPath = getTaskLockPath(tasksDir, dateStr);

  const opts = options || {};
  const owner = opts.owner || 'app';
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : LOCK_ACQUIRE_TIMEOUT_MS;
  const retryMs = typeof opts.retryMs === 'number' ? opts.retryMs : LOCK_RETRY_INTERVAL_MS;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : sleepSync;
  const startedAt = now();

  while (true) {
    const token = crypto.randomBytes(8).toString('hex');
    const acquiredAt = new Date(now()).toISOString();
    const lockContent = {
      owner: owner,
      pid: process.pid,
      host: os.hostname(),
      acquiredAt: acquiredAt,
      token: token
    };

    let fd = null;
    let opened = false;

    try {
      fd = fs.openSync(lockPath, 'wx');
      opened = true;
      fs.writeFileSync(fd, JSON.stringify(lockContent), 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      return { lockPath: lockPath, token: token, owner: owner, acquiredAt: acquiredAt };
    } catch (err) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch (closeErr) {
          // 关闭失败不覆盖原始错误。
        }
        fd = null;
      }

      if (err && err.code === 'EEXIST') {
        // 已被占用：先尝试清理残留锁；只有 token 在两次读取间不变才删除。
        if (now() - startedAt > timeoutMs) {
          throw makeLockTimeoutError();
        }

        const staleResult = tryRemoveStaleLock(lockPath, { nowMs: now() });
        if (staleResult.removed) {
          // 残留锁已清理，立即重试抢锁。
          continue;
        }

        if (now() - startedAt > timeoutMs) {
          throw makeLockTimeoutError();
        }

        sleep(retryMs);
        continue;
      }

      // 非 EEXIST 的 fs 错误直接抛；如果本次已经创建了锁文件，尽量清理自己留下的半成品。
      if (opened) {
        try {
          fs.unlinkSync(lockPath);
        } catch (unlinkErr) {
          // 清理失败不覆盖原始错误。
        }
      }

      throw err;
    }
  }
}

function releaseTaskFileLock(handle) {
  const lockPath = handle && handle.lockPath;
  const token = handle && handle.token;

  const lock = readLockFile(lockPath);
  if (lock === null) {
    return { released: true, alreadyGone: true };
  }

  if (!lock || lock.parseError || typeof token !== 'string' || lock.token !== token) {
    return { released: false, reason: 'TOKEN_MISMATCH' };
  }

  try {
    fs.unlinkSync(lockPath);
    return { released: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { released: true, alreadyGone: true };
    }
    throw err;
  }
}

function withTaskFileLock(tasksDir, dateStr, options, fn) {
  const handle = acquireTaskFileLock(tasksDir, dateStr, options);
  try {
    return fn(handle);
  } finally {
    releaseTaskFileLock(handle);
  }
}

module.exports = {
  LOCK_STALE_AFTER_MS,
  LOCK_ACQUIRE_TIMEOUT_MS,
  LOCK_RETRY_INTERVAL_MS,
  getTaskLockPath,
  readLockFile,
  isLockStale,
  tryRemoveStaleLock,
  acquireTaskFileLock,
  releaseTaskFileLock,
  withTaskFileLock
};
