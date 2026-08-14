'use strict';

const { ERROR_CODES } = require('./errors');

/**
 * 业务结果统一结构。业务层优先返回显式结果对象，编程错误才抛类型化异常。
 *
 * @typedef {Object} Result
 * @property {boolean} ok
 * @property {*} data 成功时的数据
 * @property {Object} effect 副作用描述（execute 结果）
 * @property {Object} error 失败时的错误
 */

/** 成功结果 */
function ok(data, effect = null) {
  return { ok: true, data, effect };
}

/**
 * 失败结果
 * @param {string} code 稳定错误码
 * @param {string} message 用户可见中文提示
 * @param {object} [details] 结构化详情
 */
function fail(code, message, details = null) {
  return { ok: false, error: { code, message, details } };
}

function failCode(code) {
  return fail(code, ERROR_CODES[code] || code);
}

module.exports = { ok, fail, failCode };
