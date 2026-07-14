// content/subtitle.js
// 实时字幕 —— 页面 Worker：监听平台内嵌字幕（优先）或捕获标签页音频经 Whisper 转写，
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

  // Whisper 音频抓取（流式：每片独立录制为完整 webm，直接发给后台转写；Groq 原生支持 webm）
  let whisperStream = null;       // getUserMedia 得到的标签页音频流
  let whisperRec = null;          // 当前片 MediaRecorder
  let whisperSliceTimer = null;   // 当前片停止 / 下一片启动的定时器
  let whisperAudioEl = null;      // 用于把捕获流回放到扬声器，恢复标签页声音（避免静音）
  let whisperQueue = [];          // 待转写的音频 Blob 队列（顺序处理，避免字幕错乱）
  let whisperBusy = false;        // 当前是否有切片正在流式转写
  let whisperPort = null;         // 当前活跃的 Whisper 连接端口（用于 stop 时断开）
  let whisperErrored = false;     // 转写失败仅提示一次，避免刷屏
  let whisperUnmuteTimer = null;   // 音频元素取消静音的重试定时器
  let gestureListeners = [];      // 音频元素手势监听器引用，用于清理
  const WHISPER_SLICE_MS = 4000;  // 每片时长：4 秒，远小于视频节奏，配合流式接近实时
  const MAX_WHISPER_QUEUE = 10;   // Whisper 队列最大长度，防止内存溢出
  const WHISPER_MIN_BLOB_SIZE = 1024;  // 静音片段跳过阈值

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
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
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

// ---------- Whisper：捕获标签页音频并流式切片转写 ----------
  async function setupWhisper() {
    // 0) 优先使用 video.captureStream() —— 不静音视频，捕获流保证有音频数据
    const video = document.querySelector('video');
    if (video && typeof video.captureStream === 'function') {
      // 确保 video 已加载元数据 + 正在播放（captureStream 只有在音频轨道活跃时才返回它们）
      if (video.readyState < 1) {
        // 等待 loadedmetadata
        try { await new Promise((r, rej) => {
          const t = setTimeout(() => r(), 3000);
          video.addEventListener('loadedmetadata', () => { clearTimeout(t); r(); }, { once: true });
        }); } catch (_) {}
      }
      if (video.paused) {
        try { await video.play(); } catch (_) { /* CORS 或其他策略阻止播放，继续尝试 */ }
        // 给音频解码一点时间
        if (video.paused) await new Promise(r => setTimeout(r, 800));
      }
      // 重试 captureStream（给 video 足够时间建立音频管线）
      for (let i = 0; i < 4; i++) {
        try {
          const vs = video.captureStream(0);
          if (vs && vs.getAudioTracks().length) {
            whisperStream = vs;
            renderLine('', '🎙 正在识别语音…');
            startWhisperSlice();
            return true;
          }
        } catch (_) {}
        if (i < 3) await new Promise(r => setTimeout(r, 500));
      }
    }
    // 1) tabCapture 兜底：向后台请求标签页音频流 id
    const streamResp = await chrome.runtime.sendMessage({ type: 'LIVE_CAPTION_GET_STREAM' });
    if (!streamResp || !streamResp.ok || !streamResp.streamId) {
      throw new Error((streamResp && streamResp.error) || '无法获取标签页音频流');
    }
    // 2) 凭 streamId 抓取标签页音频
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamResp.streamId } },
      });
    } catch (e) {
      throw new Error('getUserMedia 失败（标签页音频）：' + (e && e.message ? e.message : e));
    }
    if (!stream || !stream.getAudioTracks().length) {
      throw new Error('未获取到标签页音频轨道');
    }
    whisperStream = stream;
    // tabCapture 会断开标签页扬声器输出（静音）。下面用双重路径恢复声音：
    //   A) <audio> 元素：muted 起播 → 等播放中 firstShoot → 取消静音
    //   B) Web Audio API：createMediaStreamSource → destination（直连扬声器管道）
    //      AudioContext 需要用户手势，若 suspended 则挂 gesture listener 等用户点页面后再连接。
    //   两条路径同时工作、互不干扰。
    try {
      whisperAudioEl = document.createElement('audio');
      whisperAudioEl.muted = true;
      whisperAudioEl.volume = 1;
      whisperAudioEl.playsInline = true;
      whisperAudioEl.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
      document.documentElement.appendChild(whisperAudioEl);
      whisperAudioEl.srcObject = stream;
      const doUnmute = () => { if (whisperAudioEl) { whisperAudioEl.muted = false; whisperAudioEl.volume = 1; } };
      // muted play → 等 playing 事件 + 确有数据后 unmute；超时 2s 兜底
      whisperAudioEl.play().then(() => {
        const now = Date.now();
        const check = setInterval(() => {
          if (!whisperAudioEl || whisperAudioEl.muted === false) { clearInterval(check); return; }
          if (whisperAudioEl.readyState >= 3 && whisperAudioEl.currentTime > 0 && !whisperAudioEl.paused) {
            doUnmute(); clearInterval(check);
          }
          if (Date.now() - now > 2000) { doUnmute(); clearInterval(check); }
        }, 150);
      }).catch(() => {
        // 极端被拦截：用 gesture 恢复
        const onGesture = () => {
          if (!whisperAudioEl) return;
          whisperAudioEl.muted = false;
          if (whisperAudioEl.paused) whisperAudioEl.play().catch(() => {});
        };
        [{ ev: 'pointerdown' }, { ev: 'keydown' }, { ev: 'touchstart' }].forEach(({ ev }) => {
          const fn = onGesture;
          const opts = { once: true, capture: true };
          gestureListeners.push({ el: document, event: ev, fn, opts });
          document.addEventListener(ev, fn, opts);
        });
      });
    } catch (_) { whisperAudioEl = null; }
  let whisperAudioCtx = null;     // 路径 B 的 AudioContext 实例，用于 stop() 时关闭
  let whisperAudioCtxGestures = []; // 路径 B 手势监听器引用，用于清理
  let wavDecodeCtx = null;        // 持久 AudioContext，用于 webm→WAV 解码（每片复用，避免重复创建）
  let wavDecodeCtxPending = false; // 等待 wavDecodeCtx 初始化完成
  // 路径 B: Web Audio API 直连 destination
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      const ac = new AC();
      whisperAudioCtx = ac;
      if (ac.state === 'running') {
        const src = ac.createMediaStreamSource(stream);
        src.connect(ac.destination);
      } else {
        // suspended → 等用户手势后 resume + 连接
        const connectAc = () => {
          ac.resume().then(() => {
            try {
              const src = ac.createMediaStreamSource(stream);
              src.connect(ac.destination);
            } catch (_) {}
          }).catch(() => {});
        };
        ['pointerdown', 'keydown', 'touchstart'].forEach(ev => {
          const opts = { once: true, capture: true };
          whisperAudioCtxGestures.push({ el: document, event: ev, fn: connectAc, opts });
          document.addEventListener(ev, connectAc, opts);
        });
      }
    }
  } catch (_) {}
    renderLine('', '🎙 正在识别语音…');
    startWhisperSlice();
    return true;
  }

  // 每片用独立的 MediaRecorder 录制 WHISPER_SLICE_MS 毫秒，得到"带头部、可独立解码"的 webm，
  // 再转成 WAV（PCM16）发给后台——WAV 是所有 Whisper 端点（含 Groq）可靠解析的格式，
  // 可彻底避免"Chrome MediaRecorder 产出的 webm/opus 被 Groq 判为无音频轨道"导致的 400。
  function startWhisperSlice() {
    if (!active || !whisperStream) return;
    let rec;
    try {
      const opts = (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported
        && MediaRecorder.isTypeSupported('audio/webm')) ? { mimeType: 'audio/webm' } : undefined;
      rec = new MediaRecorder(whisperStream, opts);
    } catch (e) {
      // Fallback to default if webm fails
      try {
        rec = new MediaRecorder(whisperStream);
      } catch (e2) {
        showError('MediaRecorder 不支持任何音频格式'); return;
      }
    }
    whisperRec = rec;
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    rec.onerror = (e) => { console.warn('[whisper] MediaRecorder error', e); };
    rec.onstop = async () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      if (blob.size >= WHISPER_MIN_BLOB_SIZE) {            // 静音片段：跳过，省额度
        let sendBlob = blob, mime = 'audio/webm';
        try {
          const wav = await toWav(blob);  // webm/opus → WAV（可靠解析，避免 400）
          sendBlob = wav; mime = 'audio/wav';
        } catch (e) {
          console.warn('[whisper] webm→wav 失败，回退原始 webm', e);
        }
        enqueueWhisper(sendBlob, mime);
      }
      if (active) whisperSliceTimer = setTimeout(startWhisperSlice, 0); // 紧接着录下一片
    };
    // 防止 stop() 在 entry check 和 rec.start() 之间执行：再次检查 active
    if (!active || !whisperStream) return;
    try { rec.start(); } catch (e) { showError('录制失败：' + e.message); return; }
    whisperSliceTimer = setTimeout(() => { try { rec.stop(); } catch (_) {} }, WHISPER_SLICE_MS);
  }

  // webm/opus → WAV(PCM16)。关键：
  // - Web Audio API 规定 decodeAudioData 会 detach 入参 ArrayBuffer，每次 decode 必须用独立副本。
  // - 复用持久 AudioContext（每片不新建），避免重复初始化阻塞主线程。
  // - 每段 4s 录制可能含纯静音段；解码后 length=0 则不转 WAV（直接抛出，让上层的目标文件大小
  //   校验 WHISPER_MIN_BLOB_SIZE=1024 拦截，避免 Groq 收到 Header-Only WAV 报 400）。
  async function toWav(blob) {
    const raw = await blob.arrayBuffer();
    const copy = raw.slice(0); // decodeAudioData 会 detach，每次用独立副本
    const AC = window.AudioContext || window.webkitAudioContext;
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    let audioBuf = null;
    // 路径 1: 复用持久 AudioContext（首次创建）
    if (AC) {
      try {
        if (!wavDecodeCtx) {
          wavDecodeCtx = new AC();
          try { if (wavDecodeCtx.state === 'suspended') await wavDecodeCtx.resume(); } catch (_) {}
        }
        audioBuf = await wavDecodeCtx.decodeAudioData(copy);
      } catch (e) {
        console.warn('[whisper] 持久 AudioContext decode 失败，尝试 OfflineAudioContext', e);
      }
    }
    // 路径 2: OfflineAudioContext（备用）
    if (!audioBuf && OAC) {
      const ctx = new OAC(1, 44100 * 60, 44100);
      audioBuf = await ctx.decodeAudioData(copy);
    }
    if (!audioBuf) throw new Error('无可用的 AudioContext/OfflineAudioContext');
    if (!audioBuf.length || audioBuf.duration <= 0) {
      throw new Error('解码后的音频无有效采样（可能是静音段）');
    }
    return encodeWav(audioBuf);
  }
  function encodeWav(audioBuffer) {
    const numCh = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const samples = audioBuffer.length;
    const blockAlign = numCh * 2;
    const dataSize = samples * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize);
    const view = new DataView(ab);
    let off = 0;
    const writeStr = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(off++, s.charCodeAt(i)); };
    writeStr('RIFF'); view.setUint32(off, 36 + dataSize, true); off += 4;
    writeStr('WAVE'); writeStr('fmt '); view.setUint32(off, 16, true); off += 4;
    view.setUint16(off, 1, true); off += 2;            // PCM
    view.setUint16(off, numCh, true); off += 2;
    view.setUint32(off, sampleRate, true); off += 4;
    view.setUint32(off, sampleRate * blockAlign, true); off += 4;
    view.setUint16(off, blockAlign, true); off += 2;
    view.setUint16(off, 16, true); off += 2;
    writeStr('data'); view.setUint32(off, dataSize, true); off += 4;
    const ch = []; for (let c = 0; c < numCh; c++) ch.push(audioBuffer.getChannelData(c));
    let pos = 44;
    for (let i = 0; i < samples; i++) {
      for (let c = 0; c < numCh; c++) {
        let s = Math.max(-1, Math.min(1, ch[c][i]));
        view.setInt16(pos, s < 0 ? s * 0x8000 : s * 0x7FFF, true); pos += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  // 顺序把队列里的音频片发给后台做流式转写：partial 实时更新字幕，final 触发翻译。
  function enqueueWhisper(blob, mime) {
    if (whisperQueue.length >= MAX_WHISPER_QUEUE) {
      console.warn('[whisper] Queue full, dropping oldest slice');
      whisperQueue.shift();
    }
    whisperQueue.push({ blob, mime });
    pumpWhisper();
  }
  async function pumpWhisper() {
    if (whisperBusy || !whisperQueue.length) return;
    whisperBusy = true;
    const item = whisperQueue.shift();
    const port = chrome.runtime.connect({ name: 'whisper-stream' });
    whisperPort = port;
    port.onMessage.addListener((m) => {
      if (!active) { port.disconnect(); whisperPort = null; whisperBusy = false; return; }
      if (m.type === 'partial') {
        renderStreaming(m.text || '');
      } else if (m.type === 'final') {
        whisperErrored = false;
        showCaption((m.text || '').trim());   // 复用翻译/显示流水线
        whisperBusy = false; whisperPort = null; port.disconnect(); pumpWhisper();
      } else if (m.type === 'error') {
        if (!whisperErrored) { whisperErrored = true; showError('Whisper 转写失败：' + m.error); }
        whisperBusy = false; whisperPort = null; port.disconnect(); pumpWhisper();
      }
    });
    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError && !whisperErrored) {
        whisperErrored = true;
        showError('Whisper 连接断开：' + chrome.runtime.lastError.message);
      }
      if (whisperBusy) { whisperBusy = false; whisperPort = null; pumpWhisper(); }
    });
    try {
      const buf = await item.blob.arrayBuffer();
      port.postMessage({
        type: 'slice',
        whisperModelIds: cfg.whisperModelIds || [],
        audio: new Uint8Array(buf),
        language: cfg.sourceLang,
        mime: item.mime || 'audio/wav',
      });
    } catch (e) {
      console.warn('[whisper] 读取音频数据失败', e);
      whisperBusy = false; whisperPort = null; port.disconnect(); pumpWhisper();
    }
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
    // 先断开活跃的 Whisper 端口，阻止后续回调访问已销毁的 DOM
    if (whisperPort) { try { whisperPort.disconnect(); } catch (_) {} whisperPort = null; }
    if (captionObserver) { captionObserver.disconnect(); captionObserver = null; }
    if (captionPoller) { clearInterval(captionPoller); captionPoller = null; }
    if (trackWatch) { try { trackWatch.track.removeEventListener('cuechange', trackWatch.onCue); } catch (_) {} trackWatch = null; }
    if (prefetchTimer) { clearInterval(prefetchTimer); prefetchTimer = null; }
    if (whisperRec) { try { whisperRec.stop(); } catch (_) {} whisperRec = null; }
    if (whisperSliceTimer) { clearTimeout(whisperSliceTimer); whisperSliceTimer = null; }
    if (whisperUnmuteTimer) { clearInterval(whisperUnmuteTimer); whisperUnmuteTimer = null; }
    if (whisperAudioEl) { try { whisperAudioEl.pause(); whisperAudioEl.srcObject = null; } catch (_) {} whisperAudioEl = null; }
    if (whisperStream) { whisperStream.getTracks().forEach(t => t.stop()); whisperStream = null; }
    gestureListeners.forEach(({ el, event, fn, opts }) => {
      try { el.removeEventListener(event, fn, opts); } catch (_) {}
    });
    gestureListeners = [];
    // 清理路径 B 的 AudioContext 及手势监听器
    whisperAudioCtxGestures.forEach(({ el, event, fn, opts }) => {
      try { el.removeEventListener(event, fn, opts); } catch (_) {}
    });
    whisperAudioCtxGestures = [];
    if (whisperAudioCtx) { try { whisperAudioCtx.close(); } catch (_) {} whisperAudioCtx = null; }
    if (wavDecodeCtx) { try { wavDecodeCtx.close(); } catch (_) {} wavDecodeCtx = null; }
    whisperQueue = []; whisperBusy = false;
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    pendingBatch = []; currentKey = ''; cacheKeys.length = 0;
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null; origEl = null; transEl = null; captionWindow = null;
  }
})();
