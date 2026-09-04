// test/sanitize.test.mjs 中补充的对抗性用例（本次审查修复的回归防护）：
// 1) 无分号 legacy 实体（HTML5 浏览器会解码，旧实现会放行）
// 2) safeMediaSrc 媒体地址白名单
// 3) escapeHtml 引号转义（属性上下文安全）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripHtmlText, safeMediaSrc, escapeHtml } from '../shared/sanitize.js';

test('stripHtmlText: 无分号 legacy 实体包装的标签也被剥离（HTML5 解码行为对齐）', () => {
  // 浏览器在文本态会解码 &ltimg … &gt（无分号 legacy 实体）→ <img …>。
  // stripHtmlText 若不处理该形态，输出仍含可复活的标签结构。
  const out = stripHtmlText('&ltimg src=x onerror=alert(1)&gt');
  assert.ok(!/<img/i.test(out), '不应残留 <img 标签，实际得到：' + out);
  assert.ok(!/onerror/i.test(out), 'onerror 应已被处理，实际得到：' + out);
});

test('stripHtmlText: 无分号 &ltscript 变体被中和', () => {
  const out = stripHtmlText('&ltscript>alert(1)&lt/script>');
  assert.ok(!/<script/i.test(out), '实际得到：' + out);
});

test('stripHtmlText: 无分号实体不影响正常含 & 文本', () => {
  // &amp;（带分号）正常解码；裸 "AT&T" 中的 & 后不是实体名，应原样保留
  assert.ok(stripHtmlText('AT&T Rocks').includes('AT&T'));
  assert.equal(stripHtmlText('a &amp; b'), 'a & b');
});

test('escapeHtml: 引号必须转义（属性上下文安全）', () => {
  assert.equal(escapeHtml('a"onerror="x'), 'a&quot;onerror=&quot;x');
  assert.equal(escapeHtml("it's"), 'it&#39;s');
  const out = escapeHtml('<img src=x onerror=alert(1) "');
  assert.ok(!/[<>"]/.test(out), '输出不应含任何可逃逸引号/尖括号：' + out);
});

test('escapeHtml: 基础转义与空值容错', () => {
  assert.equal(escapeHtml('<script>&'), '&lt;script&gt;&amp;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('safeMediaSrc: 放行 http(s)/blob/栅格 data URL 并转义', () => {
  const httpsUrl = 'https://cdn.example.com/img.png?token=abc&sig=1';
  assert.equal(safeMediaSrc(httpsUrl), 'https://cdn.example.com/img.png?token=abc&amp;sig=1');
  assert.equal(safeMediaSrc('data:image/png;base64,iVBORw0KGgo='), 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(safeMediaSrc('data:audio/mpeg;base64,AAAA'), 'data:audio/mpeg;base64,AAAA');
  assert.equal(safeMediaSrc('data:video/mp4;base64,AAAA'), 'data:video/mp4;base64,AAAA');
  assert.ok(safeMediaSrc('blob:http://localhost/uuid-1').startsWith('blob:'));
});

test('safeMediaSrc: 拒绝可执行协议与 SVG', () => {
  assert.equal(safeMediaSrc('javascript:alert(1)'), '');
  assert.equal(safeMediaSrc('data:text/html,<script>1</script>'), '');
  // SVG 可携带脚本：图片/媒体白名单一致拒绝
  assert.equal(safeMediaSrc('data:image/svg+xml,<svg onload=alert(1)>'), '');
  assert.equal(safeMediaSrc('file:///etc/passwd'), '');
  assert.equal(safeMediaSrc(''), '');
  assert.equal(safeMediaSrc(null), '');
});

test('safeMediaSrc: 含引号的 URL 被转义而非拒绝（第三方网关 URL 可安全展示）', () => {
  const evil = 'https://example.com/a.png?x="onerror="alert(1)';
  const out = safeMediaSrc(evil);
  assert.ok(out.startsWith('https://'), '合法 http URL 应放行: ' + out);
  assert.ok(!out.includes('"'), '引号必须已转义: ' + out);
});
