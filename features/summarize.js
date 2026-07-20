// features/summarize.js
// 网页总结：核心验证闭环。
// 流程：content script 提取正文 -> 路由选模型 -> FallbackManager 调用 -> 侧边栏展示
// 同时可选地注入知识库检索片段作为上下文（增强，非必需）。
//
// 本模块只依赖 core/router、core/fallback、connectors。不依赖其他 feature。

import { Router } from '../core/router.js';
import { FallbackManager } from '../core/fallback.js';
import { hasCred, optionsFromModel } from '../shared/utils.js';
import { chatStream } from './chat.js';

/**
 * 生成总结 prompt
 * @param {string} title
 * @param {string} text
 * @param {import('../connectors/knowledge-base.js').KbChunk[]} kbChunks
 * @param {string} [instruction] 用户额外指令（如“用一句话概括”），为空时默认“请总结要点”
 * @returns {import('../core/message.js').Message[]}
 */
function buildMessages(title, text, kbChunks = [], instruction = '') {
  const sys = '你是一个网页内容总结助手，用中文输出结构清晰、要点明确的总结。';
  let user = `网页标题：${title}\n\n正文：\n${text.slice(0, 12000)}`;
  if (kbChunks.length) {
    user += '\n\n参考知识库片段：\n' + kbChunks.map((c, i) => `[${i + 1}] ${c.content}`).join('\n');
  }
  user += '\n\n' + (instruction && instruction.trim() ? instruction.trim() : '请总结要点。');
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

/**
 * 本地抽取式总结（未配置模型密钥时的兜底）：从「当前网页」真实正文中挑选代表性句子作为要点。
 * 关键点：内容完全来自用户实际访问的网页正文，绝非代码中预设的示例文本。
 * @param {object} page { title, text }
 * @param {string} [instruction] 用户额外指令
 * @returns {string}
 */
function localSummary(page, instruction = '') {
  const text = (page && page.text) || '';
  const title = (page && page.title) || '网页';
  const head = instruction && instruction.trim()
    ? `（按指令：“${instruction.trim()}”）\n\n`
    : '';
  // 按句切分，过滤过短/过长的噪声句
  const sents = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[。！？.!?])\s*/)
    .map(s => s.trim())
    .filter(s => s.length >= 12 && s.length <= 120);
  if (!sents.length) {
    return `【本地抽取总结】${title}\n\n${head}（当前网页正文较短或无有效句子，暂无可提取的要点。在“设置”中添加模型即可获得更完整的 AI 总结。）`;
  }
  // 简单打分：位置靠前 + 含关键信息词优先
  const kw = ['是', '指', '用于', '通过', '因为', '因此', '主要', '核心', '关键', '可以', '能够', '一种', '基于', '目标', '目的'];
  const scoreOf = (s, i) => (sents.length - i) + kw.reduce((a, k) => a + (s.includes(k) ? 3 : 0), 0);
  const ranked = sents
    .map((s, i) => ({ s, i, score: scoreOf(s, i) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .sort((a, b) => a.i - b.i); // 还原原文顺序，便于阅读
  const bullets = ranked.map(t => `• ${t.s}`).join('\n');
  return `【本地抽取总结】${title}\n\n${head}（未配置模型密钥，以下为基于「当前网页」正文本地抽取的代表性要点；在“设置”中添加 OpenRouter / Ollama 等模型即可获得 AI 真实总结）\n\n${bullets}`;
}

function simulateSummary(page) {
  return { text: localSummary(page), used: { name: '本地抽取（未配置模型）' }, tried: 0 };
}

/** 本地抽取式流式总结（未配置密钥时使用），逐字产出以演示流式效果 */
async function* simulateSummaryStream(page, instruction = '') {
  const text = localSummary(page, instruction);
  for (const ch of text) {
    await new Promise(r => setTimeout(r, 6));
    yield { delta: ch, model: '本地抽取（未配置模型）', index: 0 };
  }
}

/**
 * 流式执行网页总结（供聊天界面内联展示）。
 * @param {object} ctx
 * @param {import('./model-config.js').ModelConfig[]} ctx.models
 * @param {object} page { title, text }
 * @param {object} [opts]
 * @param {string} [opts.instruction] 用户额外指令
 * @param {import('../connectors/knowledge-base.js').KnowledgeBaseConnector} [opts.kb]
 * @param {(i:number,cfg:object,reason:string)=>void} [opts.onFallback]
 * @param {AbortSignal} [opts.signal]
 * @yields {{delta:string, model?:string, index?:number}}
 */
export async function* summarizeStream(ctx, page, opts = {}) {
  const router = new Router(ctx.models);
  const candidates = router.selectModel('summarize', { stream: true });
  if (!candidates.length) throw new Error('没有可用的总结模型，请检查设置');
  if (!candidates.some(hasCred)) {
    yield* simulateSummaryStream(page, opts.instruction);
    return;
  }

  let kbChunks = [];
  if (opts.kb) {
    try { kbChunks = await opts.kb.search(page.title || page.text.slice(0, 100)); }
    catch { kbChunks = []; }
  }

  const apiMessages = buildMessages(page.title, page.text, kbChunks, opts.instruction);

  // 多模型协作：交给 chatStream 的统一协作逻辑（子模型各自非流式回答，主模型整合流式输出）
  if (opts.mode === 'collab') {
    yield* chatStream({ models: ctx.models }, apiMessages, {
      mode: 'collab',
      thinkingStrength: opts.thinkingStrength,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return;
  }

  const fb = new FallbackManager({ onFallback: opts.onFallback });
  const options = { ...optionsFromModel(candidates[0]) };
  if (opts.thinkingStrength != null) options.thinkingStrength = opts.thinkingStrength;
  yield* fb.callStream(candidates, {
    messages: apiMessages,
    stream: true,
    options,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}
