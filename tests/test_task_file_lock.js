'use strict';

const lock = require('../task-file-lock');
const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');

let passed = 0;
let failed = 0;

function ok(condition, message) {
  if (condition) {
    passed++;
    console.log('  ✓ ' + message);
  } else {
    failed++;
    console.error('  ✗ ' + message);
  }
}

function equal(actual, expected, message) {
  ok(
    Object.is(actual, expected),
    message + '（实际：' + JSON.stringify(actual) + '，期望：' + JSON.stringify(expected) + '）'
  );
}

function assertThrows(fn, expectedMessage, message) {
  try {
    fn();
    failed++;
    console.error('  ✗ ' + message + '（未抛错）');
  } catch (err) {
    const msg = err && err.message;
    const code = err && err.code;
    const match = expectedMessage instanceof RegExp
      ? expectedMessage.test(String(msg)) || (code && expectedMessage.test(String(code)))
      : msg === expectedMessage || code === expectedMessage;

    if (match) {
      passed++;
      console.log('  ✓ ' + message);
    } else {
      failed++;
      console.error('  ✗ ' + message + '（实际抛出：' + (code ? code + ' / ' : '') + msg + '）');
    }
  }
}

function group(name) {
  console.log('\n[' + name + ']');
}

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
let dirIndex = 0;

function freshTasksDir(name) {
  const dir = path.join(rootDir, (++dirIndex) + '-' + name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  group('抢锁/释放往返');
  try {
    const tasksDir = freshTasksDir('roundtrip');
    const dateStr = '2026-11-11';
    const handle = lock.acquireTaskFileLock(tasksDir, dateStr, {
      owner: 'app',
      timeoutMs: 1000,
      retryMs: 20
    });

    ok(!!handle && !!handle.token, 'acquire 返回 token');
    ok(/^[0-9a-f]{16}$/.test(handle.token), 'token 是 16 位十六进制');
    ok(fs.existsSync(handle.lockPath), '锁文件存在');

    const lockData = lock.readLockFile(handle.lockPath);
    equal(lockData.owner, 'app', '锁内容 owner 正确');
    equal(lockData.token, handle.token, '锁内容 token 与 handle 一致');
    ok(
      typeof lockData.acquiredAt === 'string' && !Number.isNaN(Date.parse(lockData.acquiredAt)),
      '锁内容 acquiredAt 可解析'
    );

    const releaseResult = lock.releaseTaskFileLock(handle);
    equal(releaseResult.released, true, 'release 返回 released=true');
    ok(!fs.existsSync(handle.lockPath), 'release 后锁文件消失');
  } catch (err) {
    failed++;
    console.error('  ✗ 组异常：' + (err && err.stack || err));
  }

  group('同一日期二次抢锁超时');
  try {
    const tasksDir = freshTasksDir('timeout');
    const dateStr = '2026-11-11';
    const h1 = lock.acquireTaskFileLock(tasksDir, dateStr, {
      timeoutMs: 1000,
      retryMs: 20
    });

    assertThrows(
      () => lock.acquireTaskFileLock(tasksDir, dateStr, { timeoutMs: 300, retryMs: 50 }),
      'LOCK_TIMEOUT',
      '第二次 acquire 抛 LOCK_TIMEOUT'
    );

    lock.releaseTaskFileLock(h1);

    const h2 = lock.acquireTaskFileLock(tasksDir, dateStr, {
      timeoutMs: 1000,
      retryMs: 20
    });
    ok(!!h2 && !!h2.token, '释放第一把后能重新抢到');
    lock.releaseTaskFileLock(h2);
  } catch (err) {
    failed++;
    console.error('  ✗ 组异常：' + (err && err.stack || err));
  }

  group('残留锁清理');
  try {
    const tasksDir = freshTasksDir('stale');
    const dateStr = '2026-11-11';
    const lockPath = lock.getTaskLockPath(tasksDir, dateStr);
    const oldToken = '0123456789abcdef';
    const oldLock = {
      owner: 'muse',
      pid: 1234,
      host: 'old-host',
      acquiredAt: new Date(Date.now() - 60000).toISOString(),
      token: oldToken
    };
    fs.writeFileSync(lockPath, JSON.stringify(oldLock), 'utf8');

    const handle = lock.acquireTaskFileLock(tasksDir, dateStr, {
      timeoutMs: 2000,
      retryMs: 20
    });

    ok(handle.token !== oldToken, 'acquire 生成了新 token');
    const lockData = lock.readLockFile(lockPath);
    equal(lockData.token, handle.token, '锁文件 token 是新的');
    ok(fs.existsSync(lockPath), '新锁文件存在');

    lock.releaseTaskFileLock(handle);
    ok(!fs.existsSync(lockPath), '释放后锁文件消失');
  } catch (err) {
    failed++;
    console.error('  ✗ 组异常：' + (err && err.stack || err));
  }

  group('非残留锁不删');
  try {
    const tasksDir = freshTasksDir('notstale');
    const dateStr = '2026-11-11';
    const lockPath = lock.getTaskLockPath(tasksDir, dateStr);
    const oldLock = {
      owner: 'muse',
      pid: 1234,
      host: 'old-host',
      acquiredAt: new Date(Date.now() - 5000).toISOString(),
      token: 'aaaaaaaaaaaaaaaa'
    };
    fs.writeFileSync(lockPath, JSON.stringify(oldLock), 'utf8');

    const result = lock.tryRemoveStaleLock(lockPath, { nowMs: Date.now() });
    equal(result.removed, false, 'tryRemoveStaleLock 返回 removed=false');
    equal(result.reason, 'NOT_STALE', 'reason 为 NOT_STALE');
    ok(fs.existsSync(lockPath), '非残留锁文件仍在');
  } catch (err) {
    failed++;
    console.error('  ✗ 组异常：' + (err && err.stack || err));
  }

  group('释放 token 不一致不删除');
  try {
    const tasksDir = freshTasksDir('tokenmismatch');
    const dateStr = '2026-11-11';
    const handle = lock.acquireTaskFileLock(tasksDir, dateStr, {
      timeoutMs: 1000,
      retryMs: 20
    });

    const badHandle = { lockPath: handle.lockPath, token: 'ffffffffffffffff' };
    const badResult = lock.releaseTaskFileLock(badHandle);
    equal(badResult.released, false, '错误 token release 返回 released=false');
    equal(badResult.reason, 'TOKEN_MISMATCH', 'reason 为 TOKEN_MISMATCH');
    ok(fs.existsSync(handle.lockPath), '错误 token 不会删除锁文件');

    const goodResult = lock.releaseTaskFileLock(handle);
    equal(goodResult.released, true, '正确 token release 成功');
    ok(!fs.existsSync(handle.lockPath), '正确 token 释放后锁文件消失');
  } catch (err) {
    failed++;
    console.error('  ✗ 组异常：' + (err && err.stack || err));
  }

  group('异常也释放');
  try {
    const tasksDir = freshTasksDir('finally');
    const dateStr = '2026-11-11';
    const lockPath = lock.getTaskLockPath(tasksDir, dateStr);

    let propagated = false;
    try {
      lock.withTaskFileLock(tasksDir, dateStr, { timeoutMs: 1000, retryMs: 20 }, () => {
        throw new Error('BOOM');
      });
    } catch (err) {
      propagated = err && err.message === 'BOOM';
    }

    ok(propagated, 'fn 抛错继续向上传播');
    ok(!fs.existsSync(lockPath), 'fn 抛错后锁文件已释放');
  } catch (err) {
    failed++;
    console.error('  ✗ 组异常：' + (err && err.stack || err));
  }

  group('两方同时写不丢数据');
  try {
    const tasksDir = freshTasksDir('concurrent');
    const dateStr = '2026-11-11';
    const taskFile = path.join(tasksDir, dateStr + '.json');
    const lockPath = lock.getTaskLockPath(tasksDir, dateStr);
    const lockModulePath = path.resolve(__dirname, '..', 'task-file-lock.js');

    const script = [
      "const fs = require('fs');",
      "const path = require('path');",
      "const lock = require(process.argv[1]);",
      "const tasksDir = process.argv[2];",
      "const id = process.argv[3];",
      "const dateStr = '2026-11-11';",
      "const file = path.join(tasksDir, dateStr + '.json');",
      "lock.withTaskFileLock(tasksDir, dateStr, { timeoutMs: 5000, retryMs: 20 }, function () {",
      "  let tasks = [];",
      "  try {",
      "    const raw = fs.readFileSync(file, 'utf8');",
      "    tasks = JSON.parse(raw);",
      "    if (!Array.isArray(tasks)) tasks = [];",
      "  } catch (e) {",
      "    if (e.code !== 'ENOENT') throw e;",
      "    tasks = [];",
      "  }",
      "  tasks.push({ id: id });",
      "  const tmp = file + '.tmp.' + process.pid + '.' + Math.random().toString(16).slice(2);",
      "  fs.writeFileSync(tmp, JSON.stringify(tasks), 'utf8');",
      "  fs.renameSync(tmp, file);",
      "});"
    ].join('\n');

    function runChild(id) {
      return new Promise((resolve, reject) => {
        const child = child_process.spawn(
          process.execPath,
          ['-e', script, lockModulePath, tasksDir, id],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        );

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });

        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) {
            resolve({ id, stdout, stderr });
          } else {
            reject(
              new Error(
                '子进程 ' + id + ' 退出码 ' + code + '\nstdout: ' + stdout + '\nstderr: ' + stderr
              )
            );
          }
        });
      });
    }

    const results = await Promise.all([runChild('a'), runChild('b')]);
    ok(results.length === 2, '两个子进程都成功退出');
    ok(fs.existsSync(taskFile), '任务文件存在');

    const tasks = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
    ok(Array.isArray(tasks) && tasks.length === 2, '任务文件中有两条任务');

    const ids = tasks.map((item) => item && item.id).sort();
    equal(ids[0], 'a', '包含 id=a 的任务');
    equal(ids[1], 'b', '包含 id=b 的任务');
    ok(!fs.existsSync(lockPath), '并发写结束后锁文件已消失');
  } catch (err) {
    failed++;
    console.error('  ✗ 组异常：' + (err && err.stack || err));
  }

  group('dateStr 非法抛 INVALID_DATE');
  try {
    const tasksDir = freshTasksDir('invalid');
    assertThrows(
      () => lock.getTaskLockPath(tasksDir, '2026-1-1'),
      'INVALID_DATE',
      'getTaskLockPath 对非法 dateStr 抛 INVALID_DATE'
    );
    assertThrows(
      () => lock.acquireTaskFileLock(tasksDir, '2026/11/11', { timeoutMs: 10 }),
      'INVALID_DATE',
      'acquireTaskFileLock 对非法 dateStr 抛 INVALID_DATE'
    );
  } catch (err) {
    failed++;
    console.error('  ✗ 组异常：' + (err && err.stack || err));
  }
}

main()
  .then(() => {
    try {
      fs.rmSync(rootDir, { recursive: true, force: true });
    } catch (err) {
      console.error('清理临时目录失败：' + err.message);
    }

    console.log('\n通过 ' + passed + ' 失败 ' + failed);
    if (failed > 0) {
      process.exit(1);
    }
  })
  .catch((err) => {
    failed++;
    console.error('测试主流程异常：' + (err && err.stack || err));

    try {
      fs.rmSync(rootDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      // ignore
    }

    console.log('\n通过 ' + passed + ' 失败 ' + failed);
    process.exit(1);
  });
