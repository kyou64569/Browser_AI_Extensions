// test/adapters-thinking.test.mjs
// 四个适配器思考流（reasoning_content / reasoning / thinking_delta / part.thought / message.thinking）
// 的回归测试：伪造 global fetch 返回 SSE/NDJSON 流，断言思考增量与正文增量分路产出、
// 请求体按 thinkingStyle × 强度携带正确的思考参数。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIAdapter, effectiveTimeoutMs, willProduceThinking } from '../core/adapters/openai.js';
import { AnthropicAdapter } from '../core/adapters/anthropic.js';
import { GeminiAdapter, geminiThinkingMode, geminiThinkingConfig } from '../core/adapters/gemini.js';
import { OllamaAdapter } from '../core/adapters/ollama.js';

// ── fetch 桩 ─────────────────────────────────────────────────────────────

const enc = new TextEncoder();

/** 用一组字符串帧构造 SSE/NDJSON 响应（自动补换行） */
function sseResponse(frames) {
  const stream = new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f + '\n'));
      c.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** JSON 响应（非流式） */
function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), { status: 200 });
}

/**
 * 替换 global fetch 跑一次 fn，返回 [结果, 捕获的请求]。
 * @returns {Promise<[any, {url:string, init:any, body:any}]>}
 */
async function withFetchStub(fn, responder) {
  const orig = globalThis.fetch;
  /** @type {{url:string, init:any, body:any}} */
  const captured = { url: '', init: null, body: null };
  globalThis.fetch = async (url, init) => {
    captured.url = url;
    captured.init = init;
    captured.body = JSON.parse(init.body);
    return responder();
  };
  try {
    return [await fn(), captured];
  } finally {
    globalThis.fetch = orig;
  }
}

/** 收集异步生成器的全部产出 */
async function collect(gen) {
  const out = [];
  for await (const c of gen) out.push(c);
  return out;
}

/** @type {Array<import('../core/message.js').Message>} */
const MESSAGES = [{ role: 'user', content: '你好' }];
const req = (options, stream = true) => ({ messages: MESSAGES, stream, options });

/** 测试只关心 thinking 相关字段，其余 ModelConfig 字段不参与断言，统一放宽为 any */
const cfgOf = (o) => /** @type {any} */ (o);

// ── OpenAI 兼容：reasoning_content / reasoning ───────────────────────────

test('openai 流式: reasoning_content 增量与正文增量分路产出（DeepSeek-R1 自动识别为不发参数）', async () => {
  const cfg = cfgOf({ vendor: 'openai', model: 'deepseek-ai/DeepSeek-R1', apiBase: 'https://api.x.com/v1', apiKey: 'k', supportsStream: true, timeoutMs: 0 });
  const adapter = new OpenAIAdapter(cfg);
  const [chunks, cap] = await withFetchStub(
    () => collect(adapter.chat(req({ thinkingStrength: 'medium' }))),
    () => sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"让我"}}]}',
      'data: {"choices":[{"delta":{"reasoning_content":"想想"}}]}',
      'data: {"choices":[{"delta":{"content":"答"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ]),
  );
  assert.deepEqual(chunks, [
    { delta: '', thinking: '让我', done: false },
    { delta: '', thinking: '想想', done: false },
    { delta: '答', done: false, meta: { raw: { choices: [{ delta: { content: '答' } }] } } },
    { delta: '', done: true, finishReason: 'stop' },
  ]);
  // DeepSeek-R1 自动识别为 none：即使开了思考强度也不发任何思考参数
  assert.equal(cap.body.reasoning_effort, undefined);
  assert.equal(cap.body.enable_thinking, undefined);
});

test('openai 流式: OpenRouter 的 delta.reasoning 也能识别为思考增量', async () => {
  const cfg = cfgOf({ vendor: 'openai', model: 'foo/bar', apiBase: 'https://openrouter.ai/api/v1', apiKey: 'k', supportsStream: true, timeoutMs: 0, thinkingStyle: 'openrouter' });
  const adapter = new OpenAIAdapter(cfg);
  const [chunks, cap] = await withFetchStub(
    () => collect(adapter.chat(req({ thinkingStrength: 'high' }))),
    () => sseResponse([
      'data: {"choices":[{"delta":{"reasoning":"planning..."}}]}',
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      'data: [DONE]',
    ]),
  );
  assert.equal(chunks[0].thinking, 'planning...');
  assert.equal(chunks[1].delta, 'hi');
  assert.deepEqual(cap.body.reasoning, { effort: 'high' });
});

test('openai 请求体: thinkingStyle=glm / qwen / auto(识别 glm) 各自携带正确参数', async () => {
  const base = cfgOf({ vendor: 'openai', apiBase: 'https://api.x.com/v1', apiKey: 'k', supportsStream: true, timeoutMs: 0 });
  const bodyOf = async (cfg, options) => {
    const [, cap] = await withFetchStub(
      () => collect(new OpenAIAdapter(cfg).chat(req(options))),
      () => sseResponse(['data: [DONE]']),
    );
    return cap.body;
  };

  const glmOn = await bodyOf({ ...base, model: 'any', thinkingStyle: 'glm' }, { thinkingStrength: 'low' });
  assert.deepEqual(glmOn.thinking, { type: 'enabled' });
  const glmOff = await bodyOf({ ...base, model: 'any', thinkingStyle: 'glm' }, { thinkingStrength: 'off' });
  assert.deepEqual(glmOff.thinking, { type: 'disabled' });
  const qwen = await bodyOf({ ...base, model: 'any', thinkingStyle: 'qwen' }, { thinkingStrength: 'high' });
  assert.equal(qwen.enable_thinking, true);
  assert.equal(qwen.thinking_budget, 16384);
  // auto 按模型名识别：glm-4.5 → thinking 参数
  const autoGlm = await bodyOf({ ...base, model: 'zhipuai/glm-4.5', thinkingStyle: 'auto' }, { thinkingStrength: 'low' });
  assert.deepEqual(autoGlm.thinking, { type: 'enabled' });
  // 未开启思考（无强度）：任何风格都不发参数
  const idle = await bodyOf({ ...base, model: 'o3', thinkingStyle: 'openai' }, {});
  assert.equal('reasoning_effort' in idle, false);
  // o3 自动识别为 reasoning_effort
  const o3 = await bodyOf({ ...base, model: 'o3', thinkingStyle: 'auto' }, { thinkingStrength: 'low' });
  assert.equal(o3.reasoning_effort, 'low');
});

test('openai 非流式: message.reasoning_content 作为思考增量在正文前产出', async () => {
  const cfg = cfgOf({ vendor: 'openai', model: 'deepseek-reasoner', apiBase: 'https://api.x.com/v1', apiKey: 'k', supportsStream: true, timeoutMs: 0 });
  const adapter = new OpenAIAdapter(cfg);
  const [chunks] = await withFetchStub(
    () => collect(adapter.chat(req({ thinkingStrength: 'low' }, false))),
    () => jsonResponse({ choices: [{ message: { role: 'assistant', content: '答案', reasoning_content: '思考全文' } }] }),
  );
  assert.deepEqual(chunks, [
    { delta: '', thinking: '思考全文', done: false },
    { delta: '答案', done: true, meta: { raw: { choices: [{ message: { role: 'assistant', content: '答案', reasoning_content: '思考全文' } }] } } },
  ]);
});

// ── Anthropic：thinking_delta ────────────────────────────────────────────

test('anthropic 流式: thinking_delta 与 text 分路产出，请求携带 thinking budget', async () => {
  const cfg = cfgOf({ vendor: 'anthropic', model: 'claude-3-7-sonnet', apiBase: 'https://api.anthropic.com/v1', apiKey: 'k', supportsStream: true, timeoutMs: 0 });
  const adapter = new AnthropicAdapter(cfg);
  const [chunks, cap] = await withFetchStub(
    () => collect(adapter.chat(req({ thinkingStrength: 'low' }))),
    () => sseResponse([
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"推演"}}',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"结论"}}',
      'event: message_stop',
      'data: {"type":"message_stop"}',
    ]),
  );
  assert.deepEqual(chunks, [
    { delta: '', thinking: '推演', done: false },
    { delta: '结论', done: false, meta: { raw: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '结论' } } } },
    { delta: '', done: true },
  ]);
  // signature_delta 被忽略（没有产出空 delta 帧）
  assert.equal(chunks.length, 3);
  assert.deepEqual(cap.body.thinking, { type: 'enabled', budget_tokens: 2000 });
});

test('anthropic 非流式: thinking 内容块单独产出', async () => {
  const cfg = cfgOf({ vendor: 'anthropic', model: 'claude-3-7-sonnet', apiBase: 'https://api.anthropic.com/v1', apiKey: 'k', supportsStream: true, timeoutMs: 0 });
  const adapter = new AnthropicAdapter(cfg);
  const [chunks] = await withFetchStub(
    () => collect(adapter.chat(req({ thinkingStrength: 'medium' }, false))),
    () => jsonResponse({ content: [{ type: 'thinking', thinking: '想' }, { type: 'text', text: '答' }] }),
  );
  assert.equal(chunks[0].thinking, '想');
  assert.equal(chunks[1].delta, '答');
  assert.equal(chunks[1].done, true);
});

// ── Gemini：part.thought ─────────────────────────────────────────────────

test('gemini 流式: thought 片段与正文分离，请求开启 includeThoughts', async () => {
  const cfg = cfgOf({ vendor: 'gemini', model: 'gemini-2.5-flash', apiBase: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'k', supportsStream: true, timeoutMs: 0 });
  const adapter = new GeminiAdapter(cfg);
  const [chunks, cap] = await withFetchStub(
    () => collect(adapter.chat(req({ thinkingStrength: 'medium' }))),
    () => sseResponse([
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '思考摘要', thought: true }] } }] }),
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '正式回答' }] } }] }),
    ]),
  );
  assert.deepEqual(chunks, [
    { delta: '', thinking: '思考摘要', done: false },
    { delta: '正式回答', done: false, meta: { raw: { candidates: [{ content: { parts: [{ text: '正式回答' }] } }] } } },
    { delta: '', done: true },
  ]);
  assert.deepEqual(cap.body.generationConfig.thinkingConfig, { thinkingBudget: 4096, includeThoughts: true });
});

// Gemini 思考参数的代际差异：thinkingBudget 随 2.5 引入，3 及以后官方推荐 thinkingLevel
test('gemini 3.x: 发 thinkingLevel（minimal/low/medium/high）且不再发 thinkingBudget', async () => {
  for (const [strength, level] of [['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['minimal', 'minimal']]) {
    const cfg = cfgOf({ vendor: 'gemini', model: 'gemini-3.1-flash', apiBase: 'https://x/v1beta', apiKey: 'k', supportsStream: true, timeoutMs: 0 });
    const [, cap] = await withFetchStub(
      () => collect(new GeminiAdapter(cfg).chat(req({ thinkingStrength: strength }))),
      () => sseResponse([JSON.stringify({ candidates: [{ content: { parts: [{ text: '好' }] } }] })]),
    );
    assert.deepEqual(cap.body.generationConfig.thinkingConfig, { thinkingLevel: level, includeThoughts: true }, `档位 ${strength}`);
    assert.equal('thinkingBudget' in (cap.body.generationConfig.thinkingConfig || {}), false, '3.x 不该再带 2.5 的 budget');
  }
});

test('gemini 3.x 非流式路径同样发 thinkingLevel（两条路径必须一致）', async () => {
  const cfg = cfgOf({ vendor: 'gemini', model: 'gemini-3.5-pro', apiBase: 'https://x/v1beta', apiKey: 'k', supportsStream: true, timeoutMs: 0 });
  const [, cap] = await withFetchStub(
    () => collect(new GeminiAdapter(cfg).chat(req({ thinkingStrength: 'medium' }, false))),
    () => jsonResponse({ candidates: [{ content: { parts: [{ text: '好' }] } }] }),
  );
  assert.deepEqual(cap.body.generationConfig.thinkingConfig, { thinkingLevel: 'medium', includeThoughts: true });
});

test('gemini 2.5 保持 thinkingBudget，各种模型名写法都能判代际', async () => {
  const cases = [
    ['gemini-2.5-pro', 'budget'], ['google/gemini-2.5-flash-lite', 'budget'],
    ['models/gemini2.5', 'budget'], ['gemini-3-5-flash', 'level'], ['GEMINI-3.1-Pro', 'level'],
    ['some-gpt-model', 'budget'],      // 认不出 → 按 2.5 的 budget（两代都接受，不会 400）
    ['', 'budget'],
  ];
  for (const [model, want] of cases) {
    assert.equal(geminiThinkingMode(model), want, model);
  }
  const cfg = cfgOf({ vendor: 'gemini', model: 'gemini-2.5-flash', apiBase: 'https://x/v1beta', apiKey: 'k', supportsStream: true, timeoutMs: 0 });
  const [, cap] = await withFetchStub(
    () => collect(new GeminiAdapter(cfg).chat(req({ thinkingStrength: 'high' }))),
    () => sseResponse([JSON.stringify({ candidates: [{ content: { parts: [{ text: '好' }] } }] })]),
  );
  assert.deepEqual(cap.body.generationConfig.thinkingConfig, { thinkingBudget: 12288, includeThoughts: true });
});

test('gemini 档位认不出时不发 thinkingConfig（旧实现会退化成 thinkingBudget:0 = 关掉思考）', async () => {
  const cfg = cfgOf({ vendor: 'gemini', model: 'gemini-3.1-flash', apiBase: 'https://x/v1beta', apiKey: 'k', supportsStream: true, timeoutMs: 0 });
  const [, cap] = await withFetchStub(
    () => collect(new GeminiAdapter(cfg).chat(req({ thinkingStrength: 'ultra' }))),
    () => sseResponse([JSON.stringify({ candidates: [{ content: { parts: [{ text: '好' }] } }] })]),
  );
  assert.equal('thinkingConfig' in (cap.body.generationConfig || {}), false, JSON.stringify(cap.body.generationConfig));
  // 2.5 也一样：不认识的值就整个不发
  assert.equal(geminiThinkingConfig('gemini-2.5-flash', 'ultra'), null);
  // 未启用 / 用厂商默认 → 不发
  assert.equal(geminiThinkingConfig('gemini-2.5-flash', undefined), null);
});

test('gemini 关闭与默认档位不发任何思考参数', async () => {
  for (const strength of ['off', 'default']) {
    const cfg = cfgOf({ vendor: 'gemini', model: 'gemini-3.1-flash', apiBase: 'https://x/v1beta', apiKey: 'k', supportsStream: true, timeoutMs: 0 });
    const [, cap] = await withFetchStub(
      () => collect(new GeminiAdapter(cfg).chat(req({ thinkingStrength: strength }))),
      () => sseResponse([JSON.stringify({ candidates: [{ content: { parts: [{ text: '好' }] } }] })]),
    );
    assert.equal('thinkingConfig' in (cap.body.generationConfig || {}), false, `strength=${strength}`);
  }
});

// ── Ollama：message.thinking + think 参数 ────────────────────────────────

test('ollama 流式: message.thinking 分路产出，请求体携带 think:true', async () => {
  const cfg = cfgOf({ vendor: 'ollama', model: 'qwen3:8b', apiBase: '', apiKey: '', supportsStream: true, timeoutMs: 0 });
  const adapter = new OllamaAdapter(cfg);
  const [chunks, cap] = await withFetchStub(
    () => collect(adapter.chat(req({ thinkingStrength: 'low' }))),
    () => sseResponse([
      '{"message":{"thinking":"想一下"}}',
      '{"message":{"content":"答"},"done":false}',
      '{"done":true}',
    ]),
  );
  assert.deepEqual(chunks, [
    { delta: '', thinking: '想一下', done: false },
    { delta: '答', done: false, meta: { raw: { message: { content: '答' }, done: false } } },
    { delta: '', done: true },
  ]);
  assert.equal(cap.body.think, true);
});

test('ollama: 聊天页选「关闭」时显式发 think:false，未启用思考时不发', async () => {
  const cfg = cfgOf({ vendor: 'ollama', model: 'qwen3:8b', apiBase: '', apiKey: '', supportsStream: true, timeoutMs: 0 });
  const adapter = new OllamaAdapter(cfg);
  const [, capOff] = await withFetchStub(
    () => collect(adapter.chat(req({ thinkingStrength: 'off' }))),
    () => sseResponse(['{"done":true}']),
  );
  assert.equal(capOff.body.think, false);
  const [, capNone] = await withFetchStub(
    () => collect(adapter.chat(req({}))),
    () => sseResponse(['{"done":true}']),
  );
  assert.equal('think' in capNone.body, false);
});

test('「默认」档：各适配器都不发任何思考参数（含 glm/qwen 的显式禁用参数）', async () => {
  // auto 识别 glm-4.5 → glm 风格，但 default 档连 thinking:{type:...} 也不发
  const openai = new OpenAIAdapter(cfgOf({ vendor: 'openai', model: 'zhipuai/glm-4.5', apiBase: 'https://api.x.com/v1', apiKey: 'k', supportsStream: true, timeoutMs: 0 }));
  const [, capOpenai] = await withFetchStub(
    () => collect(openai.chat(req({ thinkingStrength: 'default' }))),
    () => sseResponse(['data: [DONE]']),
  );
  assert.equal('thinking' in capOpenai.body, false);
  assert.equal('reasoning_effort' in capOpenai.body, false);

  const ollama = new OllamaAdapter(cfgOf({ vendor: 'ollama', model: 'qwen3:8b', apiBase: '', apiKey: '', supportsStream: true, timeoutMs: 0 }));
  const [, capOllama] = await withFetchStub(
    () => collect(ollama.chat(req({ thinkingStrength: 'default' }))),
    () => sseResponse(['{"done":true}']),
  );
  assert.equal('think' in capOllama.body, false);
});

test('effectiveTimeoutMs: 会产出思考的调用自动抬升超时下限（缓冲型网关在思考结束前不回响应头）', () => {
  assert.equal(effectiveTimeoutMs(60000, true), 300000);
  assert.equal(effectiveTimeoutMs(400000, true), 400000);   // 配置更大时保留配置
  assert.equal(effectiveTimeoutMs(60000, false), 60000);    // 不思考 → 按配置值
  assert.equal(effectiveTimeoutMs(60000, undefined), 60000);
  assert.equal(effectiveTimeoutMs(0, true), 0);             // 0 = 显式永不超时
});

test('willProduceThinking: 没发思考参数 ≠ 不思考（SenseNova/R1 等默认思考模型也要拿到超时缓冲）', () => {
  // 旧判据只看「发没发出思考参数」，这类模型参数恒为空 → 只给模型卡 2 分钟 → 思考稍长就报「请求超时」
  assert.equal(willProduceThinking({ supportsThinking: true }, {}), true);
  assert.equal(willProduceThinking({ supportsThinking: true }, undefined), true);
  assert.equal(willProduceThinking({ supportsThinking: false }, { reasoning_effort: 'high' }), true);
  assert.equal(willProduceThinking({ supportsThinking: false }, {}), false);   // 不思考的普通模型
  assert.equal(willProduceThinking({}, {}), false);
});

test('finishReason 透传：各适配器把结束原因带到最终 chunk（截断判定依据）', async () => {
  // openai 流式：末帧 finish_reason=length（思考占满额度的典型形态）
  const oa = new OpenAIAdapter(cfgOf({ vendor: 'openai', model: 'm', apiBase: 'https://x/v1', apiKey: 'k', supportsStream: true, timeoutMs: 0 }));
  const [oc] = await withFetchStub(
    () => collect(oa.chat(req({ thinkingStrength: 'low' }))),
    () => sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
      'data: [DONE]',
    ]),
  );
  assert.equal(oc.at(-1).finishReason, 'length');
  assert.equal(oc.at(-1).delta, '');

  // openai 非流式
  const oa2 = new OpenAIAdapter(cfgOf({ vendor: 'openai', model: 'm', apiBase: 'https://x/v1', apiKey: 'k', supportsStream: true, timeoutMs: 0 }));
  const [oc2] = await withFetchStub(
    () => collect(oa2.chat(req({}, false))),
    () => jsonResponse({ choices: [{ message: { content: 'a' }, finish_reason: 'length' }] }),
  );
  assert.equal(oc2.at(-1).finishReason, 'length');

  // anthropic：message_delta 的 stop_reason
  const an = new AnthropicAdapter(cfgOf({ vendor: 'anthropic', model: 'c', apiBase: 'https://x/v1', apiKey: 'k', supportsStream: true, timeoutMs: 0 }));
  const [ac] = await withFetchStub(
    () => collect(an.chat(req({}))),
    () => sseResponse([
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}',
      'data: {"type":"message_stop"}',
    ]),
  );
  assert.equal(ac.at(-1).finishReason, 'max_tokens');

  // gemini：candidate.finishReason
  const ge = new GeminiAdapter(cfgOf({ vendor: 'gemini', model: 'g', apiBase: 'https://x', apiKey: 'k', supportsStream: true, timeoutMs: 0 }));
  const [gc] = await withFetchStub(
    () => collect(ge.chat(req({}))),
    () => sseResponse([JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'MAX_TOKENS' }] })]),
  );
  assert.equal(gc.at(-1).finishReason, 'MAX_TOKENS');

  // ollama：done_reason
  const ol = new OllamaAdapter(cfgOf({ vendor: 'ollama', model: 'q', apiBase: '', apiKey: '', supportsStream: true, timeoutMs: 0 }));
  const [lc] = await withFetchStub(
    () => collect(ol.chat(req({}))),
    () => sseResponse(['{"message":{"content":"hi"},"done":false}', '{"done":true,"done_reason":"length"}']),
  );
  assert.equal(lc.at(-1).finishReason, 'length');
});

// ── outputCap：判读额度必须等于实际发出的额度 ──────────────────────────

test('outputCap: 默认取本次请求带出的 max_tokens，没带就是 null（走厂商默认）', () => {
  const a = new OpenAIAdapter(cfgOf({ vendor: 'openai', model: 'gpt-4o', apiBase: 'https://x.test/v1', apiKey: 'k' }));
  assert.equal(a.outputCap(req({ maxTokens: 4096 })), 4096);
  assert.equal(a.outputCap(req({})), null);
  assert.equal(a.outputCap(req({ maxTokens: 0 })), null);
  assert.equal(a.outputCap({ messages: MESSAGES }), null);
});

test('anthropic 开思考按模型卡走：max_tokens 不再被静默压成 8192，且 outputCap 与实际发出的一致', async () => {
  const cfg = cfgOf({ vendor: 'anthropic', model: 'claude-3-7-sonnet', apiBase: 'https://api.anthropic.com/v1', apiKey: 'k', supportsStream: true, timeoutMs: 0 });
  const adapter = new AnthropicAdapter(cfg);
  const r = req({ maxTokens: 32768, thinkingStrength: 'medium' });
  const [, cap] = await withFetchStub(() => collect(adapter.chat(r)), () => sseResponse(['data: {"type":"message_stop"}']));
  assert.deepEqual(cap.body.thinking, { type: 'enabled', budget_tokens: 7168 });
  assert.equal(cap.body.max_tokens, 32768,
    '用户填的额度必须如实发出，否则「正文被 max_tokens 截断（请求 max_tokens=…）」的判读就是假数字');
  assert.equal(adapter.outputCap(r), cap.body.max_tokens, '判读用的额度必须与实际发出的同一个数');
  // 非流式路径同样按卡片走（两条路径不能一个封顶一个不封）
  const [c2, cap2] = await withFetchStub(
    () => collect(adapter.chat(req({ maxTokens: 32768, thinkingStrength: 'medium' }, false))),
    () => jsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
  );
  assert.equal(cap2.body.max_tokens, 32768);
  assert.equal(c2.at(-1).delta, 'ok');
});

test('anthropic 模型卡留空：按 budget+1024 的合法性下限发（留空≠不封顶，厂商要求 max_tokens 必填）', async () => {
  const cfg = cfgOf({ vendor: 'anthropic', model: 'claude-3-7-sonnet', apiBase: 'https://api.anthropic.com/v1', apiKey: 'k', supportsStream: true, timeoutMs: 0 });
  const adapter = new AnthropicAdapter(cfg);
  const mid = req({ thinkingStrength: 'medium' });
  const [, c1] = await withFetchStub(() => collect(adapter.chat(mid)), () => sseResponse(['data: {"type":"message_stop"}']));
  assert.equal(c1.body.max_tokens, 8192);
  assert.equal(adapter.outputCap(mid), 8192);

  const low = req({ thinkingStrength: 'low' });
  const [, c2] = await withFetchStub(() => collect(adapter.chat(low)), () => sseResponse(['data: {"type":"message_stop"}']));
  assert.equal(c2.body.max_tokens, 3024);   // budget 2000 + 1024

  const off = req({});
  const [, c3] = await withFetchStub(() => collect(adapter.chat(off)), () => sseResponse(['data: {"type":"message_stop"}']));
  assert.equal(c3.body.max_tokens, 1024);   // 不开思考时的默认值
});
