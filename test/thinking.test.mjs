// test/thinking.test.mjs
// 思考（thinking/reasoning）共享逻辑的回归测试：风格识别 / 参数构造 / 内联标签剥离 / 存储迁移。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectThinkingStyle, resolveThinkingStyle, buildThinkingParams, splitInlineThink,
  thinkingStyleIsInert, thinkingIsInert, maxTokensHint,
} from '../shared/thinking.js';
import { migrateModels } from '../core/model-config.js';

// ── detectThinkingStyle ──────────────────────────────────────────────────

test('detectThinkingStyle: 默认思考模型识别为 none（不发参数）', () => {
  assert.equal(detectThinkingStyle('deepseek-ai/DeepSeek-R1'), 'none');
  assert.equal(detectThinkingStyle('deepseek-reasoner'), 'none');
  // 识别不出的模型兜底 none：最多是「没开启思考」，绝不会因猜错参数而 400
  assert.equal(detectThinkingStyle('gpt-4o'), 'none');
  assert.equal(detectThinkingStyle('deepseek-v3'), 'none');
  assert.equal(detectThinkingStyle('qwen2.5-72b-instruct'), 'none');
  assert.equal(detectThinkingStyle('grok-4'), 'none');
});

test('detectThinkingStyle: 按模型名识别厂商参数风格', () => {
  assert.equal(detectThinkingStyle('o3'), 'openai');
  assert.equal(detectThinkingStyle('openai/o3-mini'), 'openai');
  assert.equal(detectThinkingStyle('o4-mini-2025-04-16'), 'openai');
  assert.equal(detectThinkingStyle('gpt-5-turbo'), 'openai');
  assert.equal(detectThinkingStyle('my-reasoning-pro'), 'openai');
  assert.equal(detectThinkingStyle('zhipuai/glm-4.5'), 'glm');
  assert.equal(detectThinkingStyle('glm-4.6'), 'glm');
  assert.equal(detectThinkingStyle('qwen/qwen3-235b-a22b'), 'qwen');
  assert.equal(detectThinkingStyle('qwen3-32b'), 'qwen');
});

test('detectThinkingStyle: apiBase 识别 OpenRouter 中转', () => {
  assert.equal(detectThinkingStyle('some-model', 'https://openrouter.ai/api/v1'), 'openrouter');
  // apiBase 优先级最低：明确的模型名优先于网关猜测
  assert.equal(detectThinkingStyle('deepseek/deepseek-r1', 'https://openrouter.ai/api/v1'), 'none');
});

// ── resolveThinkingStyle ─────────────────────────────────────────────────

test('resolveThinkingStyle: auto/未设置/非法值走自动识别，显式风格原样返回', () => {
  assert.equal(resolveThinkingStyle('auto', 'glm-4.5'), 'glm');
  assert.equal(resolveThinkingStyle(undefined, 'o3'), 'openai');
  assert.equal(resolveThinkingStyle('bogus-style', 'o3'), 'openai');
  assert.equal(resolveThinkingStyle('qwen', 'deepseek-r1'), 'qwen'); // 显式指定优先于识别
});

// ── buildThinkingParams ──────────────────────────────────────────────────

test('buildThinkingParams: reasoning_effort / reasoning 风格', () => {
  assert.deepEqual(buildThinkingParams('openai', 'low'), { reasoning_effort: 'low' });
  assert.deepEqual(buildThinkingParams('openai', 'high'), { reasoning_effort: 'high' });
  assert.deepEqual(buildThinkingParams('openai', 'off'), {});
  assert.deepEqual(buildThinkingParams('openai', undefined), {});
  assert.deepEqual(buildThinkingParams('openrouter', 'medium'), { reasoning: { effort: 'medium' } });
  assert.deepEqual(buildThinkingParams('openrouter', 'off'), {});
});

test('buildThinkingParams: glm / qwen 风格在「关」档发显式禁用（混合推理模型默认思考，不发参数关不掉）', () => {
  assert.deepEqual(buildThinkingParams('glm', 'low'), { thinking: { type: 'enabled' } });
  assert.deepEqual(buildThinkingParams('glm', 'off'), { thinking: { type: 'disabled' } });
  assert.deepEqual(buildThinkingParams('qwen', 'high'), { enable_thinking: true, thinking_budget: 16384 });
  assert.deepEqual(buildThinkingParams('qwen', 'medium'), { enable_thinking: true, thinking_budget: 8192 });
  assert.deepEqual(buildThinkingParams('qwen', 'off'), { enable_thinking: false });
});

test('buildThinkingParams: default 档（厂商默认）任何风格都不发参数——包括 glm/qwen 的显式禁用', () => {
  for (const style of ['openai', 'openrouter', 'glm', 'qwen', 'none']) {
    assert.deepEqual(buildThinkingParams(style, 'default'), {}, style);
  }
  assert.deepEqual(buildThinkingParams('glm', undefined), {});
  assert.deepEqual(buildThinkingParams('qwen', ''), {});
});

test('buildThinkingParams: none 风格任何强度都不发参数', () => {
  assert.deepEqual(buildThinkingParams('none', 'high'), {});
  assert.deepEqual(buildThinkingParams('none', 'off'), {});
});

test('thinkingStyleIsInert: 只有「不发参数」的风格才算强度不可调', () => {
  assert.equal(thinkingStyleIsInert('none'), true);            // SenseNova / DeepSeek-R1：选了中也没用
  assert.equal(thinkingStyleIsInert('openai'), false);
  assert.equal(thinkingStyleIsInert('openrouter'), false);
  assert.equal(thinkingStyleIsInert('glm'), false);            // 连「关」都要发禁用参数，谈不上不可调
  assert.equal(thinkingStyleIsInert('qwen'), false);
  assert.equal(thinkingStyleIsInert('未登记的风格'), true);      // 未知风格落到 default 分支 → 不发参数
});

test('maxTokensHint: 按思考参数风格给不同的输出额度建议', () => {
  // 未勾选支持思考 → 不给提示
  assert.equal(maxTokensHint({ supportsThinking: false, model: 'sensenova-6.7-flash-lite' }), '');
  // SenseNova：识别为 none，「≥16384」这种建议会让人误以为还能调强度
  assert.match(maxTokensHint({ supportsThinking: true, model: 'sensenova-6.7-flash-lite', apiBase: 'https://token.sensenova.cn/v1' }),
    /强度不可调.*≥32768/);
  // DeepSeek-R1 同理（默认思考、无开关）
  assert.match(maxTokensHint({ supportsThinking: true, model: 'deepseek-ai/DeepSeek-R1' }), /强度不可调/);
  // 强度可控的模型保持原建议值
  assert.match(maxTokensHint({ supportsThinking: true, model: 'qwen3-32b' }), /≥16384/);
  assert.equal(maxTokensHint({ supportsThinking: true, model: 'qwen3-32b' }).includes('强度不可调'), false);
  // 显式指定风格时以风格为准
  assert.match(maxTokensHint({ supportsThinking: true, thinkingStyle: 'openai', model: 'whatever' }), /≥16384/);
  assert.equal(maxTokensHint({}), '');
});

test('thinkingIsInert: 只有 OpenAI 兼容通道才按风格枚举判「强度不可调」', () => {
  // 原生厂商各发各的 budget / thinkingConfig / think，档位一定有差别。
  // 拿 OpenAI 的风格枚举去判它们，会得到「思考强度不可调」这种反事实的劝（真机验证时踩到过）。
  assert.equal(thinkingIsInert({ vendor: 'anthropic', model: 'claude-3-7-sonnet' }), false);
  assert.equal(thinkingIsInert({ vendor: 'gemini', model: 'gemini-2.5-pro' }), false);
  assert.equal(thinkingIsInert({ vendor: 'ollama', model: 'deepseek-r1:32b' }), false);
  // OpenAI 兼容通道维持原判据
  assert.equal(thinkingIsInert({ vendor: 'openai', model: 'deepseek-ai/DeepSeek-R1' }), true);
  assert.equal(thinkingIsInert({ vendor: 'openai', model: 'qwen3-32b' }), false);
  assert.equal(thinkingIsInert({ vendor: 'openai', thinkingStyle: 'glm', model: 'whatever' }), false);
  // 没标 vendor 的裸对象仍按风格判，别把判据整个丢掉
  assert.equal(thinkingIsInert({ model: 'deepseek-ai/DeepSeek-R1' }), true);
});

test('maxTokensHint: 厂商原生思考参数时不给「强度不可调」', () => {
  // 模型名长得像 SenseNova，但走的是 anthropic 通道 → 发得出 thinking budget，建议必须按可调给
  assert.match(maxTokensHint({ supportsThinking: true, vendor: 'anthropic', model: 'sensenova-6.7-flash-lite' }), /≥16384/);
  assert.equal(maxTokensHint({ supportsThinking: true, vendor: 'anthropic', model: 'claude-3-7-sonnet' }).includes('强度不可调'), false);
  assert.equal(maxTokensHint({ supportsThinking: true, vendor: 'gemini', model: 'deepseek-ai/DeepSeek-R1' }).includes('强度不可调'), false);
});

// ── splitInlineThink ─────────────────────────────────────────────────────

test('splitInlineThink: 无标签原样返回', () => {
  assert.deepEqual(splitInlineThink('你好，世界'), { think: '', answer: '你好，世界' });
  assert.deepEqual(splitInlineThink(''), { think: '', answer: '' });
  assert.deepEqual(splitInlineThink(undefined), { think: '', answer: '' });
});

test('splitInlineThink: 剥离闭合思考块（不区分大小写、支持多块）', () => {
  assert.deepEqual(splitInlineThink('<think>内部推理</think>最终答案'), { think: '内部推理', answer: '最终答案' });
  assert.deepEqual(splitInlineThink('<THINK>a</THINK>b'), { think: 'a', answer: 'b' });
  assert.deepEqual(
    splitInlineThink('<think>一</think>中\n<think>二</think>尾'),
    { think: '一\n\n二', answer: '中\n尾' },
  );
  // 标签前后允许空白
  assert.deepEqual(splitInlineThink('  \n<think>想</think> \n 答'), { think: '想', answer: '答' });
});

test('splitInlineThink: 未闭合标签（流式中途）全部算思考、正文为空', () => {
  assert.deepEqual(splitInlineThink('<think>正在想'), { think: '正在想', answer: '' });
});

test('splitInlineThink: 标签变体 <thinking>/<thought>/<reasoning> 一并剥离', () => {
  assert.deepEqual(splitInlineThink('<thinking>内部推理</thinking>最终答案'), { think: '内部推理', answer: '最终答案' });
  assert.deepEqual(splitInlineThink('<THINKING>a</THINKING>b'), { think: 'a', answer: 'b' });
  assert.deepEqual(
    splitInlineThink('<thought>t</thought>中 <reasoning>r</reasoning>尾'),
    { think: 't\n\nr', answer: '中 尾' },
  );
  // 变体的未闭合形态（截断场景）
  assert.deepEqual(splitInlineThink('<thinking>正在想'), { think: '正在想', answer: '' });
});

test('splitInlineThink: 开闭标签变体错配按思考族闭合标签截断', () => {
  // 模型开了 <think> 却用 </thinking> 收尾：按最近的思考族闭合标签截断，正文不丢
  assert.deepEqual(splitInlineThink('<think>a</thinking>b'), { think: 'a', answer: 'b' });
  // 正文里恰好出现“think”字样的普通文本不受影响
  assert.deepEqual(splitInlineThink('我说了 think 这个词'), { think: '', answer: '我说了 think 这个词' });
});

// ── migrateModels ────────────────────────────────────────────────────────

test('migrateModels: 旧 reasoningEffortSupported → thinkingStyle，已有值不动', () => {
  const models = [
    { vendor: 'openai', reasoningEffortSupported: true },   // 勾过「推理」→ reasoning_effort
    { vendor: 'openai', reasoningEffortSupported: false },  // 没勾 → 自动识别
    { vendor: 'openai', thinkingStyle: 'qwen' },            // 新配置不动
    { vendor: 'openai' },                                   // 缺失 → auto
  ];
  migrateModels(/** @type {any} **/ (models));
  assert.equal(models[0].thinkingStyle, 'openai');
  assert.equal(models[1].thinkingStyle, 'auto');
  assert.equal(models[2].thinkingStyle, 'qwen');
  assert.equal(models[3].thinkingStyle, 'auto');
  // 兼容：不删除旧字段，避免用户降级版本后旧代码读到 undefined
  assert.equal(models[0].reasoningEffortSupported, true);
});

test('migrateModels: 空/异常输入安全', () => {
  assert.deepEqual(migrateModels(/** @type {any} **/ ([])), []);
  assert.deepEqual(migrateModels(/** @type {any} **/ (undefined)), undefined);
  assert.deepEqual(migrateModels(/** @type {any} **/ (null)), null);
  const dirty = /** @type {any} */ ([null, 'oops', { vendor: 'openai' }]);
  migrateModels(dirty);
  assert.equal(dirty[0], null);
  assert.equal(dirty[1], 'oops');
  assert.equal(dirty[2].thinkingStyle, 'auto');
});
