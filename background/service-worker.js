// background/service-worker.js
// MV3 service worker：模块装配中枢。持有 router / fallback / kb 连接器。
// 通过消息与 side panel / popup / content script 通信。

import { getModels, getKbConfig, getWhisperModels } from '../shared/storage.js';
import { summarizePage } from '../features/summarize.js';
import { LocalKbConnector } from '../connectors/local-kb.js';
import { OnlineKbConnector } from '../connectors/online-kb.js';
import { execTool } from './web-tools.js';
import { createClient } from '../core/model-client.js';
import { chunkUnits, RateGate } from '../core/translate-rate.js';
import { hasCred, optionsFromModel } from '../shared/utils.js';

/** Chrome 内部页面（无法注入 content script，也无法被 tabCapture 捕获音频） */
const CHROME_PAGE_HINT =
  '当前页面为浏览器内部页面（chrome://、edge:// 等），无法捕获音频。请在普通视频网页（如 bilibili、YouTube）上打开本扩展并开启字幕。';
function isChromeInternalPage(url) {
  if (!url) return false;
  return /^(chrome|chrome-extension|chrome-search|edge|about|file|devtools|view-source):/i.test(url);
}

/** 右键普通网页：授予该标签页 activeTab 权限（用户手势触发），并打开侧边栏供点“开启字幕” */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.remove('ai-open-live-caption', () => {
    if (chrome.runtime.lastError) { /* 首次安装时菜单不存在，忽略 */ }
    chrome.contextMenus.create({
      id: 'ai-open-live-caption',
      title: 'AI 助手：开启实时字幕',
      contexts: ['page'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    }, () => { if (chrome.runtime.lastError) console.warn('[contextMenu]', chrome.runtime.lastError); });
  });
});
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'ai-open-live-caption' || !tab || !tab.id) return;
  // 右键点击普通网页本身即授予该标签页 activeTab；再打开侧边栏即可正常捕获。
  try { await chrome.sidePanel.open({ tabId: tab.id }); } catch (_) {}
});

/** 获取当前最活跃的标签页 */
async function getActiveTab() {
  // 1. 尝试当前窗口的活动标签页
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) return tab;
  } catch (_) {}

  // 2. 尝试最后聚焦的窗口的活动标签页
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && tab.id) return tab;
  } catch (_) {}

  // 3. 尝试所有窗口的活动标签页中，不是扩展或系统页面的那一个
  try {
    const tabs = await chrome.tabs.query({ active: true });
    if (tabs && tabs.length > 0) {
      const normalTab = tabs.find(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about'));
      if (normalTab) return normalTab;
      return tabs[0];
    }
  } catch (_) {}

  return null;
}

/** 延迟聚合流式输出，通过 port 推给侧边栏 */
async function runSummarize(port) {
  const models = await getModels();
  if (!models.length) {
    port?.postMessage({ type: 'ERROR', message: '请先在设置页添加模型' });
    return;
  }
  const kbCfg = await getKbConfig();
  let kb = null;
  if (kbCfg.type === 'local') kb = new LocalKbConnector(kbCfg.cfg || {});
  else if (kbCfg.type === 'online') kb = new OnlineKbConnector(kbCfg.cfg || {});

  // 取当前标签页正文
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    port?.postMessage({ type: 'ERROR', message: '无法获取当前标签页' });
    return;
  }
  const page = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PAGE' });

  // 收集完整文本（流式默认，但先聚合便于简单展示）
  const onFallback = (i, cfg, reason) => {
    port?.postMessage({ type: 'FALLBACK', index: i, name: cfg.name, reason });
  };

  try {
    const result = await summarizePage(
      { models },
      page,
      { kb, onFallback, stream: false }
    );
    port?.postMessage({ type: 'RESULT', text: result.text, used: result.used.name, tried: result.tried });
  } catch (e) {
    port?.postMessage({ type: 'ERROR', message: e.message });
  }
}

// ============================================================
// 网页翻译：content script 收集页面文本节点后，分批交给所选模型翻译。
// 每段用 [N]…[/N] 包裹，要求模型仅返回同格式译文，便于稳定解析。
// ============================================================
// 每批 token 预算（软上限）：按估算 token 数分块，而非固定段数。
// 兼顾“弱模型可靠性”（单批别太大，避免 lost-in-the-middle / 输出截断）
// 与“免费额度 TPM/RPM”（单批别太小，减少调用次数）。句/段边界切分见 core/translate-rate.js。
const MAX_BATCH_TOKENS = 2200;
// 动态并发范围：在 TPM 配额允许内适度并发以提速；监控配额占用与 429 自适应下调（优化需求 5）。
const INITIAL_CONCURRENCY = 2;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 6;
// 模型未显式配置 tpm/rpm 时的宽松默认：基本不主动限流，
// 真正保护来自“429 自适应下调 + 退避重试”（见 RateGate.onTokenRateLimit）。如显式配置则按真实配额限流。
const DEFAULT_TPM = 1000000;
const DEFAULT_RPM = 60;
// 翻译是确定性任务，temperature 不读取模型配置，强制调低以减少漏翻/幻觉式复制原文。
const TRANSLATE_TEMPERATURE = 0.1;
// 输出 token 上限（按每批输入长度动态估算并夹在 [MIN,MAX] 内）。
// 关键修复：翻译原先完全不传 max_tokens，弱模型落到厂商默认值（常很小）→ 长批次输出被截断，
// 正则只解析出前若干段 → 其余保留原文 = “翻译一半”。动态给足上限即可根治。
// 注意：这只是一个“上限”，模型不会故意生成到上限，因此不会拖慢、也不会触发推理。
const MIN_TRANS_TOKENS = 2048;
const MAX_TRANS_TOKENS = 8192;
const TRANS_TOKENS_PER_CHAR = 0.8; // 输入字符→输出 token 的粗略系数（中文约 1.5 字符/token）

// ---------- 429（限流）退避重试：第二道防线 ----------
// 主防线是把调用频率降到配额内（Whisper=offscreen VAD 一句一片；翻译=每句一次）。
// 但突发峰值仍可能偶发 429，这里统一做“退避重试”，避免偶发限流直接丢句。
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isRateLimit(e) {
  const s = (e && e.message) ? e.message : String(e || '');
  return /\b429\b|rate.?limit|too many requests|quota/i.test(s);
}
// TPM（tokens per minute）限流：错误文本含 TPM / tokens per minute 等关键字。
// 与 RPM 不同，TPM 是 60 秒滚动窗口——需等旧 token 从窗口“滑出”才能腾出额度，
// 原短退避（0.8~2.4s）毫无作用 → 立刻再次 429 → 放弃整批（漏翻）。这里改为长退避。
function isTokenRateLimit(e) {
  const s = (e && e.message) ? e.message : String(e || '');
  return /\bTPM\b|tokens per minute|tokens\/min|token limit|token rate/i.test(s);
}
// 尽力从错误文本解析服务端给的 retry-after（秒）。部分厂商会塞进 body/header，
// 但 HttpError 当前不携带响应头，故此处的解析仅为“锦上添花”，失败则回退到固定长退避。
function parseRetryAfterSec(e) {
  const s = (e && e.message) ? e.message : '';
  const m = s.match(/retry-after[:\s]+(\d+)/i) || s.match(/try again in\s+(\d+)\s*s/i) || s.match(/reset in\s+(\d+)\s*s/i);
  return m ? Number(m[1]) : null;
}
// 收集 client.chat 的流式输出为整段文本；遇 429 退避重试（最多 3 轮）。
async function chatAllWithRetry(client, params) {
  const MAX_ROUNDS = 3;
  let lastErr;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    try {
      let out = '';
      for await (const c of client.chat(params)) out += (c && c.delta) || '';
      return out;
    } catch (e) {
      lastErr = e;
      if (round < MAX_ROUNDS - 1 && isRateLimit(e)) {
        const explicit = parseRetryAfterSec(e);
        if (isTokenRateLimit(e)) {
          // TPM：等滚动窗口释放额度。优先用服务端 retry-after，否则退避 ~25s（接近一个窗口周期）。
          const wait = (explicit != null ? explicit : 25) * 1000;
          console.warn(`[429 TPM] 退避 ${Math.round(wait / 1000)}s 后重试（第 ${round + 1}/${MAX_ROUNDS - 1} 轮）`);
          await sleep(wait);
        } else {
          // 其它限流（RPM 等）：原指数退避，叠加服务端 retry-after（若有）。
          const base = 800 * (round + 1);
          const wait = explicit != null ? explicit * 1000 : base;
          await sleep(wait);
        }
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// 流式收集 + 429 重试（与 chatAllWithRetry 同款重试策略），并在每个增量到达时回调 onDelta(累计文本)。
// 用于翻译进度：让慢模型在整批返回前也能持续回报“句子单元级”进度，而不是长时间卡在 0%。
async function chatStreamWithRetry(client, params, onDelta) {
  const MAX_ROUNDS = 3;
  let lastErr;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    try {
      let out = '';
      for await (const c of client.chat(params)) {
        out += (c && c.delta) || '';
        if (onDelta) onDelta(out);
      }
      return out;
    } catch (e) {
      lastErr = e;
      if (round < MAX_ROUNDS - 1 && isRateLimit(e)) {
        const explicit = parseRetryAfterSec(e);
        if (isTokenRateLimit(e)) {
          const wait = (explicit != null ? explicit : 25) * 1000;
          console.warn(`[429 TPM·流式] 退避 ${Math.round(wait / 1000)}s 后重试（第 ${round + 1}/${MAX_ROUNDS - 1} 轮）`);
          await sleep(wait);
        } else {
          const base = 800 * (round + 1);
          const wait = explicit != null ? explicit * 1000 : base;
          await sleep(wait);
        }
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// 强约束放进 system，比只放 user 更能约束中小模型，从根源降低“照抄原文不翻译”的概率。
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

function parseTranslateResponse(text, count) {
  const map = new Array(count).fill(undefined);
  const re = /\[(\d+)\]([\s\S]*?)\[\/\1\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const idx = Number(m[1]);
    if (idx >= 0 && idx < count && !map[idx]) { // 防止重复覆盖
      map[idx] = m[2];
    }
  }
  const filled = map.filter(v => v !== undefined).length;
  // 行序兜底：弱模型常完全不遵守 [N][/N] 标记 → 正则一个都匹配不到，整批报废。
  // 此时若输出行数与段数大致相当，按行顺序对齐回填，至少把整批救回来（宁可偶尔错位，也不整批丢失）。
  // 仅当 marker 几乎完全缺失（filled===0）时启用，避免干扰正常遵守格式的强模型。
  if (filled === 0 && count > 1) {
    const lines = (text || '').split(/\r?\n/).map(l => l.trim());
    const real = [];
    for (const l of lines) {
      const cleaned = l.replace(/^\[\d+\]\s*/, '').replace(/\[\/\d+\]\s*$/, '').trim(); // 去掉残留的 [N] 残片
      if (cleaned) real.push(cleaned);
    }
    if (real.length >= Math.ceil(count * 0.8) && real.length <= Math.ceil(count * 1.5)) {
      for (let i = 0; i < count && i < real.length; i++) map[i] = real[i];
      return map;
    }
  }
  if (filled < count) {
    console.warn(`Translation parsing: only ${filled}/${count} segments parsed`);
  }
  return map;
}

// 统计流式输出文本里已完整闭合的 [N]…[/N] 单元数。
// 翻译提示词要求模型按 0,1,2… 顺序输出带标记分段，故从 0 起顺序统计“已闭合”的单元数，
// 即可在流式翻译过程中做“句子单元级”进度插值（慢模型在整批返回前也能持续向前推进）。
function countClosedUnits(raw, fromIdx = 0) {
  if (!raw) return 0;
  let count = fromIdx, idx = fromIdx;
  while (true) {
    const open = raw.indexOf('[' + idx + ']', count ? 0 : 0);
    if (open === -1) break;
    const close = raw.indexOf('[/' + idx + ']', open);
    if (close === -1) break;
    count++;
    idx++;
  }
  return count;
}

// ---------- 可持久化翻译缓存（跨刷新 / 跨标签页复用，满足「增量翻译 + 缓存」）----------
// 缓存键为「原文文本」，值为「整项译文」。命中即跳过模型调用；翻译成功后写回。
// 仅对网页翻译开启（字幕碎片上下文相关，关闭缓存避免陈旧/误译复用）。
const TRANSLATE_CACHE_KEY = 'translateCache';
const TRANSLATE_CACHE_MAX = 3000; // LRU 上限，超出从头淘汰
let _cacheMem = null;             // Map<string,string>
let _cacheLoading = null;
let _cacheDirty = false;

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
    // 按字节大小预检，避免超出 chrome.storage.local 配额（~5MB，与全扩展共享）
    const payload = JSON.stringify(Object.fromEntries(_cacheMem));
    if (payload.length > 4_500_000) {
      // 超出配额时按字节淘汰最老项直到安全线
      const entries = [..._cacheMem.entries()];
      _cacheMem.clear();
      for (const [k, v] of entries) {
        const next = JSON.stringify({ ...Object.fromEntries(_cacheMem), [k]: v });
        if (next.length > 4_000_000) break;
        _cacheMem.set(k, v);
      }
      console.warn('[cache] 超出存储配额，已按字节淘汰部分缓存（当前约 ' + Math.round(JSON.stringify(Object.fromEntries(_cacheMem)).length / 1024) + ' KB）');
    }
    await chrome.storage.local.set({ [TRANSLATE_CACHE_KEY]: Object.fromEntries(_cacheMem) });
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

// ---------- 每模型 TPM/RPM 限流门（会话内持久，支持 429 自适应下调）----------
const _gates = new Map();
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

// 单批翻译 + 遗漏防护：解析失败/为空的单元单独重试（最多 2 轮），降低漏翻（优化需求 4）。
// 返回与 units 等长的译文数组（缺失单元保留原文）。
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
  // 收集解析失败/空的单元位置
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
  // 单段兜底：弱模型完全不遵守 [N][/N] 时，用整段原始输出（parseTranslateResponse 行序兜底已覆盖大部分）
  if (units.length === 1 && (!parsed[0] || !parsed[0].trim())) {
    const flat = (lastRaw || '').trim();
    if (flat) parsed[0] = flat;
  }
  return parsed;
}

async function translateSegments(model, texts, targetLang, opts = {}) {
  const useCache = opts.useCache !== false;
  // 进度回调（可选）：在顶部定义，确保早期 return（缓存命中/无需翻译）也能回传“完成”信号给侧边栏
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
  const baseOptions = { ...optionsFromModel(model), temperature: TRANSLATE_TEMPERATURE };
  // 翻译是确定性任务，强制关闭“思考/推理”：推理模型（如 gpt-oss 经 OpenRouter）的 CoT 推理 token
  // 同样计入 TPM，会瞬间吃光低配额模型额度（如仅 8000 TPM）→ 大量 429。翻译不需要推理；
  // 关闭后既省 token 又避免限流，且不影响正常翻译速度（adapter 仅在 thinkingStrength && !== 'off' 时发 reasoning_effort）。
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

  // 2) 按 token 预算分块（句/段边界切分，避免破坏语义）—— 优化需求 1
  const chunks = chunkUnits(items, MAX_BATCH_TOKENS);
  if (!chunks.length) { if (useCache) await persistTranslateCache(); if (onProgress) onProgress({ phase: 'done', done: 0, total: 0, message: '已完成' }); return result; }

  // 3) 速率门（按模型 TPM/RPM 主动限流；未配置则用宽松默认 + 429 自适应下调）—— 优化需求 2
  const gate = getRateGate(model);
  // 注：onProgress 已在函数顶部定义（让缓存命中/无需翻译等早期 return 也能回传进度）。

  // 4) 并发执行：动态并发 + 每批遗漏校验/重试 + TPM 自适应 —— 优化需求 4/5
  const byItem = new Map(); // itemIndex -> [{partIndex, text, sep}]
  let currentMax = INITIAL_CONCURRENCY;
  let nextIdx = 0;
  let activeCount = 0;
  let doneCount = 0;
  const total = chunks.length;
  // 进度按“句子单元”粒度统计（比按批更细），慢模型也能看到明显推进，而非长时间卡在 0%
  const totalUnits = chunks.reduce((s, c) => s + c.length, 0);
  let translatedUnits = 0;
  let maxReported = 0; // 保证进度单调不减（多批并发时各批回报值可能交错，避免进度条回退）
  let goodStreak = 0;
  let fallbackUnits = 0; // 翻译失败/保留原文（遗漏防护计数）

  // 统一的进度回报：done 单调不减函数，indeterminate 表示“仍在等待首帧反馈”（慢模型动画态）
  const reportProgress = (done, indeterminate) => {
    if (!onProgress) return;
    const clamped = Math.max(maxReported, Math.min(totalUnits, done | 0));
    if (clamped > maxReported) maxReported = clamped;
    onProgress({ phase: 'translate', done: clamped, total: totalUnits, message: `翻译中… ${clamped}/${totalUnits}`, indeterminate: !!indeterminate });
  };

  if (onProgress) onProgress({ phase: 'start', done: 0, total: totalUnits, message: '准备翻译…', indeterminate: true });

  await new Promise((resolve) => {
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
      // 预约额度：输入 token + 输出预估(0.6*maxTokens) + prompt 开销，TPM 取二者之和做保守预算
      const reserveTokens = inTok + Math.ceil(maxTokens * 0.6) + 250;
      const t0 = Date.now();
      let waited = 0;
      try { waited = await gate.reserve(reserveTokens); } catch (_) { waited = Date.now() - t0; }
      let hadTPM = false;
      // 流式进度回调：用 lastClosedCount 累积计数，只对每个 delta 的增量内容扫描，避免 O(n²)
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
      // 动态调整并发（监控配额占用与 429）—— 优化需求 5
      if (hadTPM) { currentMax = Math.max(MIN_CONCURRENCY, currentMax - 1); goodStreak = 0; }
      else if (waited > 1500) { currentMax = Math.max(MIN_CONCURRENCY, currentMax - 1); }
      else { goodStreak++; if (goodStreak >= 3) { currentMax = Math.min(MAX_CONCURRENCY, currentMax + 1); goodStreak = 0; } }
    }

    pump();
  });

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

  // 遗漏防护日志：result 与输入等长保证区块数一致；此处记录未能翻译的单元数以便排查
  if (fallbackUnits > 0) console.warn(`[translate] 完成：${items.length} 项（${chunks.length} 批），约 ${fallbackUnits} 个单元未能翻译、保留原文`);
  return result;
}

// ============================================================
// 实时字幕整理（refine）：把一句话的 ASR 碎片合并成通顺原文并翻译，
// 用于替换内容脚本里“逐词堆砌 + 零散翻译”的草稿。返回 { original, translation }。
// ============================================================
// refine 提示词按源语种动态生成：明确“所有碎片都应属源语种”，
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

async function refineCaption(model, fragments, targetLang, sourceLang) {
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

// 容错解析 refine 输出：兼容 <o>/<t> 标签、原文：/译文：、以及“两行”兜底。
// 解析不出译文时 translation 留空（内容脚本回退显示原文），绝不放原语言文本冒充译文。
function parseRefine(out, raw) {
  let s = (out || '').trim();
  // 去掉可能的 markdown 代码围栏
  s = s.replace(/^```[\s\S]*?\n?/i, '').replace(/```\s*$/i, '').trim();
  const om = s.match(/<o>([\s\S]*?)<\/o>/i);
  const tm = s.match(/<t>([\s\S]*?)<\/t>/i);
  let original = om && om[1].trim() ? om[1].trim() : '';
  let translation = tm && tm[1].trim() ? tm[1].trim() : '';
  if (!original || !translation) {
    const o2 = s.match(/原文[:：]\s*([\s\S]*?)(?=\s*译文[:：])/i);
    const t2 = s.match(/译文[:：]\s*([\s\S]*)$/i);
    if (!original && o2 && o2[1].trim()) original = o2[1].trim();
    if (!translation && t2 && t2[1].trim()) translation = t2[1].trim();
  }
  // 有 <o> 但漏写 <t>：把 </o> 之后的内容（去掉可能夹带的 <t> 标签）当作译文。
  if (original && !translation && om) {
    const after = s.slice(om.index + om[0].length).replace(/^<\/?t>/i, '').trim();
    if (after) translation = after;
  }
  // 两行兜底：original 已有时，把“与原文不同的那行”当作译文；否则取首行作原文、次行作译文。
  const lines = s.split(/\n+/).map(l => l.trim()).filter(Boolean);
  if (!translation && lines.length >= 2) {
    const cand = lines.find(l => l !== original);
    if (cand) translation = cand;
  }
  if (!original && lines.length >= 2) original = lines[0];
  if (!original) original = raw;   // 完全解析失败：保留原始识别文本，至少能显示
  return { original, translation };
}

/** 源语言中文标签 → Whisper ISO 语言码（空 = 自动检测） */
const WHISPER_LANG = {
  '自动识别': '', '英语': 'en', '日语': 'ja', '韩语': 'ko', '法语': 'fr', '德语': 'de',
  '西班牙语': 'es', '俄语': 'ru', '葡萄牙语': 'pt', '意大利语': 'it', '泰语': 'th', '越南语': 'vi',
};

// 源语言中文标签 → 英文（用于 refine 提示词，让模型能理解并纠正误识语种）
const LANG_EN = {
  '日语': 'Japanese', '英语': 'English', '韩语': 'Korean', '法语': 'French', '德语': 'German',
  '西班牙语': 'Spanish', '俄语': 'Russian', '葡萄牙语': 'Portuguese', '意大利语': 'Italian',
  '泰语': 'Thai', '越南语': 'Vietnamese', '中文（简体）': 'Chinese', '中文（繁体）': 'Chinese',
};

/**
 * 流式转写（Groq/OpenAI 兼容）：每片音频经 port 发送，后台回传 partial/final。
 * 内容脚本把 webm/opus 转成 WAV（PCM16）后再发来，WAV 可被 Groq 等端点可靠解析，
 * 避免“Chrome MediaRecorder 的 webm 被判为无音频轨道”导致的 HTTP 400；
 * 兼容不支持 stream 的端点（返回普通 JSON 时直接 final）。
 */

// 跨模型轮询计数器：每片从不同的模型起步，把请求均匀分摊到多个 Whisper 模型，
// 避免全部压在单一模型上触发 429 限流（仍保留片内故障转移兜底）。
let whisperRR = 0;

// Whisper 在静音 / 纯背景音 / 音乐片段上的常见“幻觉”固定语（多语种）。
// 这些短语在无实质语音时被模型凭空吐出（如日语视频里出现“ご視聴ありがとうございました”、
// 中文“感谢观看”等）。归一化后（去空白/标点、转小写）用于整片匹配剔除。
const HALLUCINATION_NORM = [
  // 日语
  'ご視聴ありがとうございました', 'ご視聴ありがとうございます', 'ご清聴ありがとうございました',
  '最後までご視聴いただきありがとうございます', 'チャンネル登録お願いします',
  'チャンネル登録高評価よろしくお願いします', 'おやすみなさい',
  // 中文
  '感谢观看', '谢谢观看', '谢谢大家观看', '感謝觀看', '謝謝觀看', '請不吝點贊訂閱轉發打賞',
  '请不吝点赞订阅转发打赏支持明镜与点点栏目', '请点赞订阅', '字幕由amaraorg社区提供',
  '明镜与点点栏目', '字幕志愿者', '下集见', '未完待续',
  // 英语
  'thankyouforwatching', 'thanksforwatching', 'pleasesubscribe',
  'subscribetomychannel', 'seeyounexttime', 'thanksforwatchingdontforgettosubscribe',
];

// 归一化：去除空白与常见标点、转小写（保留中日文字符）。
function normalizeCaption(text) {
  return (text || '').toLowerCase()
    .replace(/[\s。、，,\.!！?？…・~〜「」『』"'“”‘’()（）\-—:：;；]/g, '');
}

// 若整片转写内容“基本只是”一条幻觉固定语，则判为幻觉并剔除（返回空串）。
// 只在整片高度匹配时剔除，避免误伤正常语音中偶含这些词。
function stripHallucination(text) {
  const t = (text || '').trim();
  if (!t) return '';
  const norm = normalizeCaption(t);
  if (!norm) return '';
  for (const p of HALLUCINATION_NORM) {
    if (norm === p) return '';
    // 整片长度与短语相当（片段几乎只有这句话）→ 视为幻觉
    if (norm.length <= p.length + 4 && norm.includes(p)) return '';
  }
  return t;
}

async function streamTranscribe(port, msg) {
  const { whisperModelIds, audio, language, mime } = msg;
  // 内容脚本发来的是 Blob（或少数情况下的 ArrayBuffer）。跨进程传输后类型可能变化，
  // 这里只做 null 检查和 Blob/ArrayBuffer 的通用容量判断，避免误判。
  if (!audio) {
    port.postMessage({ type: 'error', error: 'Whisper 转写失败：无效的音频数据' }); return;
  }

  // 兼容防错：跨进程（MessagePort）传输二进制 Uint8Array 时，可能会在部分浏览器中被序列化为普通 Object（例如 {0: 10, 1: 20...}）。
  // 若不进行转换，直接 new Blob([audio]) 会在 Blob 中写入 "[object Object]" 文本，导致 Whisper HTTP 400（no audio track found in file）。
  let binaryData = audio;
  if (audio && typeof audio === 'object' && !(audio instanceof Blob) && !(audio instanceof ArrayBuffer) && !ArrayBuffer.isView(audio)) {
    const keys = Object.keys(audio).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
    if (keys.length > 0) {
      const u8 = new Uint8Array(keys.length);
      for (let i = 0; i < keys.length; i++) {
        u8[i] = audio[keys[i]];
      }
      binaryData = u8;
    }
  }

  const all = await getWhisperModels();
  const matched = (Array.isArray(whisperModelIds) && whisperModelIds.length)
    ? all.filter(w => whisperModelIds.includes(w.id) && w.model) : all.filter(w => w.model);
  if (!matched.length) { port.postMessage({ type: 'error', error: '未配置可用的 Whisper 模型' }); return; }
  // 轮询负载均衡：本片从 ((whisperRR++) % N) 这个模型起步，把请求分摊到各模型；
  // 列表仍按“起步模型在前、其余在后”的顺序遍历，故某模型 429/失败时自动故障转移到下一个。
  const startIdx = whisperRR % matched.length;
  whisperRR = (whisperRR + 1) % matched.length;
  const list = matched.map((_, i) => matched[(startIdx + i) % matched.length]);
  const lang = WHISPER_LANG[language] || '';
  const isWav = /wav/i.test(mime || '');
  const fileType = isWav ? 'audio/wav' : 'audio/webm';
  const fileName = isWav ? 'audio.wav' : 'audio.webm';
  const audioBlob = (binaryData instanceof Blob) ? binaryData : new Blob([binaryData], { type: fileType });
  const TOTAL_TIMEOUT_MS = 120000;
  const startedAt = Date.now();
  let lastErr;
  const MAX_ROUNDS = 3;
  for (let round = 0; round < MAX_ROUNDS; round++) {
   let sawRate = false;
   for (const wm of list) {
    if (Date.now() - startedAt > TOTAL_TIMEOUT_MS) {
      port.postMessage({ type: 'error', error: 'Whisper 转写超时（超过 2 分钟）' });
      return;
    }
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), wm.timeoutMs || 60000);
    try {
      const fd = new FormData();
      fd.append('file', audioBlob, fileName);
      fd.append('model', wm.model || 'whisper-large-v3');
      if (lang) fd.append('language', lang);
      const res = await fetch(`${String(wm.apiBase || '').replace(/\/$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${wm.apiKey || ''}` },
        body: fd, signal: ctrl.signal,
      });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 400); } catch (_) {}
        throw new Error('Whisper HTTP ' + res.status + (detail ? '：' + detail : ''));
      }
      const ct = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '';
      if (!/text\/event-stream/i.test(ct)) {
        const json = await res.json().catch(() => ({}));
        port.postMessage({ type: 'final', text: stripHallucination((json.text || '').trim()) });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '', full = '';
      const MAX_SSE_BUFFER = 1024 * 1024; // 1MB
      const MAX_FULL_TEXT = 20000; // 20KB transcript cap
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          if (buf.length > MAX_SSE_BUFFER) throw new Error('SSE buffer overflow');
          const ev = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const dataLine = ev.split('\n').find(l => l.startsWith('data:'));
          if (!dataLine) continue;
          const data = dataLine.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let json; try { json = JSON.parse(data); } catch (_) { continue; }
          if (json.type === 'transcript.text') {
            port.postMessage({ type: 'partial', text: json.text || '' });
          } else if (json.type === 'transcript.delta') {
            full += json.delta || '';
            if (full.length > MAX_FULL_TEXT) full = full.slice(-MAX_FULL_TEXT);
            port.postMessage({ type: 'partial', text: full });
          } else if (json.type === 'transcript.done') {
            full = json.text || full;
          } else if (json.type === 'error') {
            throw new Error((json.error && json.error.message) ? json.error.message : '转写错误');
          }
        }
      }
      port.postMessage({ type: 'final', text: stripHallucination(full.trim()) }); return;
    } catch (e) {
      lastErr = e;
      if (isRateLimit(e)) sawRate = true;
      console.warn(`[whisper] 流式模型 ${wm.name || wm.id} 失败：${e.message}`);
    } finally {
      clearTimeout(to);
    }
   }
   // 一轮内所有模型都失败：仅当遇到 429 限流时才退避重试（其它错误重试无益，直接放弃）
   if (!sawRate) break;
   if (round < MAX_ROUNDS - 1) await sleep(700 * (round + 1));
  }
  port.postMessage({ type: 'error', error: (lastErr && lastErr.message) || '所有 Whisper 模型均失败' });
}

// ---------- 实时字幕：Offscreen Document 音频捕获（绕过内容脚本 autoplay 限制）----------
let offscreenCaptionPort = null;   // offscreen 文档连上来的端口
let activeCaptionTabId = null;     // 当前正在生成字幕的标签页（用于把音频片段转发给它）
let pendingCaptionStart = null;    // offscreen 尚未连接时的挂起 start
let creatingOffscreen = false;

// 取标签页音频流 id（在 SW 中调用 chrome.tabCapture.getMediaStreamId，内容脚本无此权限）
async function getTabStreamId(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = (tab && (tab.url || tab.pendingUrl)) || '';
    if (isChromeInternalPage(url)) return { ok: false, error: CHROME_PAGE_HINT };
  } catch (_) { /* 取不到 url 也不阻塞，继续走 getMediaStreamId */ }
  return new Promise((resolve) => {
    // 关键：必须传 targetTabId 指定“要捕获哪个标签页”（Chrome 116+ 官方写法）。
    // 旧的 consumerTabId 只控制“谁可消费”，不能指定捕获目标；漏传会导致 offscreen 里
    // getUserMedia 报 “Error starting tab capture”。
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message || '';
        if (/not been invoked|activeTab/i.test(errMsg)) {
          resolve({ ok: false, error: '获取音频流失败：扩展尚未在当前页面被授权（activeTab）。请在目标视频标签页上点击本扩展图标，或右键该页面选择“AI 助手：开启实时字幕”以授权，然后重试。' });
        } else {
          resolve({ ok: false, error: '获取音频流失败：' + errMsg });
        }
        return;
      }
      if (!streamId) { resolve({ ok: false, error: '无法获取标签页音频流（请确认在视频标签页内，且扩展拥有 tabCapture 权限）' }); return; }
      resolve({ ok: true, streamId });
    });
  });
}

// 关闭可能残留的 offscreen 文档（上一 SW 实例/上次会话留下的孤儿，其仍持有标签页音频捕获，
// 会导致 getMediaStreamId 报 “Cannot capture a tab with an active stream”，并令标签页持续静音）。
async function closeLingeringOffscreen() {
  try {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (ctxs && ctxs.length) { await chrome.offscreen.closeDocument(); }
  } catch (_) { /* 无文档或已关闭，忽略 */ }
}

// 确保 offscreen 文档存在（扩展自有文档，AudioContext 不受视频页 autoplay 限制）。
// 调用方在调用前应已关闭旧文档（见 LIVE_CAPTION_START_CAPTURE），本函数只负责创建。
async function ensureOffscreen() {
  if (offscreenCaptionPort) return; // 已有可用连接，直接复用
  if (creatingOffscreen) return;
  creatingOffscreen = true;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/subtitle-offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: '捕获标签页音频并恢复声音（绕过内容脚本 autoplay 限制）',
    });
  } catch (e) {
    // 极小概率竞态下文档已存在，忽略——其端口会连上来
    if (!/already exists/i.test(String((e && e.message) || ''))) {
      console.warn('[offscreen] createDocument 失败', e);
    }
  } finally {
    creatingOffscreen = false;
  }
}

// 侧边栏用长连接 port 接收流式/状态
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    port.onMessage.addListener(async (msg) => {
      if (msg.type === 'PING') return; // 侧边栏保活心跳，无需处理
      if (msg.type === 'SUMMARIZE') {
        await runSummarize(port);
      }
    });
    return;
  }
  // Whisper 流式转写：content script 每片音频经此 port 发送，后台流式回传 partial/final
  if (port.name === 'whisper-stream') {
    port.onMessage.addListener(async (msg) => {
      if (msg.type === 'slice') {
        try { await streamTranscribe(port, msg); }
        catch (e) { port.postMessage({ type: 'error', error: (e && e.message) ? e.message : '流式转写异常' }); }
      }
    });
  }
  // 实时字幕 offscreen 文档：接收音频片段并转发给内容脚本做 Whisper 转写
  if (port.name === 'offscreen-caption') {
    offscreenCaptionPort = port;
    port.onMessage.addListener(async (m) => {
      if (!m) return;
      if (m.type === 'AUDIO') {
        // 音频已在 offscreen 编码为 base64 字符串，sendMessage（JSON 序列化）可可靠传输。
        if (activeCaptionTabId != null) {
          try { await chrome.tabs.sendMessage(activeCaptionTabId, { type: 'LIVE_CAPTION_AUDIO', audioB64: m.audioB64, mime: m.mime }); } catch (_) {}
        }
      } else if (m.type === 'AUDIO_SILENCE') {
        // 静音窗口标记：转发给内容脚本用于音频时间轴判句（不携带音频，极轻量）
        if (activeCaptionTabId != null) {
          try { await chrome.tabs.sendMessage(activeCaptionTabId, { type: 'LIVE_CAPTION_SILENCE' }); } catch (_) {}
        }
      } else if (m.type === 'CAPTURE_ERROR') {
        if (activeCaptionTabId != null) {
          try { await chrome.tabs.sendMessage(activeCaptionTabId, { type: 'LIVE_CAPTION_CAPTURE_ERROR', error: m.error }); } catch (_) {}
        }
      }
    });
    port.onDisconnect.addListener(() => { if (offscreenCaptionPort === port) offscreenCaptionPort = null; });
    // offscreen 刚连上：若此前有挂起的 start，立即下发
    if (pendingCaptionStart) {
      port.postMessage({ type: 'START', streamId: pendingCaptionStart.streamId });
      pendingCaptionStart = null;
    }
  }
});

// 网页翻译/字幕翻译：统一处理文本翻译请求（去重 model 选择 + credential 检查）
async function handleTranslateBatch(modelId, targetLang, items, errLabel, opts = {}) {
  if (!Array.isArray(items)) return { ok: false, error: `参数错误：${items === 'texts' ? 'texts' : 'lines'} 必须是数组` };
  const models = await getModels();
  const model = models.find(m => m.id === modelId)
    || models.find(m => m.enabled !== false && m.isPrimary)
    || models.find(m => m.enabled !== false);
  if (!model) return { ok: false, error: '未找到可用翻译模型，请先在设置添加模型' };
  if (!hasCred(model)) return { ok: false, error: '翻译模型缺少有效凭证（API Key）' };
  const translations = await translateSegments(model, items, targetLang || '中文（简体）', opts);
  return { ok: true, translations };
}

// ============================================================
// 联网搜索：service worker 中无 DOMParser，故用 fetch 抓取 DuckDuckGo
// 免密 HTML 版结果页并以正则解析。利用 host_permissions <all_urls>，
// 后台发起的请求不受页面 CORS 限制。
// ============================================================
/** 清理 HTML 片段为纯文本（去标签 + 解码常见实体） */
function stripHtmlText(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 还原 DuckDuckGo 结果链接（去掉 //duckduckgo.com/l/?uddg= 重定向包装） */
function decodeDdgUrl(href) {
  try {
    let h = String(href || '').replace(/&amp;/g, '&');
    if (h.startsWith('//')) h = 'https:' + h;
    const u = new URL(h);
    const uddg = u.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : h;
  } catch (_) {
    return href;
  }
}

/** 解析 DuckDuckGo HTML 结果页，提取前 maxResults 条 { title, url, snippet } */
function parseDdgResults(html, maxResults) {
  const results = [];
  const titleRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = titleRe.exec(html)) && results.length < maxResults) {
    const title = stripHtmlText(m[2]);
    if (!title) continue;
    results.push({ title, url: decodeDdgUrl(m[1]), snippet: '' });
  }
  const snipRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let sm, i = 0;
  while ((sm = snipRe.exec(html)) && i < results.length) {
    results[i].snippet = stripHtmlText(sm[1]);
    i++;
  }
  return results;
}

/** 抓取联网搜索结果：优先 GET，无结果时回退 POST（DDG 偶尔仅接受 POST） */
async function webSearch(query, maxResults = 6) {
  const endpoint = 'https://html.duckduckgo.com/html/';
  const headers = { 'Accept': 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' };
  let html = '';
  try {
    const res = await fetch(endpoint + '?q=' + encodeURIComponent(query), { method: 'GET', headers });
    if (res.ok) html = await res.text();
  } catch (e) {
    // 记录 GET 请求失败原因，便于调试
    console.warn('[webSearch] GET 请求失败，尝试 POST 回退:', e?.message || String(e));
  }

  let results = html ? parseDdgResults(html, maxResults) : [];
  if (!results.length) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'q=' + encodeURIComponent(query),
    });
    if (!res.ok) throw new Error('搜索服务返回 HTTP ' + res.status);
    results = parseDdgResults(await res.text(), maxResults);
  }
  return results;
}

// content script / popup 的简单请求
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'WEB_SEARCH') {
    (async () => {
      try {
        const q = (msg.query || '').trim();
        if (!q) { sendResponse({ error: '搜索关键词为空' }); return; }
        const results = await webSearch(q, msg.maxResults || 6);
        if (!results.length) { sendResponse({ error: '未获取到搜索结果，请稍后重试或更换关键词' }); return; }
        sendResponse({ results });
      } catch (e) {
        sendResponse({ error: e?.message || '联网搜索失败' });
      }
    })();
    return true; // 异步 sendResponse
  }
  if (msg.type === 'SUMMARIZE') {
    // 兼容非 port 调用：直接返回（简单起见复用 port 逻辑需要连接，这里仅提示用侧边栏）
    sendResponse({ type: 'INFO', message: '请打开侧边栏（右键图标 -> 在边栏中打开本扩展）' });
    return true;
  }
  if (msg.type === 'AUTOMATE') {
    // 侧边栏请求执行网页自动化工具：解析当前活动标签页后交由 execTool 执行。
    // 加 settled 守卫 + 兜底超时：保证 sendResponse 一定被调用一次，
    // 避免极端情况下端口悬挂 → 发送端收到 “The message port closed before a response was received.”。
    let settled = false;
    const SAFETY_MS = 55000; // 略小于发送端 60s 超时，确保发送端先收到明确的超时错误
    const safety = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { sendResponse({ ok: false, error: '后台执行超时（工具运行超时）' }); } catch (_) {}
    }, SAFETY_MS);
    (async () => {
      try {
        const tab = await getActiveTab();
        if (!tab || !tab.id) {
          if (!settled) { settled = true; clearTimeout(safety); }
          sendResponse({ ok: false, error: '无法获取当前标签页' });
          return;
        }
        const out = await execTool(tab, msg.tool, msg.args || {});
        if (!settled) { settled = true; clearTimeout(safety); }
        sendResponse(out);
      } catch (e) {
        if (!settled) { settled = true; clearTimeout(safety); }
        sendResponse({ ok: false, error: e?.message || '执行失败' });
      }
    })();
    return true; // 异步 sendResponse
  }
  if (msg.type === 'GET_PAGE') {
    // 侧边栏请求“当前网页”正文：向当前标签页取正文后回传。
    // 优先用内容脚本（EXTRACT_PAGE），不可达时（如脚本未注入）回退到 scripting API 直接抽取，
    // 确保对用户“正在浏览”的任意网页都能拿到真实正文，而不是退回示例/侧边栏自身内容。
    (async () => {
      try {
        const tab = await getActiveTab();
        if (!tab || !tab.id) { sendResponse({ error: '无法获取当前标签页' }); return; }

        let page = null;
        try {
          page = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PAGE' });
        } catch (_) {
          page = null; // 内容脚本未注入或不可用，进入下方兜底
        }

        if (!page || !page.text || !page.text.trim()) {
          try {
            const [res] = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => {
                const root = document.querySelector('article') || document.querySelector('main') || document.body;
                if (!root) return { title: document.title, text: '', url: location.href };
                const clone = root.cloneNode(true);
                clone.querySelectorAll('script,style,noscript,nav,header,footer,aside').forEach(el => el.remove());
                const text = (clone.innerText || clone.textContent || '')
                  .replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
                return { title: document.title, text, url: location.href };
              },
            });
            page = (res && res.result) ? res.result : null;
          } catch (_) {
            page = null;
          }
        }

        if (!page || !page.text || !page.text.trim()) {
          sendResponse({ error: '未能从当前网页提取到正文（可能是浏览器内置页或需要刷新页面）' });
          return;
        }
        sendResponse(page);
      } catch (e) {
        sendResponse({ error: e?.message || '获取网页失败' });
      }
    })();
    return true; // 异步 sendResponse
  }
  if (msg.type === 'TRANSLATE_PAGE') {
    (async () => {
      // 进度回传：SW 直接发往扩展页面（侧边栏/弹窗），不经 content 脚本中转。
      // 原因：content 脚本在 await TRANSLATE_PAGE 响应期间自身被阻塞，经它中转的进度消息易丢失，
      // 导致侧边栏只看到初始 0% 然后直接“完成”。直接回传最可靠。
      const onProgress = (p) => {
        try { chrome.runtime.sendMessage({ type: 'WEB_TRANSLATE_PROGRESS', payload: p }, () => { void chrome.runtime.lastError; }); }
        catch (_) { /* 侧边栏未打开时忽略 */ }
      };
      try {
        const { modelId, targetLang, texts } = msg;
        if (!Array.isArray(texts)) { sendResponse({ ok: false, error: '参数错误：texts 必须是数组' }); return; }
        const result = await handleTranslateBatch(modelId, targetLang, texts, null, { onProgress });
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) ? e.message : '翻译失败' });
      }
    })();
    return true; // 异步 sendResponse
  }
  // 注：旧的 LIVE_CAPTION_GET_STREAM（内容脚本自行 getUserMedia 捕获）已废弃——
  // 捕获与声音恢复统一在 Offscreen 文档完成（见 LIVE_CAPTION_START_CAPTURE / offscreen/）。

  // 实时字幕：内容脚本请求在 offscreen 中启动音频捕获（绕开内容脚本 autoplay 限制）
  if (msg.type === 'LIVE_CAPTION_START_CAPTURE') {
    (async () => {
      try {
        const tabId = sender && sender.tab && sender.tab.id;
        if (!tabId) { sendResponse({ ok: false, error: '无法确定来源标签页' }); return; }
        // 关键：若已有捕获（含上一会话留下的孤儿 offscreen），先停掉并关闭旧文档，
        // 否则 getMediaStreamId 会报 “Cannot capture a tab with an active stream”，且标签页持续静音。
        if (offscreenCaptionPort) { try { offscreenCaptionPort.postMessage({ type: 'STOP' }); } catch (_) {} }
        offscreenCaptionPort = null;
        pendingCaptionStart = null;
        await closeLingeringOffscreen();
        // 等待旧捕获的轨道真正释放，避免 getMediaStreamId 立刻报 “active stream”
        await new Promise((r) => setTimeout(r, 200));
        const got = await getTabStreamId(tabId);
        if (!got.ok) { sendResponse({ ok: false, error: got.error }); return; }
        activeCaptionTabId = tabId;
        await ensureOffscreen();
        if (offscreenCaptionPort) {
          offscreenCaptionPort.postMessage({ type: 'START', streamId: got.streamId });
        } else {
          pendingCaptionStart = { streamId: got.streamId }; // offscreen 连接后来下发
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) ? e.message : '启动音频捕获异常' });
      }
    })();
    return true;
  }
  // 实时字幕：停止 offscreen 音频捕获
  if (msg.type === 'LIVE_CAPTION_STOP_CAPTURE') {
    if (offscreenCaptionPort) { try { offscreenCaptionPort.postMessage({ type: 'STOP' }); } catch (_) {} }
    pendingCaptionStart = null;
    // 关闭离屏文档：彻底释放标签页音频捕获，恢复原生声音（捕获会静音原标签页）
    try { chrome.offscreen.closeDocument().catch(() => {}); } catch (_) {}
    offscreenCaptionPort = null;
    activeCaptionTabId = null;
    sendResponse({ ok: true });
    return true;
  }
  // offscreen 文档就绪信号
  if (msg.type === 'OFFSCREEN_CAPTION_READY') {
    if (pendingCaptionStart && offscreenCaptionPort) {
      offscreenCaptionPort.postMessage({ type: 'START', streamId: pendingCaptionStart.streamId });
      pendingCaptionStart = null;
    }
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'LIVE_CAPTION_TRANSLATE') {
    (async () => {
      try {
        const { modelId, targetLang, lines } = msg;
        if (!Array.isArray(lines)) { sendResponse({ ok: false, error: '参数错误：lines 必须是数组' }); return; }
        // 字幕碎片上下文相关（同一短语脱离句子含义不同），关闭持久化缓存避免陈旧复用
        const result = await handleTranslateBatch(modelId, targetLang, lines, null, { useCache: false });
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) ? e.message : '字幕翻译失败' });
      }
    })();
    return true;
  }
  // 实时字幕：把一句话的 ASR 碎片整段整理 + 翻译，替换草稿区的零散词组
  if (msg.type === 'LIVE_CAPTION_REFINE') {
    (async () => {
      try {
        const { modelId, targetLang, fragments, sourceLang } = msg;
        if (!Array.isArray(fragments) || !fragments.length) {
          sendResponse({ ok: false, error: '参数错误：fragments 必须是非空数组' });
          return;
        }
        const models = await getModels();
        const model = models.find(m => m.id === modelId)
          || models.find(m => m.enabled !== false && m.isPrimary)
          || models.find(m => m.enabled !== false);
        if (!model) { sendResponse({ ok: false, error: '未找到可用翻译模型，请先在设置添加模型' }); return; }
        if (!hasCred(model)) { sendResponse({ ok: false, error: '翻译模型缺少有效凭证（API Key）' }); return; }
        const r = await refineCaption(model, fragments, targetLang || '中文（简体）', sourceLang);
        sendResponse({ ok: true, original: r.original, translation: r.translation });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) ? e.message : '字幕整理失败' });
      }
    })();
    return true;
  }
  return false;
});


// 点击工具栏图标：直接在浏览器原生侧边栏中打开聊天应用（最可靠，无需内容脚本）
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

// 兜底：部分浏览器若未启用“点击图标开侧面板”，则手动打开当前标签页的侧边栏
chrome.action?.onClicked?.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try { await chrome.sidePanel.open({ tabId: tab.id }); } catch (_) {}
});

// 扩展启动 / 更新 / 安装时，主动给所有已打开的“普通网页”标签页注入 content script。
// 解决：扩展重载后，已打开的标签页不会自动重新注入 content script，
// 导致侧边栏发起 EXECUTE_TOOL 时 sendMessage 找不到接收端（表现为“content script 无法建立连接”）。
// 注入失败时静默跳过（受保护页面 / 内部页本就无法注入）。
async function injectContentScriptsToOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab || !tab.id || !tab.url) continue;
      // 仅对 http/https/ file 普通页面注入；跳过浏览器内部页（chrome://、edge://、扩展页等）
      if (!/^(https?:|file:|about:blank)/i.test(tab.url)) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/extract.js', 'content/sidebar-inject.js', 'content/subtitle.js'],
        });
      } catch (_) { /* 该页面不可注入，忽略 */ }
    }
  } catch (_) { /* 查询失败忽略 */ }
}

// 安装 / 更新时注入：合并翻译脚本注入和自动化脚本注入
chrome.runtime.onInstalled?.addListener(async () => {
  // 清理上一版本可能残留的 offscreen 捕获文档（否则会令标签页持续静音）
  try { await closeLingeringOffscreen(); } catch (_) {}
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs || []) {
      if (!tab || !tab.id || !tab.url) continue;
      if (!/^(https?:|file:|about:blank)/i.test(tab.url)) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/translate.js', 'content/extract.js', 'content/sidebar-inject.js', 'content/subtitle.js'],
        });
      } catch (_) { /* 部分页面可能拒绝注入，忽略 */ }
    }
  } catch (_) {}
});
chrome.runtime.onStartup?.addListener(async () => {
  try { await closeLingeringOffscreen(); } catch (_) {}
  injectContentScriptsToOpenTabs();
});
