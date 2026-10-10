// @ts-nocheck
// test/collab.test.mjs
// 多模型协作的回归测试：
// - onSubModel 事件契约：start / progress / done / empty / error（含耗时、思考、返回、失败原因、成因）
// - 子模型并发但有上限（勾满模型时不能一次打出 N 个并发长请求）
// - 整合提示里的子模型顺序必须等于勾选顺序，不随完成先后漂移
// - 子模型走流式只为回报进度；视觉回灌仍是非流式
// - 用户中止原样上抛，不再发主模型整合请求
// （ts-nocheck：文件里的 globalThis.chrome / fetch 桩无法实现完整 chrome.* 类型面，
//   与被测代码的类型检查在其它文件里照旧进行——与 usage-flush.test.mjs 同一处理。）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatStream, COLLAB_MAX_CONCURRENCY } from '../features/chat.js';

const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const card = (over = {}) => /** @type {any} */ ({
  id: 'c' + Math.random().toString(36).slice(2, 7),
  vendor: 'openai', name: 'm', apiBase: 'https://x.test/v1', apiKey: 'sk-x',
  model: 'gpt-4o-mini', supportsVision: false, supportsStream: true,
  timeoutMs: 0, enabled: true, isPrimary: false, ...over,
});

const SYNTHESIS_MARK = '以下是多个模型对该问题的独立回答';

/**
 * fetch 桩：流式请求返回 SSE（先思考帧再逐字正文帧），非流式返回 JSON。
 * 主模型（整合请求）与子模型返回不同文本，避免断言被同一个字符串同时满足。
 * 记录每次请求体与「同时在途数」，用于断言并发上限与流式开关。
 * @param {{failModels?:string[], delayMs?:number, subThink?:string, subText?:string, primaryText?:string}} [opt]
 */
function makeStub(opt = {}) {
  const {
    failModels = [], delayMs = 12, subThink = '子模型想了这些', subText = '子模型的答案',
    primaryText = '整合后的最佳答案',
  } = opt;
  const calls = [];
  let active = 0;
  let maxActive = 0;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const isSynthesis = JSON.stringify(body.messages).includes(SYNTHESIS_MARK);
    calls.push({ url: String(url), body, stream: !!body.stream, isSynthesis });
    active++; maxActive = Math.max(maxActive, active);
    try {
      await sleep(delayMs);
      if (init.signal && init.signal.aborted) throw new Error('aborted');
      if (failModels.includes(body.model)) throw new Error('boom 上游炸了');
      if (body.stream) {
        const out = isSynthesis ? primaryText : subText;
        const frames = [
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: isSynthesis ? '主模型整合思考' : subThink }, finish_reason: null }] })}`,
          ...[...out].map((ch) => `data: ${JSON.stringify({ choices: [{ delta: { content: ch }, finish_reason: null }] })}`),
          'data: [DONE]',
        ];
        return new Response(new ReadableStream({ start(c) { for (const f of frames) c.enqueue(enc.encode(f + '\n')); c.close(); } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { reasoning_content: subThink, content: subText }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } finally {
      active--;
    }
  };
  return { calls, maxActive: () => maxActive, restore: () => { globalThis.fetch = origFetch; } };
}
const origFetch = globalThis.fetch;

async function collect(gen) {
  const out = [];
  for await (const c of gen) out.push(c);
  return out;
}

test('协作：每个子模型都有 start 与终态事件，终态带思考/返回/耗时', async () => {
  const primary = card({ name: '主模型', isPrimary: true });
  const s1 = card({ name: '子A', model: 'sub-a' });
  const s2 = card({ name: '子B', model: 'sub-b' });
  const stub = makeStub();
  try {
    const events = [];
    const chunks = await collect(chatStream({ models: [primary, s1, s2] }, [{ role: 'user', content: '问题' }], {
      mode: 'collab', selectedId: primary.id, thinkingStrength: 'medium',
      onSubModel: (e) => events.push(e),
    }));

    for (const idx of [0, 1]) {
      assert.ok(events.some((e) => e.index === idx && e.phase === 'start'), `缺少 index=${idx} 的 start`);
      const done = events.find((e) => e.index === idx && e.phase === 'done');
      assert.ok(done, `缺少 index=${idx} 的 done`);
      assert.equal(done.total, 2);
      assert.equal(done.thinking, '子模型想了这些');
      assert.equal(done.text, '子模型的答案');
      assert.ok(Number.isFinite(done.ms) && done.ms >= 0);
    }
    // 主模型整合的请求是最后一个，且只发一次
    const synthesisCalls = stub.calls.filter((c) => c.isSynthesis);
    assert.equal(synthesisCalls.length, 1);
    assert.equal(stub.calls[stub.calls.length - 1], synthesisCalls[0]);
    // UI 收到的正文只来自主模型（子模型的文本不应混进回复流），思考也是主模型那份
    assert.equal(chunks.map((c) => c.delta || '').join(''), '整合后的最佳答案');
    assert.equal(chunks.filter((c) => c.thinking).map((c) => c.thinking).join(''), '主模型整合思考');
    assert.ok(chunks.every((c) => c.model === '主模型'));
  } finally { stub.restore(); }
});

test('协作：整合提示里的子模型顺序等于勾选顺序（并发完成先后不影响它）', async () => {
  const primary = card({ name: '主模型', isPrimary: true, model: 'primary-m' });
  // 故意让第 1 个子模型慢得多：若按完成顺序 push，它就会被排到最后
  const slow = card({ name: '慢子', model: 'slow-sub' });
  const fast = card({ name: '_fast', model: 'fast-sub' });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const isPrimaryCall = JSON.stringify(body.messages).includes(SYNTHESIS_MARK);
    if (!isPrimaryCall) await sleep(body.model === 'slow-sub' ? 60 : 5);
    if (body.stream) {
      const frames = [isPrimaryCall
        ? 'data: {"choices":[{"delta":{"content":"终"}}]}\ndata: [DONE]'
        : 'data: {"choices":[{"delta":{"content":"X"}}]}\ndata: [DONE}'];
      return new Response(new ReadableStream({ start(c) { for (const f of frames) c.enqueue(enc.encode(f + '\n')); c.close(); } }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Y' } }] }), { status: 200 });
  };
  try {
    await collect(chatStream({ models: [primary, slow, fast] }, [{ role: 'user', content: 'q' }], { mode: 'collab' }));
    const synth = calls.find((b) => JSON.stringify(b.messages).includes(SYNTHESIS_MARK));
    const content = synth.messages[synth.messages.length - 1].content;
    assert.ok(content.indexOf('【子模型 1：慢子】') < content.indexOf('【子模型 2：_fast】'), '顺序应为勾选顺序：' + content);
  } finally { globalThis.fetch = origFetch; }
});

test('协作：并发有上限，且确实并发（>1 路同时在途）', async () => {
  const primary = card({ name: '主模型', isPrimary: true, model: 'primary-m' });
  const subs = Array.from({ length: COLLAB_MAX_CONCURRENCY + 2 }, (_, i) => card({ name: '子' + i, model: 'sub-' + i }));
  const stub = makeStub({ delayMs: 25 });
  try {
    await collect(chatStream({ models: [primary, ...subs] }, [{ role: 'user', content: 'q' }], { mode: 'collab' }));
    const subCallCount = stub.calls.filter((c) => !JSON.stringify(c.body.messages).includes(SYNTHESIS_MARK)).length;
    assert.equal(subCallCount, subs.length);
    assert.ok(stub.maxActive() > 1, `应观察到并发（实测峰值 ${stub.maxActive()}）`);
    assert.ok(stub.maxActive() <= COLLAB_MAX_CONCURRENCY, `并发峰值不应超过 ${COLLAB_MAX_CONCURRENCY}（实测 ${stub.maxActive()}）`);
  } finally { stub.restore(); }
});

test('协作：有 onSubModel 时子模型走流式并回报 progress，增量拼起来等于终态全文', async () => {
  const primary = card({ name: '主模型', isPrimary: true, model: 'primary-m' });
  const sub = card({ name: '子A', model: 'sub-a' });
  const stub = makeStub({ subText: '答案一二三' });
  try {
    const events = [];
    await collect(chatStream({ models: [primary, sub] }, [{ role: 'user', content: 'q' }], {
      mode: 'collab', onSubModel: (e) => events.push(e),
    }));
    assert.equal(stub.calls[0].stream, true, '子模型应走流式以回报进度');
    assert.equal(stub.calls[0].isSynthesis, false);
    const progress = events.filter((e) => e.phase === 'progress');
    assert.ok(progress.length > 0, '应有 progress 事件');
    const joinThink = progress.map((e) => e.thinkingDelta || '').join('');
    const joinText = progress.map((e) => e.textDelta || '').join('');
    const done = events.find((e) => e.phase === 'done');
    assert.equal(joinThink, done.thinking);
    assert.equal(joinText, done.text);
    assert.equal(done.text, '答案一二三');
  } finally { stub.restore(); }
});

test('协作：视觉回灌仍是非流式（没有 onProgress 就不该改请求形态）', async () => {
  const chatModel = card({ name: '聊天模型', model: 'chat-m' });
  const vision = card({ name: '视觉模型', model: 'vis-m', supportsVision: true });
  const stub = makeStub({ subText: '图里是一只猫', subThink: '看图想了这些' });
  try {
    await collect(chatStream({ models: [chatModel, vision] }, [
      { role: 'user', content: '这是什么动物', attachments: [{ type: 'image', data: 'data:image/png;base64,AAA' }] },
    ], { mode: 'single', selectedId: chatModel.id }));
    const visionCall = stub.calls[0];
    assert.equal(visionCall.stream, false, '视觉识别保持非流式');
    const sent = JSON.stringify(stub.calls[stub.calls.length - 1].body.messages);
    assert.match(sent, /图里是一只猫/);
    assert.doesNotMatch(sent, /\[object Object\]/);
  } finally { stub.restore(); }
});

test('协作：子模型失败上报 error，失败说明仍进整合提示，其余子模型照常参与', async () => {
  const primary = card({ name: '主模型', isPrimary: true, model: 'primary-m' });
  const ok = card({ name: '子A', model: 'sub-ok' });
  const bad = card({ name: '子B', model: 'sub-bad' });
  const stub = makeStub({ failModels: ['sub-bad'] });
  try {
    const events = [];
    await collect(chatStream({ models: [primary, ok, bad] }, [{ role: 'user', content: 'q' }], {
      mode: 'collab', onSubModel: (e) => events.push(e),
    }));
    const err = events.find((e) => e.phase === 'error');
    assert.equal(err.name, '子B');
    assert.match(err.error, /boom 上游炸了/);
    assert.ok(events.some((e) => e.name === '子A' && e.phase === 'done'), '其余子模型不受影响');
    // 终态事件不带 text（失败没有正文），但整合提示里仍有失败说明
    // （http 层会在错误后追加「（请求地址：…）」，所以只分别断言两处片段）
    const synth = stub.calls.find((c) => c.isSynthesis);
    const synthText = JSON.stringify(synth.body.messages);
    assert.match(synthText, /\[模型 子B 调用失败：/);
    assert.match(synthText, /boom 上游炸了/);
  } finally { stub.restore(); }
});

test('协作：用户中止原样上抛，且不再发主模型整合请求', async () => {
  const primary = card({ name: '主模型', isPrimary: true, model: 'primary-m' });
  const subs = [card({ name: '子A', model: 'sub-a' }), card({ name: '子B', model: 'sub-b' })];
  const ctrl = new AbortController();
  ctrl.abort();                                  // 已中止：任何一次调用都应立刻抛
  const stub = makeStub();
  let err = null;
  try {
    await collect(chatStream({ models: [primary, ...subs] }, [{ role: 'user', content: 'q' }], {
      mode: 'collab', signal: ctrl.signal,
    }));
  } catch (e) { err = e; } finally { stub.restore(); }
  assert.ok(err, '中止必须抛出，而不是静默整合');
  assert.ok(!stub.calls.some((c) => JSON.stringify(c.body.messages).includes(SYNTHESIS_MARK)), '中止后不该再烧一次整合调用');
});

test('网页总结协作：summarizeStream 把 onSubModel 透传给 chatStream（子模型状态不再静默）', async () => {
  const { summarizeStream } = await import('../features/summarize.js');
  const primary = card({ name: '主模型', model: 'primary-m', isPrimary: true });
  const sub = card({ name: '子A', model: 'sub-a' });
  const stub = makeStub();
  try {
    const events = [];
    await collect(summarizeStream(
      { models: [primary, sub] },
      { title: '某网页', text: '正文内容'.repeat(30) },
      { mode: 'collab', thinkingStrength: 'medium', onSubModel: (e) => events.push(e) },
    ));
    assert.ok(events.some((e) => e.phase === 'start' && e.name === '子A'), '应有子模型 start');
    assert.ok(events.some((e) => e.phase === 'done' && e.name === '子A'), '应有子模型 done');
    assert.ok(stub.calls.some((c) => c.isSynthesis), '主模型整合请求应发出');
  } finally { stub.restore(); }
});

test('网页总结协作：不传 onSubModel 时行为不变（字幕总结等调用方不受影响）', async () => {
  const { summarizeStream } = await import('../features/summarize.js');
  const primary = card({ name: '主模型', model: 'primary-m', isPrimary: true });
  const sub = card({ name: '子A', model: 'sub-a' });
  const stub = makeStub();
  try {
    const chunks = await collect(summarizeStream(
      { models: [primary, sub] },
      { title: 't', text: 'x'.repeat(200) },
      { mode: 'collab' },
    ));
    assert.ok(chunks.some((c) => c.delta), '仍应产出正文');
  } finally { stub.restore(); }
});

// ── 子模型「跑完但没正文」的判读 / 保护 / 用量 ───────────────────────────

test('协作：子模型零正文时报 empty 而不是「完成」，整合提示写明未产出', async () => {
  const primary = card({ name: '主模型', model: 'primary-m', isPrimary: true });
  const subA = card({ name: '子A', model: 'sub-a' });
  const stub = makeStub({ subText: '' });     // 只回思考帧，一帧正文都没有
  try {
    const events = [];
    await collect(chatStream({ models: [primary, subA] }, [{ role: 'user', content: '无解的题' }],
      { mode: 'collab', onSubModel: (e) => events.push(e) }));
    const done = events.find((e) => e.phase !== 'start' && e.phase !== 'progress');
    assert.equal(done.phase, 'empty', '零正文不能报「done」——芯片会显示成「完成 · 559.8s」骗人');
    assert.match(done.reason, /只有思考、没有正文/);
    assert.match(done.reason, /已思考 \d+ 字/, '成因里要带思考字数，这是判断额度够不够的依据');
    assert.ok(done.thinking.length > 0, '思考全文仍要回报，用户点开能看到它想到哪一步');
    const synth = stub.calls.find((c) => c.isSynthesis);
    const sent = JSON.stringify(synth.body.messages);
    assert.match(sent, /只有思考、没有正文/, '主模型必须知道这一票是弃权，而不是看见一格空白');
  } finally { stub.restore(); }
});

test('协作：子模型也吃思考预算保护，正文没出就逼近额度时提前断开', async () => {
  const primary = card({ name: '主模型', model: 'primary-m', isPrimary: true });
  // maxTokens=4 → 阈值 3.6 估算 token，默认那帧思考（7 字）就已越线；
  // 桩里后面还排着正文帧，一旦保护生效就读不到它们。
  const subA = card({ name: '子A', model: 'sub-a', maxTokens: 4 });
  const stub = makeStub();
  try {
    const events = [];
    await collect(chatStream({ models: [primary, subA] }, [{ role: 'user', content: 'hi' }],
      { mode: 'collab', onSubModel: (e) => events.push(e) }));
    const fin = events.find((e) => e.phase === 'empty');
    assert.ok(fin, '应报 empty');
    assert.match(fin.reason, /已提前停止/, '要区分「我方止损」与「厂商截断」，用户的动作不一样');
    assert.equal(fin.text, '', '保护生效后不该再读到后续正文帧');
    assert.equal(fin.thinking.length > 0, true);
    const synth = stub.calls.find((c) => c.isSynthesis);
    assert.match(JSON.stringify(synth.body.messages), /思考占满输出额度，已提前停止/);
  } finally { stub.restore(); }
});

test('协作：子模型与整合调用的消耗都进用量记录（含思考，kind=collab）', async () => {
  // 用量走「缓冲 + 兜底定时器」落盘（FLUSH_INTERVAL_MS=4000），所以这里等它自己 flush，
  // 不手工 flushUsage：本文件前面的用例已经把 _lastFlush 推进了节流窗口，手工调用会被推迟。
  const stored = new Map();
  globalThis.chrome = {
    runtime: { lastError: null },
    storage: { local: {
      get: (k, cb) => cb({ [k]: stored.get(k) }),
      set: (obj, cb) => { for (const [k, v] of Object.entries(obj)) stored.set(k, v); if (cb) cb(); },
    } },
  };
  // 模型名取本用例独有，避免与同文件其它用例的记录混在一起
  const primary = card({ name: '用量-主模型', model: 'primary-m', isPrimary: true });
  const subA = card({ name: '用量-子A', model: 'sub-a' });
  const subB = card({ name: '用量-子B', model: 'sub-b' });
  const stub = makeStub();
  try {
    await collect(chatStream({ models: [primary, subA, subB] }, [{ role: 'user', content: 'hi' }], { mode: 'collab' }));
    // 落盘走「缓冲 + 兜底定时器」，而本文件前面的用例已经把 _lastFlush 推进了节流窗口，
    // 命中窗口时 flushUsage 会再排一次定时器——所以轮询等它写出来，而不是干等一个固定时长。
    const t0 = Date.now();
    while (!stored.get('usageLog') && Date.now() - t0 < 12000) await new Promise((r) => setTimeout(r, 200));
    const log = stored.get('usageLog') || [];
    const collab = log.filter((e) => String(e.model).startsWith('用量-'));
    assert.equal(collab.length, 3, `两路子模型 + 一次整合调用都该记上，实际 ${JSON.stringify(log.map((e) => e.model))}`);
    assert.deepEqual(collab.map((e) => e.model).sort(), ['用量-主模型', '用量-子A', '用量-子B']);
    assert.ok(collab.every((e) => e.kind === 'collab'), 'kind 要能区分出这是协作的消耗');
    assert.ok(collab.every((e) => e.outTok > 0), '输出 token 要含思考文本');
    assert.ok(collab.every((e) => e.ok === true));
  } finally { stub.restore(); delete globalThis.chrome; }
});
