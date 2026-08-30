// test/automation.test.mjs
// 工具调用解析与正文提取的回归测试。
// parseToolCalls 是 Agent / 网页自动化的入口解析：解析漏了 → Agent 直接"卡住不动作"，
// 解析错了 → 执行到非预期工具，属于必须锁死行为的部分。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseToolCalls, parseToolCall, stripToolCall, buildToolSystemPrompt, TOOLS,
} from '../features/automation.js';

// ── parseToolCalls ────────────────────────────────────────────────────────

test('parseToolCalls: 解析标准 ```toolcall 代码块', () => {
  const text = '我来点击按钮。\n```toolcall\n{"name":"click","args":{"selector":"#submit"}}\n```';
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'click');
  assert.deepEqual(calls[0].args, { selector: '#submit' });
});

test('parseToolCalls: 一次输出多个工具调用，按序返回', () => {
  const text = [
    '```toolcall',
    '{"name":"get_text","args":{}}',
    '```',
    '```toolcall',
    '{"name":"screenshot","args":{"mode":"visible"}}',
    '```',
  ].join('\n');
  const calls = parseToolCalls(text);
  assert.deepEqual(calls.map(c => c.name), ['get_text', 'screenshot']);
});

test('parseToolCalls: 兼容 <<TOOLCALL>> 与 <tool_call> 变体', () => {
  assert.equal(parseToolCalls('<<TOOLCALL>>{"name":"click","args":{}}<</TOOLCALL>>')[0].name, 'click');
  assert.equal(parseToolCalls('<tool_call>{"name":"click","args":{}}</tool_call>')[0].name, 'click');
});

test('parseToolCalls: 缺少 args 时补空对象', () => {
  const calls = parseToolCalls('```toolcall\n{"name":"get_text"}\n```');
  assert.deepEqual(calls[0].args, {});
});

test('parseToolCalls: 非法 JSON / 缺 name 一律忽略而不是抛错', () => {
  assert.deepEqual(parseToolCalls('```toolcall\n{这不是 JSON}\n```'), []);
  assert.deepEqual(parseToolCalls('```toolcall\n{"args":{"a":1}}\n```'), []);
  assert.deepEqual(parseToolCalls(''), []);
  assert.deepEqual(parseToolCalls(null), []);
});

test('parseToolCalls: args 含花括号与转义引号也能正确配对', () => {
  const text = '```toolcall\n{"name":"type","args":{"text":"if (a > b) { return \\"x\\"; }"}}\n```';
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 1, '括号匹配失败会导致整个调用丢失');
  assert.equal(calls[0].args.text, 'if (a > b) { return "x"; }');
});

test('parseToolCalls: 无工具调用的普通回复返回空数组（视为最终回答）', () => {
  assert.deepEqual(parseToolCalls('任务已完成，这是最终结果。'), []);
});

test('parseToolCall: 兼容旧调用，只取第一个', () => {
  const text = '```toolcall\n{"name":"a","args":{}}\n```\n```toolcall\n{"name":"b","args":{}}\n```';
  assert.equal(parseToolCall(text).name, 'a');
  assert.equal(parseToolCall('没有调用'), null);
});

// ── stripToolCall ─────────────────────────────────────────────────────────

test('stripToolCall: 移除工具调用块，只留自然���言', () => {
  const text = '思考一下\n```toolcall\n{"name":"click","args":{}}\n```\n完成';
  const out = stripToolCall(text);
  assert.ok(!out.includes('toolcall'), '不应残留标记：' + out);
  assert.ok(!out.includes('"name"'), '不应残留原始 JSON：' + out);
  assert.ok(out.includes('思考一下') && out.includes('完成'));
});

test('stripToolCall: 无任何调用时原样返回（仅压缩空行）', () => {
  assert.equal(stripToolCall('普通回复'), '普通回复');
  assert.equal(stripToolCall(''), '');
  assert.equal(stripToolCall(null), null);
});

test('stripToolCall: 变体标签也能清掉', () => {
  assert.ok(!/toolcall/i.test(stripToolCall('前文<toolcall>{"name":"a","args":{}}</toolcall>后文')));
});

// ── 工具清单与提示词 ──────────────────────────────────────────────────────

test('TOOLS: 名称唯一且都有描述', () => {
  const names = TOOLS.map(t => t.name);
  assert.equal(new Set(names).size, names.length, '工具名不能重复：' + names.join(','));
  for (const t of TOOLS) assert.ok(t.desc && t.desc.length > 0, t.name + ' 缺少描述');
});

test('buildToolSystemPrompt: 覆盖全部工具名', () => {
  const p = buildToolSystemPrompt();
  for (const t of TOOLS) assert.ok(p.includes(t.name), '提示词缺少工具：' + t.name);
});
