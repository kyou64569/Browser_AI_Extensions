// background/state.js
// 跨 handler 共享的模块级可变状态 + 通用小工具。
//
// 为什么单独成文件：这些变量原先散落在 service-worker.js 里，拆分 handler 后
// 会被多个模块读写。如果各自在 handler 里声明，就变成隐式耦合（谁改了谁不知道）；
// 集中到这里后，"哪些状态是 MV3 service worker 被杀死后会丢的"一目了然。
//
// ⚠️ 生命周期提醒：MV3 的 service worker 空闲约 30 秒就会被浏览器终止，
// 下面这些内存状态随之丢失。凡需要跨 SW 重启保留的，必须落到 chrome.storage
// （翻译缓存已落 local、跨域放行记录已落 session）。

/** Chrome 内部页面（无法注入 content script，也无法被 tabCapture 捕获音频） */
const CHROME_PAGE_HINT =
  '当前页面为浏览器内部页面（chrome://、edge:// 等），无法捕获音频。请在普通视频网页（如 bilibili、YouTube）上打开本扩展并开启字幕。';

/** 是否为浏览器内部页面 */
export function isChromeInternalPage(url) {
  if (!url) return false;
  return /^(chrome|chrome-extension|chrome-search|edge|about|file|devtools|view-source):/i.test(url);
}

export { CHROME_PAGE_HINT };

/**
 * 获取当前最活跃的标签页。
 * 逐级降级：当前窗口 → 最后聚焦窗口 → 任意窗口中的普通页面。
 */
export async function getActiveTab() {
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
      const normalTab = tabs.find(t => t.url && !isChromeInternalPage(t.url));
      if (normalTab) return normalTab;
      return tabs[0];
    }
  } catch (_) {}

  return null;
}

// ── 运行中的 Agent 实例（供 AGENT_ABORT 消息拿到句柄）─────────────────────
// 用 getter/setter 而非直接导出 let：ES module 的 live binding 允许"读"到更新，
// 但 importer 不能对导入的 binding 赋值，因此必须提供 setter。
let _runningAgent = null;
export function setRunningAgent(agent) { _runningAgent = agent; }
export function getRunningAgent() { return _runningAgent; }

// ── Whisper 跨模型轮询计数器 ──────────────────────────────────────────────
// 每片音频从不同的模型起步，把请求均匀分摊到多个 Whisper 模型，
// 避免全部压在单一模型上触发 429 限流（片内仍保留故障转移兜底）。
let _whisperRR = 0;
/** 取下一个起步模型下标：((rr++) % n) */
export function nextWhisperStart(n) {
  const idx = _whisperRR % n;
  _whisperRR = (_whisperRR + 1) % n;
  return idx;
}

// ── 实时字幕 Offscreen 文档相关状态 ───────────────────────────────────────
let _offscreenCaptionPort = null;   // offscreen 文档连上来的端口
let _activeCaptionTabId = null;     // 当前正在生成字幕的标签页（用于把音频片段转发给它）
let _pendingCaptionStart = null;    // offscreen 尚未连接时的挂起 start
let _creatingOffscreen = false;

export const offscreen = {
  getPort: () => _offscreenCaptionPort,
  setPort: (p) => { _offscreenCaptionPort = p; },
  /** 端口断开时只在"断的就是当前这个"时才清空，避免新端口被旧断连事件误清 */
  clearPortIf: (p) => { _offscreenCaptionPort = _offscreenCaptionPort === p ? null : _offscreenCaptionPort; },

  getActiveTabId: () => _activeCaptionTabId,
  setActiveTabId: (id) => { _activeCaptionTabId = id; },

  getPendingStart: () => _pendingCaptionStart,
  setPendingStart: (v) => { _pendingCaptionStart = v; },

  getCreating: () => _creatingOffscreen,
  setCreating: (v) => { _creatingOffscreen = v; },
};

// ── 节流日志 ──────────────────────────────────────────────────────────────
// 同一 key 在 windowMs 内只输出一次。用于高频路径（字幕分片转发等）的异常留痕：
// 既不再静默吞异常，也不会因句频到达而刷屏。
const _warnLast = new Map();
export function warnThrottled(key, windowMs, ...args) {
  const now = Date.now();
  const last = _warnLast.get(key) || 0;
  if (now - last < windowMs) return;
  _warnLast.set(key, now);
  console.warn(...args);
}
