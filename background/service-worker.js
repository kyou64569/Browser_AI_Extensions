// background/service-worker.js
// MV3 service worker：模块装配中枢。持有 router / fallback / kb 连接器。
// 通过消息与 side panel / popup / content script 通信。

import { getModels, getKbConfig } from '../shared/storage.js';
import { summarizePage } from '../features/summarize.js';
import { LocalKbConnector } from '../connectors/local-kb.js';
import { OnlineKbConnector } from '../connectors/online-kb.js';
import { execTool } from './web-tools.js';
import { createClient } from '../core/model-client.js';
import { hasCred, optionsFromModel } from '../shared/utils.js';

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

// ============================================================
// 网页翻译：content script 收集页面文本节点后，分批交给所选模型翻译。
// 每段用 [N]…[/N] 包裹，要求模型仅返回同格式译文，便于稳定解析。
// ============================================================
const TRANSLATE_BATCH = 100;

function buildTranslatePrompt(segments, targetLang) {
  const body = segments.map((s, i) => `[${i}]${s}[/${i}]`).join('\n');
  return [
    `Translate the following segments into ${targetLang}.`,
    'Rules:',
    `- Each segment is wrapped with [N] and [/N] markers (N = index starting at 0).`,
    '- Output ONLY the translated segments using the exact same [N]...[/N] format, in order.',
    '- Do NOT add any explanations, headings, or markdown fences.',
    '',
    body,
  ].join('\n');
}

function parseTranslateResponse(text, count) {
  const map = new Array(count).fill(undefined);
  const re = /\[(\d+)\]([\s\S]*?)\[\/\1\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const idx = Number(m[1]);
    if (idx >= 0 && idx < count && !map[idx]) { // 防止重复覆盖
      map[idx] = m[2];
    }
  }
  // 验证解析结果
  const filled = map.filter(v => v !== undefined).length;
  if (filled < count) {
    console.warn(`Translation parsing: only ${filled}/${count} segments parsed`);
  }
  return map;
}

async function translateSegments(model, texts, targetLang) {
  const result = texts.slice();
  const items = [];
  texts.forEach((t, i) => { if (t && t.trim()) items.push({ i, t }); });
  if (!items.length) return result;
  let client;
  try { client = createClient(model); } catch (e) { throw new Error('翻译模型配置无效：' + e.message); }
  if (!client) {
    throw new Error('无法创建翻译客户端');
  }
  const options = { ...optionsFromModel(model) };

  // 分组成批（每批 TRANSLATE_BATCH 段）
  const batches = [];
  for (let s = 0; s < items.length; s += TRANSLATE_BATCH) {
    batches.push(items.slice(s, s + TRANSLATE_BATCH));
  }

  // 并发发送，最大 3 批同时进行（减小整体等待时间，同时避免触发 API 频率限制）
  const CONCURRENCY = 3;
  for (let b = 0; b < batches.length; b += CONCURRENCY) {
    const chunk = batches.slice(b, b + CONCURRENCY);
    await Promise.all(chunk.map(async (batch) => {
      const prompt = buildTranslatePrompt(batch.map(c => c.t), targetLang);
      let out = '';
      try {
        for await (const c of client.chat({ messages: [{ role: 'user', content: prompt }], stream: false, options })) {
          out += (c && c.delta) || '';
        }
      } catch (e) {
        console.error('Translation batch failed:', e);
        return; // 整批失败：保留原文，不中断其它批次
      }
      const parsed = parseTranslateResponse(out, batch.length);
      batch.forEach((c, k) => {
        const tr = parsed[k];
        result[c.i] = (tr != null && tr.trim() !== '') ? tr.trim() : c.t;
      });
      // 单段且解析失败时，退化为整段输出（模型未遵守 [N][/N] 格式）
      if (batch.length === 1 && (!parsed[0] || !parsed[0].trim())) {
        const flat = out.trim();
        if (flat) result[batch[0].i] = flat;
      }
    }));
  }

  return result;
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
  if (msg.type === 'TRANSLATE_PAGE') {
    // 网页翻译：content script 收集页面文本后，分批交由所选模型翻译。
    (async () => {
      try {
        const { modelId, targetLang, texts } = msg;
        if (!Array.isArray(texts)) { sendResponse({ ok: false, error: '参数错误：texts 必须是数组' }); return; }
        const models = await getModels();
        const model = models.find(m => m.id === modelId)
          || models.find(m => m.enabled !== false && m.isPrimary)
          || models.find(m => m.enabled !== false);
        if (!model) { sendResponse({ ok: false, error: '未找到可用翻译模型，请先在设置添加模型' }); return; }
        if (!hasCred(model)) { sendResponse({ ok: false, error: '翻译模型缺少有效凭证（API Key）' }); return; }
        const translations = await translateSegments(model, texts, targetLang || '中文（简体）');
        sendResponse({ ok: true, translations });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) ? e.message : '翻译失败' });
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

// 扩展启动 / 更新 / 安装时，主动给所有已打开的“普通网页”标签页注入 content script。
// 解决：扩展重载后，已打开的标签页不会自动重新注入 content script，
// 导致侧边栏发起 EXECUTE_TOOL 时 sendMessage 找不到接收端（表现为“content script 无法建立连接”）。
// 注入失败时静默跳过（受保护页面 / 内部页本就无法注入）。
async function injectContentScriptsToOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab || !tab.id || !tab.url) continue;
      // 仅对 http/https/ file 普通页面注入；跳过浏览器内部页（chrome://、edge://、扩展页等）
      if (!/^(https?:|file:|^about:blank)/i.test(tab.url)) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/extract.js', 'content/sidebar-inject.js'],
        });
      } catch (_) { /* 该页面不可注入，忽略 */ }
    }
  } catch (_) { /* 查询失败忽略 */ }
}

// 安装 / 更新时注入：合并翻译脚本注入和自动化脚本注入
chrome.runtime.onInstalled?.addListener(async () => {
  // 1) 注入翻译脚本（用于网页翻译功能）
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs || []) {
      if (!tab || !tab.id || !tab.url) continue;
      // 跳过快照/内置/扩展自身等无法注入的页面
      if (/^(chrome|chrome-extension|edge|about|moz-extension|devtools):/i.test(tab.url)) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/translate.js', 'content/extract.js', 'content/sidebar-inject.js'],
        });
      } catch (_) { /* 部分页面可能拒绝注入，忽略 */ }
    }
  } catch (_) {}
  // 2) 注入自动化脚本（用于网页操作功能）
  injectContentScriptsToOpenTabs();
});
chrome.runtime.onStartup?.addListener(() => { injectContentScriptsToOpenTabs(); });
