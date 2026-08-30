// content/subtitle.js
// 实时字幕 —— 页面 Worker：监听平台内嵌字幕（优先）或经 Whisper 转写捕获到的语音，
// 把原文交给后台所选大模型翻译，并在页面上叠加"原文 + 译文"双语字幕层。
//
// 与 translate.js 一样，通过 chrome.runtime.onMessage 接收侧边栏指令：
//   LIVE_CAPTION_START  → 开始采集字幕（平台字幕 / Whisper 语音识别）
//   LIVE_CAPTION_STOP   → 停止并清理
//
// 设计要点（解决自定义大模型"慢"的问题）：
//   - 原文先即时显示，译文异步回写（体感无等待）
//   - 窗口批处理：多条字幕合并成一个请求，砍掉 RTT
//   - 短语缓存：重复句（片头/客套话）只翻一次
//   - 非直播预取：原生 <track> 字幕轨可被整片预翻译，播放到时秒显
//
// 路线 A（根治“开启字幕后视频无声”）：
//   标签页音频的“捕获”与“声音恢复（Web Audio）”全部在【Offscreen 文档】中完成，
//   因为捕获必然静音原标签页，而恢复声音所需的 AudioContext 若建在【视频页内容脚本】里
//   会被 Chrome 自动播放策略卡成 suspended（手势在侧边栏、不在视频页）。Offscreen 是扩展
//   自有文档，其 AudioContext 不受此限制，可稳定恢复声音。本脚本只负责：
//     1) 收到 SW 转发的音频切片（LIVE_CAPTION_AUDIO）→ 送 Whisper 转写 → 渲染；
//     2) 捕获失败时显示错误（LIVE_CAPTION_CAPTURE_ERROR）。

(function () {
  'use strict';
  if (window.self !== window.top) return;       // 仅顶层文档
  if (window.__aiSubtitleWorker) return;
  window.__aiSubtitleWorker = true;

  let active = false;
  let cfg = null;            // 当前配置（来自 LIVE_CAPTION_START）
  let overlay = null;
  let boxHeader = null, historyEl = null, draftEl = null;
  let bodyEl = null, collapseBtnEl = null, compactEl = null, collapsed = false;

  // 平台字幕抓取
  let captionObserver = null;
  let captionWindow = null;
  let captionPoller = null;
  let trackWatch = null;     // 原生 textTracks 监听
  let prefetchTimer = null;

  // Whisper 转写（音频捕获在 Offscreen 文档完成；这里只把收到的音频片段送转写 + 渲染）
  let whisperQueue = [];          // 待转写的音频 Blob 队列（带序号，按序显示避免字幕错乱）
  let whisperSeq = 0;             // 下一个待发片的序号
  let whisperNextShow = 0;        // 下一个应按序显示的序号
  let whisperActive = 0;          // 当前正在转写的端口数（并发上限控制）
  let whisperRunning = false;     // pump 循环是否在跑（防重入）
  const WHISPER_CONCURRENCY = 2; // 同时进行的 Whisper 流式端口数（方案 B：重叠发送消积压）
  const whisperPorts = new Set(); // 当前活跃端口集合（stop 时统一断开）
  const whisperDone = new Map();  // seq -> final 文本（已转写完成，等待按序冲刷）
  const whisperLive = new Map();  // seq -> 当前 partial 文本（用于流式显示）
  let whisperErrored = false;     // 转写失败仅提示一次，避免刷屏
  const MAX_WHISPER_QUEUE = 10;   // Whisper 队列最大长度，防止内存溢出

  // 翻译结果缓存（重复句只整理翻译一次，如片头/客套话）
  const translationCache = new Map();
  const cacheKeys = [];            // FIFO 缓存键队列
  const MAX_CACHE = 600;

  // 累积字幕 + 成句整理（refine）——核心：碎词先入草稿，成句后交 AI 整段整理+翻译
  let committedDraft = '';          // 当前句已识别定稿的原始文本（草稿区展示）
  let livePartial = '';             // whisper 流式 partial（未定稿，仅预览）
  let liveTrans = '';               // 当前草稿的实时译文（实时翻译；成句后由 refine 结果替换）
  let liveTransRaw = '';            // 上一次实时翻译对应的原文，避免重复请求
  let liveTransTimer = null;        // 实时翻译防抖计时器
  let liveTransSeq = 0;             // 实时翻译请求序号：防止旧的短请求后返回覆盖新译文（消除闪回）
  const LIVE_TRANS_DEBOUNCE = 600; // 实时翻译防抖间隔（ms）
  const LIVE_TRANS_MIN_CHARS = 2;  // 低于此长度不翻译，避免碎词空翻
  // 判句策略（根治“首句超长、后续切碎”与 429）：
  // Whisper 分片已在 offscreen 侧用 VAD（静音驱动）切成“一句一片”——每片 final 就是一整句，
  // 无需 content 侧再做静音累积/宽限判句。这样 Whisper 调用降到句频、稳在配额内，
  // 也不会再出现“首句吞积压 / 429 被误判静音后乱切”。
  // 以下变量仅供【平台字幕】路径（YouTube DOM / <track>）使用（它们是整行累积、需停顿收尾）。
  let sentenceTimer = null;         // 平台字幕停顿计时器（Whisper 路径不用）
  const SENTENCE_GAP_MS = 2500;
  const SENTENCE_MAX_CHARS = 200;   // 单句最大长度，超过强制收尾（平台字幕兜底）
  let refineQueue = [];             // 待整理的句子快照（按序处理，避免串句）
  let refineRunning = false;        // refine 泵是否在运行（防重入）
  const historyLines = [];          // 已定稿字幕：{ original, translation }
  const HISTORY_MAX_LINES = 300;    // 历史保留行数上限（FIFO 丢最旧，避免无限增长）；折叠时只显示最新一行，无需整轮清空
  const HISTORY_MAX_CHARS = 50000;  // 历史保留字符数上限（防止长字幕占用过多内存）

  // ---------- 缓存 ----------
  function setCache(k, v) {
    if (translationCache.size >= MAX_CACHE) {
      const oldest = cacheKeys.shift();
      translationCache.delete(oldest);
    }
    translationCache.set(k, v);
    cacheKeys.push(k);
  }
  function cacheGet(k) { return translationCache.has(k) ? translationCache.get(k) : null; }

  // ---------- 字幕盒子（常驻 + 可拖拽 + 历史区 + 草稿区）----------
  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;left:50%;bottom:8%;transform:translateX(-50%);' +
      'width:72%;max-width:920px;z-index:2147483647;' +
      'display:flex;flex-direction:column;overflow:hidden;border-radius:12px;' +
      'background:rgba(0,0,0,.55);box-shadow:0 6px 24px rgba(0,0,0,.4);' +
      'backdrop-filter:blur(3px);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';

    // 顶部拖拽条：可拖动移动；右侧两个按钮 —— 折叠（收起正文，不停止识别）/ 关闭（停止）
    boxHeader = document.createElement('div');
    boxHeader.style.cssText =
      'pointer-events:auto;cursor:move;user-select:none;' +
      'display:flex;align-items:center;justify-content:space-between;gap:6px;' +
      'padding:4px 10px;background:rgba(255,255,255,.10);color:rgba(255,255,255,.75);font-size:12px;';
    const title = document.createElement('span');
    title.textContent = '实时字幕 · 拖动可移动';
    title.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

    const btnWrap = document.createElement('span');
    btnWrap.style.cssText = 'display:flex;align-items:center;gap:2px;pointer-events:auto;';

    // 折叠：仅隐藏正文，识别仍在后台进行（解决“字幕栏挡住画面”）
    collapseBtnEl = document.createElement('span');
    collapseBtnEl.textContent = '▾';            // ▾ 收起 / ▴ 展开
    collapseBtnEl.title = '收起 / 展开字幕（不停止识别）';
    collapseBtnEl.style.cssText = 'cursor:pointer;padding:0 6px;font-size:13px;';
    collapseBtnEl.addEventListener('mousedown', (e) => e.stopPropagation()); // 不触发拖动
    collapseBtnEl.addEventListener('click', (e) => { e.stopPropagation(); toggleCollapse(); });

    const closeBtn = document.createElement('span');
    closeBtn.textContent = '✕';
    closeBtn.title = '关闭实时字幕';
    closeBtn.style.cssText = 'cursor:pointer;padding:0 6px;font-size:13px;';
    closeBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      try { chrome.runtime.sendMessage({ type: 'LIVE_CAPTION_STOP_CAPTURE' }); } catch (_) {}
      stop();
    });

    btnWrap.appendChild(collapseBtnEl);
    btnWrap.appendChild(closeBtn);
    boxHeader.appendChild(title);
    boxHeader.appendChild(btnWrap);

    // 正文：历史区（可滚动）+ 草稿区。pointer-events:auto 让滚动条/滚轮可交互
    // （此前为 none 导致字幕溢出后无法向上滚动）。
    bodyEl = document.createElement('div');
    bodyEl.style.cssText = 'pointer-events:auto;padding:8px 14px;max-height:30vh;overflow-y:auto;';
    historyEl = document.createElement('div');
    historyEl.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    draftEl = document.createElement('div');
    draftEl.style.cssText =
      'margin-top:6px;color:rgba(255,255,255,.55);font-size:15px;font-style:italic;' +
      'min-height:1em;white-space:pre-wrap;word-break:break-word;';
    bodyEl.appendChild(historyEl);
    bodyEl.appendChild(draftEl);

    overlay.appendChild(boxHeader);
    overlay.appendChild(bodyEl);
    // 折叠态紧凑视图：仅显示最新一行（原文+译文）+ 实时草稿，不滚动、不占大面积
    compactEl = document.createElement('div');
    compactEl.style.cssText = 'pointer-events:auto;padding:8px 14px;display:none;';
    overlay.appendChild(compactEl);
    document.documentElement.appendChild(overlay);

    // 恢复折叠状态（跨刷新/重开保留）
    try {
      if (sessionStorage.getItem('__aiSubtitleCollapsed') === '1') applyCollapse(true);
    } catch (_) {}

    restoreBoxPosition();
    enableDrag();
  }

  // 拖拽：仅 header 触发；拖动时固定 left/top，移除居中 transform。
  let _dragCleanup = null; // enableDrag/disableDrag 清理引用
  function enableDrag() {
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    const onMove = (e) => {
      if (!dragging) return;
      overlay.style.left = (ox + (e.clientX - sx)) + 'px';
      overlay.style.top = (oy + (e.clientY - sy)) + 'px';
      overlay.style.bottom = 'auto';
      overlay.style.transform = 'none';
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      saveBoxPosition();
    };
    const handler = (e) => {
      dragging = true;
      const r = overlay.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      overlay.style.left = r.left + 'px';
      overlay.style.top = r.top + 'px';
      overlay.style.bottom = 'auto';
      overlay.style.transform = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    };
    boxHeader.addEventListener('mousedown', handler);
    _dragCleanup = () => {
      boxHeader.removeEventListener('mousedown', handler);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }
  function disableDrag() {
    if (_dragCleanup) { _dragCleanup(); _dragCleanup = null; }
  }
  function saveBoxPosition() {
    try {
      const r = overlay.getBoundingClientRect();
      sessionStorage.setItem('__aiSubtitleBoxPos', JSON.stringify({ left: r.left, top: r.top }));
    } catch (_) {}
  }
  function restoreBoxPosition() {
    try {
      const raw = sessionStorage.getItem('__aiSubtitleBoxPos');
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p && typeof p.left === 'number' && typeof p.top === 'number') {
        overlay.style.left = p.left + 'px';
        overlay.style.top = p.top + 'px';
        overlay.style.bottom = 'auto';
        overlay.style.transform = 'none';
      }
    } catch (_) {}
  }

  // 折叠 / 展开：折叠时只显示最新一行紧凑视图，识别继续（解决“字幕栏挡住画面”）。
  function applyCollapse(c) {
    collapsed = c;
    if (bodyEl) bodyEl.style.display = collapsed ? 'none' : '';
    if (compactEl) compactEl.style.display = collapsed ? '' : 'none';
    if (collapseBtnEl) collapseBtnEl.textContent = collapsed ? '▴' : '▾';
    if (collapsed) renderCompact();   // 立即渲染一次最新行
  }

  // 折叠态渲染：仅最新一行（译文大 + 原文小，双语时）+ 实时草稿，便于边看画面边看实时翻译。
  function renderCompact() {
    if (!compactEl) return;
    compactEl.textContent = '';
    const last = historyLines[historyLines.length - 1];
    if (last) {
      const tr = document.createElement('div');
      tr.textContent = last.translation || last.original || '';
      tr.style.cssText = 'color:#fff;font-size:18px;font-weight:600;line-height:1.3;text-shadow:0 1px 2px rgba(0,0,0,.6);';
      compactEl.appendChild(tr);
      if (cfg && cfg.bilingual && last.original && last.translation) {
        const og = document.createElement('div');
        og.textContent = last.original;
        og.style.cssText = 'color:rgba(255,255,255,.7);font-size:12px;line-height:1.25;';
        compactEl.appendChild(og);
      }
    }
    const raw = (committedDraft + (livePartial ? ' ' + livePartial : '')).trim();
    if (raw || liveTrans) {
      const d = document.createElement('div');
      let s = '✍ ' + (raw || '…');
      if (liveTrans) s += '\n→ ' + liveTrans;
      d.textContent = s;
      d.style.cssText = 'margin-top:4px;color:rgba(255,255,255,.55);font-size:14px;font-style:italic;white-space:pre-wrap;word-break:break-word;';
      compactEl.appendChild(d);
    }
  }
  function toggleCollapse() {
    if (!overlay) return;
    const next = !collapsed;
    applyCollapse(next);
    try { sessionStorage.setItem('__aiSubtitleCollapsed', next ? '1' : '0'); } catch (_) {}
  }

  // 渲染历史区：逐行「译文（大）+ 原文（小，双语时）」
  function renderHistory() {
    if (!historyEl) return;
    historyEl.innerHTML = '';
    for (const line of historyLines) {
      const row = document.createElement('div');
      const tr = document.createElement('div');
      tr.textContent = line.translation || line.original || '';
      tr.style.cssText =
        'color:#fff;font-size:20px;font-weight:600;line-height:1.35;text-shadow:0 1px 2px rgba(0,0,0,.6);';
      row.appendChild(tr);
      if (cfg && cfg.bilingual && line.original && line.translation) {
        const og = document.createElement('div');
        og.textContent = line.original;
        og.style.cssText = 'color:rgba(255,255,255,.7);font-size:13px;line-height:1.3;';
        row.appendChild(og);
      }
      historyEl.appendChild(row);
    }
    const body = historyEl.parentNode;
    if (body) body.scrollTop = body.scrollHeight; // 始终滚到最新
    if (collapsed) renderCompact();               // 折叠态同步最新一行
  }

  // 渲染草稿区：当前句还未定稿的原始识别文本（碎词 + 流式 partial）+ 实时译文
  function renderDraft() {
    if (!draftEl) return;
    const raw = (committedDraft + (livePartial ? ' ' + livePartial : '')).trim();
    if (!raw && !liveTrans) { draftEl.textContent = ''; if (collapsed) renderCompact(); return; }
    let s = '✍ ' + (raw || '…');
    if (liveTrans) s += '\n→ ' + liveTrans;
    draftEl.textContent = s;
    if (collapsed) renderCompact();   // 折叠态同步实时草稿
  }

  // 错误提示：保持盒子挂载可见，让用户知道为何没有字幕
  function showError(text) {
    ensureOverlay();
    if (draftEl) draftEl.textContent = '⚠ ' + text;
  }

  // 向功能页（侧边栏）同步“实时字幕是否运行中”的状态，修复“关闭字幕栏后
  // 功能页卡片仍显示已开启”的问题。通过 chrome.storage 跨上下文广播，
  // 功能页监听 chrome.storage.onChanged 更新卡片状态。
  function setCaptionRunning(active, targetLang) {
    try {
      chrome.storage.local.set({
        captionRunning: { active: !!active, targetLang: targetLang || '', ts: Date.now() },
      });
    } catch (_) {}
  }

  // ---------- 累积 → 成句 → 整理翻译 流水线 ----------
  // 平台字幕：每次收到的是当前整行（累积增长）→ 直接替换草稿。
  function feedPlatformLine(text) {
    if (!active || !text) return;
    livePartial = '';
    if (text === committedDraft) return;
    committedDraft = text;
    renderDraft();
    scheduleLiveTranslate();      // 平台字幕同样先实时翻译
    scheduleSentenceBoundary();
    maybeForceBoundary();
  }

  // Whisper（VAD 分片）：每片 final 已是完整一句 → 直接整理成一行历史。
  // 整理（refine）里会顺带翻译，因此翻译调用频率 = 句频，稳在配额内（不再做高频实时翻译）。
  function feedWhisperFinal(seq, text) {
    if (!active) return;
    const clean = (text || '').trim();
    livePartial = '';
    renderDraft();
    if (!clean) return;
    refineQueue.push({ raw: clean, carried: '' });  // 整段整理 + 翻译，一句一行
    pumpRefine();
  }

  // Whisper：流式 partial 仅作草稿区“正在识别”预览，不翻译（翻译只在成句 refine 时做一次，省配额）。
  function feedLivePartial(text) {
    if (!active) return;
    livePartial = text || '';
    renderDraft();
  }

  // 实时翻译（防抖）：把当前草稿即时翻成译文显示在草稿区，体感“字幕级”实时性；
  // 成句后的 refine 会用更干净、更连贯的整句译文替换它。
  function scheduleLiveTranslate() {
    if (!active) return;
    if (liveTransTimer) clearTimeout(liveTransTimer);
    liveTransTimer = setTimeout(doLiveTranslate, LIVE_TRANS_DEBOUNCE);
  }
  async function doLiveTranslate() {
    liveTransTimer = null;
    const cur = (committedDraft + (livePartial ? ' ' + livePartial : '')).trim();
    if (cur.length < LIVE_TRANS_MIN_CHARS || cur === liveTransRaw) { renderDraft(); return; }
    liveTransRaw = cur;
    const reqId = ++liveTransSeq;   // 本次请求序号
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'LIVE_CAPTION_TRANSLATE',
        modelId: cfg.modelId,
        targetLang: cfg.targetLang,
        lines: [cur],
      });
      // 已被更新的请求取代（旧的短请求后返回）→ 丢弃，避免译文闪回/回退
      if (reqId !== liveTransSeq) return;
      if (resp && resp.ok && Array.isArray(resp.translations)) {
        const t = (resp.translations[0] || '').trim();
        // 仅接受“真正译文”：非空且不等于原文（后台解析失败会回退原文，须拒绝这种回声）
        if (t && t !== cur) liveTrans = t;
        // 否则保留上一次的有效译文，不降级为原文
      }
    } catch (_) { /* 实时翻译失败不阻塞，保留上次译文；成句 refine 会兜底 */ }
    if (reqId === liveTransSeq) renderDraft();
  }

  // 平台字幕：每行已是完整句，句末标点或超长 → 立即收尾（Whisper 模式不调用此函数）。
  function maybeForceBoundary() {
    if (committedDraft.length >= SENTENCE_MAX_CHARS || /[。！？.!?]\s*$/.test(committedDraft)) {
      finalizeSentence();
    }
  }

  // 每来新内容就重置停顿计时器：一段时间没新词 → 判为一句话说完。
  function scheduleSentenceBoundary() {
    if (sentenceTimer) clearTimeout(sentenceTimer);
    sentenceTimer = setTimeout(finalizeSentence, SENTENCE_GAP_MS);
  }

  // 句子边界（平台字幕路径）：把当前草稿快照丢进 refine 队列，清空草稿开始下一句。
  function finalizeSentence() {
    if (sentenceTimer) { clearTimeout(sentenceTimer); sentenceTimer = null; }
    const snapshot = committedDraft.trim();
    // 携带草稿区已显示的实时译文；但若它其实等于原文（异常回声）则不携带，避免历史行显示未翻译状态
    const carried = (liveTrans && liveTrans !== snapshot) ? liveTrans : '';
    committedDraft = '';
    livePartial = '';
    liveTrans = ''; liveTransRaw = '';
    if (liveTransTimer) { clearTimeout(liveTransTimer); liveTransTimer = null; }
    renderDraft();
    if (!snapshot) return;
    refineQueue.push({ raw: snapshot, carried });
    pumpRefine();
  }

  // 追加一行历史；仅按上限做 FIFO 丢弃最旧行（不整轮清空），
  // 这样展开后可回看历史、折叠时只显示最新一行，无需删除清空。
  function appendHistory(line) {
    historyLines.push(line);
    // 按行数限制 FIFO 丢弃
    if (historyLines.length > HISTORY_MAX_LINES) {
      historyLines.splice(0, historyLines.length - HISTORY_MAX_LINES);
    }
    // 按字符数限制 FIFO 丢弃（防止长字幕占用过多内存）
    let totalChars = historyLines.reduce((sum, l) => sum + (l.original || '').length + (l.translation || '').length, 0);
    while (totalChars > HISTORY_MAX_CHARS && historyLines.length > 10) {
      const removed = historyLines.shift();
      totalChars -= (removed.original || '').length + (removed.translation || '').length;
    }
    renderHistory();
  }

  // refine 泵：串行处理，保证历史顺序与说话顺序一致。
  function pumpRefine() {
    if (refineRunning) return;
    refineRunning = true;
    (async () => {
      while (refineQueue.length && active) {
        const item = refineQueue.shift();
        const raw = typeof item === 'string' ? item : (item.raw || '');
        const carried = typeof item === 'string' ? '' : (item.carried || '');
        const lineRef = (item && typeof item === 'object' && item.lineRef) || null;
        // 携带草稿区已显示的实时译文：成句瞬间历史行即有译文（白粗体），refine 回包后再覆盖为更干净的版本。
        const placeholder = lineRef || { original: raw, translation: carried };
        if (!lineRef) appendHistory(placeholder);
        const cached = cacheGet(raw);
        if (cached) {
          placeholder.original = cached.original || raw;
          if (cached.translation && cached.translation.trim()) placeholder.translation = cached.translation.trim();
          renderHistory();
          continue;
        }
        try {
          const resp = await chrome.runtime.sendMessage({
            type: 'LIVE_CAPTION_REFINE',
            modelId: cfg.modelId,
            targetLang: cfg.targetLang,
            sourceLang: cfg.sourceLang,
            fragments: [raw],
          });
          if (!active) continue; // await 期间用户可能已停止字幕，跳过 DOM 操作
          if (resp && resp.ok) {
            placeholder.original = (resp.original && resp.original.trim()) || raw;
            const t = (resp.translation && resp.translation.trim()) || '';
            if (t) placeholder.translation = t;   // 仅当 refine 给出非空译文才覆盖（保留携带的实时译文）
            setCache(raw, { original: placeholder.original, translation: placeholder.translation });
          }
        } catch (e) { 
          if (!active) { console.debug('[refine] 已停止，跳过异常处理'); continue; }
          console.warn('[refine] 整理失败：', e && e.message);
        }
        renderHistory();
        // 每次循环后检查 active 状态，避免用户停止后继续处理队列
        if (!active) break;
      }
      refineRunning = false;
    })();
  }

  // ---------- 平台字幕：YouTube DOM 监听 ----------
  function findYouTubeCaptionWindow() {
    return document.querySelector('.ytp-caption-window-rollup')
      || document.querySelector('.ytp-caption-window-container .ytp-caption-window');
  }
  function setupYouTubeCaptions() {
    captionWindow = findYouTubeCaptionWindow();
    if (!captionWindow) return false;
    captionObserver = new MutationObserver(() => {
      const segs = captionWindow.querySelectorAll('.ytp-caption-segment');
      const text = Array.from(segs).map(s => s.textContent).join(' ').trim();
      if (text) feedPlatformLine(text);
    });
    captionObserver.observe(captionWindow, { childList: true, subtree: true, characterData: true });
    // 字幕容器可能在用户开关 CC 后被重建：轮询找回
    captionPoller = setInterval(() => {
      if (!captionWindow || !document.body.contains(captionWindow)) {
        const w = findYouTubeCaptionWindow();
        if (w) {
          captionWindow = w;
          captionObserver && captionObserver.disconnect();
          captionObserver = new MutationObserver(() => {
            const segs = captionWindow.querySelectorAll('.ytp-caption-segment');
            const text = Array.from(segs).map(s => s.textContent).join(' ').trim();
            if (text) feedPlatformLine(text);
          });
          captionObserver.observe(captionWindow, { childList: true, subtree: true, characterData: true });
        }
      }
    }, 1500);
    return true;
  }

  // ---------- 平台字幕：原生 <track> 字幕轨（支持预取）----------
  function setupNativeTracks(video) {
    if (!video || !video.textTracks || video.textTracks.length === 0) return false;
    const tracks = Array.from(video.textTracks).filter(t => t.kind === 'captions' || t.kind === 'subtitles');
    if (!tracks.length) return false;
    const track = tracks[0];
    const onCue = () => {
      if (!active) return;
      const active2 = track.activeCues;
      if (active2 && active2.length) {
        const text = Array.from(active2).map(c => c.text).join('\n').replace(/<[^>]+>/g, '').trim();
        if (text) feedPlatformLine(text);
      }
    };
    track.mode = 'hidden';
    track.addEventListener('cuechange', onCue);
    trackWatch = { track, onCue };
    return true;
  }

  // ---------- Whisper：音频已在 Offscreen 文档捕获并切片 ----------
  // 本函数只负责“请求后台启动 Offscreen 捕获”。真实捕获 / 声音恢复 / 切片 / 转 WAV 都在
  // offscreen/subtitle-offscreen.js 里完成；捕获到的音频片段经 SW 以 LIVE_CAPTION_AUDIO
  // 消息转发到这里，再由 enqueueWhisper 送 Whisper 转写。
  async function setupWhisper() {
    const resp = await chrome.runtime.sendMessage({ type: 'LIVE_CAPTION_START_CAPTURE' });
    if (!resp || !resp.ok) {
      throw new Error((resp && resp.error) || '无法启动音频捕获（Whisper 模式需要标签页音频权限）');
    }
    if (draftEl) draftEl.textContent = '🎙 正在识别语音…';
    return true;
  }

  // base64 字符串 → Uint8Array（跨进程音频的统一载体，字符串传输 100% 可靠）
  function base64ToBytes(b64) {
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // 把跨进程传来的音频数据统一成“可被 Blob 包裹的二进制”。
  // 主路径：offscreen 已把音频编码为 base64 字符串（字符串在 sendMessage / 端口里都可靠）。
  // 同时保留对 ArrayBuffer / Uint8Array / Blob / 普通数字键对象的兼容兜底。
  function toBytes(audio) {
    if (audio == null) return null;
    if (typeof audio === 'string') {
      try { return base64ToBytes(audio); } catch (_) { return null; }
    }
    // ArrayBuffer：直接 instanceof 或按 byteLength + constructor 名称判断，
    // 规避跨 realm（扩展世界 ↔ 内容脚本隔离世界）instanceof 失效的情形。
    const isArrayBufferLike = audio instanceof ArrayBuffer
      || (typeof audio.byteLength === 'number' && !ArrayBuffer.isView(audio)
          && audio.constructor && /ArrayBuffer/.test(audio.constructor.name));
    if (isArrayBufferLike) return new Uint8Array(audio);
    if (ArrayBuffer.isView(audio)) return new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
    if (audio instanceof Blob) return audio;
    if (typeof audio === 'object') {
      const keys = Object.keys(audio).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
      if (keys.length) {
        const u8 = new Uint8Array(keys.length);
        for (let i = 0; i < keys.length; i++) u8[i] = audio[keys[i]];
        return u8;
      }
    }
    return null;
  }

  // 把捕获到的音频片送入队列，分配序号后尝试泵流（方案 B：并发泵流）。
  function enqueueWhisper(audio, mime) {
    if (!active) return; // 防止 stop() 后还塞入队列
    if (whisperQueue.length >= MAX_WHISPER_QUEUE) {
      console.warn('[whisper] Queue full, dropping oldest slice');
      whisperQueue.shift();
    }
    whisperQueue.push({ seq: whisperSeq++, audio, mime });
    pumpWhisper();
  }

  // 兼容旧消息：VAD 分片后 offscreen 不再发静音标记（判句已在音频源头完成）。保留空实现避免报错。
  function enqueueWhisperSilence() { /* no-op */ }

  // 并发泵流：同时最多开 WHISPER_CONCURRENCY 个 whisper-stream 端口，
  // 各片重叠发送，避免单片延迟在队列里累积（方案 B）。
  function pumpWhisper() {
    if (whisperRunning) return; // 防重入
    whisperRunning = true;
    while (whisperQueue.length && whisperActive < WHISPER_CONCURRENCY) {
      const item = whisperQueue.shift();
      whisperActive++;
      runOneWhisper(item).finally(() => {
        whisperActive--;
        pumpWhisper();
      });
    }
    whisperRunning = false;
  }

  // 单端口转写一片：partial 暂存，final/error 标记完成，统一由 flushInOrder 按序冲刷。
  async function runOneWhisper(item) {
    const seq = item.seq;
    const port = chrome.runtime.connect({ name: 'whisper-stream' });
    whisperPorts.add(port);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      whisperPorts.delete(port);
      whisperLive.delete(seq);
      try { port.disconnect(); } catch (_) {}
    };
    port.onMessage.addListener((m) => {
      if (!active) { finish(); return; }
      if (m.type === 'partial') {
        const txt = m.text || '';
        whisperLive.set(seq, txt);
        // partial 仅作草稿区预览（灰色斜体），不定稿；final 后并入 committedDraft 累积成句。
        if (seq === whisperNextShow) feedLivePartial(txt);
      } else if (m.type === 'final') {
        whisperErrored = false;
        whisperDone.set(seq, (m.text || '').trim());
        finish();
        flushInOrder();
      } else if (m.type === 'error') {
        if (!whisperErrored) { whisperErrored = true; showError('Whisper 转写失败：' + m.error); }
        whisperDone.set(seq, ''); // 标记该片已完成（空），避免卡住后续按序冲刷
        finish();
        flushInOrder();
      }
    });
    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError && !whisperErrored) {
        whisperErrored = true;
        showError('Whisper 连接断开：' + chrome.runtime.lastError.message);
      }
      if (!finished) {
        whisperDone.set(seq, '');
        finish();
        flushInOrder();
      }
    });
    try {
      const bytes = toBytes(item.audio);
      if (!bytes) {
        console.warn('[whisper] 音频数据无效，跳过该片');
        whisperDone.set(seq, '');
        finish();
        flushInOrder();
        return;
      }
      const blob = (bytes instanceof Blob) ? bytes : new Blob([bytes], { type: item.mime || 'audio/wav' });
      const buf = await blob.arrayBuffer();
      port.postMessage({
        type: 'slice',
        whisperModelIds: cfg.whisperModelIds || [],
        audio: new Uint8Array(buf),
        language: cfg.sourceLang,
        mime: item.mime || 'audio/wav',
      });
    } catch (e) {
      console.warn('[whisper] 读取音频数据失败', e);
      whisperDone.set(seq, '');
      finish();
      flushInOrder();
    }
  }

  // 按序号顺序冲刷已完成的转写结果，保证字幕不乱序。
  function flushInOrder() {
    while (whisperDone.has(whisperNextShow)) {
      const seq = whisperNextShow;
      const txt = whisperDone.get(seq);
      whisperDone.delete(seq);
      whisperNextShow++;
      if (txt) {
        feedWhisperFinal(seq, txt);   // 每片=一句：直接整理成一行历史
      } else {
        // 该片无有效语音（幻觉短语 / 纯背景音被后台过滤成空）→ 忽略，仅清预览
        livePartial = '';
        renderDraft();
      }
    }
    renderLiveForSeq();
  }

  // 流式显示：只展示“下一个待显示序号”那片的 partial 到草稿区。
  function renderLiveForSeq() {
    feedLivePartial(whisperLive.get(whisperNextShow) || '');
  }

  // ---------- 启动 / 停止 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'LIVE_CAPTION_START') {
      (async () => {
        let ok = true, error = null;
        try {
          await start(msg);
        } catch (e) {
          ok = false;
          error = (e && e.message) ? e.message : String(e);
        }
        if (!ok) showError(error);
        try { sendResponse({ ok, error }); } catch (_) {}
      })();
      return true;
    }
    if (msg.type === 'LIVE_CAPTION_STOP') {
      stop();
      sendResponse({ ok: true });
      return true;
    }
    // 侧边栏“总结字幕”：返回当前累积的字幕转录（{original,translation}）。
    // 即便字幕已停止（active=false），只要本页会话仍累积过字幕即可返回，方便事后总结。
    if (msg.type === 'LIVE_CAPTION_GET_TRANSCRIPT') {
      try {
        sendResponse({ ok: true, active, lines: historyLines.slice() });
      } catch (_) {
        sendResponse({ ok: false, error: '字幕转录读取失败' });
      }
      return;
    }
    // Offscreen 文档捕获到的音频片段（base64 字符串）→ 送 Whisper 转写
    if (msg.type === 'LIVE_CAPTION_AUDIO') {
      enqueueWhisper(msg.audioB64, msg.mime);
      return;
    }
    // Offscreen 检测到的静音窗口 → 音频时间轴判句
    if (msg.type === 'LIVE_CAPTION_SILENCE') {
      enqueueWhisperSilence();
      return;
    }
    // Offscreen 捕获失败（如权限不足 / activeTab 未授权）→ 仅提示，不阻塞
    if (msg.type === 'LIVE_CAPTION_CAPTURE_ERROR') {
      if (!active) return;
      showError(msg.error || '音频捕获失败');
      // 通知后台停止并关闭 offscreen，释放标签页音频、恢复原生声音
      try { chrome.runtime.sendMessage({ type: 'LIVE_CAPTION_STOP_CAPTURE' }); } catch (_) {}
      return;
    }
  });

  async function start(msg) {
    if (active) stop();   // 重新开始：先清理旧状态，避免叠加/卡死
    historyLines.length = 0;   // 新会话：清空上一轮累积的字幕（停止字幕不再清空，便于事后总结）
    cfg = {
      modelId: msg.modelId,
      targetLang: msg.targetLang,
      sourceLang: msg.sourceLang,
      sourceMode: msg.sourceMode || 'auto',
      whisperModelIds: msg.whisperModelIds || [],
      prefetch: !!msg.prefetch,
      bilingual: msg.bilingual !== false,
    };
    active = true;
    ensureOverlay();
    setCaptionRunning(true, cfg.targetLang);

    const video = document.querySelector('video');
    const mode = cfg.sourceMode;

    if (mode === 'platform') {
      if (!tryPlatform(video)) throw new Error('未找到平台字幕（请确认视频已开启字幕 CC）');
      return true;
    }
    if (mode === 'whisper') {
      const ok = await setupWhisper();
      if (!ok) throw new Error('无法捕获标签页音频（Whisper 模式需要标签页音频权限）');
      return true;
    }
    // auto：先试平台字幕，失败再回退 Whisper
    if (tryPlatform(video)) return true;
    const ok = await setupWhisper();
    if (!ok) throw new Error('未检测到平台字幕，且无法启用 Whisper 音频捕获');
    return true;
  }

  function tryPlatform(video) {
    if (setupYouTubeCaptions()) return true;
    if (video && setupNativeTracks(video)) return true;
    return false;
  }

  // 将当前累积的字幕作为一条记录提交到 chrome.storage.local.subtitles（供“字幕管理”列表展示 / 批量总结）。
  function commitCurrentSubtitle() {
    if (!historyLines.length) return;
    const first = historyLines[0];
    const defaultName = ((first.translation || first.original || '').trim() || '未命名字幕').slice(0, 40);
    const item = {
      id: 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      name: defaultName,
      lines: historyLines.map(l => ({ original: l.original || '', translation: l.translation || '' })),
      createdAt: Date.now(),
      source: 'live',
    };
    try {
      chrome.storage.local.get('subtitles', (v) => {
        const arr = Array.isArray(v && v.subtitles) ? v.subtitles : [];
        arr.unshift(item);
        try { chrome.storage.local.set({ subtitles: arr }); } catch (_) {}
      });
    } catch (_) {}
  }

  function stop() {
    active = false;
    setCaptionRunning(false);   // 通知功能页：字幕已停止
    // 先断开所有活跃的 Whisper 端口，阻止后续回调访问已销毁的 DOM
    whisperPorts.forEach((p) => { try { p.disconnect(); } catch (_) {} });
    whisperPorts.clear();
    disableDrag(); // 清理拖拽事件监听器，解除闭包引用
    if (captionObserver) { captionObserver.disconnect(); captionObserver = null; }
    if (captionPoller) { clearInterval(captionPoller); captionPoller = null; }
    if (trackWatch) { try { trackWatch.track.removeEventListener('cuechange', trackWatch.onCue); } catch (_) {} trackWatch = null; }
    if (prefetchTimer) { clearInterval(prefetchTimer); prefetchTimer = null; }
    // 通知后台停止 offscreen 音频捕获并关闭离屏文档，释放标签页音频、恢复原生声音
    try { chrome.runtime.sendMessage({ type: 'LIVE_CAPTION_STOP_CAPTURE' }); } catch (_) {}
    whisperQueue = []; whisperActive = 0; whisperRunning = false;
    whisperSeq = 0; whisperNextShow = 0;
    whisperDone.clear(); whisperLive.clear();
    // 累积/整理相关状态清理
    liveTransSeq = 0;
    if (sentenceTimer) { clearTimeout(sentenceTimer); sentenceTimer = null; }
    refineQueue = []; refineRunning = false;
    committedDraft = ''; livePartial = '';
    liveTrans = ''; liveTransRaw = '';
    if (liveTransTimer) { clearTimeout(liveTransTimer); liveTransTimer = null; }
    cacheKeys.length = 0; translationCache.clear();
    // 本次字幕会话结束：将累积字幕作为一条记录存入“字幕管理”列表（持久化），随后清空内存中的 live 转录
    commitCurrentSubtitle();
    historyLines.length = 0;
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null; boxHeader = null; historyEl = null; draftEl = null; captionWindow = null;
  }
})();
