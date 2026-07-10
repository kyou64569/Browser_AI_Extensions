// features/chat.js
// 通用聊天：复用同一套 Router + FallbackManager 链路。
// 通过 FallbackManager.callStream 获得流式增量，调用失败（未产出任何内容前）自动降级。
// 本模块只依赖 core/router、core/fallback、core/model-client，不依赖其他 feature。

import { Router } from '../core/router.js';
import { FallbackManager } from '../core/fallback.js';
import { HttpError } from '../core/http.js';
import { hasCred } from '../shared/utils.js';

/**
 * 流式聊天。
 * @param {object} ctx { models }
 * @param {import('../core/message.js').Message[]} messages 完整对话历史
 * @param {object} [opts]
 * @param {(i:number,cfg:object,reason:string)=>void} [opts.onFallback] UI 提示回调
 * @param {AbortSignal} [opts.signal]
 * @yields {{delta:string, model:string, index:number}}
 */
function buildDemoReply(prompt) {
  const p = (prompt || '').trim();
  if (!p) {
    return '你好！这是一个在真实网页中运行的扩展侧边栏演示。\n\n直接在下方输入消息，即可看到流式逐字输出（当前为本地演示模式，尚未配置任何模型密钥）。';
  }
  return `（演示模式）你问的是：“${p.slice(0, 80)}”。\n\n这是一个由本地代码生成的示例回复，用于演示侧边栏的流式输出与紧凑布局。\n\n要在真实模型下运行，请点右上角「设置」添加模型：推荐使用 OpenRouter 或本地 Ollama——二者都支持浏览器直连，无需本地代理。`;
}

/** 本地模拟流式输出：保证未配置密钥时也能看到可运行的聊天效果 */
async function* simulateStream(messages, errNote) {
  const prompt = messages.filter(m => m.role === 'user').pop()?.content || '';
  let reply = buildDemoReply(prompt);
  if (errNote) reply = `（本地演示 · 真实调用失败：${errNote}）\n\n` + reply;
  for (const ch of reply) {
    await new Promise(r => setTimeout(r, 10));
    yield { delta: ch, model: '演示模式（本地）', index: 0 };
  }
}

export async function* chatStream(ctx, messages, opts = {}) {
  const router = new Router(ctx.models);
  // 聊天默认不强制 vision/stream，按可用模型全部纳入候选（Router 已过滤 enabled）
  const candidates = router.selectModel('generic', {});

  // 没有任何可用凭证（如默认 OpenRouter 未填 Key）→ 本地演示回复，保证开箱即用
  if (!candidates.length || !candidates.some(hasCred)) {
    yield* simulateStream(messages);
    return;
  }

  const fb = new FallbackManager({ onFallback: opts.onFallback });
  try {
    yield* fb.callStream(candidates, {
      messages,
      stream: true,
      signal: opts.signal,
    });
  } catch (e) {
    // 若全程没有任何可用凭证，降级为本地演示回复，避免白等
    if (!candidates.some(hasCred)) {
      yield* simulateStream(messages, e.message);
      return;
    }
    throw e;
  }
}

/**
 * 非流式聊天（一次性返回全文）。
 * @returns {Promise<{text:string, used:object, tried:number}>}
 */
export async function chatOnce(ctx, messages, opts = {}) {
  const router = new Router(ctx.models);
  const candidates = router.selectModel('generic', {});
  if (!candidates.length || !candidates.some(hasCred)) {
    const prompt = messages.filter(m => m.role === 'user').pop()?.content || '';
    return { text: buildDemoReply(prompt), used: { name: '演示模式（本地）' }, tried: 0 };
  }
  const fb = new FallbackManager({ onFallback: opts.onFallback });
  return fb.call(candidates, { messages, stream: false, signal: opts.signal });
}
