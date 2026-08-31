// shared/usage.js
// 模型用量统计：调用记录的收集（带节流落盘）+ 纯函数聚合。
//
// 设计取舍：
// - token 数为「字符估算」（中文≈1字/1token、英文≈4字符/1token 的混合折算），非厂商精确值。
//   各厂商流式响应的 usage 字段格式不一（OpenAI 在末帧 / Anthropic 在 message_delta / Gemini 在 usageMetadata），
//   逐家精确解析的收益不足以抵消脆弱性；估算值足够支撑"用量趋势 / 相对成本"的判断。
// - 记录写入 chrome.storage.local（key = usageLog），带节流与容量上限，避免高频翻译请求打爆存储。
// - 非 chrome 环境（单测 / dev-server 预览）只进内存，不落盘。

const LOG_KEY = 'usageLog';
const MAX_ENTRIES = 2000;   // 日志条数上限（超出丢最旧）
const FLUSH_INTERVAL_MS = 4000;

/** 内存缓冲 + 最近一次 flush 时间 */
let _buf = [];
let _lastFlush = 0;

/**
 * 估算一段文本的 token 数（粗估：CJK 字符 ≈ 1 token/字，其他 ≈ 1 token/4 字符）。
 * @param {string} s
 * @returns {number}
 */
export function estimateTokens(s) {
  if (!s) return 0;
  const str = String(s);
  const cjk = (str.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const rest = str.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

/**
 * 由消息数组与回复文本估算一次调用的 输入/输出 token。
 * @param {Array<{role:string, content:string}>} messages
 * @param {string} completion
 * @returns {{inTok:number, outTok:number}}
 */
export function estimateCallTokens(messages, completion) {
  const inText = (messages || []).map(m => m && m.content ? String(m.content) : '').join('\n');
  return {
    inTok: estimateTokens(inText),
    outTok: estimateTokens(completion || ''),
  };
}

/**
 * 记录一次模型调用。失败/中止的调用也记录（ok:false），便于观察降级频率。
 * @param {{model:string, vendor?:string, kind?:string, ok?:boolean,
 *          messages?:Array<{role:string,content:string}>, completion?:string,
 *          durationMs?:number}} entry
 */
export function recordCall(entry) {
  if (!entry || !entry.model) return;
  const est = estimateCallTokens(entry.messages, entry.completion);
  _buf.push({
    t: Date.now(),
    model: String(entry.model),
    vendor: entry.vendor || '',
    kind: entry.kind || 'chat',          // chat | summarize | translate | agent ...
    ok: entry.ok !== false,
    inTok: est.inTok,
    outTok: est.outTok,
    ms: Math.max(0, Math.round(entry.durationMs || 0)),
  });
  if (_buf.length >= 20) void flushUsage();
}

/** 把缓冲写入 storage.local（节流：距上次 flush 不足 FLUSH_INTERVAL_MS 则等待下批）。非 chrome 环境丢弃缓冲。 */
export function flushUsage() {
  const now = Date.now();
  if (_buf.length && now - _lastFlush < FLUSH_INTERVAL_MS) return; // 攒批，下次再写
  _lastFlush = now;
  const batch = _buf;
  _buf = [];
  if (!batch.length) return;
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
  chrome.storage.local.get(LOG_KEY, (r) => {
    const log = /** @type {any[]} */ (Array.isArray(r && r[LOG_KEY]) ? r[LOG_KEY] : []);
    const next = log.concat(batch).slice(-MAX_ENTRIES);
    try { chrome.storage.local.set({ [LOG_KEY]: next }, () => { void chrome.runtime.lastError; }); }
    catch (_) { /* storage 不可用（如卸载中），静默 */ }
  });
}

/**
 * 聚合用量日志（纯函数）。
 * @param {Array<{t:number, model:string, kind?:string, ok?:boolean, inTok?:number, outTok?:number, ms?:number}>} log
 * @param {object} [opts]
 * @param {number} [opts.days=7] 按天分桶的天数（0 = 不分天）
 * @returns {{total:{calls:number, ok:number, inTok:number, outTok:number, ms:number},
 *            byModel:Array<{model:string, calls:number, inTok:number, outTok:number, ms:number}>,
 *            byDay:Array<{day:string, calls:number, inTok:number, outTok:number}>}}
 */
export function aggregateUsage(log, opts = {}) {
  const days = opts.days == null ? 7 : opts.days;
  const total = { calls: 0, ok: 0, inTok: 0, outTok: 0, ms: 0 };
  const byModel = new Map();
  const byDay = new Map();
  const dayKeys = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    dayKeys.push(key);
    byDay.set(key, { calls: 0, inTok: 0, outTok: 0 });
  }
  for (const e of log || []) {
    if (!e) continue;
    const inTok = e.inTok || 0;
    const outTok = e.outTok || 0;
    total.calls++;
    if (e.ok !== false) total.ok++;
    total.inTok += inTok;
    total.outTok += outTok;
    total.ms += e.ms || 0;

    const model = String(e.model || '未知');
    const m = byModel.get(model) || { model, calls: 0, inTok: 0, outTok: 0, ms: 0 };
    m.calls++; m.inTok += inTok; m.outTok += outTok; m.ms += e.ms || 0;
    byModel.set(model, m);

    if (days > 0 && e.t) {
      const d = new Date(e.t);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const day = byDay.get(key);
      if (day) { day.calls++; day.inTok += inTok; day.outTok += outTok; }
    }
  }
  return {
    total,
    byModel: [...byModel.values()].sort((a, b) => (b.inTok + b.outTok) - (a.inTok + a.outTok)),
    byDay: dayKeys.map(k => ({ day: k, ...(byDay.get(k)) })),
  };
}

/**
 * 清理过期日志（纯函数）：保留最近 maxAgeDays 天且最多 maxEntries 条。
 * @param {Array<{t:number}>} log
 * @param {{maxAgeDays?:number, maxEntries?:number}} [opts]
 * @returns {Array}
 */
export function trimUsageLog(log, opts = {}) {
  const maxAgeDays = opts.maxAgeDays == null ? 90 : opts.maxAgeDays;
  const maxEntries = opts.maxEntries == null ? MAX_ENTRIES : opts.maxEntries;
  const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
  const arr = (log || []).filter(e => e && e.t && e.t >= cutoff);
  return arr.slice(-maxEntries);
}
