// background/handlers/streams.js
// chrome.runtime.onConnect 长连接端口的处理。
//
// 四种端口：
// - 'sidepanel'        侧边栏保活（PING）+ 网页总结（SUMMARIZE，聚合后一次回传）
// - 'whisper-stream'   内容脚本把每片音频送来转写，流式回传 partial/final
// - 'selection-result' 划词快捷操作：翻译/解释等，流式回传结果
// - 'offscreen-caption' offscreen 文档连上来（音频捕获链路），转发音频片段给内容脚本

import { getModels, getKbConfig } from '../../shared/storage.js';
import { summarizePage } from '../../features/summarize.js';
import { createKbConnector } from '../../connectors/kb-registry.js';
import { streamSelection } from '../../features/selection.js';
import { extractMainTextInPage } from '../../shared/extract.js';
import { streamTranscribe, handleOffscreenCaptionPort } from './caption.js';
import { getActiveTab } from '../state.js';

/** 延迟聚合流式输出，通过 port 推给侧边栏（网页总结入口） */
async function runSummarize(port) {
  try {
    const models = await getModels();
    if (!models.length) {
      port?.postMessage({ type: 'ERROR', message: '请先在设置页添加模型' });
      return;
    }
    const kbCfg = await getKbConfig();
    // 用注册表统一实例化（默认激活的 ima 也走 OnlineKbConnector），避免 type 未覆盖导致 KB 增强静默失效
    let kb = createKbConnector(kbCfg.type, kbCfg.cfg || {});
    if (!kb) console.warn('[summarize] 未知的知识库类型，跳过知识库增强：', kbCfg.type);

    // 取当前标签页正文
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      port?.postMessage({ type: 'ERROR', message: '无法获取当前标签页' });
      return;
    }
    let page;
    try {
      page = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PAGE' });
    } catch (_) {
      // 内容脚本未注入（扩展重载后的旧标签页）时，回退到 scripting 直接抽取正文，避免主链路静默失败
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: extractMainTextInPage,
        });
        page = { title: tab.title || '', text: (res && res.result) || '', url: tab.url || '' };
      } catch (e2) {
        port?.postMessage({ type: 'ERROR', message: '无法获取页面正文：' + (e2 && e2.message ? e2.message : e2) });
        return;
      }
    }

    const onFallback = (i, cfg, reason) => {
      port?.postMessage({ type: 'FALLBACK', index: i, name: cfg.name, reason });
    };

    const result = await summarizePage(
      { models },
      page,
      { kb, onFallback, stream: false }
    );
    port?.postMessage({ type: 'RESULT', text: result.text, used: (result.used && /** @type {any} */ (result.used).name) || '', tried: result.tried });
  } catch (e) {
    port?.postMessage({ type: 'ERROR', message: (e && e.message) ? e.message : String(e) });
  }
}

/**
 * 统一处理 chrome.runtime.onConnect 的所有端口。
 * 返回 true 表示端口已被本函数消费。
 */
export function handlePortConnect(port) {
  // 侧边栏保活 + 网页总结
  if (port.name === 'sidepanel') {
    port.onMessage.addListener(async (msg) => {
      if (msg.type === 'PING') return; // 侧边栏保活心跳，无需处理
      if (msg.type === 'SUMMARIZE') {
        await runSummarize(port);
      }
    });
    return true;
  }

  // Whisper 流式转写：content script 每片音频经此 port 发送，后台流式回传 partial/final
  if (port.name === 'whisper-stream') {
    port.onMessage.addListener(async (msg) => {
      if (msg.type === 'slice') {
        try { await streamTranscribe(port, msg); }
        catch (e) { port.postMessage({ type: 'error', error: (e && e.message) ? e.message : '流式转写异常' }); }
      }
    });
    return true;
  }

  // 划词快捷操作：接收翻译/解释/请求，流式回传结果
  if (port.name === 'selection-result') {
    port.onMessage.addListener(async (msg) => {
      if (!msg || !msg.type || !msg.text) return;
      try {
        const models = await getModels();
        const ctx = { models: models.filter(m => m.enabled !== false) };
        await streamSelection(ctx, msg.text, msg.type, (chunk) => {
          // 这是用户可见的主链路：端口断开（侧边栏关闭/页面刷新）会导致译文无声消失。
          // 不再静默吞掉，至少留下一条可追溯的日志。
          try { port.postMessage({ type: 'chunk', delta: chunk }); }
          catch (e) { console.warn('[selection] 推送译文分片失败（端口可能已断开）：', e?.message || e); }
        });
        try { port.postMessage({ type: 'done' }); }
        catch (e) { console.warn('[selection] 推送完成信号失败：', e?.message || e); }
      } catch (e) {
        try { port.postMessage({ type: 'error', error: e?.message || '处理失败' }); }
        catch (e2) { console.warn('[selection] 推送错误失败，用户将看不到任何反馈：', e2?.message || e2, '| 原始错误：', e?.message || e); }
      }
    });
    return true;
  }

  // 实时字幕 offscreen 文档端口
  if (port.name === 'offscreen-caption') {
    handleOffscreenCaptionPort(port);
    return true;
  }

  return false;
}
