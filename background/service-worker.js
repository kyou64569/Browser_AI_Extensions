// background/service-worker.js
// MV3 service worker：模块装配中枢。持有 router / fallback / kb 连接器。
// 通过消息与 side panel / popup / content script 通信。

import { getModels, getKbConfig } from '../shared/storage.js';
import { summarizePage } from '../features/summarize.js';
import { LocalKbConnector } from '../connectors/local-kb.js';
import { OnlineKbConnector } from '../connectors/online-kb.js';
import { execTool } from './web-tools.js';

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

// 侧边栏用长连接 port 接收流式/状态
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'PING') return; // 侧边栏保活心跳，无需处理
    if (msg.type === 'SUMMARIZE') {
      await runSummarize(port);
    }
  });
});

// content script / popup 的简单请求
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
  return false;
});

// 点击工具栏图标：直接在浏览器原生侧边栏中打开聊天应用（最可靠，无需内容脚本）
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

// 兜底：部分浏览器若未启用“点击图标开侧面板”，则手动打开当前标签页的侧边栏
chrome.action?.onClicked?.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try { await chrome.sidePanel.open({ tabId: tab.id }); } catch (_) {}
});
