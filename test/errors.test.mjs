// test/errors.test.mjs
// 错误分类与文案映射的回归测试。
// 分类靠"HTTP 状态码 + 消息文本正则"，文本匹配很容易互相踩（例如
// "缺少有效凭证" 同时含 "凭证" 与 "API Key" 两类关键词），改动时必须有测试兜底。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, describeError, formatErrorLine, ERROR_KIND } from '../shared/errors.js';

/** 构造一个 HttpError 形态的错误（core/http.js 的实际结构） */
function httpError(status, message, kind) {
  const e = /** @type {any} */ (new Error(message));
  e.name = 'HttpError';
  e.status = status;
  if (kind) e.kind = kind;
  return e;
}

// ── 结构化信息优先 ────────────────────────────────────────────────────────

test('classifyError: HttpError 的 kind 优先于文本', () => {
  assert.equal(classifyError(httpError(0, 'anything', 'auth')), ERROR_KIND.AUTH);
  assert.equal(classifyError(httpError(0, 'anything', 'rate_limit')), ERROR_KIND.RATE_LIMIT);
  assert.equal(classifyError(httpError(0, 'anything', 'timeout')), ERROR_KIND.TIMEOUT);
  assert.equal(classifyError(httpError(0, 'anything', 'network')), ERROR_KIND.NETWORK);
});

test('classifyError: 状态码映射到对应类别', () => {
  assert.equal(classifyError(httpError(401, 'HTTP 401: unauthorized')), ERROR_KIND.AUTH);
  assert.equal(classifyError(httpError(403, 'HTTP 403: forbidden')), ERROR_KIND.AUTH);
  assert.equal(classifyError(httpError(429, 'HTTP 429: too many requests')), ERROR_KIND.RATE_LIMIT);
  assert.equal(classifyError(httpError(500, 'HTTP 500')), ERROR_KIND.SERVER);
  assert.equal(classifyError(httpError(503, 'HTTP 503')), ERROR_KIND.SERVER);
  assert.equal(classifyError(httpError(400, 'HTTP 400')), ERROR_KIND.BAD_REQUEST);
});

// ── 无结构化信息时按文本匹配 ──────────────────────────────────────────────

test('classifyError: 纯 Error 按消息文本分类', () => {
  assert.equal(classifyError(new Error('请求超时（>60000ms）')), ERROR_KIND.TIMEOUT);
  assert.equal(classifyError(new Error('Failed to fetch')), ERROR_KIND.NETWORK);
  assert.equal(classifyError(new Error('Rate limit exceeded for TPM')), ERROR_KIND.RATE_LIMIT);
  assert.equal(classifyError(new Error('Bad gateway')), ERROR_KIND.SERVER);
});

test('classifyError: 业务错误"缺少凭证"归入 credential 而非 auth', () => {
  // 这两类关键词重叠（都含 Key），顺序错了会把"没填密钥"报成"密钥无效"，误导用户
  const e = new Error('翻译模型缺少有效凭证（API Key）');
  assert.equal(classifyError(e), ERROR_KIND.CREDENTIAL);
});

test('classifyError: 无法归类时返回 unknown', () => {
  assert.equal(classifyError(new Error('PPT 没有幻灯片内容')), ERROR_KIND.UNKNOWN);
  assert.equal(classifyError(null), ERROR_KIND.UNKNOWN);
  assert.equal(classifyError(undefined), ERROR_KIND.UNKNOWN);
  assert.equal(classifyError('字符串错误'), ERROR_KIND.UNKNOWN);
});

// ── describeError ─────────────────────────────────────────────────────────

test('describeError: 429 给出可读文案，原始响应体进 detail', () => {
  const raw = 'HTTP 429: {"error":{"message":"Rate limit exceeded for TPM"}}';
  const d = describeError(httpError(429, raw));
  assert.equal(d.kind, ERROR_KIND.RATE_LIMIT);
  assert.ok(d.title.includes('过于频繁'), '主文案应说清限流：' + d.title);
  assert.ok(!d.title.includes('{'), '主文案不应含原始 JSON');
  assert.equal(d.detail, raw, '原始消息必须保留在 detail 供排障');
  assert.equal(d.status, 429);
});

test('describeError: 401/403 提示检查密钥', () => {
  const d = describeError(httpError(401, 'HTTP 401: invalid api key'));
  assert.ok(d.title.includes('API Key'), d.title);
  assert.ok(d.hint.includes('设置'), '应给出可操作建议：' + d.hint);
});

test('describeError: 超时提示调大超时时间', () => {
  const d = describeError(new Error('请求超时（>60000ms）'));
  assert.ok(d.title.includes('超时'));
  assert.ok(d.hint.length > 0);
});

test('describeError: 无法归类时直接展示原始消息（业务错误本身就是人话）', () => {
  const d = describeError(new Error('PPT 没有幻灯片内容'));
  assert.equal(d.kind, ERROR_KIND.UNKNOWN);
  assert.equal(d.title, 'PPT 没有幻灯片内容');
  assert.equal(d.detail, '', '无额外技术细节时不应显示空折叠区');
});

test('describeError: 空错误用兜底文案', () => {
  const d = describeError(null, { fallbackTitle: '操作失败' });
  assert.equal(d.title, '操作失败');
});

test('describeError: 字符串错误也能处理', () => {
  assert.equal(describeError('Failed to fetch').kind, ERROR_KIND.NETWORK);
});

// ── formatErrorLine ───────────────────────────────────────────────────────

test('formatErrorLine: 单行版本不含换行，且截断过长细节', () => {
  const raw = 'HTTP 429: ' + 'x'.repeat(200);
  const line = formatErrorLine(httpError(429, raw));
  assert.ok(!line.includes('\n'));
  assert.ok(line.length < 120, '单行文案不应失控：' + line.length);
  assert.ok(line.includes('…'), '超长细节应截断');
});

test('formatErrorLine: detailMax=0 时只给主文案', () => {
  const line = formatErrorLine(httpError(429, 'HTTP 429: x'), 0);
  assert.equal(line, describeError(httpError(429, 'HTTP 429: x')).title);
});

test('formatErrorLine: 无细节的业务错误原样返回', () => {
  assert.equal(formatErrorLine(new Error('PPT 没有幻灯片内容')), 'PPT 没有幻灯片内容');
});
