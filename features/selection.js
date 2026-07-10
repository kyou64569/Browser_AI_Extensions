// features/selection.js
// 划词处理：翻译 / 解释 / 追问。
//
// TODO: 当前仅预留接口骨架，未接入 UI 划词事件。结构与 summarize 对齐，
// 之后在 content/extract.js 监听 selection 后调用本模块即可。

import { Router } from '../core/router.js';
import { FallbackManager } from '../core/fallback.js';
import { hasCred, optionsFromModel } from '../shared/utils.js';

/**
 * @typedef {'translate'|'explain'|'ask'} SelectionAction
 */

const PROMPTS = {
  translate: '请将下面的文本翻译成中文，保留原意与语气：',
  explain: '请用通俗语言解释下面的文本，必要时举例子：',
  ask: '基于下面的文本回答问题：',
};

/**
 * 处理选中文本
 * @param {object} ctx { models }
 * @param {string} text
 * @param {SelectionAction} action
 * @param {object} [opts]
 * @returns {Promise<{text:string, used:object, tried:number}>}
 */
export async function processSelection(ctx, text, action, opts = {}) {
  const router = new Router(ctx.models);
  const candidates = router.selectModel(action, { stream: true });
  if (!candidates.length) throw new Error('没有可用的模型');
  if (!candidates.some(hasCred)) return simulateSelection(text, action);

  const sys = '你是一个选中文助手。';
  const user = `${PROMPTS[action] || PROMPTS.explain}\n\n${text.slice(0, 4000)}`;
  const fb = new FallbackManager({ onFallback: opts.onFallback });
  return fb.call(candidates, {
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    stream: true,
    options: optionsFromModel(candidates[0]),
  });
}

function simulateSelection(text, action) {
  const label = { translate: '翻译', explain: '解释', ask: '追问' }[action] || '处理';
  const text2 = `【演示·${label}】\n\n${text.slice(0, 200)}${text.length > 200 ? '…' : ''}\n\n（以上为本地占位结果；在“设置”中添加模型后，这里会返回真实模型输出）`;
  return { text: text2, used: { name: '演示模式（本地）' }, tried: 0 };
}
