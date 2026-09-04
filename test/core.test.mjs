// test/core.test.mjs
// 适配层工具类 / 限流 / 重试 / URL 处理的回归测试。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApiBase, hasCred, optionsFromModel, thinkingLevels } from '../shared/utils.js';
import { estimateTokens, splitSentences, chunkUnits, RateGate } from '../core/translate-rate.js';
import {
  isRateLimit, isTokenRateLimit, parseRetryAfterSec, backoffMs, withRateLimitRetry,
} from '../core/retry.js';
import { RETRY_TPM_BACKOFF_MS, RETRY_BASE_BACKOFF_MS } from '../shared/constants.js';

// ── normalizeApiBase ──────────────────────────────────────────────────────

test('normalizeApiBase: 去 BOM / 空白 / 尾部斜杠', () => {
  assert.equal(normalizeApiBase('\uFEFFhttps://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(normalizeApiBase('  https://api.example.com/v1  '), 'https://api.example.com/v1');
  assert.equal(normalizeApiBase('https://api.example.com/v1///'), 'https://api.example.com/v1');
});

test('normalizeApiBase: 去掉用户误填的已知子路径', () => {
  assert.equal(normalizeApiBase('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1');
  assert.equal(normalizeApiBase('https://api.example.com/v1/messages'), 'https://api.example.com/v1');
  assert.equal(normalizeApiBase('https://api.example.com/v1/models'), 'https://api.example.com/v1');
});

test('normalizeApiBase: 非字符串返回空串', () => {
  assert.equal(normalizeApiBase(null), '');
  assert.equal(normalizeApiBase(undefined), '');
  assert.equal(normalizeApiBase(123), '');
});

// ── hasCred / optionsFromModel ────────────────────────────────────────────

test('hasCred: ollama 免密钥，其余必须有 key', () => {
  assert.equal(hasCred({ vendor: 'ollama' }), true);
  assert.equal(hasCred({ vendor: 'openai', apiKey: 'sk-x' }), true);
  assert.equal(hasCred({ vendor: 'openai', apiKey: '   ' }), false);
  assert.equal(hasCred({ vendor: 'openai' }), false);
});

test('optionsFromModel: 只透传合法数值', () => {
  assert.deepEqual(optionsFromModel({ temperature: 0.5, top_p: 0.9, maxTokens: 100 }),
    { temperature: 0.5, top_p: 0.9, maxTokens: 100 });
  assert.deepEqual(optionsFromModel({}), {});
  assert.deepEqual(optionsFromModel(/** @type {any} */ ({ temperature: 'hot' })), {});
});

test('optionsFromModel: reasoning_effort 仅对显式支持的厂商发送', () => {
  // OpenAI 兼容厂商未声明支持 → 不发（否则普通模型 HTTP 400）
  assert.equal(optionsFromModel({ vendor: 'openai', supportsThinking: true, thinkingStrength: 'low' }).thinkingStrength, undefined);
  // 声明支持 → 发
  assert.equal(optionsFromModel({ vendor: 'openai', supportsThinking: true, thinkingStrength: 'low', reasoningEffortSupported: true }).thinkingStrength, 'low');
  // Anthropic 走 thinking budget，不需要 reasoningEffortSupported
  assert.equal(optionsFromModel({ vendor: 'anthropic', supportsThinking: true, thinkingStrength: 'high' }).thinkingStrength, 'high');
  // 'off' 一律不发
  assert.equal(optionsFromModel({ vendor: 'anthropic', supportsThinking: true, thinkingStrength: 'off' }).thinkingStrength, undefined);
});

test('thinkingLevels: anthropic 展示预算档位，其余展示通用档位', () => {
  assert.ok(thinkingLevels('anthropic').some(l => l.label.includes('2K')));
  assert.ok(!thinkingLevels('openai').some(l => l.label.includes('2K')));
  assert.equal(thinkingLevels('openai')[0].value, 'off');
});

// ── 分块与分句 ────────────────────────────────────────────────────────────

test('estimateTokens: 空串为 0，随长度增长', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('a'.repeat(1000)) > estimateTokens('a'.repeat(100)));
});

test('splitSentences: 中英文句末都能切分', () => {
  const en = splitSentences('Hello world. This is a test! Another one?');
  assert.ok(en.length >= 3, '英文应切成多句，实际：' + JSON.stringify(en));
  const zh = splitSentences('第一句。第二句！第三句？');
  assert.ok(zh.length >= 3, '中文应切成多句，实际：' + JSON.stringify(zh));
});

test('splitSentences: 小数点不切分（审查修复回归：3.5 不再碎成两句）', () => {
  const parts = splitSentences('Pi is 3.5 times. Next one');
  assert.equal(parts.length, 2, '小数点不应成为切分点，实际：' + JSON.stringify(parts));
  const joined = parts.map(p => p.text + p.sep).join('');
  assert.ok(joined.includes('3.5 times'), '小数必须完整保留，实际：' + joined);
  assert.equal(splitSentences('value 0.5')[0].text, 'value 0.5');
});

test('splitSentences: 空输入返回空数组', () => {
  assert.deepEqual(splitSentences(''), []);
});

test('chunkUnits: 按预算分块，且不丢任何原文项', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ i, t: `这是第 ${i} 段测试文本，内容略微长一些以便累积 token。` }));
  const chunks = chunkUnits(items, 200);
  assert.ok(chunks.length > 1, '应分成多批，实际 ' + chunks.length + ' 批');
  // 每个原文项的每一句都必须出现在某个批里，且 itemIndex/partIndex 唯一
  const seen = new Set();
  for (const chunk of chunks) {
    let tok = 0;
    for (const u of chunk) {
      seen.add(u.itemIndex + ':' + u.partIndex);
      tok += u.tok;
    }
    // 单个超长单元允许独占一批并略超预算，但不允许无谓地堆爆
    assert.ok(tok <= 200 + 400, '单批 token 过高：' + tok);
  }
  assert.ok(seen.size >= items.length, `单元数(${seen.size})不应少于原文项数(${items.length})`);
  for (let i = 0; i < items.length; i++) {
    assert.ok([...seen].some(k => k.startsWith(i + ':')), '丢失原文项 ' + i);
  }
});

test('chunkUnits: 空输入返回空数组', () => {
  assert.deepEqual(chunkUnits([], 100), []);
});

// ── RateGate ──────────────────────────────────────────────────────────────

test('RateGate: RPM 超额时 reserve 返回等待时长', async () => {
  // 窗口刻意设短（300ms）：用真实的 60s 窗口时，第三次预约要等满一个窗口才放行，
  // 单测会直接卡 60 秒。限流判定逻辑与窗口长度无关，缩短窗口不影响覆盖。
  const gate = new RateGate({ tpm: Infinity, rpm: 2, windowMs: 300 });
  assert.equal(await gate.reserve(1), 0);
  assert.equal(await gate.reserve(1), 0);
  const waited = await gate.reserve(1); // 第 3 次超出 rpm=2
  assert.ok(waited > 100, '第三次应被限流等待，实际等待 ' + waited + 'ms');
});

test('RateGate: 单次请求量远超 TPM 也不死锁（直接放行）', async () => {
  const gate = new RateGate({ tpm: 10, rpm: Infinity });
  const waited = await gate.reserve(1e9); // 无论如何都等不到额度
  assert.equal(waited, 0, '超大单请求应直接放行，否则翻译会永久挂起');
});

test('RateGate: 未配置配额时不限流', async () => {
  const gate = new RateGate({});
  for (let i = 0; i < 5; i++) assert.equal(await gate.reserve(1000), 0);
});

test('RateGate: onTokenRateLimit 自适应下调且有下限', () => {
  const gate = new RateGate({ tpm: 10000, rpm: 60 });
  gate.tokenLog.push({ t: Date.now(), n: 4000 }); // 窗口内已用 4000
  gate.onTokenRateLimit();
  assert.ok(gate.tpm < 10000, 'TPM 应被下调，实际 ' + gate.tpm);
  assert.ok(gate.tpm >= gate._floor, '不应低于自适应下限（会被压死）');
});

test('RateGate: stats 反映窗口用量', async () => {
  const gate = new RateGate({ tpm: 100000, rpm: 60 });
  await gate.reserve(100);
  await gate.reserve(200);
  const st = gate.stats();
  assert.equal(st.usedTokens, 300);
  assert.equal(st.usedRequests, 2);
  assert.equal(st.tpm, 100000);
});

// ── 429 退避重试 ──────────────────────────────────────────────────────────

test('isRateLimit: 识别常见限流文案', () => {
  assert.ok(isRateLimit(new Error('HTTP 429')));
  assert.ok(isRateLimit(new Error('rate limit exceeded')));
  assert.ok(isRateLimit(new Error('Too Many Requests')));
  assert.ok(isRateLimit(new Error('quota exceeded')));
  assert.ok(!isRateLimit(new Error('HTTP 500')));
  assert.ok(!isRateLimit(new Error('invalid api key')));
});

test('isTokenRateLimit: 区分 TPM 与 RPM', () => {
  assert.ok(isTokenRateLimit(new Error('TPM limit reached')));
  assert.ok(isTokenRateLimit(new Error('tokens per minute exceeded')));
  assert.ok(!isTokenRateLimit(new Error('HTTP 429 rate limit')));
});

test('parseRetryAfterSec: 解析服务端 retry-after', () => {
  assert.equal(parseRetryAfterSec(new Error('retry-after: 30')), 30);
  assert.equal(parseRetryAfterSec(new Error('please try again in 12s')), 12);
  assert.equal(parseRetryAfterSec(new Error('429')), null);
});

test('backoffMs: TPM 走长退避，RPM 走指数退避', () => {
  assert.equal(backoffMs(new Error('TPM limit'), 0), RETRY_TPM_BACKOFF_MS);
  assert.equal(backoffMs(new Error('rate limit'), 0), RETRY_BASE_BACKOFF_MS);
  assert.equal(backoffMs(new Error('rate limit'), 2), RETRY_BASE_BACKOFF_MS * 3);
  // 服务端给了 retry-after 就听它的
  assert.equal(backoffMs(new Error('TPM limit retry-after: 5'), 0), 5000);
});

/** 构造一个"前 n 次抛指定错误、之后成功"的异步生成器工厂 */
function flaky(errors, chunks) {
  let attempt = 0;
  return function run() {
    const i = attempt++;
    return (async function* () {
      if (i < errors.length) throw errors[i];
      for (const d of chunks) yield { delta: d };
    })();
  };
}

test('withRateLimitRetry: 限流错误会重试并最终成功', async () => {
  // retry-after: 0 —— 这里验证的是"是否会重试"，退避时长本身由 backoffMs 用例覆盖
  const run = flaky([new Error('HTTP 429 rate limit retry-after: 0'), new Error('HTTP 429 rate limit retry-after: 0')], ['a', 'b']);
  const out = await withRateLimitRetry(run, { maxRounds: 3 });
  assert.equal(out, 'ab');
});

test('withRateLimitRetry: 非限流错误立即抛出，不重试', async () => {
  let calls = 0;
  const run = () => { calls++; return (async function* () { throw new Error('invalid api key'); })(); };
  await assert.rejects(() => withRateLimitRetry(run, { maxRounds: 3 }), /invalid api key/);
  assert.equal(calls, 1, '非限流错误不应重试');
});

test('withRateLimitRetry: 重试轮数用尽后抛出最后一次错误', async () => {
  const run = flaky(
    [new Error('HTTP 429 retry-after: 0'), new Error('HTTP 429 retry-after: 0'), new Error('HTTP 429 retry-after: 0')],
    ['never']
  );
  await assert.rejects(() => withRateLimitRetry(run, { maxRounds: 3 }), /429/);
});

test('withRateLimitRetry: onDelta 收到累计文本而非增量', async () => {
  const seen = [];
  const run = () => (async function* () { yield { delta: 'a' }; yield { delta: 'b' }; yield { delta: 'c' }; })();
  await withRateLimitRetry(run, { onDelta: (acc) => seen.push(acc) });
  assert.deepEqual(seen, ['a', 'ab', 'abc']);
});

test('withRateLimitRetry: 重试不会重复累积上一次的半成品输出', async () => {
  // 第一次产出 'ab' 后被限流打断，第二次完整产出 'xyz'；结果必须是 'xyz'
  let attempt = 0;
  const run = () => {
    const i = attempt++;
    return (async function* () {
      if (i === 0) { yield { delta: 'a' }; yield { delta: 'b' }; throw new Error('HTTP 429 retry-after: 0'); }
      yield { delta: 'x' }; yield { delta: 'y' }; yield { delta: 'z' };
    })();
  };
  const out = await withRateLimitRetry(run, { maxRounds: 3 });
  assert.equal(out, 'xyz');
});
