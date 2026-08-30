// offscreen/subtitle-offscreen.js
// 在扩展自有文档（Offscreen Document）中捕获标签页音频、用 Web Audio 恢复声音、切片转 WAV，
// 再把音频片段经 chrome.runtime 端口回传 SW（SW 再转发内容脚本做 Whisper 转写）。
//
// 为什么放这里（而非内容脚本）：
//   捕获标签页音频必然静音原标签页，恢复声音的标准做法是 Web Audio 的
//   createMediaStreamSource(stream).connect(audioCtx.destination)。
//   该 AudioContext 若建在【视频页的内容脚本】里，会被 Chrome 自动播放策略卡成 suspended
//   （因为“开启字幕”的手势在侧边栏、不在视频页），导致恢复失败、视频持续静音。
//   Offscreen 文档是【扩展自有文档】，其 AudioContext 不受视频页 autoplay 限制，可稳定恢复声音。
//
// 注意：Offscreen 文档只能使用 chrome.runtime API，故音频片段经 chrome.runtime 端口回传 SW。

// 本文件由 <script src> 以传统脚本方式加载（非 module），因此不会自动进入严格模式，
// 必须显式声明：否则隐式全局赋值、八进制字面量等静默问题不会被报出来。
'use strict';

// ============================================================
// VAD（静音驱动）分片：不再“固定每秒切一片”，而是累积音频直到检测到句末停顿才发一片。
// 目的（根治）：把 Whisper 调用频率从 ~60 次/分钟（每秒一片）降到“句频”（~10~30 次/分钟），
// 稳定落在“20 次/模型 × 2 模型 = 40 次/分钟”的配额内，从根源消除 429 与其引发的
// “首句超长（吞积压）+ 后续切碎（429 被误判静音）”。副作用：一片=一句，判句在音频源头天然完成。
const STEP_MS = 100;                 // VAD 评估步长：每 100ms 评估一次能量
const VAD_PEAK = 0.01;               // 步内峰值≥此值视为“有声”，否则视为静音（正常语音峰值通常 >0.05）
const SILENCE_HANG_MS = 700;         // 语音段后连续静音达此值 → 判为一句结束，切片发送
const MIN_SPEECH_MS = 300;           // 段内有声时长不足此值 → 丢弃（避免把咔哒声/极短噪声当一句）
const MAX_SEGMENT_MS = 8000;         // 单段最长：连续说话不停顿时强制切片，兜住极长句
const TARGET_RATE = 16000;          // Whisper 原生采样率：降采样减少约 60% 数据量（48kHz→16kHz）

let capStream = null;     // 捕获到的标签页音频流
let capAudioCtx = null;   // Web Audio 上下文（恢复被静音的标签页声音 + 抓取 PCM）
let capPcmNode = null;    // AudioWorkletNode（在 worklet 线程持续抓取 PCM，替代已废弃的 ScriptProcessorNode）
let capPcmBuf = [];       // 当前 STEP 内累积的 Float32 帧（由 worklet 的 port.onmessage 填充，evaluate 每 STEP_MS 取走）
let capPcmLen = 0;        // 当前 STEP 已累积样本数
let capSliceTimer = null; // VAD 评估定时器（每 STEP_MS 触发 evaluate）
let capActive = false;

// VAD 语音段状态（累积“当前这一句”的 PCM，静音停顿到阈值即成句发送）
let segFrames = [];       // 当前语音段累积的 Float32 帧
let segSamples = 0;       // 当前语音段累积样本数
let segVoiceMs = 0;       // 段内“有声”累计时长
let segTotalMs = 0;       // 段总时长（含句中停顿）
let inSpeech = false;     // 是否处于语音段中
let silenceMs = 0;        // 段内当前连续静音时长
let lastStep = null;      // 上一 STEP 的 PCM（preroll：语音起始前一步，避免吃掉句首辅音）

let swPort = null;        // 与 SW 的端口

function connectSW() {
  swPort = chrome.runtime.connect({ name: 'offscreen-caption' });
  swPort.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'START') startCapture(msg.streamId);
    else if (msg.type === 'STOP') stopCapture();
  });
  swPort.onDisconnect.addListener(() => { swPort = null; stopCapture(); });
  // 通知 SW：离屏文档已就绪，可接收 START
  try { chrome.runtime.sendMessage({ type: 'OFFSCREEN_CAPTION_READY' }); } catch (_) {}
}

async function startCapture(streamId) {
  if (capActive) stopCapture();
  capActive = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    });
    if (!stream || !stream.getAudioTracks().length) throw new Error('未获取到标签页音频轨道');
    capStream = stream;
    restoreTabAudio(stream); // 在 offscreen 文档里恢复声音（不受视频页 autoplay 限制）
    startSlice();
  } catch (e) {
    capActive = false;
    stopCapture(); // 释放标签页音频轨道，恢复原生声音（避免捕获半途失败时持续静音）
    if (swPort) swPort.postMessage({ type: 'CAPTURE_ERROR', error: (e && e.message) ? e.message : String(e) });
  }
}

// 用 Web Audio 把捕获到的标签页音频流接回扬声器，恢复被捕获静音的标签页声音。
// 关键：本文件运行于 offscreen（扩展自有文档），AudioContext 不会因视频页无手势而被 autoplay 卡死。
function restoreTabAudio(stream) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const src = ctx.createMediaStreamSource(stream);
    src.connect(ctx.destination); // 官方推荐：把捕获流接回默认输出，恢复标签页声音
    capAudioCtx = ctx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  } catch (_) { capAudioCtx = null; }
}

// 方案 C：用 Web Audio 直接抓取 PCM（而非 MediaRecorder 的 webm 分片）。
// 原因：MediaRecorder 多块拼出的 webm 只有首块带文件头，后续窗口缺头无法解码（报 decode 错误）。
// 改抓 PCM 后，每个窗口独立编码成合法的 WAV，全程连续、无 stop/start 空缺，且绝不会出现解码失败。
// PCM 采集用 AudioWorkletNode（offscreen/pcm-worklet.js）替代已废弃的 ScriptProcessorNode：
// process() 跑在专用音频线程，降采样也在 worklet 内完成，主线程只收 chunk 数据。
async function startSlice() {
  if (!capActive || !capStream) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { console.warn('[offscreen] 无 AudioContext，无法捕获'); return; }
  if (!capAudioCtx) { // restoreTabAudio 已建好则复用，否则自建
    try { capAudioCtx = new AC(); } catch (_) { console.warn('[offscreen] AudioContext 创建失败'); return; }
  }
  try {
    // AudioWorklet 模块按 AudioContext 加载：每次 start 都 addModule。
    // 同一 ctx 重复调用是幂等的（no-op 且 resolve）；新 ctx 则必须重新加载。
    // worklet 文件位于扩展内，chrome-extension:// 页面为 secure context，AudioWorklet 可用。
    await capAudioCtx.audioWorklet.addModule(chrome.runtime.getURL('offscreen/pcm-worklet.js'));
    const src = capAudioCtx.createMediaStreamSource(capStream);
    // 抓取 PCM：AudioWorklet 必须接在图中才会被拉取（与原 ScriptProcessor 同理）。
    // 用静音增益接回 destination，避免重复出声（恢复声音由 restoreTabAudio 单独负责）。
    const node = new AudioWorkletNode(capAudioCtx, 'pcm-capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    capPcmNode = node;
    capPcmBuf = [];
    capPcmLen = 0;
    // worklet 已在内部完成降采样（48kHz→16kHz，数据量减约 60%），主线程直接收块即可
    node.port.onmessage = (ev) => {
      if (!capActive) return;
      const d = ev.data; // Float32Array（16kHz 降采样块）
      capPcmBuf.push(d);
      capPcmLen += d.length;
    };
    const silent = capAudioCtx.createGain();
    silent.gain.value = 0;
    src.connect(node);
    node.connect(silent);
    silent.connect(capAudioCtx.destination);
    if (capAudioCtx.state === 'suspended') capAudioCtx.resume().catch(() => {});
  } catch (e) {
    // AudioWorklet 加载失败（个别 WebView / 旧 Chromium）：降级回 ScriptProcessorNode，
    // 保证字幕功能不退化。该节点虽已废弃但仍在支持范围内。
    console.warn('[offscreen] AudioWorklet 初始化失败，降级 ScriptProcessorNode：', (e && e.message) || e);
    const fallback = startSliceLegacy();
    if (!fallback) { console.warn('[offscreen] PCM 捕获初始化失败（含降级）', e); return; }
  }
  // 重置 VAD 段状态并按 STEP_MS 周期评估
  segFrames = []; segSamples = 0; segVoiceMs = 0; segTotalMs = 0;
  inSpeech = false; silenceMs = 0; lastStep = null;
  capSliceTimer = setInterval(evaluateStep, STEP_MS);
}

// ScriptProcessorNode 降级路径（仅当 AudioWorklet 不可用时启用，见 startSlice 的 catch）。
// 与原实现完全一致：4096 buffer、主线程降采样、onaudioprocess 填充 capPcmBuf。
function startSliceLegacy() {
  if (!capActive || !capStream) return false;
  try {
    const src = capAudioCtx.createMediaStreamSource(capStream);
    const node = capAudioCtx.createScriptProcessor(4096, 1, 1);
    capPcmNode = node;
    capPcmBuf = [];
    capPcmLen = 0;
    const decimate = Math.max(1, Math.floor(capAudioCtx.sampleRate / TARGET_RATE));
    node.onaudioprocess = (ev) => {
      if (!capActive) return;
      const ch = ev.inputBuffer.getChannelData(0);
      const decimated = new Float32Array(Math.ceil(ch.length / decimate));
      for (let i = 0, j = 0; i < ch.length; i += decimate, j++) decimated[j] = ch[i];
      capPcmBuf.push(decimated);
      capPcmLen += decimated.length;
    };
    const silent = capAudioCtx.createGain();
    silent.gain.value = 0;
    src.connect(node);
    node.connect(silent);
    silent.connect(capAudioCtx.destination);
    if (capAudioCtx.state === 'suspended') capAudioCtx.resume().catch(() => {});
    return true;
  } catch (_) {
    return false;
  }
}

// VAD 评估：每 STEP_MS 取走本步累积的 PCM，算峰值，交由状态机判定“有声/静音”。
// 编码/发送仅在“一句结束”时触发一次（flushSegment），大幅降低 Whisper 调用频率。
function evaluateStep() {
  if (!capActive || !capAudioCtx) return;
  const frames = capPcmBuf;
  capPcmBuf = [];              // 立即开新步，避免与本步处理重叠累积
  const total = capPcmLen;
  capPcmLen = 0;
  if (!total || !frames.length) { handleStep(null, 0, 0); return; } // 无采样：按静音步推进计时
  const data = new Float32Array(total);
  let off = 0;
  for (const f of frames) { data.set(f, off); off += f.length; }
  let peak = 0;
  for (let i = 0; i < data.length; i += 33) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
  handleStep(data, total, peak);
}

// VAD 状态机：累积“当前一句”的 PCM；句末静音达阈值或超长 → 成句发送。
function handleStep(data, total, peak) {
  const voiced = !!data && peak >= VAD_PEAK;
  if (voiced) {
    if (!inSpeech) {
      // 语音段开始：清段状态；把上一步（preroll）纳入，避免吃掉句首辅音
      inSpeech = true;
      segFrames = []; segSamples = 0; segVoiceMs = 0; segTotalMs = 0;
      if (lastStep && lastStep.total) {
        segFrames.push(lastStep.data); segSamples += lastStep.total; segTotalMs += STEP_MS;
      }
    }
    segFrames.push(data); segSamples += total;
    segVoiceMs += STEP_MS; segTotalMs += STEP_MS;
    silenceMs = 0;
  } else if (inSpeech) {
    // 句中/句末静音：也纳入段（保留自然停顿），静音累计达阈值即成句
    if (data) { segFrames.push(data); segSamples += total; }
    segTotalMs += STEP_MS;
    silenceMs += STEP_MS;
    if (silenceMs >= SILENCE_HANG_MS) { flushSegment(); }
  }
  // 长时间不停顿：强制切片兜底，避免单句超过配额可处理的时长
  if (inSpeech && segTotalMs >= MAX_SEGMENT_MS) { flushSegment(); }
  lastStep = data ? { data, total } : null;
}

// 成句：把整段语音 PCM 拼好后编码发送（一句一片）。段太短则丢弃。
function flushSegment() {
  const frames = segFrames, samples = segSamples, voiceMs = segVoiceMs;
  inSpeech = false; silenceMs = 0;
  segFrames = []; segSamples = 0; segVoiceMs = 0; segTotalMs = 0;
  if (!samples || voiceMs < MIN_SPEECH_MS) return; // 有效语音不足：丢弃，不占用配额
  const data = new Float32Array(samples);
  let off = 0;
  for (const f of frames) { data.set(f, off); off += f.length; }
  encodeAndSendAsync(data, samples);
}

// 异步编码 + 发送：先释放主线程，避免阻塞 UI 与消息泵
async function encodeAndSendAsync(data, total) {
  // 释放主线程：编码/传输不在采集回调里做（PCM 采集已移到 worklet 独立线程，
  // 主线程这里即使被短暂阻塞也不会掉音；释放一次仍能降低卡顿感）
  await new Promise(r => setTimeout(r, 0));
  if (!capActive || !capAudioCtx) return;
  try {
    // 用 TARGET_RATE（16kHz）创建 AudioBuffer，WAV 头将写 16kHz（数据已降采样）
    const ab = capAudioCtx.createBuffer(1, total, TARGET_RATE);
    ab.copyToChannel(data, 0);
    const wav = encodeWav(ab);
    if (swPort && capActive) {
      const buf = await wav.arrayBuffer();
      // 再次释放主线程，避免 base64 编码阻塞采集
      await new Promise(r => setTimeout(r, 0));
      if (!capActive || !swPort) return;
      const b64 = bufToBase64(buf);
      // 音频编码为 base64 字符串再发送：跨进程消息对二进制（Blob/ArrayBuffer）不可靠，
      // base64 是普通字符串，可 100% 可靠传输，内容脚本再解码回字节。
      swPort.postMessage({ type: 'AUDIO', audioB64: b64, mime: 'audio/wav' });
    }
  } catch (e) {
    console.warn('[offscreen] 编码/发送 WAV 失败，跳过该片', e);
  }
}

function stopCapture() {
  capActive = false;
  if (capSliceTimer) { clearInterval(capSliceTimer); capSliceTimer = null; }
  if (capPcmNode) {
    // AudioWorkletNode 的清理比 ScriptProcessor 多一步：断开图 + 关闭 port
    try { capPcmNode.disconnect(); capPcmNode.port.close(); } catch (_) {}
    capPcmNode = null;
  }
  capPcmBuf = []; capPcmLen = 0;
  segFrames = []; segSamples = 0; segVoiceMs = 0; segTotalMs = 0;
  inSpeech = false; silenceMs = 0; lastStep = null;
  if (capAudioCtx) { try { capAudioCtx.close(); } catch (_) {} capAudioCtx = null; }
  if (capStream) { capStream.getTracks().forEach(t => t.stop()); capStream = null; }
}

// ---------- webm/opus → WAV(PCM16) ----------
// ArrayBuffer → base64 字符串（分块避免 String.fromCharCode 调用栈溢出）。
function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000; // 32KB
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
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
      const s = Math.max(-1, Math.min(1, ch[c][i]));
      view.setInt16(pos, s < 0 ? s * 0x8000 : s * 0x7FFF, true); pos += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

connectSW();
