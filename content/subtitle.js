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
  if (window.self !== window.top) return;       // 仅顶层文档
  if (window.__aiSubtitleWorker) return;
  window.__aiSubtitleWorker = true;

  let active = false;
  let cfg = null;            // 当前配置（来自 LIVE_CAPTION_START）
  let overlay = null;
  let origEl = null, transEl = null;
  let currentKey = '';       // 当前正在显示的字幕原文（去重用）

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

  // 翻译批处理 + 缓存
  let pendingBatch = [];
  let batchTimer = null;
  const translationCache = new Map();
  const cacheKeys = [];            // FIFO 缓存键队列
  const MAX_CACHE = 600;
  const BATCH_MS = 280;
  const PREFETCH_AHEAD_LIMIT = 12; // 预取时一次最多翻译的 cue 数
  let translateTokenCount = 0;     // 速率限制令牌
  let translateTokenTimestamps = []; // 每个令牌的过期时间戳
  const TRANSLATE_RATE_MAX = 4;    // 每 TRANSLATE_RATE_WINDOW 最多允许的翻译批次
  const TRANSLATE_RATE_WINDOW = 3000; // 3s 滑动窗口

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

  // ---------- 字幕覆盖层 ----------
  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;left:50%;bottom:8%;transform:translateX(-50%);' +
      'max-width:82%;text-align:center;z-index:2147483647;pointer-events:none;' +
      'font-family:-apple-system,BlinkMacFont,"Segoe UI",Roboto,sans-serif;' +
      'line-height:1.4;transition:opacity .15s;';
    transEl = document.createElement('div');
    transEl.style.cssText =
      'display:inline-block;margin:2px auto;padding:4px 12px;border-radius:10px;' +
      'background:rgba(0,0,0,.62);color:#fff;font-size:22px;font-weight:600;' +
      'text-shadow:0 1px 2px rgba(0,0,0,.6);backdrop-filter:blur(2px);';
    transEl.textContent = '';
    origEl = document.createElement('div');
    origEl.style.cssText =
      'display:inline-block;margin:2px auto;padding:2px 10px;border-radius:8px;' +
      'background:rgba(0,0,0,.38);color:rgba(255,255,255,.82);font-size:14px;';
    origEl.textContent = '';
    overlay.appendChild(origEl);
    overlay.appendChild(transEl);
    document.documentElement.appendChild(overlay);
  }
  function renderLine(original, translation) {
    if (cfg && !cfg.bilingual) {
      origEl.style.display = 'none';
      transEl.textContent = translation || original;  // 无译文时回退原文
    } else {
      origEl.style.display = '';
      origEl.textContent = original || '';
      transEl.textContent = translation || '';
    }
  }
  // 错误提示：保持覆盖层挂载可见，让用户知道为何没有字幕
  function showError(text) {
    ensureOverlay();
    if (origEl) origEl.style.display = 'none';
    if (transEl) transEl.textContent = '⚠ ' + text;
  }

  // ---------- 翻译流水线 ----------
  function showCaption(text) {
    if (!active || !text) return;
    if (text === currentKey) return;            // 同句去重
    currentKey = text;
    const cached = cacheGet(text);
    renderLine(text, cached || '');
    if (!cached) requestTranslate(text);
  }

  function requestTranslate(text) {
    if (pendingBatch.includes(text)) return;
    pendingBatch.push(text);
    if (batchTimer) return;
    batchTimer = setTimeout(flushTranslate, BATCH_MS);
  }

  async function flushTranslate() {
    batchTimer = null;
    const batch = pendingBatch; pendingBatch = [];
    if (!batch.length) return;
    const uncached = batch.filter(t => !cacheGet(t));
    if (!uncached.length) return;
    // 速率限制：滑动窗口内超过上限则等待最老的令牌过期后再重试
    const now = Date.now();
    translateTokenTimestamps = translateTokenTimestamps.filter(t => now - t < TRANSLATE_RATE_WINDOW);
    if (translateTokenTimestamps.length >= TRANSLATE_RATE_MAX) {
      pendingBatch = uncached;
      const oldest = translateTokenTimestamps[0];
      const waitMs = TRANSLATE_RATE_WINDOW - (now - oldest) + 50; // 等最老令牌过期 + 50ms
      batchTimer = setTimeout(flushTranslate, Math.min(waitMs, 5000));
      return;
    }
    translateTokenTimestamps.push(now);
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'LIVE_CAPTION_TRANSLATE',
        modelId: cfg.modelId,
        targetLang: cfg.targetLang,
        lines: uncached,
      });
      if (resp && resp.ok && Array.isArray(resp.translations)) {
        uncached.forEach((line, i) => {
          const t = resp.translations[i];
          if (t && t.trim()) {
            setCache(line, t.trim());
            if (line === currentKey) renderLine(line, t.trim());
          }
        });
      }
    } catch (_) { /* 单批失败不影响字幕显示 */ }
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
      if (text) showCaption(text);
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
            if (text) showCaption(text);
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
        if (text) showCaption(text);
      }
    };
    track.mode = 'hidden';
    track.addEventListener('cuechange', onCue);
    trackWatch = { track, onCue };

    // 预取：把"已缓存但未观看"的后续 cue 提前翻译（非直播提速关键）
    if (cfg.prefetch) {
      prefetchTimer = setInterval(() => {
        if (!active || !track || !track.cues || track.cues.length === 0) return;
        const t = video.currentTime;
        const ahead = [];
        for (let i = 0; i < track.cues.length; i++) {
          const c = track.cues[i];
          if (c.startTime >= t && c.startTime <= t + 40) {
            const txt = (c.text || '').replace(/<[^>]+>/g, '').trim();
            if (txt && !cacheGet(txt)) ahead.push(txt);
          }
        }
        ahead.slice(0, PREFETCH_AHEAD_LIMIT).forEach(requestTranslate);
      }, 3000);
    }
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
    renderLine('', '🎙 正在识别语音…');
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
        whisperLive.set(seq, m.text || '');
        renderLiveForSeq();
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
      const txt = whisperDone.get(whisperNextShow);
      whisperDone.delete(whisperNextShow);
      whisperNextShow++;
      if (txt) {
        showCaption(txt);   // 复用翻译/显示流水线
      } else {
        // 该片段无有效语音：清掉仍停留在屏幕上的 partial 残影，避免显示错误的半句字幕
        currentKey = '';
        if (origEl) origEl.textContent = '';
        if (transEl) transEl.textContent = '';
      }
    }
    renderLiveForSeq();
  }

  // 流式显示：只展示“下一个待显示序号”那片的 partial，避免并发片的残影互相覆盖。
  function renderLiveForSeq() {
    renderStreaming(whisperLive.get(whisperNextShow) || '');
  }
  // 流式 partial：原文逐字刷新（双语模式显示原文 + "…"占位译文；单语模式直接显示）
  function renderStreaming(text) {
    if (!active) return; // 防止 stop() 后回调访问已销毁的 DOM
    ensureOverlay();
    if (cfg && !cfg.bilingual) {
      origEl.style.display = 'none';
      transEl.textContent = text || '…';
    } else {
      origEl.style.display = '';
      origEl.textContent = text || '…';
      transEl.textContent = '…';
    }
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
    // Offscreen 文档捕获到的音频片段（base64 字符串）→ 送 Whisper 转写
    if (msg.type === 'LIVE_CAPTION_AUDIO') {
      enqueueWhisper(msg.audioB64, msg.mime);
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

  function stop() {
    active = false;
    // 先断开所有活跃的 Whisper 端口，阻止后续回调访问已销毁的 DOM
    whisperPorts.forEach((p) => { try { p.disconnect(); } catch (_) {} });
    whisperPorts.clear();
    if (captionObserver) { captionObserver.disconnect(); captionObserver = null; }
    if (captionPoller) { clearInterval(captionPoller); captionPoller = null; }
    if (trackWatch) { try { trackWatch.track.removeEventListener('cuechange', trackWatch.onCue); } catch (_) {} trackWatch = null; }
    if (prefetchTimer) { clearInterval(prefetchTimer); prefetchTimer = null; }
    // 通知后台停止 offscreen 音频捕获并关闭离屏文档，释放标签页音频、恢复原生声音
    try { chrome.runtime.sendMessage({ type: 'LIVE_CAPTION_STOP_CAPTURE' }); } catch (_) {}
    whisperQueue = []; whisperActive = 0; whisperRunning = false;
    whisperSeq = 0; whisperNextShow = 0;
    whisperDone.clear(); whisperLive.clear();
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    pendingBatch = []; currentKey = ''; cacheKeys.length = 0;
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null; origEl = null; transEl = null; captionWindow = null;
  }
})();
