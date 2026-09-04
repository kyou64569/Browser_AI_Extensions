// test/sse.test.mjs
// core/sse.js 共享流式解析器的回归测试。
// 覆盖本次审查修复的三个点：data: 前缀剥离、末尾无换行的残帧不丢、reader 提前取消。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamLines, sseData } from '../core/sse.js';

/** 用内存 ReadableStream 模拟分块到达的响应体 */
function bodyOf(...chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(enc.encode(c));
      ctrl.close();
    },
  });
}

test('sseData: 剥离 data: 前缀；注释与字段行返回 null', () => {
  assert.equal(sseData('data: {"a":1}'), '{"a":1}');
  assert.equal(sseData('data:[DONE]'), '[DONE]');
  assert.equal(sseData(': keep-alive'), null);
  assert.equal(sseData('event: message'), null);
  assert.equal(sseData('id: 42'), null);
  assert.equal(sseData('retry: 1000'), null);
  assert.equal(sseData(''), null);
  assert.equal(sseData('   '), null);
  // 无前缀裸 JSON 行（Ollama NDJSON）原样放行
  assert.equal(sseData('{"done":true}'), '{"done":true}');
});

test('streamLines: 按行产出、分块跨界行正确拼接', () => {
  // 一行被拆到两个 chunk 中间
  const lines = [];
  (async () => {
    for await (const l of streamLines(bodyOf('data: he', 'llo\ndata: world\n'))) lines.push(l);
  })();
  return (async () => {
    // 等待流结束
    for (let i = 0; i < 10 && lines.length < 2; i++) await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(lines, ['data: hello', 'data: world']);
  })();
});

test('streamLines: 末尾无换行的残帧不丢失（旧实现 lines.pop 后丢弃 buf）', async () => {
  const lines = [];
  for await (const l of streamLines(bodyOf('a\nb\nc'))) lines.push(l);
  assert.deepEqual(lines, ['a', 'b', 'c']);
});

test('streamLines: 消费方提前 return 时 reader 被 cancel（不悬挂连接）', async () => {
  let cancelled = false;
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(ctrl) {
      // 持续产出大量数据：若消费方退出后未 cancel，生成器会被一直挂着
      const t = setInterval(() => {
        try { ctrl.enqueue(enc.encode('x\n')); } catch (_) { clearInterval(t); }
      }, 5);
    },
    cancel() { cancelled = true; },
  });
  for await (const l of streamLines(body)) {
    void l;
    break; // 读到第一行就退出
  }
  for (let i = 0; i < 20 && !cancelled; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(cancelled, '提前退出必须触发底层流的 cancel()');
});
