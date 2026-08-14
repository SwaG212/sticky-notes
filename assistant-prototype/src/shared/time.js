'use strict';

const { AppError, ERROR_CODES } = require('./errors');

const SHANGHAI_OFFSET_MINUTES = 480; // Asia/Shanghai 固定 UTC+8，无夏令时

/** 当前时间 ISO 8601（UTC，存储统一用 UTC） */
function nowIso() {
  return new Date().toISOString();
}

/** 当前 Asia/Shanghai 时刻的"钟面 Date"（本地计算固定 +8 偏移；支持注入基准用于测试） */
function nowInShanghai(base = new Date()) {
  return new Date(base.getTime() + SHANGHAI_OFFSET_MINUTES * 60 * 1000);
}

/** 当天日期键 YYYY-MM-DD（Asia/Shanghai） */
function todayKey(base = new Date()) {
  return toDateKey(new Date(base.getTime() + SHANGHAI_OFFSET_MINUTES * 60 * 1000));
}

function toDateKey(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Date（UTC 时刻）→ Asia/Shanghai 钟面时间的 ISO 字符串（带 +08:00 偏移） */
function toShanghaiIso(d) {
  const shifted = new Date(d.getTime() + SHANGHAI_OFFSET_MINUTES * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  const h = String(shifted.getUTCHours()).padStart(2, '0');
  const min = String(shifted.getUTCMinutes()).padStart(2, '0');
  const s = String(shifted.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${day}T${h}:${min}:${s}.000+08:00`;
}

/**
 * 解析中文相对/模糊时间表达式为 Asia/Shanghai 绝对时间。
 * 支持：今天/明天/后天/大后天、周X/下周一、X点/下午X点/晚上X点/X:XX/X点XX分、
 *       X月X日、X分钟后/半小时后 等。不支持则返回 ok:false。
 *
 * @param {string} text 用户或 LLM 给的时间描述
 * @param {Date} [base] 基准时刻（默认上海时区现在），测试用
 * @returns {{ok: true, value: string}|{ok: false, reason: string}}
 */
function parseRelativeTime(text, base = new Date()) {
  if (typeof text !== 'string') return { ok: false, reason: 'NOT_A_STRING' };
  const raw = text.trim();
  if (!raw) return { ok: false, reason: 'EMPTY' };

  // 先尝试 ISO / RFC3339
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (isoMatch) {
    const [full, y, mo, d, hh, mm] = isoMatch;
    if (full.length === raw.length) {
      if (raw.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(raw)) {
        // 带时区的真实时刻
        const parsed = new Date(raw.replace(' ', 'T'));
        if (Number.isNaN(parsed.getTime())) return { ok: false, reason: 'BAD_ISO' };
        return { ok: true, value: toShanghaiIso(parsed) };
      }
      // 无时区：按上海钟面理解（文档要求显式 Asia/Shanghai，不依赖本机时区）
      return { ok: true, value: faceToIso(y, mo, d, hh, mm) };
    }
  }

  const sh = nowInShanghai(base); // 上海钟面基准
  const hourMin = pickTime(raw);
  const dayDelta = pickDayDelta(raw, base);
  if (dayDelta === null && hourMin === null) {
    return { ok: false, reason: 'UNRECOGNIZED' };
  }

  const face = new Date(sh); // 上海钟面
  if (dayDelta !== null) {
    face.setUTCDate(sh.getUTCDate() + dayDelta);
  }
  if (hourMin !== null) {
    face.setUTCHours(hourMin.h, hourMin.m, 0, 0);
  } else if (dayDelta !== null) {
    face.setUTCHours(9, 0, 0, 0); // 只说"明天"默认早上 9 点
  }
  // 钟面 → 真实时刻（钟面 - 8h）→ 再输出上海 ISO，等价于钟面 +08:00
  const moment = new Date(face.getTime() - SHANGHAI_OFFSET_MINUTES * 60 * 1000);
  return { ok: true, value: toShanghaiIso(moment) };
}

/** 上海钟面字段 → ISO 字符串（+08:00）。 */
function faceToIso(y, m, d, h, min) {
  const yy = String(y).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  const hh = String(h === undefined ? 9 : Number(h)).padStart(2, '0');
  const mi = String(min === undefined ? 0 : Number(min)).padStart(2, '0');
  return `${yy}-${mm}-${dd}T${hh}:${mi}:00.000+08:00`;
}

const WEEKDAYS = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };

/** 返回 { h, m } 或 null */
function pickTime(raw) {
  // 今晚X点 / 下午X点 / 晚上X点 / 中午X点 / 上午X点 / X点XX分 / X点半 / X:XX
  const isEvening = /今晚/.test(raw);
  let m = raw.match(/(下午|晚上|傍晚|中午|上午)?\s*(\d{1,2})\s*点\s*(半|(\d{1,2})\s*分)?/);
  if (m) {
    let h = Number(m[2]);
    const isPm = isEvening || m[1] === '下午' || m[1] === '晚上' || m[1] === '傍晚';
    const isNoon = m[1] === '中午';
    if (isPm && h < 12) h += 12;
    if (isNoon && h === 12) h = 12;
    if (h > 23) return null;
    const minute = m[3] === '半' ? 30 : m[4] ? Number(m[4]) : 0;
    return { h, m: minute };
  }
  // X:XX
  m = raw.match(/(\d{1,2}):(\d{2})/);
  if (m) {
    const h = Number(m[1]);
    const minute = Number(m[2]);
    if (h > 23 || minute > 59) return null;
    return { h, m: minute };
  }
  return null;
}

/** 返回天数偏移或 null；base 为真实时刻（默认现在） */
function pickDayDelta(raw, base) {
  if (/大后天/.test(raw)) return 3;
  if (/后天/.test(raw)) return 2;
  if (/明天/.test(raw)) return 1;
  if (/今天|今晚/.test(raw)) return 0;
  // X月X日（今年或明年）
  const md = raw.match(/(\d{1,2})月(\d{1,2})日/);
  if (md) {
    const sh = nowInShanghai(base);
    const month = Number(md[1]);
    const day = Number(md[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    let target = new Date(Date.UTC(sh.getUTCFullYear(), month - 1, day));
    if (target.getTime() < sh.getTime()) {
      target = new Date(Date.UTC(sh.getUTCFullYear() + 1, month - 1, day));
    }
    return Math.round((target.getTime() - sh.getTime()) / 86400000);
  }
  for (const [cn, dow] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`(下周|下礼拜)?周${cn}`).test(raw)) {
      const sh = nowInShanghai(base);
      const todayDow = sh.getUTCDay() || 7; // 0(日) → 7
      const isNextWeek = /下周|下礼拜/.test(raw);
      let delta;
      if (dow === todayDow) {
        delta = 7; // 今天就是星期 X → 未来第一个（下）周
      } else if (dow > todayDow) {
        delta = dow - todayDow; // 本周尚未到
        if (isNextWeek) delta += 7; // 显式"下周" → 推到下周
      } else {
        delta = 7 - todayDow + dow; // 本周已过 → 下一个（即下）周的星期 X
      }
      return delta;
    }
  }
  return null;
}

/**
 * 计算一个到期日到目标时间的天数差（Asia/Shanghai），用于提醒提前量校验。
 */
function daysBetweenShanghai(aIso, bIso) {
  const a = new Date(aIso);
  const b = new Date(bIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) {
    throw new AppError(ERROR_CODES.INVALID_ARGUMENT, '无效时间', { details: { aIso, bIso } });
  }
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

module.exports = {
  SHANGHAI_OFFSET_MINUTES,
  nowIso,
  nowInShanghai,
  todayKey,
  toDateKey,
  toShanghaiIso,
  parseRelativeTime,
  daysBetweenShanghai,
};
