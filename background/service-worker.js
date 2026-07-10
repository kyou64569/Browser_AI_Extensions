// background/service-worker.js
// MV3 service worker：模块装配中枢。持有 router / fallback / kb 连接器。
// 通过消息与 side panel / popup / content script 通信。

import { getModels, getKbConfig } from '../shared/storage.js';
import { summarizePage } from '../features/summarize.js';
import { LocalKbConnector } from '../connectors/local-kb.js';
import { OnlineKbConnector } from '../connectors/online-kb.js';

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
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
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
  return false;
});

// 点击工具栏图标：直接在浏览器原生侧边栏中打开聊天应用（最可靠，无需内容脚本）
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

// 兜底：部分浏览器若未启用“点击图标开侧面板”，则手动打开当前标签页的侧边栏
chrome.action?.onClicked?.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try { await chrome.sidePanel.open({ tabId: tab.id }); } catch (_) {}
});
