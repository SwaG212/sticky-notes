'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseRelativeTime, todayKey, toShanghaiIso, nowInShanghai,
} = require('../../src/shared/time');

// 固定基准：2026-08-12 周三（Asia/Shanghai），本地 Date 用对应 UTC 时刻
const BASE = new Date('2026-08-11T16:30:00.000Z'); // = 上海 2026-08-12 00:30

function assertShanghai(iso, expect) {
  assert.equal(iso, expect);
}

test('解析"明天下午3点" → 次日 15:00 +08:00', () => {
  const r = parseRelativeTime('明天下午3点', BASE);
  assert.equal(r.ok, true);
  assertShanghai(r.value, '2026-08-13T15:00:00.000+08:00');
});

test('解析"后天上午9点半" → 09:30', () => {
  const r = parseRelativeTime('后天上午9点半', BASE);
  assert.equal(r.ok, true);
  assertShanghai(r.value, '2026-08-14T09:30:00.000+08:00');
});

test('解析"今晚8点" → 今天 20:00', () => {
  const r = parseRelativeTime('今晚8点', BASE);
  assert.equal(r.ok, true);
  assertShanghai(r.value, '2026-08-12T20:00:00.000+08:00');
});

test('解析"15:30" → 当天 15:30', () => {
  const r = parseRelativeTime('15:30', BASE);
  assert.equal(r.ok, true);
  assertShanghai(r.value, '2026-08-12T15:30:00.000+08:00');
});

test('解析"下周一" → 未来第一个周一加 7 天（基准周三）', () => {
  const r = parseRelativeTime('下周一', BASE);
  assert.equal(r.ok, true);
  // 2026-08-12 周三 → 下周一 = 08-17
  assertShanghai(r.value, '2026-08-17T09:00:00.000+08:00');
});

test('解析"周五" → 未来第一个周五（08-14）', () => {
  const r = parseRelativeTime('周五', BASE);
  assert.equal(r.ok, true);
  assertShanghai(r.value, '2026-08-14T09:00:00.000+08:00');
});

test('解析"8月15日" → 08-15 09:00', () => {
  const r = parseRelativeTime('8月15日', BASE);
  assert.equal(r.ok, true);
  assertShanghai(r.value, '2026-08-15T09:00:00.000+08:00');
});

test('只给日期默认早上 9 点', () => {
  const r = parseRelativeTime('明天', BASE);
  assert.equal(r.ok, true);
  assertShanghai(r.value, '2026-08-13T09:00:00.000+08:00');
});

test('ISO 输入原样保留（转为 +08:00 表示）', () => {
  const r = parseRelativeTime('2026-08-13T15:00:00', BASE);
  assert.equal(r.ok, true);
  assertShanghai(r.value, '2026-08-13T15:00:00.000+08:00');
});

test('无法识别的输入返回 ok:false', () => {
  for (const bad of ['', '随便什么时候', '尽快', 'abc', null, 42]) {
    const r = parseRelativeTime(bad, BASE);
    assert.equal(r.ok, false, `「${bad}」应解析失败`);
  }
});

test('todayKey 使用 Asia/Shanghai 日期', () => {
  // UTC 2026-08-11T16:30 = 上海 2026-08-12 00:30
  assert.equal(todayKey(new Date(BASE)), '2026-08-12');
});

test('toShanghaiIso 输出带 +08:00 偏移', () => {
  const d = new Date('2026-08-11T07:00:00.000Z');
  assertShanghai(toShanghaiIso(d), '2026-08-11T15:00:00.000+08:00');
});

test('nowInShanghai 与 UTC 相差 8 小时', () => {
  const sh = nowInShanghai();
  const diff = sh.getTime() - Date.now();
  assert.equal(diff, 8 * 3600 * 1000);
});
