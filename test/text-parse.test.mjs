// test/text-parse.test.mjs
// 模型输出容错解析的回归测试（审查报告 A-01）。
// 这些函数是"弱模型不按格式输出"时的最后一道防线，改坏了会表现为漏翻/整批报废，
// 且很难在手工测试里复现，必须靠单测兜住。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTranslateResponse, countClosedUnits, parseRefine,
  normalizeCaption, stripHallucination, HALLUCINATION_NORM,
} from '../shared/text-parse.js';

// ── parseTranslateResponse ────────────────────────────────────────────────

test('parseTranslateResponse: 标准 [N]…[/N] 格式', () => {
  const out = parseTranslateResponse('[0]你好[／0]'.replace('／', '/') + '[1]世界[/1]', 2);
  assert.deepEqual(out, ['你好', '世界']);
});

test('parseTranslateResponse: 段内含换行也能匹配', () => {
  const raw = '[0]第一行\n第二行[/0]\n[1]第二段[/1]';
  const out = parseTranslateResponse(raw, 2);
  assert.equal(out[0], '第一行\n第二行');
  assert.equal(out[1], '第二段');
});

test('parseTranslateResponse: 越界序号被忽略', () => {
  const out = parseTranslateResponse('[0]a[/0][5]越界[/5]', 1);
  assert.deepEqual(out, ['a']);
});

test('parseTranslateResponse: 重复出现的同一序号不覆盖（保留首次）', () => {
  const out = parseTranslateResponse('[0]首次[/0][0]再次[/0]', 1);
  assert.deepEqual(out, ['首次']);
});

test('parseTranslateResponse: 标记完全缺失时按行序兜底', () => {
  // 弱模型常见：直接输出 3 行译文，一个标记都没有
  const out = parseTranslateResponse('第一行\n第二行\n第三行', 3);
  assert.deepEqual(out, ['第一行', '第二行', '第三行']);
});

test('parseTranslateResponse: 行序兜底也会清掉残留的 [N] 残片', () => {
  const out = parseTranslateResponse('[0] 甲\n[1] 乙\n[2] 丙', 3);
  assert.deepEqual(out, ['甲', '乙', '丙']);
});

test('parseTranslateResponse: 行数与段数差距过大时不兜底（避免错位更严重）', () => {
  const out = parseTranslateResponse('只有一行', 5);
  assert.equal(out.filter(v => v !== undefined).length, 0);
  assert.equal(out.length, 5);
});

test('parseTranslateResponse: 部分命中时其余位置为 undefined（供上层保留原文）', () => {
  const out = parseTranslateResponse('[0]a[/0]', 3);
  assert.equal(out[0], 'a');
  assert.equal(out[1], undefined);
  assert.equal(out[2], undefined);
});

test('parseTranslateResponse: 空输入不抛异常', () => {
  assert.deepEqual(parseTranslateResponse('', 2), [undefined, undefined]);
  assert.deepEqual(parseTranslateResponse(null, 1), [undefined]);
});

// ── countClosedUnits ──────────────────────────────────────────────────────

test('countClosedUnits: 统计已完整闭合的单元数', () => {
  assert.equal(countClosedUnits('[0]a[/0]'), 1);
  assert.equal(countClosedUnits('[0]a[/0][1]b[/1]'), 2);
  // 第 2 段还没闭合 → 只算 1
  assert.equal(countClosedUnits('[0]a[/0][1]b'), 1);
  assert.equal(countClosedUnits('[0]a'), 0);
});

test('countClosedUnits: 空输入返回 0', () => {
  assert.equal(countClosedUnits(''), 0);
  assert.equal(countClosedUnits(null), 0);
});

test('countClosedUnits: 支持从中间序号继续（增量调用）', () => {
  // 已确认前 2 段闭合，从第 2 段接着数
  assert.equal(countClosedUnits('[0]a[/0][1]b[/1][2]c[/2]', 2), 3);
});

// ── parseRefine ───────────────────────────────────────────────────────────

test('parseRefine: 格式 A（<o>/<t> 标签）', () => {
  const r = parseRefine('<o>原文一句</o>\n<t>译文一句</t>', 'raw');
  assert.deepEqual(r, { original: '原文一句', translation: '译文一句' });
});

test('parseRefine: 格式 B（原文：/译文：）', () => {
  const r = parseRefine('原文：こんにちは\n译文：你好', 'raw');
  assert.equal(r.original, 'こんにちは');
  assert.equal(r.translation, '你好');
});

test('parseRefine: 有 <o> 漏写 <t> 时，把后续内容当译文', () => {
  const r = parseRefine('<o>原文</o>\n这句是译文', 'raw');
  assert.equal(r.original, '原文');
  assert.equal(r.translation, '这句是译文');
});

test('parseRefine: 两行兜底', () => {
  const r = parseRefine('第一行原文\n第二行译文', 'raw');
  assert.equal(r.original, '第一行原文');
  assert.equal(r.translation, '第二行译文');
});

test('parseRefine: 去掉 markdown 代码围栏', () => {
  const r = parseRefine('```\n<o>原文</o>\n<t>译文</t>\n```', 'raw');
  assert.deepEqual(r, { original: '原文', translation: '译文' });
});

test('parseRefine: 完全解析不出来时 original 回落到原始 ASR 文本', () => {
  const r = parseRefine('', '这是原始识别文本');
  assert.equal(r.original, '这是原始识别文本');
  assert.equal(r.translation, '');
});

test('parseRefine: 绝不用原文冒充译文', () => {
  // 只有一行输出：不能既当原文又当译文
  const r = parseRefine('只有一行', 'raw');
  assert.equal(r.translation, '');
});

// ── 幻觉剔除 ──────────────────────────────────────────────────────────────

test('normalizeCaption: 去标点空白并转小写', () => {
  assert.equal(normalizeCaption(' Thank you for watching! '), 'thankyouforwatching');
  assert.equal(normalizeCaption('ご視聴ありがとうございました。'), 'ご視聴ありがとうございました');
});

test('stripHallucination: 整片就是幻觉固定语 → 剔除', () => {
  assert.equal(stripHallucination('ご視聴ありがとうございました'), '');
  assert.equal(stripHallucination('感谢观看'), '');
  assert.equal(stripHallucination('Thank you for watching!'), '');
});

test('stripHallucination: 幻觉语 + 少量杂音也剔除', () => {
  assert.equal(stripHallucination('谢谢观看。'), '');
});

test('stripHallucination: 正常长句不被误伤', () => {
  const t = '今天我们来讲一下如何使用这个扩展的翻译功能';
  assert.equal(stripHallucination(t), t);
  // 句中恰好含"下集见"但内容远长于该短语 → 保留
  const t2 = '这一期的内容就到这里，下集见，别忘了先去看看前面几期的完整讲解';
  assert.equal(stripHallucination(t2), t2);
});

test('stripHallucination: 空输入返回空串', () => {
  assert.equal(stripHallucination(''), '');
  assert.equal(stripHallucination(null), '');
  assert.equal(stripHallucination('   '), '');
});

test('HALLUCINATION_NORM: 词条本身已归一化（无空白/标点/大写）', () => {
  for (const p of HALLUCINATION_NORM) {
    assert.equal(p, normalizeCaption(p), `词条未归一化：${p}`);
  }
});
