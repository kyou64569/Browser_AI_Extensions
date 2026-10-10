// test/fallback.test.mjs
// FallbackManager 的思考相关行为回归测试：
// - 思考预算保护（正文迟迟不出、思考逼近 max_tokens 时主动断开流，且不降级、不记冷却）
// - 已开始出正文时绝不触发保护（不能误杀正常长回复）
// - 「正文被 max_tokens 截断」的文案必须带实测数字，并按思考风格给对的劝
// 桩的写法：ReadableStream 用 pull 惰性出帧——消费方停止读取后 pull 不再被调用，
// 于是「厂商侧实际出了多少帧」直接反映「流有没有被提前断开」。出帧数封顶后关闭，
// 保证保护逻辑一旦回归，测试是断言失败而不是无限挂住。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FallbackManager, isThinkingBudgetBlown, THINKING_GUARD_FLAG, THINKING_BUDGET_GUARD_RATIO,
} from '../core/fallback.js';

const enc = new TextEncoder();

const cardOf = (over = {}) => /** @type {any} */ ({
  id: 'fb' + Math.random().toString(36).slice(2, 8),
  vendor: 'openai', name: 'card', apiBase: 'https://sensenova-a.test/v1', apiKey: 'sk-x',
  model: 'sensenova-6.7-flash-lite', supportsVision: false,
  supportsStream: true, supportsThinking: true,
  timeoutMs: 0, thinkingStyle: 'auto', maxTokens: 1000, ...over,
});

/** 一直吐思考帧的响应（maxFrames 帧后收尾），并回报实际出帧数 */
function endlessThinkingResponse(maxFrames = 500, chunkChars = 40) {
  let sent = 0;
  const res = new Response(new ReadableStream({
    pull(c) {
      if (sent >= maxFrames) { c.enqueue(enc.encode('data: [DONE]\n')); c.close(); return; }
      c.enqueue(enc.encode(`data: {"choices":[{"delta":{"reasoning_content":"${'想'.repeat(chunkChars)}"}}]}\n`));
      sent++;
    },
  }), { status: 200 });
  return { res, frames: () => sent };
}

/** 少量思考帧 + finish_reason=length 后结束：走厂商截断分支，且刻意不触发我方保护 */
function truncatingResponse({ frames = 3, chunkChars = 30 } = {}) {
  const res = new Response(new ReadableStream({
    start(c) {
      for (let i = 0; i < frames; i++) c.enqueue(enc.encode(`data: {"choices":[{"delta":{"reasoning_content":"${'想'.repeat(chunkChars)}"}}]}\n`));
      c.enqueue(enc.encode('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n'));
      c.enqueue(enc.encode('data: [DONE]\n'));
      c.close();
    },
  }), { status: 200 });
  return { res, frames: () => frames };
}

/**
 * 用 fetch 桩跑一次 callStream。
 * options 按 features/chat.js 的真实做法构造：由「所选模型」的卡片算出，
 * 之后所有候选模型共用同一份 options（这正是降级时额度错位的来源）。
 * @param {any[]} candidates 模型卡
 * @param {() => {res: Response, frames: () => number}} makeRes 每次请求构造响应
 * @param {Record<string, any>} [options] 覆盖默认 options
 */
async function runStream(candidates, makeRes, options) {
  const orig = globalThis.fetch;
  let calls = 0;
  let firstUrl = '';
  let last = null;
  globalThis.fetch = async (url) => {
    calls++;
    if (!firstUrl) firstUrl = String(url);
    last = makeRes();
    return last.res;
  };
  const opts = options != null ? options
    : (candidates[0] && Number.isFinite(candidates[0].maxTokens) ? { maxTokens: candidates[0].maxTokens } : {});
  let err = null;
  let chunks = 0;
  try {
    for await (const c of new FallbackManager().callStream(candidates, { stream: true, messages: [{ role: 'user', content: 'hi' }], options: opts })) {
      chunks += c ? 1 : 0;
    }
  } catch (e) {
    err = e;
  } finally {
    globalThis.fetch = orig;
  }
  return { err, calls, firstUrl, frames: last ? last.frames() : -1, chunks };
}

test('isThinkingBudgetBlown: 按实际发出的 max_tokens 的 90% 阈值判定，未设额度时不启用', () => {
  const at = (n) => '想'.repeat(n);
  const edge = Math.ceil(1000 * THINKING_BUDGET_GUARD_RATIO);
  assert.equal(isThinkingBudgetBlown(1000, at(edge - 1)), false);
  assert.equal(isThinkingBudgetBlown(1000, at(edge)), true);
  // 未设置 / 非法额度：宁可多等，也不误杀正常回复
  assert.equal(isThinkingBudgetBlown(null, at(100000)), false);
  assert.equal(isThinkingBudgetBlown(0, at(100000)), false);
  assert.equal(isThinkingBudgetBlown(-5, at(100000)), false);
  assert.equal(isThinkingBudgetBlown(undefined, at(100000)), false);
  // 英文按 ~4 字符 = 1 估算 token 折算
  assert.equal(isThinkingBudgetBlown(100, 'a'.repeat(4 * 89)), false);
  assert.equal(isThinkingBudgetBlown(100, 'a'.repeat(4 * 90)), true);
});

test('思考预算保护：正文未出现而思考逼近额度时提前断开流，且不降级到备用模型', async () => {
  const primary = cardOf({ maxTokens: 300 });
  const backup = cardOf({ maxTokens: 300, model: 'qwen3-32b', apiBase: 'https://qwen-b.test/v1' });
  const { err, calls, firstUrl, frames } = await runStream([primary, backup], () => endlessThinkingResponse());
  assert.ok(err, '应当抛出错误');
  assert.equal(err[THINKING_GUARD_FLAG], true, '错误应带思考预算保护标记');
  assert.match(err.message, /已主动停止以免白烧额度/);
  assert.match(err.message, /估算 \d+ token/);
  assert.equal(calls, 1, '保护不是模型故障：不该再叫备用模型把第二份额度也烧掉');
  assert.match(firstUrl, /sensenova-a/);
  assert.ok(frames < 60, `思考流应被提前断开（实际出帧 ${frames}）`);
});

test('保护不记冷却：下一个请求仍先试这张卡，而不是跳过它', async () => {
  const primary = cardOf({ maxTokens: 200 });
  const backup = cardOf({ maxTokens: 200, apiBase: 'https://qwen-b.test/v1' });
  const pool = [primary, backup];
  // 若保护被当成模型故障记进 FAIL_LOG（10 分钟冷却），第二次跑就会跳过 primary 先打 backup
  const r1 = await runStream(pool, () => endlessThinkingResponse(300, 50));
  const r2 = await runStream(pool, () => endlessThinkingResponse(300, 50));
  assert.equal(r1.err[THINKING_GUARD_FLAG], true);
  assert.match(r2.firstUrl, /sensenova-a/, '第二次仍应先试原模型：思考预算问题不该让该模型进冷却');
});

test('已开始出正文时绝不触发保护（正常长回复不能被误杀）', async () => {
  const card = cardOf({ maxTokens: 120 });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(c) {
      c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"回答开头"}}]}\n'));
      for (let i = 0; i < 20; i++) c.enqueue(enc.encode(`data: {"choices":[{"delta":{"reasoning_content":"${'想'.repeat(40)}"}}]}\n`));
      c.enqueue(enc.encode('data: [DONE]\n'));
      c.close();
    },
  }), { status: 200 });
  let err = null;
  const deltas = [];
  try {
    for await (const c of new FallbackManager().callStream([card], { stream: true, messages: [] })) {
      if (c.delta) deltas.push(c.delta);
    }
  } catch (e) { err = e; } finally { globalThis.fetch = orig; }
  assert.equal(err, null, '正文已开始，后续思考再长也不该中断本轮');
  assert.deepEqual(deltas, ['回答开头']);
});

test('截断文案带实测数字，并按思考风格给对的劝（额度没用满 / 真吃满 / 未设额度）', async () => {
  // 3 帧 × 30 字 = 90 估算 token，且刻意低于保护阈值（0.9×maxTokens），确保走厂商截断分支
  const mk = () => truncatingResponse();

  // 风格不可调（SenseNova → none）+ 思考字数远不到申请的 8000
  const inert = (await runStream([cardOf({ maxTokens: 8000 })], mk)).err.message;
  assert.match(inert, /本次思考约 90 字 \/ 估算 90 token，请求 max_tokens=8000/);
  assert.match(inert, /思考字数远不到申请的 8000/);
  assert.match(inert, /继续调大数值不会有用/);
  assert.doesNotMatch(inert, /把思考强度调低一档/);   // 对这类模型这句是空头建议
  assert.match(inert, /题面条件互相冲突/);

  // 风格可调（Qwen3 → enable_thinking）且额度确实被顶满（90 token ≥ 0.8×110，且 < 0.9×110 不触发保护）
  const controllable = (await runStream([cardOf({ maxTokens: 110, model: 'qwen3-32b' })], mk)).err.message;
  assert.match(controllable, /思考确实把额度吃满了/);
  assert.match(controllable, /把思考强度调低一档/);

  // 未设置额度：撞的是厂商自己的上限
  const noCap = (await runStream([cardOf({ maxTokens: undefined })], mk)).err.message;
  assert.match(noCap, /请求 max_tokens=未设置（走厂商默认）/);
  assert.match(noCap, /请在模型卡填「最大输出 tokens」/);
});

test('保护阈值只认「本次实际发出的额度」：卡片填了但请求没带该字段时不启用', async () => {
  // options 显式为空 = 本次根本没发 max_tokens（真实调用里 options 由所选模型算出，
  // 备用卡自己的 maxTokens 并不会进请求体）。旧实现按 cfg.maxTokens 判会误杀。
  const r = await runStream([cardOf({ maxTokens: 300 })], () => endlessThinkingResponse(30, 40), {});
  assert.ok(r.err, '零正文仍要按空响应报错');
  assert.equal(r.err[THINKING_GUARD_FLAG], undefined, '没发额度就没有「逼近申请额度」这回事，不该走保护');
  assert.match(r.err.message, /模型只返回了思考、没有正文/);
});

test('Anthropic：截断判读用的是适配器实际发出的 max_tokens，且不再被误判为「强度不可调」', async () => {
  const card = cardOf({ vendor: 'anthropic', model: 'claude-3-7-sonnet', apiBase: 'https://claude-a.test/v1', maxTokens: 32768 });
  const res = () => ({
    res: new Response(new ReadableStream({
      start(c) {
        for (let i = 0; i < 3; i++) c.enqueue(enc.encode(`data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"${'想'.repeat(300)}"}}\n`));
        c.enqueue(enc.encode('data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n'));
        c.enqueue(enc.encode('data: {"type":"message_stop"}\n'));
        c.close();
      },
    }), { status: 200 }),
    frames: () => 3,
  });
  const msg = (await runStream([card], res)).err.message;
  // 3×300 = 900 估算 token，远低于 32768 → 走「没按申请值截」那一支；额度必须是卡片的 32768
  //（改前适配器把 max_tokens 静默压成 8192，文案却照卡片报 32768，两个数对不上）
  assert.match(msg, /请求 max_tokens=32768/);
  assert.doesNotMatch(msg, /思考强度不可调/, 'Anthropic 发原生 thinking budget，档位有差别，不能按 OpenAI 风格枚举判成不可调');
  assert.match(msg, /思考字数远不到申请的 32768/);
});
