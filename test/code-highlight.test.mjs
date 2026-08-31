// test/code-highlight.test.mjs
// 代码块渲染（shared/code-highlight.js）的回归测试。
// 该模块直接决定聊天里 AI 回复的代码展示，且输出进 innerHTML，
// 转义一旦失守就是 XSS，必须有单测兜住。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCodeBlocks, highlightCode, normalizeLang } from '../shared/code-highlight.js';

// ---------- extractCodeBlocks ----------

test('extractCodeBlocks: 标准围栏切出 文本/代码/文本 三段', () => {
  const segs = extractCodeBlocks('前文\n```js\nconst a = 1;\n```\n后文');
  assert.equal(segs.length, 3);
  assert.deepEqual(segs.map(s => s.type), ['text', 'code', 'text']);
  assert.equal(segs[0].content, '前文');
  assert.equal(segs[1].content, 'const a = 1;');
  assert.equal(segs[1].lang, 'js');
  assert.equal(segs[2].content, '后文');
});

test('extractCodeBlocks: 未闭合围栏的剩余内容按代码段处理（流式中途）', () => {
  const segs = extractCodeBlocks('看这个：\n```python\nprint(1)');
  assert.equal(segs.length, 2);
  assert.equal(segs[1].type, 'code');
  assert.equal(segs[1].lang, 'python');
  assert.equal(segs[1].content, 'print(1)');
});

test('extractCodeBlocks: 无围栏时返回单一文本段且内容原样', () => {
  const segs = extractCodeBlocks('普通回复，\n带换行，还有 ``` 三个反引号但不构成围栏。');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, 'text');
  assert.equal(segs[0].content, '普通回复，\n带换行，还有 ``` 三个反引号但不构成围栏。');
});

test('extractCodeBlocks: 围栏语言取 info string 首个单词', () => {
  const segs = extractCodeBlocks('```ts title=abc\nlet x;\n```');
  assert.equal(segs[0].lang, 'ts');
});

test('extractCodeBlocks: 代码内容逐字保留（含注释和特殊字符）', () => {
  const code = '// <b>not html</b>\nlet s = "a&b";';
  const segs = extractCodeBlocks('```\n' + code + '\n```');
  assert.equal(segs[0].content, code);
});

test('extractCodeBlocks: 闭合围栏必须同字符（``` 不被 ~~~ 关闭）', () => {
  const segs = extractCodeBlocks('```js\nconst a = 1;\n~~~\nconst b = 2;\n```');
  // ~~~ 在围栏内只是普通代码行；闭合后无尾随文本，总共只有 1 段
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, 'code');
  assert.equal(segs[0].content, 'const a = 1;\n~~~\nconst b = 2;');
});

test('extractCodeBlocks: 空值/非字符串不抛异常', () => {
  assert.deepEqual(extractCodeBlocks(''), [{ type: 'text', content: '' }]);
  assert.deepEqual(extractCodeBlocks(null), [{ type: 'text', content: '' }]);
  assert.deepEqual(extractCodeBlocks(undefined), [{ type: 'text', content: '' }]);
});

test('extractCodeBlocks: 结尾换行不丢内容', () => {
  const segs = extractCodeBlocks('第一行\n');
  assert.equal(segs[0].content, '第一行\n');
});

// ---------- highlightCode ----------

test('highlightCode: HTML 内容被转义，绝不输出原始标签（防 XSS）', () => {
  const out = highlightCode('<script>alert("x")</script>', 'html');
  assert.ok(!/<script/i.test(out), '不应残留原始 <script>：' + out);
  assert.ok(out.includes('&lt;script'), '应被转义：' + out);
});

test('highlightCode: 字符串内的 // 不被误判为注释', () => {
  const out = highlightCode('const url = "http://example.com";', 'js');
  // URL 应整体在字符串 token 里（引号被转义为 &quot;），且不在注释 token 内
  assert.ok(/<span class="tok-str">&quot;http:\/\/example\.com&quot;<\/span>/.test(out), out);
  assert.ok(!out.includes('tok-com'), out);
});

test('highlightCode: 关键字与函数调用分别着色', () => {
  const out = highlightCode('function foo() { return 1; }', 'js');
  assert.ok(out.includes('<span class="tok-kw">function</span>'), out);
  assert.ok(out.includes('<span class="tok-fn">foo</span>'), out);
  assert.ok(out.includes('<span class="tok-kw">return</span>'), out);
  assert.ok(out.includes('<span class="tok-num">1</span>'), out);
});

test('highlightCode: python 行注释与字符串', () => {
  const out = highlightCode('# 注释\ns = "值"', 'python');
  assert.ok(out.includes('<span class="tok-com"># 注释</span>'), out);
  assert.ok(out.includes('<span class="tok-str">&quot;值&quot;</span>'), out);
});

test('highlightCode: 未知语言按 plain 处理（通用字符串/注释/数字仍着色）', () => {
  const out = highlightCode('x = 1 # 备注', 'cobol');
  assert.ok(out.includes('<span class="tok-num">1</span>'), out);
  assert.ok(out.includes('<span class="tok-com"># 备注</span>'), out);
});

test('highlightCode: 块注释跨行正确着色', () => {
  const out = highlightCode('/* 多行\n注释 */\nlet x;', 'js');
  assert.ok(out.includes('<span class="tok-com">/* 多行\n注释 */</span>'), out);
});

test('highlightCode: 关键字优先于函数调用判定（if( 不算函数）', () => {
  const out = highlightCode('if (a) { foo(); }', 'js');
  assert.ok(out.includes('<span class="tok-kw">if</span>'), out);
  assert.ok(!out.includes('<span class="tok-fn">if</span>'), out);
  assert.ok(out.includes('<span class="tok-fn">foo</span>'), out);
});

test('highlightCode: 空输入返回空串', () => {
  assert.equal(highlightCode('', 'js'), '');
  assert.equal(highlightCode(null, 'js'), '');
});

test('highlightCode: 输出中的引号实体不会被二次破坏', () => {
  const out = highlightCode('const s = "a\\"b";', 'js');
  assert.ok(out.includes('&quot;'), out);
});

// ---------- normalizeLang ----------

test('normalizeLang: 常用别名归一化', () => {
  assert.equal(normalizeLang('py'), 'python');
  assert.equal(normalizeLang('TS'), 'js');
  assert.equal(normalizeLang('shell'), 'bash');
  assert.equal(normalizeLang('c++'), 'clike');
});

test('normalizeLang: 未知语言返回 plain', () => {
  assert.equal(normalizeLang('brainfuck'), 'plain');
  assert.equal(normalizeLang(''), 'plain');
  assert.equal(normalizeLang(undefined), 'plain');
});
