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

const WHISPER_SLICE_MS = 4000;      // 每片时长
const WHISPER_MIN_BLOB_SIZE = 1024; // 静音片段（过小）直接跳过，省额度

let capStream = null;     // 捕获到的标签页音频流
let capAudioCtx = null;   // Web Audio 上下文（恢复被静音的标签页声音）
let capRec = null;        // 当前 MediaRecorder
let capSliceTimer = null;
let capActive = false;
let wavDecodeCtx = null;  // 持久 AudioContext，用于 webm→WAV 解码

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

function startSlice() {
  if (!capActive || !capStream) return;
  let rec;
  try {
    const opts = (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported
      && MediaRecorder.isTypeSupported('audio/webm')) ? { mimeType: 'audio/webm' } : undefined;
    rec = new MediaRecorder(capStream, opts);
  } catch (e) {
    try { rec = new MediaRecorder(capStream); }
    catch (e2) { console.warn('[offscreen] MediaRecorder 不支持任何音频格式', e2); return; }
  }
  capRec = rec;
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  rec.onerror = (e) => { console.warn('[offscreen] MediaRecorder error', e); };
  rec.onstop = async () => {
    const blob = new Blob(chunks, { type: 'audio/webm' });
    if (blob.size >= WHISPER_MIN_BLOB_SIZE) { // 静音片段：跳过，省额度
      let sendBlob = blob, mime = 'audio/webm';
      try {
        const wav = await toWav(blob); // webm/opus → WAV（可靠解析，避免 400）
        sendBlob = wav; mime = 'audio/wav';
      } catch (e) {
        console.warn('[offscreen] webm→wav 失败，回退原始 webm', e);
      }
      if (swPort) swPort.postMessage({ type: 'AUDIO', blob: sendBlob, mime });
    }
    if (capActive) capSliceTimer = setTimeout(startSlice, 0); // 紧接着录下一片
  };
  if (!capActive || !capStream) return;
  try { rec.start(); } catch (e) { console.warn('[offscreen] 录制失败', e); return; }
  capSliceTimer = setTimeout(() => { try { capRec && capRec.stop(); } catch (_) {} }, WHISPER_SLICE_MS);
}

function stopCapture() {
  capActive = false;
  if (capSliceTimer) { clearTimeout(capSliceTimer); capSliceTimer = null; }
  if (capRec) { try { capRec.stop(); } catch (_) {} capRec = null; }
  if (capAudioCtx) { try { capAudioCtx.close(); } catch (_) {} capAudioCtx = null; }
  if (capStream) { capStream.getTracks().forEach(t => t.stop()); capStream = null; }
  if (wavDecodeCtx) { try { wavDecodeCtx.close(); } catch (_) {} wavDecodeCtx = null; }
}

// ---------- webm/opus → WAV(PCM16) ----------
async function toWav(blob) {
  const raw = await blob.arrayBuffer();
  const copy = raw.slice(0); // decodeAudioData 会 detach，每次用独立副本
  const AC = window.AudioContext || window.webkitAudioContext;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  let audioBuf = null;
  if (AC) {
    try {
      if (!wavDecodeCtx) {
        wavDecodeCtx = new AC();
        try { if (wavDecodeCtx.state === 'suspended') await wavDecodeCtx.resume(); } catch (_) {}
      }
      audioBuf = await wavDecodeCtx.decodeAudioData(copy);
    } catch (e) {
      console.warn('[offscreen] 持久 AudioContext decode 失败，尝试 OfflineAudioContext', e);
    }
  }
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
      const s = Math.max(-1, Math.min(1, ch[c][i]));
      view.setInt16(pos, s < 0 ? s * 0x8000 : s * 0x7FFF, true); pos += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

connectSW();
