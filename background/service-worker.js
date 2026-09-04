// background/service-worker.js
// MV3 service worker：初始化 + 消息路由 + 事件注册。
//
// 业务逻辑已按消息类型拆到 background/handlers/ 下的独立模块：
//   streams.js   —— 长连接端口（sidepanel / whisper-stream / selection-result / offscreen-caption）
//   translate.js —— 网页翻译 / 字幕翻译 / refine
//   search.js    —— 联网搜索（DDG / Bing）
//   kb.js        —— 知识库（测试 / 列表 / 检索）
//   ppt.js       —— PPT 导出与自定义模板
//   agent.js     —— 自主 Agent / 工作流引擎
// 跨模块共享状态集中在 background/state.js；超时守卫见 background/messaging.js。
//
// 本文件只保留：初始化、chrome 事件注册、onMessage 按 type 分发。

import { execTool } from './web-tools.js';
import {
  handleTranslateBatch, refineCaption,
} from './handlers/translate.js';
import { webSearch } from './handlers/search.js';
import { handleKbMessage, loadKbListCache } from './handlers/kb.js';
import {
  getPptThemes, importPptTemplate, deletePptTemplate, exportPpt, exportPptForAutomate,
} from './handlers/ppt.js';
import {
  handleAgentRun, handleWorkflowRun,
} from './handlers/agent.js';
import { handlePortConnect } from './handlers/streams.js';
import {
  startCapture, stopCapture, closeLingeringOffscreen,
} from './handlers/caption.js';
import { withSafetyTimeout } from './messaging.js';
import {
  getActiveTab, offscreen,
} from './state.js';
import { extractMainPageInPage } from '../shared/extract.js';
import { getModels } from '../shared/storage.js';
import { hasCred } from '../shared/utils.js';
import {
  TIMEOUT_AUTOMATE_MS, WEB_SEARCH_DEFAULT_MAX,
} from '../shared/constants.js';

/** 右键普通网页：授予该标签页 activeTab 权限（用户手势触发），并打开侧边栏供点“开启字幕” */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.remove('ai-open-live-caption', () => {
    if (chrome.runtime.lastError) { /* 首次安装时菜单不存在，忽略 */ }
    chrome.contextMenus.create({
      id: 'ai-open-live-caption',
      title: 'AI 助手：开启实时字幕',
      contexts: ['page'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    }, () => { if (chrome.runtime.lastError) console.warn('[contextMenu]', chrome.runtime.lastError); });
  });
});
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'ai-open-live-caption' || !tab || !tab.id) return;
  // 右键点击普通网页本身即授予该标签页 activeTab；再打开侧边栏即可正常捕获。
  try { await chrome.sidePanel.open({ tabId: tab.id }); } catch (_) {}
});

// ── 长连接端口（onConnect）──
// 注意：onConnect 是"每端口一次"的监听器，不能放在 onMessage 的分发里，
// 否则端口一多会重复注册。交给 streams.js 统一处理。
chrome.runtime.onConnect.addListener((port) => {
  handlePortConnect(port);
});

// ── 一次性消息（onMessage）路由 ──
// 每个分支要么返回 true（异步回包，统一走 withSafetyTimeout），
// 要么不匹配返回 false（交给其它监听器 / 内容脚本）。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'AGENT_RUN' || msg.type === 'AUTOMATE' || msg.type === 'WORKFLOW_RUN' || msg.type === 'PPT_EXPORT') {
    console.log('[SW] 收到消息:', msg.type, '| 来自:', sender?.tab?.id || sender?.id || 'popup');
  }

  // ── 联网搜索 ──
  if (msg.type === 'WEB_SEARCH') {
    return withSafetyTimeout(
      async () => {
        const q = (msg.query || '').trim();
        if (!q) return { error: '搜索关键词为空' };
        const results = await webSearch(q, msg.maxResults || WEB_SEARCH_DEFAULT_MAX);
        if (!results.length) return { error: '未获取到搜索结果，请稍后重试或更换关键词' };
        return { results };
      },
      { sendResponse, timeoutMs: 30000, label: '联网搜索' }
    );
  }

  // ── 兼容旧调用：SUMMARIZE 直接返回提示 ──
  if (msg.type === 'SUMMARIZE') {
    sendResponse({ type: 'INFO', message: '请打开侧边栏（右键图标 -> 在边栏中打开本扩展）' });
    return true;
  }

  // ── 网页自动化（AUTOMATE）──
  if (msg.type === 'AUTOMATE') {
    return withSafetyTimeout(
      async () => {
        const tab = await getActiveTab();
        if (!tab || !tab.id) return { ok: false, error: '无法获取当前标签页' };
        if (msg.tool === 'export_ppt') {
          return await exportPptForAutomate(msg.args || {});
        }
        const out = await execTool(tab, msg.tool, msg.args || {});
        return out;
      },
      { sendResponse, timeoutMs: TIMEOUT_AUTOMATE_MS, label: '网页自动化' }
    );
  }

  // ── 获取当前网页正文 ──
  if (msg.type === 'GET_PAGE') {
    return withSafetyTimeout(
      async () => {
        const tab = await getActiveTab();
        if (!tab || !tab.id) return { error: '无法获取当前标签页' };

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
              func: extractMainPageInPage,
            });
            page = (res && res.result) ? res.result : null;
          } catch (_) {
            page = null;
          }
        }

        if (!page || !page.text || !page.text.trim()) {
          return { error: '未能从当前网页提取到正文（可能是浏览器内置页或需要刷新页面）' };
        }
        return page;
      },
      { sendResponse, timeoutMs: 30000, label: '获取网页正文' }
    );
  }

  // ── 网页翻译 ──
  if (msg.type === 'TRANSLATE_PAGE') {
    return withSafetyTimeout(
      async () => {
        const { modelId, targetLang, texts } = msg;
        if (!Array.isArray(texts)) return { ok: false, error: '参数错误：texts 必须是数组' };
        // 进度回传：SW 直接发往扩展页面（侧边栏/弹窗），不经 content 脚本中转。
        // 原因：content 脚本在 await TRANSLATE_PAGE 响应期间自身被阻塞，经它中转的进度消息易丢失。
        const onProgress = (p) => {
          try { chrome.runtime.sendMessage({ type: 'WEB_TRANSLATE_PROGRESS', payload: p }, () => { void chrome.runtime.lastError; }); }
          catch (_) { /* 侧边栏未打开时忽略 */ }
        };
        return await handleTranslateBatch(modelId, targetLang, texts, { onProgress });
      },
      { sendResponse, timeoutMs: 120000, label: '网页翻译' }
    );
  }

  // ── 实时字幕：启动音频捕获（Offscreen 文档）──
  if (msg.type === 'LIVE_CAPTION_START_CAPTURE') {
    return withSafetyTimeout(
      async () => {
        const tabId = sender && sender.tab && sender.tab.id;
        if (!tabId) return { ok: false, error: '无法确定来源标签页' };
        const r = await startCapture(tabId);
        return r; // { ok:true } 或 { ok:false, error }
      },
      { sendResponse, timeoutMs: 20000, label: '启动音频捕获' }
    );
  }

  // ── 实时字幕：停止捕获并释放 ──
  if (msg.type === 'LIVE_CAPTION_STOP_CAPTURE') {
    stopCapture(); // 不 await：closeDocument 为 fire-and-forget，端口断开处理在内部
    sendResponse({ ok: true });
    return true;
  }

  // ── offscreen 文档就绪信号 ──
  // offscreen 文档建立端口后广播 READY；此处兜底补发挂起的 START
  // （正常路径下 handleOffscreenCaptionPort 在端口连上时已下发，这里是双保险）。
  if (msg.type === 'OFFSCREEN_CAPTION_READY') {
    const pending = offscreen.getPendingStart();
    const port = offscreen.getPort();
    if (pending && port) {
      port.postMessage({ type: 'START', streamId: pending.streamId });
      offscreen.setPendingStart(null);
    }
    sendResponse({ ok: true });
    return true;
  }

  // ── 字幕翻译 ──
  if (msg.type === 'LIVE_CAPTION_TRANSLATE') {
    return withSafetyTimeout(
      async () => {
        const { modelId, targetLang, lines } = msg;
        if (!Array.isArray(lines)) return { ok: false, error: '参数错误：lines 必须是数组' };
        // 字幕碎片上下文相关（同一短语脱离句子含义不同），关闭持久化缓存避免陈旧复用
        return await handleTranslateBatch(modelId, targetLang, lines, { useCache: false });
      },
      { sendResponse, timeoutMs: 60000, label: '字幕翻译' }
    );
  }

  // ── 知识库（测试 / 列表 / 检索）──
  if (msg.type === 'KB_TEST' || msg.type === 'KB_LIST' || msg.type === 'KB_SEARCH') {
    return handleKbMessage(msg, { respond: sendResponse });
  }

  // ── 字幕整理（refine）──
  if (msg.type === 'LIVE_CAPTION_REFINE') {
    return withSafetyTimeout(
      async () => {
        const { modelId, targetLang, fragments, sourceLang } = msg;
        if (!Array.isArray(fragments) || !fragments.length) {
          return { ok: false, error: '参数错误：fragments 必须是非空数组' };
        }
        const models = await getModels();
        const model = models.find(m => m.id === modelId)
          || models.find(m => m.enabled !== false && m.isPrimary)
          || models.find(m => m.enabled !== false);
        if (!model) return { ok: false, error: '未找到可用翻译模型，请先在设置添加模型' };
        if (!hasCred(model)) {
          return { ok: false, error: '翻译模型缺少有效凭证（API Key）' };
        }
        const r = await refineCaption(model, fragments, targetLang || '中文（简体）', sourceLang);
        return { ok: true, original: r.original, translation: r.translation };
      },
      { sendResponse, timeoutMs: 60000, label: '字幕整理' }
    );
  }

  // ── PPT：主题列表 / 导入模板 / 删除模板 / 导出 ──
  if (msg.type === 'GET_PPT_THEMES') {
    return withSafetyTimeout(
      async () => await getPptThemes(),
      { sendResponse, timeoutMs: 30000, label: '获取 PPT 主题' }
    );
  }
  if (msg.type === 'PPT_IMPORT_TEMPLATE') {
    return withSafetyTimeout(
      async () => {
        try {
          return await importPptTemplate({ data: msg.data, name: msg.name });
        } catch (e) {
          return { ok: false, error: '模板解析失败：' + (e?.message || e) };
        }
      },
      { sendResponse, timeoutMs: 60000, label: '导入 PPT 模板' }
    );
  }
  if (msg.type === 'DELETE_PPT_TEMPLATE') {
    return withSafetyTimeout(
      async () => {
        try {
          return await deletePptTemplate();
        } catch (e) {
          return { ok: false, error: '删除失败：' + (e?.message || e) };
        }
      },
      { sendResponse, timeoutMs: 15000, label: '删除 PPT 模板' }
    );
  }
  if (msg.type === 'PPT_EXPORT') {
    return withSafetyTimeout(
      async () => {
        try {
          return await exportPpt(msg);
        } catch (e) {
          return { ok: false, error: e?.message || 'PPT 导出失败' };
        }
      },
      { sendResponse, timeoutMs: 30000, label: 'PPT 导出' }
    );
  }

  // ── 自主 Agent / 工作流 ──
  if (msg.type === 'AGENT_RUN') {
    return handleAgentRun(msg, { respond: sendResponse });
  }
  if (msg.type === 'WORKFLOW_RUN') {
    return handleWorkflowRun(msg, { respond: sendResponse });
  }

  return false; // 未匹配，交给其它监听器
});

// ── 初始化 ──

// 点击工具栏图标：直接在浏览器原生侧边栏中打开聊天应用（最可靠，无需内容脚本）
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

// 兜底：部分浏览器若未启用"点击图标开侧面板"，则手动打开当前标签页的侧边栏
chrome.action?.onClicked?.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try { await chrome.sidePanel.open({ tabId: tab.id }); } catch (_) {}
});

// 扩展启动 / 更新 / 安装时，主动给所有已打开的"普通网页"标签页注入 content script。
// 解决：扩展重载后，已打开的标签页不会自动重新注入 content script，
// 导致侧边栏发起 EXECUTE_TOOL 时 sendMessage 找不到接收端（表现为"content script 无法建立连接"）。
// 注入失败时静默跳过（受保护页面 / 内部页本就无法注入）。
async function injectContentScriptsToOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab || !tab.id || !tab.url) continue;
      // 仅对 http/https/ file 普通页面注入；跳过浏览器内部页（chrome://、edge://、扩展页等）
      if (!/^(https?:|file:|about:blank)/i.test(tab.url)) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/extract.js', 'content/sidebar-inject.js', 'content/subtitle.js'],
        });
      } catch (_) { /* 该页面不可注入，忽略 */ }
    }
  } catch (_) { /* 查询失败忽略 */ }
}

// 安装 / 更新时注入：合并翻译脚本注入和自动化脚本注入
chrome.runtime.onInstalled?.addListener(async () => {
  // 清理上一版本可能残留的 offscreen 捕获文档（否则会令标签页持续静音）
  try { await closeLingeringOffscreen(); } catch (_) {}
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs || []) {
      if (!tab || !tab.id || !tab.url) continue;
      if (!/^(https?:|file:|about:blank)/i.test(tab.url)) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/translate.js', 'content/extract.js', 'content/sidebar-inject.js', 'content/subtitle.js'],
        });
      } catch (_) { /* 部分页面可能拒绝注入，忽略 */ }
    }
  } catch (_) {}
});
chrome.runtime.onStartup?.addListener(async () => {
  try { await closeLingeringOffscreen(); } catch (_) {}
  loadKbListCache();
  injectContentScriptsToOpenTabs();
});
