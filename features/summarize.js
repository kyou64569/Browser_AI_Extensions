// features/summarize.js
// 网页总结：核心验证闭环。
// 流程：content script 提取正文 -> 路由选模型 -> FallbackManager 调用 -> 侧边栏展示
// 同时可选地注入知识库检索片段作为上下文（增强，非必需）。
//
// 本模块只依赖 core/router、core/fallback、connectors。不依赖其他 feature。

import { Router } from '../core/router.js';
import { FallbackManager } from '../core/fallback.js';
import { hasCred, optionsFromModel } from '../shared/utils.js';

/**
 * 生成总结 prompt
 * @param {string} title
 * @param {string} text
 * @param {import('../connectors/knowledge-base.js').KbChunk[]} kbChunks
 * @returns {import('../core/message.js').Message[]}
 */
function buildMessages(title, text, kbChunks = []) {
  const sys = '你是一个网页内容总结助手，用中文输出结构清晰、要点明确的总结。';
  let user = `网页标题：${title}\n\n正文：\n${text.slice(0, 12000)}`;
  if (kbChunks.length) {
    user += '\n\n参考知识库片段：\n' + kbChunks.map((c, i) => `[${i + 1}] ${c.content}`).join('\n');
  }
  user += '\n\n请总结要点。';
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

/**
 * 执行网页总结
 * @param {object} ctx
 * @param {import('./model-config.js').ModelConfig[]} ctx.models
 * @param {object} page { title, text }
 * @param {object} [opts]
 * @param {import('../connectors/knowledge-base.js').KnowledgeBaseConnector} [opts.kb] 可选知识库
 * @param {(i:number,cfg:object,reason:string)=>void} [opts.onFallback] UI 提示
 * @param {boolean} [opts.stream]
 * @returns {Promise<{text:string, used:object, tried:number}>}
 */
export async function summarizePage(ctx, page, opts = {}) {
  const router = new Router(ctx.models);
  const candidates = router.selectModel('summarize', { stream: opts.stream ?? true });
  if (!candidates.length) throw new Error('没有可用的总结模型，请检查设置');
  if (!candidates.some(hasCred)) return simulateSummary(page);

  // 可选：知识库检索增强
  let kbChunks = [];
  if (opts.kb) {
    try { kbChunks = await opts.kb.search(page.title || page.text.slice(0, 100)); }
    catch { kbChunks = []; }
  }

  const fb = new FallbackManager({ onFallback: opts.onFallback });
  const req = {
    messages: buildMessages(page.title, page.text, kbChunks),
    stream: opts.stream ?? true,
    options: optionsFromModel(candidates[0]),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  return fb.call(candidates, req);
}

function simulateSummary(page) {
  const paras = (page.text || '').split(/\n+/).map(s => s.trim()).filter(Boolean).slice(0, 6);
  const bullets = paras.map(p => `• ${p.slice(0, 64)}${p.length > 64 ? '…' : ''}`).join('\n');
  const text = `【演示总结】${page.title || '网页'}\n\n以下为本地生成的要点示例（未配置模型）：\n${bullets}\n\n（在“设置”中添加 OpenRouter / Ollama 即可获得真实总结）`;
  return { text, used: { name: '演示模式（本地）' }, tried: 0 };
}
