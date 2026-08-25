const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWriteFileSync } = require('../atomic-write');

test('atomicWriteFileSync replaces content and leaves no temporary file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-atomic-'));
  const file = path.join(dir, 'nested', 'tasks.json');
  try {
    atomicWriteFileSync(file, '{"version":1}', 'utf8');
    atomicWriteFileSync(file, '{"version":2}', 'utf8');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"version":2}');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['tasks.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
