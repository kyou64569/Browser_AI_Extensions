// @ts-nocheck
// test/usage-flush.test.mjs
// 用量记录「缓冲 → 兜底调度 → 落盘」链路的回归测试。
// 修复的问题：旧实现只在缓冲攒满 20 条时才 flush、节流命中时直接放弃——
// MV3 SW 约 30 秒被杀，普通聊天一次 1~2 条记录永远凑不满，用量统计页长期空白。
// （ts-nocheck：文件内的 chrome.storage stub 无法实现完整 chrome.* 类型面，
//  checkJs 会逐字段报错；被测的 usage.js 本身仍在其它文件的检查范围内。）

import { test } from 'node:test';
import assert from 'node:assert/strict';

// recordCall/flushUsage 通过全局 chrome.storage.local 落盘；此处装一个最小 stub
const stored = new Map();
let setCalls = 0;
globalThis.chrome = {
  runtime: { lastError: null },
  storage: {
    local: {
      get(key, cb) { cb({ [key]: stored.get(key) }); },
      set(obj, cb) {
        setCalls++;
        for (const [k, v] of Object.entries(obj)) stored.set(k, v);
        if (cb) cb();
      },
    },
  },
};


const { recordCall, flushUsage } = await import('../shared/usage.js');
const LOG_KEY = 'usageLog';

test('recordCall 后即使不满 20 条也会被兜底调度落盘（SW 存活窗口内）', async () => {
  setCalls = 0;
  stored.clear();
  recordCall({ model: 'A', messages: [{ role: 'user', content: 'hi' }], completion: 'ok', durationMs: 5 });
  recordCall({ model: 'A', messages: [{ role: 'user', content: 'hi2' }], completion: 'ok2', durationMs: 5 });
  // 不满 20 条：不应同步落盘（攒批）
  // 等待兜底定时器（FLUSH_INTERVAL_MS=4000）触发
  await new Promise(r => setTimeout(r, 4600));
  const log = stored.get(LOG_KEY) || [];
  assert.ok(setCalls >= 1, '兜底定时器应触发至少一次 storage.local.set');
  assert.ok(log.length >= 2, `缓冲记录应完整落盘，实际 ${log.length} 条`);
  assert.ok(log.some(e => e.model === 'A' && e.outTok > 0), '记录内容应包含模型与 token 估算');
});

test('flushUsage 在节流窗口内不丢缓冲：延迟后仍会落盘（旧实现直接 return 丢弃机会）', async () => {
  setCalls = 0;
  stored.clear();
  // 先手工 flush 一次建立 _lastFlush（缓冲为空，仅记录时间）
  flushUsage();
  recordCall({ model: 'B', messages: [], completion: 'x' });
  // 立刻调用 flushUsage：处于节流窗口内，但必须安排定时器而不是放弃
  flushUsage();
  await new Promise(r => setTimeout(r, 4600));
  const log = stored.get(LOG_KEY) || [];
  assert.ok(log.some(e => e.model === 'B'), '节流窗口内的记录最终应落盘，实际日志：' + JSON.stringify(log).slice(0, 200));
});
