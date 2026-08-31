// features/chat.js
// 通用聊天：复用同一套 adapter + FallbackManager 链路。
// 支持三种调用形态：
//   1) 单模型（默认）：使用 ctx.models 中的所选模型，失败且无凭证时降级为本地演示。
//   2) 多模型协作（opts.mode === 'collab'）：所有"已启用"模型参与，由"主模型"收集各子模型
//      结果并整合为最终流式回复；仅主模型判断是否流式。
//   3) 视觉转发：当聊天模型不支持看图、而用户消息含图片时，自动把图片转交"视觉模型"识别，
//      再把识别结果回灌给聊天模型整合回答。
// 本模块只依赖 core/model-client、core/fallback、shared/utils，不依赖具体 UI。

import { FallbackManager } from '../core/fallback.js';
import { createClient } from '../core/model-client.js';
import { hasCred, optionsFromModel } from '../shared/utils.js';

/**
 * 流式聊天。
 * @param {object} ctx { models } 全部已配置模型（用于发现视觉模型、主模型）
 * @param {import('../core/message.js').Message[]} messages 完整对话历史（user 消息可带 attachments）
 * @param {object} [opts]
 * @param {'single'|'collab'} [opts.mode] 单模型 / 多模型协作
 * @param {string} [opts.selectedId] 单模型模式下所选模型 id（不传则用 models[0]）
 * @param {string} [opts.thinkingStrength] 聊天所选模型的思考强度（覆盖模型配置）
 * @param {(i:number,cfg:object,reason:string)=>void} [opts.onFallback] UI 提示回调
 * @param {AbortSignal} [opts.signal]
 * @yields {{delta:string, model?:string, index?:number, error?:string}}
 */
function buildDemoReply(prompt) {
  const p = (prompt || '').trim();
  if (!p) {
    return '你好！这是一个在真实网页中运行的扩展侧边栏演示。\n\n直接在下方输入消息，即可看到流式逐字输出（当前为本地演示模式，尚未配置任何模型密钥）。';
  }
  return `（演示模式）你问的是：“${p.slice(0, 80)}”。\n\n这是一个由本地代码生成的示例回复，用于演示侧边栏的流式输出与紧凑布局。\n\n要在真实模型下运行，请点右上角「设置」添加模型：推荐使用 OpenRouter 或本地 Ollama——二者都支持浏览器直连，无需本地代理。`;
}

/** 本地模拟流式输出：保证未配置密钥时也能看到可运行的聊天效果 */
async function* simulateStream(messages, errNote, signal) {
  const prompt = messages.filter(m => m.role === 'user').pop()?.content || '';
  let reply = buildDemoReply(prompt);
  if (errNote) reply = `（本地演示 · 真实调用失败：${errNote}）\n\n` + reply;
  for (const ch of reply) {
    if (signal && signal.aborted) throw new Error('已停止生成');
    await new Promise(r => setTimeout(r, 10));
    yield { delta: ch, model: '演示模式（本地）', index: 0 };
  }
}

/** 抽取消息中所有图片附件 */
function extractImages(messages) {
  const imgs = [];
  for (const m of messages) {
    if (m.attachments) for (const a of m.attachments) if (a.type === 'image') imgs.push(a);
  }
  return imgs;
}

/**
 * 视觉转发：若聊天模型自身不支持看图且配置了视觉模型，则先把图片交给视觉模型识别，
 * 再把识别结果以文本形式回灌进原消息，交由聊天模型整合回答。
 * 聊天模型支持看图（supportsVision）或未配置视觉模型时，原样返回。
 */
async function augmentWithVision(messages, chatCfg, visionCfg, opts) {
  const imgs = extractImages(messages);
  if (!imgs.length) return messages;
  if (chatCfg.supportsVision) return messages; // 聊天模型自身可看图
  if (!visionCfg) return messages;             // 无视觉模型，原样发送（可能报错，由上层处理）

  const desc = await runSingle(visionCfg, [{
    role: 'user',
    content: '请尽可能详细地描述这张图片中的所有可见内容，包括文字、图表、布局与关键细节，以便另一个模型据此回答用户问题。',
    attachments: imgs,
  }], opts);

  // 用视觉识别结果替换图片附件，避免聊天模型收到它无法解析的图片
  return messages.map(m => {
    if (m.attachments && m.attachments.length) {
      const text = (m.content ? m.content + '\n\n' : '') + `[以下为用户发送图片的视觉模型识别结果：\n${desc}]`;
      return { role: m.role, content: text };
    }
    return m;
  });
}

/** 非流式调用单个模型（用于子模型回答、视觉识别）。自动按配置决定是否思考。 */
async function runSingle(cfg, messages, opts = {}) {
  const client = createClient(cfg);
  const options = { ...optionsFromModel(cfg) };
  if (opts.thinkingStrength != null) options.thinkingStrength = opts.thinkingStrength;
  let text = '';
  for await (const c of client.chat({ messages, stream: false, options, signal: opts.signal })) {
    text += c.delta || '';
  }
  return text;
}

/**
 * 组装主模型的"整合"提示：保留原始对话，去掉图片附件（子模型已对图片做视觉分析并汇总），
 * 追加各子模型独立回答，要求主模型综合分析、去重、修正后给出最佳答案。
 */
function buildSynthesis(messages, results) {
  // 仅保留 role/content，剥离 attachments，避免主模型重复转发图片
  const base = messages.map(m => ({ role: m.role, content: m.content || '' }));
  const summary = results
    .map((r, i) => `【子模型 ${i + 1}：${r.name}】\n${r.text}`)
    .join('\n\n');
  base.push({
    role: 'user',
    content: `以下是多个模型对该问题的独立回答，请综合分析、去重，并修正其中明显错误，给出整合后的最佳答案：\n\n${summary}`,
  });
  return base;
}

/** 多模型协作：子模型各自非流式回答，主模型收集整合后流式输出。 */
async function* collabStream({ models, primary, visionModel, thinkingStrength, messages, opts }) {
  const subs = models.filter(m => m !== primary && m.enabled !== false);
  const subResults = [];
  for (const m of subs) {
    const aug = await augmentWithVision(messages, m, visionModel, opts);
    let text = '';
    try {
      text = await runSingle(m, aug, opts);
    } catch (e) {
      text = `[模型 ${m.name} 调用失败：${e.message}]`;
    }
    subResults.push({ name: m.name, text });
  }

  const synthesisMessages = buildSynthesis(messages, subResults);
  const client = createClient(primary);
  // 仅主模型决定是否流式；子模型一律非流式
  const options = { ...optionsFromModel(primary) };
  if (thinkingStrength != null) options.thinkingStrength = thinkingStrength;

  for await (const c of client.chat({
    messages: synthesisMessages,
    stream: primary.supportsStream,
    options,
    signal: opts.signal,
  })) {
    yield { ...c, model: primary.name, index: 0 };
  }
}

export async function* chatStream(ctx, messages, opts = {}) {
  const models = (ctx.models || []).filter(Boolean);
  const hasAnyCred = models.some(hasCred);
  if (!models.length || !hasAnyCred) {
    yield* simulateStream(messages, undefined, opts.signal);
    return;
  }

  const mode = opts.mode === 'collab' ? 'collab' : 'single';
  const visionModel = models.find(m => m.supportsVision);

  if (mode === 'collab') {
    const enabledModels = models.filter(m => m.enabled !== false);
    const primary = enabledModels.find(m => m.isPrimary);
    if (!primary) {
      yield { error: 'NO_PRIMARY', delta: '' };
      return;
    }
    // 视觉模型即使未“启用”也纳入候选，保证图片识别可用
    let pool = enabledModels;
    if (visionModel && !pool.includes(visionModel)) pool = [...pool, visionModel];
    yield* collabStream({ models: pool, primary, visionModel, thinkingStrength: opts.thinkingStrength, messages, opts });
    return;
  }

  // 单模型：使用所选模型（默认 models[0]）；视觉模型从完整列表中单独发现
  const chatModel = (opts.selectedId ? models.find(m => m.id === opts.selectedId) : models[0]) || models[0];
  const aug = await augmentWithVision(messages, chatModel, visionModel, opts);
  const fb = new FallbackManager({ onFallback: opts.onFallback });
  const options = { ...optionsFromModel(chatModel) };
  if (opts.thinkingStrength != null) options.thinkingStrength = opts.thinkingStrength;

  // 自动降级：聊天模型调用失败时，按优先级依次尝试“备用模型配置”（沿用原模型的温度/top_p 等参数）
  const backup = (ctx.backupModels || []).filter(Boolean);
  const candidates = [chatModel, ...backup];

  try {
    yield* fb.callStream(candidates, {
      messages: aug,
      stream: chatModel.supportsStream, // 勾选流式且支持才流式，否则适配器自动降级
      options,
      signal: opts.signal,
    });
  } catch (e) {
    if (!hasCred(chatModel)) {
      yield* simulateStream(messages, e.message, opts.signal);
      return;
    }
    throw e;
  }
}

/**
 * 非流式聊天（一次性返回全文）。透传 chatStream 收集增量，便于上层统一处理模式/视觉/协作。
 * @returns {Promise<{text:string, used:object, tried:number}>}
 */
export async function chatOnce(ctx, messages, opts = {}) {
  let text = '';
  let used = { name: '演示模式（本地）' };
  for await (const c of chatStream(ctx, messages, opts)) {
    if (c.error === 'NO_PRIMARY') throw new Error('NO_PRIMARY');
    text += c.delta || '';
    if (c.model) used = { name: c.model };
  }
  return { text, used, tried: 1 };
}
