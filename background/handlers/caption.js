// background/handlers/caption.js
// 实时字幕：Whisper 流式转写 + Offscreen 文档音频捕获生命周期。
//
// 为什么音频捕获必须放 Offscreen 文档（而非内容脚本）：
//   捕获标签页音频必然静音原标签页，恢复声音的标准做法是 Web Audio 的
//   createMediaStreamSource(stream).connect(audioCtx.destination)。
//   该 AudioContext 若建在【视频页的内容脚本】里，会被 Chrome 自动播放策略卡成 suspended
//   （因为"开启字幕"的手势发生在侧边栏、不在视频页），导致恢复失败、视频持续静音。
//   Offscreen 文档是【扩展自有文档】，其 AudioContext 不受视频页 autoplay 限制，可稳定恢复声音。

import { getWhisperModels } from '../../shared/storage.js';
import { normalizeApiBase } from '../../shared/utils.js';
import { isRateLimit, sleep } from '../../core/retry.js';
import { stripHallucination } from '../../shared/text-parse.js';
import {
  isChromeInternalPage, CHROME_PAGE_HINT, nextWhisperStart, offscreen, warnThrottled,
} from '../state.js';
import {
  WHISPER_TOTAL_TIMEOUT_MS, WHISPER_MAX_ROUNDS, WHISPER_DEFAULT_TIMEOUT_MS,
  WHISPER_MAX_SSE_BUFFER, WHISPER_MAX_FULL_TEXT, WHISPER_RETRY_BACKOFF_MS,
  CAPTURE_RELEASE_WAIT_MS,
} from '../../shared/constants.js';

/** 源语言中文标签 → Whisper ISO 语言码（空 = 自动检测） */
const WHISPER_LANG = {
  '自动识别': '', '英语': 'en', '日语': 'ja', '韩语': 'ko', '法语': 'fr', '德语': 'de',
  '西班牙语': 'es', '俄语': 'ru', '葡萄牙语': 'pt', '意大利语': 'it', '泰语': 'th', '越南语': 'vi',
};

/**
 * 流式转写（Groq/OpenAI 兼容）：每片音频经 port 发送，后台回传 partial/final。
 * 内容脚本把 webm/opus 转成 WAV（PCM16）后再发来，WAV 可被 Groq 等端点可靠解析，
 * 避免"Chrome MediaRecorder 的 webm 被判为无音频轨道"导致的 HTTP 400；
 * 兼容不支持 stream 的端点（返回普通 JSON 时直接 final）。
 */
export async function streamTranscribe(port, msg) {
  const { whisperModelIds, audio, language, mime } = msg;
  // 内容脚本发来的是 Blob（或少数情况下的 ArrayBuffer）。跨进程传输后类型可能变化，
  // 这里只做 null 检查和 Blob/ArrayBuffer 的通用容量判断，避免误判。
  if (!audio) {
    port.postMessage({ type: 'error', error: 'Whisper 转写失败：无效的音频数据' }); return;
  }

  // 兼容防错：跨进程（MessagePort）传输二进制 Uint8Array 时，可能在部分浏览器中被序列化为
  // 普通 Object（例如 {0: 10, 1: 20...}）。若不转换，new Blob([audio]) 会写入
  // "[object Object]" 文本，导致 Whisper HTTP 400（no audio track found in file）。
  let binaryData = audio;
  if (audio && typeof audio === 'object' && !(audio instanceof Blob) && !(audio instanceof ArrayBuffer) && !ArrayBuffer.isView(audio)) {
    const keys = Object.keys(audio).map(Number).filter(n => !isNaN(n) && Number.isInteger(n)).sort((a, b) => a - b);
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

  // 轮询负载均衡：本片从 ((rr++) % N) 这个模型起步，把请求分摊到各模型；
  // 列表仍按"起步模型在前、其余在后"的顺序遍历，故某模型 429/失败时自动故障转移到下一个。
  const startIdx = nextWhisperStart(matched.length);
  const list = matched.map((_, i) => matched[(startIdx + i) % matched.length]);
  const lang = WHISPER_LANG[language] || '';
  const isWav = /wav/i.test(mime || '');
  const fileType = isWav ? 'audio/wav' : 'audio/webm';
  const fileName = isWav ? 'audio.wav' : 'audio.webm';
  const audioBlob = (binaryData instanceof Blob) ? binaryData : new Blob([binaryData], { type: fileType });
  const startedAt = Date.now();
  let lastErr;

  for (let round = 0; round < WHISPER_MAX_ROUNDS; round++) {
    let sawRate = false;
    for (const wm of list) {
      if (Date.now() - startedAt > WHISPER_TOTAL_TIMEOUT_MS) {
        port.postMessage({ type: 'error', error: 'Whisper 转写超时（超过 2 分钟）' });
        return;
      }
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), wm.timeoutMs || WHISPER_DEFAULT_TIMEOUT_MS);
      try {
        const fd = new FormData();
        fd.append('file', audioBlob, fileName);
        fd.append('model', wm.model || 'whisper-large-v3');
        if (lang) fd.append('language', lang);
        const res = await fetch(`${normalizeApiBase(wm.apiBase)}/audio/transcriptions`, {
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
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            if (buf.length > WHISPER_MAX_SSE_BUFFER) throw new Error('SSE buffer overflow');
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
              if (full.length > WHISPER_MAX_FULL_TEXT) full = full.slice(-WHISPER_MAX_FULL_TEXT);
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
    if (round < WHISPER_MAX_ROUNDS - 1) await sleep(WHISPER_RETRY_BACKOFF_MS * (round + 1));
  }
  port.postMessage({ type: 'error', error: (lastErr && lastErr.message) || '所有 Whisper 模型均失败' });
}

// ---------- Offscreen Document 生命周期 ----------

/**
 * 取标签页音频流 id（在 SW 中调用 chrome.tabCapture.getMediaStreamId，内容脚本无此权限）
 * @returns {Promise<{ok:boolean, streamId?:string, error?:string}>}
 */
export async function getTabStreamId(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = (tab && (tab.url || tab.pendingUrl)) || '';
    if (isChromeInternalPage(url)) return { ok: false, error: CHROME_PAGE_HINT };
  } catch (_) { /* 取不到 url 也不阻塞，继续走 getMediaStreamId */ }
  return new Promise((resolve) => {
    // 关键：必须传 targetTabId 指定"要捕获哪个标签页"（Chrome 116+ 官方写法）。
    // 旧的 consumerTabId 只控制"谁可消费"，不能指定捕获目标；漏传会导致 offscreen 里
    // getUserMedia 报 "Error starting tab capture"。
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message || '';
        if (/not been invoked|activeTab/i.test(errMsg)) {
          resolve({ ok: false, error: '获取音频流失败：扩展尚未在当前页面被授权（activeTab）。请在目标视频标签页上点击本扩展图标，或右键该页面选择"AI 助手：开启实时字幕"以授权，然后重试。' });
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

/**
 * 关闭可能残留的 offscreen 文档（上一 SW 实例/上次会话留下的孤儿，其仍持有标签页音频捕获，
 * 会导致 getMediaStreamId 报 "Cannot capture a tab with an active stream"，并令标签页持续静音）。
 */
export async function closeLingeringOffscreen() {
  try {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (ctxs && ctxs.length) { await chrome.offscreen.closeDocument(); }
  } catch (_) { /* 无文档或已关闭，忽略 */ }
}

/**
 * 确保 offscreen 文档存在（扩展自有文档，AudioContext 不受视频页 autoplay 限制）。
 * 调用方在调用前应已关闭旧文档（见 LIVE_CAPTION_START_CAPTURE），本函数只负责创建。
 */
export async function ensureOffscreen() {
  if (offscreen.getPort()) return; // 已有可用连接，直接复用
  if (offscreen.getCreating()) return;
  offscreen.setCreating(true);
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
    offscreen.setCreating(false);
  }
}

/**
 * 启动音频捕获：拿 streamId → 建 offscreen → 下发 START。
 * 调用前必须先关掉旧捕获，否则 getMediaStreamId 会报
 * "Cannot capture a tab with an active stream"，且标签页持续静音。
 */
export async function startCapture(tabId) {
  // 若已有捕获（含上一会话留下的孤儿 offscreen），先停掉
  const port = offscreen.getPort();
  if (port) { try { port.postMessage({ type: 'STOP' }); } catch (_) {} }
  offscreen.setPort(null);
  offscreen.setPendingStart(null);
  await closeLingeringOffscreen();
  // 等待旧捕获的轨道真正释放，避免 getMediaStreamId 立刻报 "active stream"
  await new Promise((r) => setTimeout(r, CAPTURE_RELEASE_WAIT_MS));

  const got = await getTabStreamId(tabId);
  if (!got.ok) return { ok: false, error: got.error };

  offscreen.setActiveTabId(tabId);
  await ensureOffscreen();
  const p = offscreen.getPort();
  if (p) {
    p.postMessage({ type: 'START', streamId: got.streamId });
  } else {
    offscreen.setPendingStart({ streamId: got.streamId }); // offscreen 连接后来下发
  }
  return { ok: true };
}

/** 停止音频捕获并彻底释放（恢复标签页原生声音） */
export async function stopCapture() {
  const port = offscreen.getPort();
  if (port) { try { port.postMessage({ type: 'STOP' }); } catch (_) {} }
  offscreen.setPendingStart(null);
  // 关闭离屏文档：彻底释放标签页音频捕获，恢复原生声音（捕获会静音原标签页）
  try { chrome.offscreen.closeDocument().catch(() => {}); } catch (_) {}
  offscreen.setPort(null);
  offscreen.setActiveTabId(null);
}

/**
 * 处理 offscreen 文档连上来的长连接端口。
 * offscreen 只能使用 chrome.runtime API，故音频片段经此端口回传 SW，再由 SW 转给内容脚本。
 */
export function handleOffscreenCaptionPort(port) {
  offscreen.setPort(port);
  port.onMessage.addListener(async (m) => {
    if (!m) return;
    // 转发失败意味着字幕会静默停止，必须留痕；但音频片到达频率高（句频），
    // 逐片打印会刷屏，故按 key 节流到 5 秒一条。
    const forward = async (msg) => {
      const tabId = offscreen.getActiveTabId();
      if (tabId == null) return;
      try { await chrome.tabs.sendMessage(tabId, msg); }
      catch (e) { warnThrottled('caption-forward:' + msg.type, 5000, '字幕转发失败（内容脚本可能已失效）：', e?.message || e); }
    };
    if (m.type === 'AUDIO') {
      // 音频已在 offscreen 编码为 base64 字符串，sendMessage（JSON 序列化）可可靠传输。
      await forward({ type: 'LIVE_CAPTION_AUDIO', audioB64: m.audioB64, mime: m.mime });
    } else if (m.type === 'AUDIO_SILENCE') {
      // 静音窗口标记：转发给内容脚本用于音频时间轴判句（不携带音频，极轻量）
      await forward({ type: 'LIVE_CAPTION_SILENCE' });
    } else if (m.type === 'CAPTURE_ERROR') {
      await forward({ type: 'LIVE_CAPTION_CAPTURE_ERROR', error: m.error });
    }
  });
  port.onDisconnect.addListener(() => { offscreen.clearPortIf(port); });
  // offscreen 刚连上：若此前有挂起的 start，立即下发
  const pending = offscreen.getPendingStart();
  if (pending) {
    port.postMessage({ type: 'START', streamId: pending.streamId });
    offscreen.setPendingStart(null);
  }
}
