// test/sanitize.test.mjs
// shared/sanitize.js 的回归测试。
// 重点覆盖"消毒后不能再被当成 HTML 复活"这条安全底线（审查报告 S-04）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripHtmlText, decodeHtmlEntities, sanitizeHttpUrl, safeImageSrc, redactUrl,
} from '../shared/sanitize.js';

test('stripHtmlText: 去掉普通标签', () => {
  assert.equal(stripHtmlText('<p>你好 <b>世界</b></p>'), '你好 世界');
});

test('stripHtmlText: 解码后复活的标签必须再次剥离（编码型 XSS）', () => {
  // 只做"去标签→解实体"一遍的话，解码后会重新出现 <img ...>
  const out = stripHtmlText('&lt;img src=x onerror=alert(1)&gt;');
  assert.ok(!/<img/i.test(out), '不应残留 <img 标签，实际得到：' + out);
  assert.ok(!/onerror/i.test(out) || !/<img/i.test(out));
});

test('stripHtmlText: 双重编码也要清干净', () => {
  const out = stripHtmlText('&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;');
  assert.ok(!/<script/i.test(out), '实际得到：' + out);
});

test('stripHtmlText: script/style 整块内容被丢弃', () => {
  const out = stripHtmlText('前文<script>alert(1)</script>后文');
  assert.ok(!/alert/.test(out), 'script 内容不应保留，实际得到：' + out);
  assert.match(out, /前文/);
  assert.match(out, /后文/);
});

test('stripHtmlText: 未闭合的标签起始符被中和', () => {
  const out = stripHtmlText('标题<script');
  assert.ok(!out.includes('<'), '不应残留 < ，实际得到：' + out);
});

test('stripHtmlText: 保留比较运算里的裸 <（不误伤正文）', () => {
  assert.equal(stripHtmlText('a < b 且 c > d'), 'a < b 且 c > d');
  assert.equal(stripHtmlText('分数 <3 分'), '分数 <3 分');
});

test('stripHtmlText: 数字实体与命名实体', () => {
  assert.equal(stripHtmlText('&#20320;&#22909;'), '你好');
  assert.equal(stripHtmlText('&amp;&lt;&gt;&quot;'), '&<>"');
});

test('stripHtmlText: 空值与非字符串不抛异常', () => {
  assert.equal(stripHtmlText(null), '');
  assert.equal(stripHtmlText(undefined), '');
  assert.equal(stripHtmlText(123), '123');
});

test('decodeHtmlEntities: 拒绝控制字符与代理项', () => {
  assert.equal(decodeHtmlEntities('&#0;'), '');
  assert.equal(decodeHtmlEntities('&#xD800;'), '');
  assert.equal(decodeHtmlEntities('&#x9;'), '\t');
});

test('sanitizeHttpUrl: 只放行 http/https', () => {
  assert.equal(sanitizeHttpUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(sanitizeHttpUrl('http://example.com'), 'http://example.com/');
  assert.equal(sanitizeHttpUrl('javascript:alert(1)'), '');
  assert.equal(sanitizeHttpUrl('data:text/html,<script>1</script>'), '');
  assert.equal(sanitizeHttpUrl('file:///etc/passwd'), '');
  assert.equal(sanitizeHttpUrl('chrome://extensions'), '');
  assert.equal(sanitizeHttpUrl(''), '');
  assert.equal(sanitizeHttpUrl('not a url'), '');
});

test('safeImageSrc: 截图类 data URL 放行，可执行协议拒绝', () => {
  assert.ok(safeImageSrc('data:image/png;base64,iVBORw0KGgo=').startsWith('data:image/png'));
  assert.ok(safeImageSrc('data:image/jpeg;base64,AAAA'));
  assert.ok(safeImageSrc('blob:http://localhost/abc-123'));
  assert.ok(safeImageSrc('https://example.com/a.png'));
  // SVG 可携带脚本，一律拒绝
  assert.equal(safeImageSrc('data:image/svg+xml,<svg onload=alert(1)>'), '');
  assert.equal(safeImageSrc('javascript:alert(1)'), '');
  assert.equal(safeImageSrc('data:text/html,<script>1</script>'), '');
});

test('safeImageSrc: 拒绝能提前闭合 src 属性的字符', () => {
  assert.equal(safeImageSrc('data:image/png;base64,AAA" onerror="alert(1)'), '');
  assert.equal(safeImageSrc('https://example.com/a.png" onload="x'), '');
});

test('redactUrl: 去掉 query 与 hash，抹掉 URL 里的密钥', () => {
  assert.equal(
    redactUrl('https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent?key=SECRET123'),
    'https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent'
  );
  assert.equal(redactUrl('https://api.example.com/v1/chat#frag'), 'https://api.example.com/v1/chat');
  assert.equal(redactUrl(''), '');
  assert.equal(redactUrl('not a url?key=SECRET'), 'not a url');
});

test('redactUrl: 保留 path 以便定位 apiBase 配错', () => {
  assert.equal(redactUrl('https://openrouter.ai/api/v1/chat/completions'), 'https://openrouter.ai/api/v1/chat/completions');
});
