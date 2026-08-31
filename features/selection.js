// features/selection.js
// 划词处理：翻译 / 解释 / 追问。
//
// 支持两种调用方式：
//   1) processSelection(ctx, text, action) - 非流式，返回完整结果
//   2) streamSelection(ctx, text, action, onChunk) - 流式，逐块回调
//
// UI 层在 content/extract.js 中通过 selection-result 端口连接后台，
// 后台调用 streamSelection 并通过端口流式回传结果。

import { Router } from '../core/router.js';
import { FallbackManager } from '../core/fallback.js';
import { hasCred, optionsFromModel } from '../shared/utils.js';
import { createClient } from '../core/model-client.js';

/**
 * @typedef {'translate'|'explain'|'ask'} SelectionAction
 */

const PROMPTS = {
  translate: '请将下面的文本翻译成中文（若已是中文则译成英文），保留原意与语气：',
  explain: '请用通俗语言解释下面的文本，必要时举例子帮助理解：',
  ask: '请基于下面这段文本，简洁回答问题或提供深入分析：',
};

/**
 * 处理选中文本（非流式，返回完整结果）
 * @param {object} ctx { models }
 * @param {string} text
 * @param {SelectionAction} action
 * @param {{thinkingStrength?:string, onFallback?:(i:number,cfg:object,reason:string)=>void, signal?:AbortSignal, [k:string]:any}} [opts]
 * @returns {Promise<{text:string, used:object, tried:number}>}
 */
export async function processSelection(ctx, text, action, opts = {}) {
  const { model, candidates, client } = _resolve(ctx, action);
  if (!model) return simulateSelection(text, action);

  const sys = '你是一个选中文本助手。给出简洁、准确的回答，不要多余寒暄。';
  const user = `${PROMPTS[action] || PROMPTS.explain}\n\n${text.slice(0, 4000)}`;
  const options = { ...optionsFromModel(model) };
  if (opts.thinkingStrength) options.thinkingStrength = opts.thinkingStrength;

  const fb = new FallbackManager({ onFallback: opts.onFallback });
  try {
    return await fb.call(candidates, {
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      stream: false,
      options,
    });
  } catch (e) {
    return { text: `处理失败：${e.message}`, used: { name: model.name }, tried: 1 };
  }
}

/**
 * 处理选中文本（流式）
 * @param {object} ctx { models }
 * @param {string} text
 * @param {SelectionAction} action
 * @param {(chunk: string) => void} onChunk 流式回调
 * @param {AbortSignal} [signal]
 */
export async function streamSelection(ctx, text, action, onChunk, signal) {
  const { model, candidates } = _resolve(ctx, action);
  if (!model) {
    const demo = simulateSelection(text, action);
    for (const ch of demo.text) {
      if (signal?.aborted) return;
      onChunk(ch);
    }
    return;
  }

  const sys = '你是一个选中文本助手。给出简洁、准确的回答，不要多余寒暄。';
  const user = `${PROMPTS[action] || PROMPTS.explain}\n\n${text.slice(0, 4000)}`;
  const options = { ...optionsFromModel(model) };
  const fb = new FallbackManager({});
  const candidatesList = candidates.length ? candidates : [model];

  let lastErr;
  for (const cand of candidatesList) {
    try {
      const client = createClient(cand);
      let text = '';
      for await (const c of client.chat({
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        stream: cand.supportsStream && model.supportsStream,
        options,
        signal,
      })) {
        if (c.delta) { text += c.delta; onChunk(c.delta); }
      }
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`[selection] 模型 ${cand.name} 失败：`, e.message);
    }
  }
  onChunk(`\n\n[处理失败：${lastErr?.message || '所有模型均不可用'}]`);
}

function _resolve(ctx, action) {
  const router = new Router(ctx.models);
  const candidates = router.selectModel(action, { stream: true });
  if (!candidates.length) return { model: null, candidates: [], client: null };
  const model = candidates.find(hasCred) || null;
  return { model, candidates: model ? candidates : [], client: null };
}

function simulateSelection(text, action) {
  const label = { translate: '翻译', explain: '解释', ask: '追问' }[action] || '处理';
  const text2 = `【演示·${label}】\n\n${text.slice(0, 200)}${text.length > 200 ? '…' : ''}\n\n（以上为本地占位结果；在“设置”中添加模型后，这里会返回真实模型输出）`;
  return { text: text2, used: { name: '演示模式（本地）' }, tried: 0 };
}
