// test/conv-export.test.mjs
// 会话导出（shared/conv-export.js）的回归测试。
// 导出内容会离开扩展（用户存档/分享），格式稳定且不泄露结构噪声是基本要求。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationToMarkdown, safeFilename } from '../shared/conv-export.js';

test('conversationToMarkdown: 基本结构——标题、用户与 AI 消息分段', () => {
  const md = conversationToMarkdown({
    title: '测试会话',
    messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！有什么可以帮你？' },
    ],
  }, { exportedAt: '2026-08-31T10:00:00' });
  assert.ok(md.startsWith('# 测试会话'), md);
  assert.ok(md.includes('## 👤 用户'), md);
  assert.ok(md.includes('你好'), md);
  assert.ok(md.includes('## 🤖 AI'), md);
  assert.ok(md.includes('你好！有什么可以帮你？'), md);
  assert.ok(md.includes('导出时间'), md);
});

test('conversationToMarkdown: 工具调用消息渲染为 JSON 代码块并标注成败', () => {
  const md = conversationToMarkdown({
    title: 't',
    messages: [{ role: 'assistant', content: '', tool: { name: 'click', args: { sel: '#a' }, ok: false, error: '元素未找到' } }],
  }, { exportedAt: 0 });
  assert.ok(md.includes('### 🛠 工具调用：click（失败）'), md);
  assert.ok(md.includes('```json'), md);
  assert.ok(md.includes('"sel"'), md);
  assert.ok(md.includes('错误：元素未找到'), md);
});

test('conversationToMarkdown: 空会话/缺字段不抛异常且不产生空洞标题', () => {
  assert.ok(conversationToMarkdown({}).includes('# 未命名会话'));
  assert.ok(conversationToMarkdown(null).includes('# 未命名会话'));
  const md = conversationToMarkdown({ title: 'x', messages: [null, undefined] }, { exportedAt: 0 });
  assert.equal(md.trim().split('\n').filter(l => l.startsWith('##')).length, 0);
});

test('conversationToMarkdown: 无效时间戳不输出 NaN', () => {
  const md = conversationToMarkdown({ title: 't', createdAt: 'not-a-date' }, { exportedAt: 'bad' });
  assert.ok(!md.includes('NaN'), md);
  assert.ok(!md.includes('Invalid Date'), md);
});

test('conversationToMarkdown: 消息内容原样保留（含代码块围栏）', () => {
  const code = '```js\nconst a = 1;\n```';
  const md = conversationToMarkdown({ title: 't', messages: [{ role: 'assistant', content: code }] }, { exportedAt: 0 });
  assert.ok(md.includes(code), md);
});

test('safeFilename: 去掉文件系统非法字符并限长', () => {
  assert.equal(safeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(safeFilename('  多  空格  '), '多 空格');
  assert.equal(safeFilename('x'.repeat(100)).length, 60);
  assert.equal(safeFilename(''), '未命名会话');
  assert.equal(safeFilename(null), '未命名会话');
});
