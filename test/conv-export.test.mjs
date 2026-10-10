// test/conv-export.test.mjs
// 会话导出（shared/conv-export.js）的回归测试。
// 导出内容会离开扩展（用户存档/分享），格式稳定且不泄露结构噪声是基本要求。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationToMarkdown, safeFilename, trimSubsForPersist,
  MAX_PERSIST_SUBS, MAX_PERSIST_SUB_THINK_CHARS, MAX_PERSIST_SUB_TEXT_CHARS,
} from '../shared/conv-export.js';

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

// ── 协作子模型明细：持久化封顶 ────────────────────────────────────────────

test('trimSubsForPersist: 空输入返回 undefined，字段按原样收敛', () => {
  assert.equal(trimSubsForPersist(undefined), undefined);
  assert.equal(trimSubsForPersist([]), undefined);
  assert.equal(trimSubsForPersist({ items: [] }), undefined);
  assert.equal(trimSubsForPersist([null, undefined]), undefined);
  const one = trimSubsForPersist({ total: 1, items: [{ name: '子A', phase: 'done', ms: 10.6, thinking: '想', text: '答' }] });
  assert.deepEqual(one, { total: 1, items: [{ name: '子A', phase: 'done', ms: 11, thinking: '想', text: '答' }] });
});

test('trimSubsForPersist: 条数封顶但 total 保留真实总数（能看出只记了前若干个）', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ name: '子' + i, phase: 'done', text: 'x' }));
  const r = trimSubsForPersist({ total: 10, items });
  assert.equal(r.items.length, MAX_PERSIST_SUBS);
  assert.equal(r.total, 10);
  assert.equal(r.items[0].name, '子0');
  assert.equal(r.items[r.items.length - 1].name, '子' + (MAX_PERSIST_SUBS - 1));
});

test('trimSubsForPersist: 思考与正文按各自上限截断并留可见标记', () => {
  const r = trimSubsForPersist({
    total: 2,
    items: [
      { name: '子A', phase: 'done', thinking: '想'.repeat(5000), text: '答'.repeat(9000) },
      { name: '子B', phase: 'error', error: 'E'.repeat(1200) },
    ],
  });
  assert.equal(r.items[0].thinking.length, MAX_PERSIST_SUB_THINK_CHARS);
  assert.ok(r.items[0].thinking.endsWith('…（已截断）'), '思考应带截断标记');
  assert.equal(r.items[0].text.length, MAX_PERSIST_SUB_TEXT_CHARS);
  assert.equal(r.items[1].error.length, 300);
  assert.equal(r.items[1].phase, 'error');
  assert.equal(r.items[1].thinking, undefined, '没有思考内容就不要写空字段');
});

test('trimSubsForPersist: 重复截断必须幂等——会话每轮整份重写，标记不能一层层叠上去', () => {
  const raw = { total: 1, items: [{ name: '子A', phase: 'done', thinking: '想'.repeat(5000), text: '答'.repeat(9000) }] };
  const once = trimSubsForPersist(raw);
  const twice = trimSubsForPersist(once);
  const thrice = trimSubsForPersist(twice);
  assert.deepEqual(twice, once, '第二次截断不应改变内容');
  assert.deepEqual(thrice, once, '第三次同样不变');
  assert.equal((once.items[0].thinking.match(/已截断/g) || []).length, 1, '截断标记只能有一个');
});

test('trimSubsForPersist: phase 归一化，未知值按完成处理', () => {
  const r = trimSubsForPersist({
    total: 3,
    items: [{ name: 'a', phase: 'start' }, { name: 'b', phase: 'weird' }, { name: 'c' }],
  });
  assert.deepEqual(r.items.map(x => x.phase), ['start', 'done', 'done']);
});

test('conversationToMarkdown: 协作消息导出子模型明细段（状态、用时、思考、返回）', () => {
  const md = conversationToMarkdown({
    title: '协作会话',
    messages: [{
      role: 'assistant', content: '整合后的答案',
      subs: { total: 2, items: [
        { name: '子A', phase: 'done', ms: 1234, thinking: '先排除矛盾项', text: 'E > C > A > B > D' },
        { name: '子B', phase: 'error', error: 'HTTP 500 上游炸了' },
      ] },
    }],
  }, { exportedAt: 0 });
  assert.ok(md.includes('多模型协作 · 子模型 2/2 条记录'), md);
  assert.ok(md.includes('子A（完成 · 1234ms）'), md);
  assert.ok(md.includes('思考：先排除矛盾项'), md);
  assert.ok(md.includes('返回：E > C > A > B > D'), md);
  assert.ok(md.includes('子B（失败）：HTTP 500 上游炸了'), md);
});

test('conversationToMarkdown: 无 subs 的普通消息不多出协作段落', () => {
  const md = conversationToMarkdown({ title: 't', messages: [{ role: 'assistant', content: '普通回答' }] }, { exportedAt: 0 });
  assert.ok(!md.includes('多模型协作'), md);
});

test('trimSubsForPersist：empty 阶段与成因存得下来，导出能看出那一路是弃权', () => {
  const r = trimSubsForPersist({ total: 2, items: [
    { name: '子A', phase: 'empty', ms: 559800, thinking: '想'.repeat(20), reason: '思考占满输出额度，已提前停止（已思考 20 字）' },
    { name: '子B', phase: '没见过的阶段', text: '答' },
  ] });
  assert.equal(r.items[0].phase, 'empty', '认得出的阶段必须原样保留，否则回放时又被折叠成「完成」');
  assert.match(r.items[0].reason, /已提前停止/);
  assert.equal(r.items[0].text, undefined);
  assert.equal(r.items[1].phase, 'done', '认不出的阶段收敛为 done，别让脏值进会话');
  const md = conversationToMarkdown({ title: 't', messages: [{ role: 'assistant', content: '主答案', subs: r }] });
  assert.match(md, /无正文/);
  assert.match(md, /已提前停止/);
});
