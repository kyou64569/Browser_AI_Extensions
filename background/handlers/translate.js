// background/handlers/translate.js
// 网页翻译 / 字幕翻译引擎 + 实时字幕整理（refine）。
//
// 设计要点（从原 service-worker.js 整体搬来，行为未改）：
// 1) token 预算分块 —— 按估算 token 分批而非固定段数，兼顾弱模型可靠性与额度消耗
// 2) TPM/RPM 速率门 —— 主动限流 + 429 自适应下调
// 3) 持久化 LRU 缓存 —— 跨刷新/跨标签页复用，命中即跳过模型调用
// 4) 遗漏防护重试 —— 解析失败/为空的单元单独重试，最多 2 轮
// 5) 动态并发 —— 429 与等待时长驱动并发上下调

import { getModels } from '../../shared/storage.js';
import { createClient } from '../../core/model-client.js';
import { chunkUnits, RateGate } from '../../core/translate-rate.js';
import { recordCall } from '../../shared/usage.js';
import { hasCred, optionsFromModel } from '../../shared/utils.js';
import { withRateLimitRetry, isTokenRateLimit } from '../../core/retry.js';
import { parseTranslateResponse, countClosedUnits, parseRefine } from '../../shared/text-parse.js';
import {
  TRANSLATE_MAX_BATCH_TOKENS,
  TRANSLATE_INITIAL_CONCURRENCY, TRANSLATE_MIN_CONCURRENCY, TRANSLATE_MAX_CONCURRENCY,
  DEFAULT_TPM, DEFAULT_RPM,
  TRANSLATE_TEMPERATURE,
  MIN_TRANS_TOKENS, MAX_TRANS_TOKENS, TRANS_TOKENS_PER_CHAR,
  TRANSLATE_CACHE_KEY, TRANSLATE_CACHE_MAX,
  TRANSLATE_CACHE_QUOTA_BYTES, TRANSLATE_CACHE_EVICT_TO_BYTES, TRANSLATE_CACHE_ENTRY_OVERHEAD,
  TRANSLATE_CONCURRENCY_WAIT_THRESHOLD_MS,
} from '../../shared/constants.js';

// ── 模块内私有状态（仅本 handler 使用，故不进 state.js）────────────────────
// SW 被杀死后这些会丢，但两者都可在下次使用时重建：
// 缓存会重新从 storage 载入，限流门重建后按真实 429 重新自适应。
let _cacheMem = null;             // Map<string,string> 译文缓存
let _cacheLoading = null;
let _cacheDirty = false;
const _gates = new Map();         // modelId -> RateGate

/** 收集 client.chat 的输出为整段文本；遇 429 退避重试。 */
function chatAllWithRetry(client, params, label = '') {
  return withRateLimitRetry(() => client.chat(params), {
    onRetry: (wait, round, total) =>
      console.warn(`[429${label ? ' ' + label : ''}] 退避 ${Math.round(wait / 1000)}s 后重试（第 ${round}/${total} 轮）`),
  });
}

/** 同上，但每个增量到达时回调 onDelta(累计文本)，用于翻译进度插值。 */
function chatStreamWithRetry(client, params, onDelta, label = '流式') {
  return withRateLimitRetry(() => client.chat(params), {
    onDelta,
    onRetry: (wait, round, total) =>
      console.warn(`[429 ${label}] 退避 ${Math.round(wait / 1000)}s 后重试（第 ${round}/${total} 轮）`),
  });
}

// 强约束放进 system，比只放 user 更能约束中小模型，从根源降低"照抄原文不翻译"的概率。
const TRANSLATE_SYSTEM_PROMPT = [
  'You are a professional real-time subtitle translator.',
  'Your ONLY job is to translate every input segment into the target language.',
  'Strict rules you MUST follow:',
  '1. Translate ALL segments. Never skip, omit, or leave a segment untranslated.',
  '2. NEVER copy a segment unchanged. If a segment is already in the target language or needs no change, still wrap it in its markers — but you must never output the original foreign text as your translation.',
  '3. Each segment is wrapped with [N] and [/N] markers (N = index starting at 0). Output ONLY the translated segments using the exact same [N]...[/N] format, in order.',
  '4. Do NOT add any explanations, headings, numbering, or markdown fences. Output nothing except the [N]...[/N] segments.',
  '5. Do not think step by step. Output the translated segments directly.',
  '6. Preserve verbatim (translate ONLY the surrounding natural-language text, never these): URLs (https://...), file paths, code snippets, programming identifiers, version numbers, brand/model/product names such as "Gemini-3.1-flash-lite", and ALL standalone numeric values with their units — e.g. "30", "1K", "500MB", "2.5s", "1920x1080", "¥1,200", "75%". These are data/parameters, not prose; keep them EXACTLY as in the source.',
].join('\n');

function buildTranslatePrompt(segments, targetLang) {
  const body = segments.map((s, i) => `[${i}]${s}[/${i}]`).join('\n');
  return `Translate the following segments into ${targetLang}.\n\n${body}`;
}

// ── 可持久化翻译缓存（跨刷新 / 跨标签页复用）────────────────────────────
// 缓存键为「原文文本」，值为「整项译文」。命中即跳过模型调用。
// 仅对网页翻译开启（字幕碎片上下文相关，关闭缓存避免陈旧/误译复用）。
async function loadTranslateCache() {
  if (_cacheMem) return _cacheMem;
  if (_cacheLoading) return _cacheLoading;
  _cacheLoading = (async () => {
    try {
      const r = await chrome.storage.local.get(TRANSLATE_CACHE_KEY);
      _cacheMem = new Map(Object.entries(r[TRANSLATE_CACHE_KEY] || {}));
    } catch (_) {
      _cacheMem = new Map();
    }
    return _cacheMem;
  })();
  return _cacheLoading;
}

async function persistTranslateCache() {
  if (!_cacheMem || !_cacheDirty) return;
  try {
    while (_cacheMem.size > TRANSLATE_CACHE_MAX) {
      const k = _cacheMem.keys().next().value;
      _cacheMem.delete(k);
    }
    // 按字节大小预检：先 stringify 一次得到最终对象，超出配额再按 FIFO 批量淘汰后重新序列化
    let obj = Object.fromEntries(_cacheMem);
    let payload = JSON.stringify(obj);
    if (payload.length > TRANSLATE_CACHE_QUOTA_BYTES) {
      const entries = [..._cacheMem.entries()];
      // 估算每条的近似字节贡献（key + ":" + value + 引号/逗号/花括号开销）
      const perEntry = entries.map(([k, v]) => ({ k, v, est: k.length + v.length + TRANSLATE_CACHE_ENTRY_OVERHEAD }));
      let total = perEntry.reduce((s, e) => s + e.est, 0);
      const evictTarget = total - TRANSLATE_CACHE_EVICT_TO_BYTES;
      let evictedBytes = 0;
      let evictedCount = 0;
      for (const e of perEntry) {
        if (evictedBytes >= evictTarget) break;
        _cacheMem.delete(e.k);
        total -= e.est;
        evictedBytes += e.est;
        evictedCount++;
      }
      obj = Object.fromEntries(_cacheMem);
      payload = JSON.stringify(obj);
      console.warn('[cache] 超出存储配额，已按字节淘汰 ' + evictedCount + ' 条（剩余 ' + _cacheMem.size + ' 条，当前约 ' + Math.round(payload.length / 1024) + ' KB）');
    }
    await chrome.storage.local.set({ [TRANSLATE_CACHE_KEY]: obj });
    _cacheDirty = false;  // 仅在写入成功后清除脏标记
  } catch (e) {
    console.warn('[cache] 持久化失败，下次重试：', e && e.message);
  }
}

function cacheGet(text) {
  if (!_cacheMem) return undefined;
  const v = _cacheMem.get(text);
  if (v !== undefined) { _cacheMem.delete(text); _cacheMem.set(text, v); } // 提到最近
  return v;
}

function cacheSet(text, val) {
  if (!_cacheMem) return;
  if (_cacheMem.has(text)) _cacheMem.delete(text);
  _cacheMem.set(text, val);
  _cacheDirty = true;
}

/** 每模型 TPM/RPM 限流门（会话内持久，支持 429 自适应下调） */
function getRateGate(model) {
  const id = model.id || model.model || 'default';
  let g = _gates.get(id);
  if (!g) {
    const tpm = (typeof model.tpm === 'number' && model.tpm > 0) ? model.tpm : DEFAULT_TPM;
    const rpm = (typeof model.rpm === 'number' && model.rpm > 0) ? model.rpm : DEFAULT_RPM;
    g = new RateGate({ tpm, rpm });
    _gates.set(id, g);
  }
  return g;
}

/**
 * 单批翻译 + 遗漏防护：解析失败/为空的单元单独重试（最多 2 轮），降低漏翻。
 * @returns {Promise<string[]>} 与 units 等长的译文数组（缺失单元由调用方保留原文）
 */
async function translateChunkWithRetry(client, baseOptions, units, targetLang, onStream) {
  const doOne = async (us) => {
    const inChars = us.reduce((s, u) => s + (u.text ? u.text.length : 0), 0);
    const maxTokens = Math.min(MAX_TRANS_TOKENS, Math.max(MIN_TRANS_TOKENS, Math.ceil(inChars * TRANS_TOKENS_PER_CHAR)));
    const prompt = buildTranslatePrompt(us.map(u => u.text), targetLang);
    const params = {
      messages: [{ role: 'system', content: TRANSLATE_SYSTEM_PROMPT }, { role: 'user', content: prompt }],
      // 翻译默认走流式（模型支持时）：逐增量回报，使慢模型进度条持续前进而非卡在 0%。
      stream: !!(client.config && client.config.supportsStream),
      options: { ...baseOptions, maxTokens },
    };
    let raw;
    if (params.stream) {
      raw = await chatStreamWithRetry(client, params, onStream);
    } else {
      raw = await chatAllWithRetry(client, params);
      if (onStream) onStream(raw); // 非流式模型：整批完成后回报一次（至少能推进到本批）
    }
    return { parsed: parseTranslateResponse(raw, us.length), raw };
  };
  const first = await doOne(units);
  const parsed = first.parsed;
  let lastRaw = first.raw;
  let missing = [];
  for (let k = 0; k < units.length; k++) {
    if (parsed[k] == null || !parsed[k].trim()) missing.push(k);
  }
  let round = 0;
  while (missing.length && round < 2) {
    const subUnits = missing.map(k => units[k]);
    const sub = await doOne(subUnits);
    lastRaw = sub.raw;
    const stillMissing = [];
    missing.forEach((k, j) => {
      if (sub.parsed[j] != null && sub.parsed[j].trim()) parsed[k] = sub.parsed[j].trim();
      else stillMissing.push(k);
    });
    missing = stillMissing;
    round++;
  }
  // 单段兜底：弱模型完全不遵守 [N][/N] 时，用整段原始输出
  if (units.length === 1 && (!parsed[0] || !parsed[0].trim())) {
    const flat = (lastRaw || '').trim();
    if (flat) parsed[0] = flat;
  }
  return parsed;
}

/**
 * 批量翻译文本段。
 * @param {import('../../core/model-config.js').ModelConfig} model 模型配置
 * @param {string[]} texts 原文数组
 * @param {string} targetLang 目标语言
 * @param {object} [opts]
 * @param {boolean} [opts.useCache=true] 是否启用持久化缓存（字幕碎片应传 false）
 * @param {(p:object)=>void} [opts.onProgress] 进度回调
 * @returns {Promise<string[]>} 与 texts 等长；未译出的位置保留原文
 */
export async function translateSegments(model, texts, targetLang, opts = {}) {
  const useCache = opts.useCache !== false;
  // 进度回调在顶部定义，确保早期 return（缓存命中/无需翻译）也能回传"完成"信号
  const onProgress = (typeof opts.onProgress === 'function') ? opts.onProgress : null;
  const result = texts.slice();
  const items = [];
  texts.forEach((t, i) => { if (t && String(t).trim()) items.push({ i, t: String(t) }); });
  if (!items.length) { if (useCache) await persistTranslateCache(); if (onProgress) onProgress({ phase: 'done', done: 0, total: 0, message: '无需翻译' }); return result; }

  let client;
  try { client = createClient(model); } catch (e) { throw new Error('翻译模型配置无效：' + e.message); }
  if (!client) throw new Error('无法创建翻译客户端');

  // 翻译专用参数：temperature 强制调低（不读取模型配置），其余采样参数沿用配置。
  // 注意：故意不读模型配置的 maxTokens —— 弱模型若未配置会落到厂商默认的小值，已用动态估算替代。
  const baseOptions = /** @type {Record<string, any>} */ ({ ...optionsFromModel(model), temperature: TRANSLATE_TEMPERATURE });
  // 翻译是确定性任务，强制关闭"思考/推理"：推理模型的 CoT token 同样计入 TPM，
  // 会瞬间吃光低配额模型额度 → 大量 429。关闭后既省 token 又不影响翻译速度。
  delete baseOptions.thinkingStrength;

  // 1) 持久化缓存命中：仅翻译未命中项（增量翻译，避免重复请求）
  if (useCache) {
    await loadTranslateCache();
    const stillUncached = [];
    for (const it of items) {
      const cached = cacheGet(it.t);
      if (cached !== undefined && cached !== '') result[it.i] = cached;
      else stillUncached.push(it);
    }
    if (!stillUncached.length) { await persistTranslateCache(); if (onProgress) onProgress({ phase: 'done', done: 0, total: 0, message: '已完成（全部命中缓存）' }); return result; }
    items.length = 0;
    items.push(...stillUncached);
  }

  // 2) 按 token 预算分块（句/段边界切分，避免破坏语义）
  const chunks = chunkUnits(items, TRANSLATE_MAX_BATCH_TOKENS);
  if (!chunks.length) { if (useCache) await persistTranslateCache(); if (onProgress) onProgress({ phase: 'done', done: 0, total: 0, message: '已完成' }); return result; }

  // 3) 速率门（按模型 TPM/RPM 主动限流；未配置则用宽松默认 + 429 自适应下调）
  const gate = getRateGate(model);

  // 4) 并发执行：动态并发 + 每批遗漏校验/重试 + TPM 自适应
  const byItem = new Map(); // itemIndex -> [{partIndex, text, sep}]
  let currentMax = TRANSLATE_INITIAL_CONCURRENCY;
  let nextIdx = 0;
  let activeCount = 0;
  let doneCount = 0;
  const total = chunks.length;
  // 进度按"句子单元"粒度统计（比按批更细），慢模型也能看到明显推进，而非长时间卡在 0%
  const totalUnits = chunks.reduce((s, c) => s + c.length, 0);
  let translatedUnits = 0;
  let maxReported = 0; // 保证进度单调不减（多批并发时各批回报值可能交错，避免进度条回退）
  let goodStreak = 0;
  let fallbackUnits = 0; // 翻译失败/保留原文（遗漏防护计数）

  const reportProgress = (done, indeterminate) => {
    if (!onProgress) return;
    const clamped = Math.max(maxReported, Math.min(totalUnits, done | 0));
    if (clamped > maxReported) maxReported = clamped;
    onProgress({ phase: 'translate', done: clamped, total: totalUnits, message: `翻译中… ${clamped}/${totalUnits}`, indeterminate: !!indeterminate });
  };

  if (onProgress) onProgress({ phase: 'start', done: 0, total: totalUnits, message: '准备翻译…', indeterminate: true });

  await /** @type {Promise<void>} */ (new Promise((resolve) => {
    const pump = () => {
      while (activeCount < currentMax && nextIdx < total) {
        const idx = nextIdx++;
        activeCount++;
        runChunk(idx).catch((e) => { console.error('[translate] chunk 执行异常', e); }).finally(() => {
          activeCount--;
          doneCount++;
          if (doneCount >= total) resolve();
          else pump();
        });
      }
      if (doneCount >= total) resolve();
    };

    async function runChunk(idx) {
      const chunk = chunks[idx];
      const inTok = chunk.reduce((s, u) => s + u.tok, 0);
      const inChars = chunk.reduce((s, u) => s + (u.text ? u.text.length : 0), 0);
      const maxTokens = Math.min(MAX_TRANS_TOKENS, Math.max(MIN_TRANS_TOKENS, Math.ceil(inChars * TRANS_TOKENS_PER_CHAR)));
      // 预约额度：输入 token + 输出预估(0.6*maxTokens) + prompt 开销，取保守预算
      const reserveTokens = inTok + Math.ceil(maxTokens * 0.6) + 250;
      const t0 = Date.now();
      let waited = 0;
      try { waited = await gate.reserve(reserveTokens); } catch (_) { waited = Date.now() - t0; }
      let hadTPM = false;
      // 流式进度：用 lastClosedCount 累积计数，只扫描增量内容，避免 O(n²)
      let lastClosedCount = 0;
      const onStream = (raw) => {
        const partial = countClosedUnits(raw, lastClosedCount);
        lastClosedCount = partial;
        reportProgress(translatedUnits + partial, false);
      };
      try {
        const parsed = await translateChunkWithRetry(client, baseOptions, chunk, targetLang, onStream);
        chunk.forEach((u, k) => {
          const tr = (parsed[k] != null && parsed[k].trim() !== '') ? parsed[k].trim() : u.text;
          if (tr === u.text) fallbackUnits++; // 未能翻译，保留原文（遗漏计数）
          if (!byItem.has(u.itemIndex)) byItem.set(u.itemIndex, []);
          byItem.get(u.itemIndex).push({ partIndex: u.partIndex, text: tr, sep: u.sep });
        });
        // 本批完成：累加单元数并回报一个确定到本批终点的进度（与流式插值平滑衔接）
        translatedUnits += chunk.length;
        reportProgress(translatedUnits, false);
      } catch (e) {
        if (isTokenRateLimit(e)) { hadTPM = true; gate.onTokenRateLimit(); }
        // 整批失败（含 TPM 重试后仍失败）：保留原文，不中断其它批次
        chunk.forEach((u) => {
          if (!byItem.has(u.itemIndex)) byItem.set(u.itemIndex, []);
          byItem.get(u.itemIndex).push({ partIndex: u.partIndex, text: u.text, sep: u.sep });
        });
        console.error('[translate] 整批翻译失败，保留原文：', e && e.message);
      }
      // 动态调整并发（监控配额占用与 429）
      if (hadTPM) { currentMax = Math.max(TRANSLATE_MIN_CONCURRENCY, currentMax - 1); goodStreak = 0; }
      else if (waited > TRANSLATE_CONCURRENCY_WAIT_THRESHOLD_MS) { currentMax = Math.max(TRANSLATE_MIN_CONCURRENCY, currentMax - 1); }
      else { goodStreak++; if (goodStreak >= 3) { currentMax = Math.min(TRANSLATE_MAX_CONCURRENCY, currentMax + 1); goodStreak = 0; } }
    }

    pump();
  }));

  if (onProgress) onProgress({ phase: 'done', done: totalUnits, total: totalUnits, message: '翻译完成' });

  // 5) 跨块重排并拼回每个原始项（同一项被拆到多处/多批时按 partIndex 排序拼接）
  for (const [itemIndex, parts] of byItem) {
    parts.sort((a, b) => a.partIndex - b.partIndex);
    const joined = parts.map(p => (p.text || '') + (p.sep || '')).join('');
    if (joined.trim()) result[itemIndex] = joined;
  }

  // 6) 写回持久化缓存（仅记录确实翻译成功、且与原文不同的项）
  if (useCache) {
    for (const it of items) {
      const v = result[it.i];
      if (v && v.trim() && v !== it.t) cacheSet(it.t, v);
    }
    await persistTranslateCache();
  }

  if (fallbackUnits > 0) console.warn(`[translate] 完成：${items.length} 项（${chunks.length} 批），约 ${fallbackUnits} 个单元未能翻译、保留原文`);
  return result;
}

// ============================================================
// 实时字幕整理（refine）：把一句话的 ASR 碎片合并成通顺原文并翻译，
// 用于替换内容脚本里"逐词堆砌 + 零散翻译"的草稿。返回 { original, translation }。
// ============================================================

/** 源语言中文标签 → 英文（用于 refine 提示词，让模型能理解并纠正误识语种） */
const LANG_EN = {
  '日语': 'Japanese', '英语': 'English', '韩语': 'Korean', '法语': 'French', '德语': 'German',
  '西班牙语': 'Spanish', '俄语': 'Russian', '葡萄牙语': 'Portuguese', '意大利语': 'Italian',
  '泰语': 'Thai', '越南语': 'Vietnamese', '中文（简体）': 'Chinese', '中文（繁体）': 'Chinese',
};

// refine 提示词按源语种动态生成：明确"所有碎片都应属源语种"，
// 并指示模型把误识成其他语种（如日语语音被识别成韩语/俄语）的碎片纠正回源语种。
function buildRefineSystem(srcEn) {
  return [
    'You are a real-time subtitle post-editor and translator.',
    'You receive raw speech-recognition (ASR) fragments of ONE spoken utterance, in order.',
    'They may contain duplicated words, wrong word breaks, or minor recognition errors.',
    `The speaker is speaking ${srcEn}. ALL fragments should be in that language.`,
    `If any fragment was mis-recognized in a WRONG language (e.g., Korean/Russian text when the source is Japanese), convert it back to ${srcEn} before merging — never leave foreign-language text in the cleaned sentence.`,
    'Do the following:',
    '1. Merge and clean the fragments into ONE fluent, correctly punctuated sentence in the ORIGINAL spoken language. Only fix obvious ASR artifacts; NEVER invent content that was not spoken.',
    '2. Translate that cleaned sentence into the target language faithfully and naturally.',
    'Output STRICTLY in ONE of these formats and nothing else (no explanations, no markdown fences, no thinking):',
    'Format A:',
    '<o>cleaned original sentence</o>',
    '<t>translation</t>',
    'Format B (if tags are hard to produce):',
    '原文：cleaned original sentence',
    '译文：translation',
  ].join('\n');
}

/**
 * 把 ASR 碎片整理成通顺原文并翻译。
 * @returns {Promise<{original:string, translation:string}>}
 */
export async function refineCaption(model, fragments, targetLang, sourceLang) {
  let client;
  try { client = createClient(model); } catch (e) { throw new Error('翻译模型配置无效：' + e.message); }
  if (!client) throw new Error('无法创建翻译客户端');
  // 与翻译一致：强制低 temperature，抑制幻觉式改写/编造。
  const options = { ...optionsFromModel(model), temperature: TRANSLATE_TEMPERATURE };
  const raw = fragments.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const srcLabel = (sourceLang && String(sourceLang).trim()) || '';
  const srcEn = LANG_EN[srcLabel] || srcLabel || "the user's spoken language";
  const prompt = `Target language: ${targetLang}\nSource (spoken) language: ${srcEn} (${srcLabel || 'auto'})\n\nASR fragments:\n${raw}`;
  const out = await chatAllWithRetry(client, {
    messages: [{ role: 'system', content: buildRefineSystem(srcEn) }, { role: 'user', content: prompt }],
    stream: false, options,
  });
  return parseRefine(out, raw);
}

/**
 * 网页翻译 / 字幕翻译的统一入口（去重模型选择逻辑 + 凭证检查）。
 * @param {string} modelId
 * @param {string} targetLang
 * @param {string[]} items
 * @param {object} [opts] 透传给 translateSegments
 */
export async function handleTranslateBatch(modelId, targetLang, items, opts = {}) {
  if (!Array.isArray(items)) return { ok: false, error: '参数错误：待翻译内容必须是数组' };
  const models = await getModels();
  const model = models.find(m => m.id === modelId)
    || models.find(m => m.enabled !== false && m.isPrimary)
    || models.find(m => m.enabled !== false);
  if (!model) return { ok: false, error: '未找到可用翻译模型，请先在设置添加模型' };
  if (!hasCred(model)) return { ok: false, error: '翻译模型缺少有效凭证（API Key）' };
  const t0 = Date.now();
  try {
    const translations = await translateSegments(model, items, targetLang || '中文（简体）', opts);
    recordCall({ model: model.name, vendor: model.vendor, kind: 'translate', ok: true,
      messages: [{ role: 'user', content: items.join('\n') }],
      completion: (translations || []).join('\n'), durationMs: Date.now() - t0 });
    return { ok: true, translations };
  } catch (e) {
    recordCall({ model: model.name, vendor: model.vendor, kind: 'translate', ok: false,
      messages: [{ role: 'user', content: items.join('\n') }], completion: '', durationMs: Date.now() - t0 });
    throw e;
  }
}
