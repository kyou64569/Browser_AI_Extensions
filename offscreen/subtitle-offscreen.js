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

const WHISPER_SLICE_MS = 2000;      // 每片（发送窗口）时长：连续捕获，按此周期切窗编码发送
const WHISPER_PCM_SILENCE = 0.001;  // 窗口峰值低于此值视为静音，跳过发送省额度

let capStream = null;     // 捕获到的标签页音频流
let capAudioCtx = null;   // Web Audio 上下文（恢复被静音的标签页声音 + 抓取 PCM）
let capPcmNode = null;    // ScriptProcessorNode（持续抓取 PCM）
let capPcmBuf = [];       // 当前窗口内累积的 Float32 帧（滑动窗口缓冲）
let capPcmLen = 0;        // 当前窗口已累积样本数
let capSliceTimer = null; // 切窗发送定时器（方案 C：setInterval）
let capActive = false;

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
function startSlice() {
  if (!capActive || !capStream) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { console.warn('[offscreen] 无 AudioContext，无法捕获'); return; }
  if (!capAudioCtx) { // restoreTabAudio 已建好则复用，否则自建
    try { capAudioCtx = new AC(); } catch (_) { console.warn('[offscreen] AudioContext 创建失败'); return; }
  }
  try {
    const src = capAudioCtx.createMediaStreamSource(capStream);
    // 抓取 PCM：ScriptProcessor 必须接在图中才会触发 onaudioprocess，
    // 用静音增益接回 destination，避免重复出声（恢复声音由 restoreTabAudio 单独负责）。
    const node = capAudioCtx.createScriptProcessor(4096, 1, 1);
    capPcmNode = node;
    capPcmBuf = [];
    capPcmLen = 0;
    node.onaudioprocess = (ev) => {
      if (!capActive) return;
      const ch = ev.inputBuffer.getChannelData(0);
      capPcmBuf.push(new Float32Array(ch)); // 复制，避免被复用
      capPcmLen += ch.length;
    };
    const silent = capAudioCtx.createGain();
    silent.gain.value = 0;
    src.connect(node);
    node.connect(silent);
    silent.connect(capAudioCtx.destination);
    if (capAudioCtx.state === 'suspended') capAudioCtx.resume().catch(() => {});
  } catch (e) {
    console.warn('[offscreen] PCM 捕获初始化失败', e);
    return;
  }
  capSliceTimer = setInterval(sendWindow, WHISPER_SLICE_MS);
}

// 把当前窗口内累积的 PCM 帧编码成 WAV 发送给 SW（内容脚本 → Whisper 转写）
async function sendWindow() {
  if (!capActive || !capAudioCtx) return;
  const frames = capPcmBuf;
  capPcmBuf = []; // 立即开新窗口，避免与正在进行的编码重叠累积
  const total = capPcmLen;
  capPcmLen = 0;
  if (!frames.length || !total) return;
  const data = new Float32Array(total);
  let off = 0;
  for (const f of frames) { data.set(f, off); off += f.length; }
  // 静音窗口：峰值过低则跳过，省额度
  let peak = 0;
  for (let i = 0; i < data.length; i += 257) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
  if (peak < WHISPER_PCM_SILENCE) return;
  // 直接编码 WAV（无需 webm 解码，彻底规避 decode 错误）
  try {
    const ab = capAudioCtx.createBuffer(1, total, capAudioCtx.sampleRate);
    ab.copyToChannel(data, 0);
    const wav = encodeWav(ab);
    if (swPort) {
      const buf = await wav.arrayBuffer();
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
  if (capPcmNode) { try { capPcmNode.disconnect(); } catch (_) {} capPcmNode = null; }
  capPcmBuf = []; capPcmLen = 0;
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
