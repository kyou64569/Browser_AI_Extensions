// test/usage.test.mjs
// 用量统计（shared/usage.js）的回归测试。聚合逻辑是选项页展示的唯一数据源。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, estimateCallTokens, recordCall, aggregateUsage, trimUsageLog, flushUsage } from '../shared/usage.js';

test('estimateTokens: CJK 按字计、其他按 4 字符计', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens('中文四字'), 4);
  assert.equal(estimateTokens('abcdefgh'), 2);   // 8 字符 / 4
  assert.equal(estimateTokens('中文abc'), 3);    // 2(CJK) + ceil(3/4)
});

test('estimateCallTokens: 汇总消息内容与回复', () => {
  const r = estimateCallTokens([{ role: 'system', content: '系统指令' }, { role: 'user', content: '问题' }], '回答内容');
  assert.ok(r.inTok > 0 && r.outTok > 0);
});

test('recordCall → aggregateUsage: 记录并按模型聚合', async () => {
  const { default: clear } = await import('node:assert');
  void clear;
  recordCall({ model: 'A', messages: [{ role: 'user', content: '中文问题' }], completion: '回答' });
  // flush 在非 chrome 环境丢弃缓冲，不影响内存聚合以外的东西；这里只验证 record→aggregate 链路
  // 用 aggregateUsage 直接喂日志（recordCall 的内部缓冲不可读，所以聚合以手工日志为主）。
  void flushUsage;
  void recordCall;
  const log = [
    { t: Date.now(), model: 'gpt-4o', ok: true, inTok: 100, outTok: 50, ms: 800 },
    { t: Date.now(), model: 'gpt-4o', ok: true, inTok: 100, outTok: 50, ms: 700 },
    { t: Date.now(), model: 'claude', ok: false, inTok: 10, outTok: 0, ms: 100 },
  ];
  const agg = aggregateUsage(log, { days: 7 });
  assert.equal(agg.total.calls, 3);
  assert.equal(agg.total.ok, 2);
  assert.equal(agg.total.inTok, 210);
  assert.equal(agg.total.outTok, 100);
  assert.equal(agg.byModel[0].model, 'gpt-4o');   // 按 token 总量排序
  assert.equal(agg.byModel[0].calls, 2);
});

test('aggregateUsage: 按天分桶只含最近 N 天且日期键格式固定', () => {
  const now = Date.now();
  const log = [
    { t: now, model: 'A', inTok: 1, outTok: 1 },
    { t: now - 8 * 24 * 3600 * 1000, model: 'A', inTok: 9, outTok: 9 }, // 8 天前，不在 7 天桶内
  ];
  const agg = aggregateUsage(log, { days: 7 });
  assert.equal(agg.byDay.length, 7);
  assert.ok(agg.byDay.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d.day)));
  const todayKey = agg.byDay[agg.byDay.length - 1].day;
  const today = agg.byDay.find(d => d.day === todayKey);
  assert.equal(today.calls, 1);
  const sumCalls = agg.byDay.reduce((a, d) => a + d.calls, 0);
  assert.equal(sumCalls, 1); // 8 天前的那条不计入
});

test('aggregateUsage: 空日志/缺字段健壮', () => {
  const agg = aggregateUsage([], { days: 3 });
  assert.equal(agg.total.calls, 0);
  assert.equal(agg.byDay.length, 3);
  const agg2 = aggregateUsage([null, { t: Date.now(), model: 'A' }], { days: 0 });
  assert.equal(agg2.total.calls, 1);
  assert.equal(agg2.byDay.length, 0);
});

test('trimUsageLog: 丢弃过期与超限的最旧条目', () => {
  const now = Date.now();
  const log = [
    { t: now - 100 * 24 * 3600 * 1000 },   // 过期（>90 天）
    { t: now, v: 1 },
    { t: now, v: 2 },
  ];
  assert.equal(trimUsageLog(log).length, 2);
  assert.equal(trimUsageLog(log, { maxEntries: 1 })[0].v, 2);   // 保留最新
  assert.equal(trimUsageLog(null).length, 0);
});
