// shared/thinking.js
// 思考（thinking / reasoning）能力的共享逻辑，供适配器与两处配置 UI 共用：
// - 请求侧：各厂商「让模型思考」的参数形态不一（reasoning_effort / thinking / enable_thinking / …），
//   这里收敛为有限的「思考参数风格」枚举 + 按模型名自动识别，用户只做选择题、不写 JSON。
// - 响应侧：部分模型把思考内联在正文里输出（<think>...</think> 标签），提供统一的剥离函数，
//   让 UI 能把思考文本与正文分开渲染。
// 响应侧的厂商字段解析（reasoning_content / thinking_delta / part.thought / message.thinking）
// 仍是各适配器自己的职责，本文件不涉及网络格式。

/** 思考强度 → Qwen3 thinking_budget（tokens）档位映射 */
const QWEN_THINKING_BUDGET = { low: 4096, medium: 8192, high: 16384 };

/**
 * 「思考参数风格」下拉选项（仅 openai 兼容厂商展示）。
 * label 同时给人话与参数名：懂网关文档的人看参数名认领，小白选「自动识别」即可。
 */
export const THINKING_STYLES = [
  { value: 'auto', label: '自动识别（推荐）' },
  { value: 'none', label: '不发送参数（DeepSeek-R1 等默认思考模型）' },
  { value: 'openai', label: 'reasoning_effort（OpenAI o 系 / 多数聚合网关）' },
  { value: 'openrouter', label: 'reasoning（OpenRouter）' },
  { value: 'glm', label: 'thinking（智谱 GLM）' },
  { value: 'qwen', label: 'enable_thinking（通义 Qwen3）' },
];

const STYLE_VALUES = new Set(THINKING_STYLES.map(s => s.value));

/**
 * 按模型名 / apiBase 猜测思考参数风格。
 * 识别不出的兜底是 'none'（不发送任何思考参数）——猜错最多是「没开启思考」，
 * 绝不会像旧 reasoning_effort 开关那样「勾错直接 HTTP 400」。
 * @param {string} [model] 模型名（如 'deepseek-ai/DeepSeek-R1'、'zhipuai/glm-4.5'）
 * @param {string} [apiBase] API Base（用于识别 OpenRouter 中转）
 * @returns {string} THINKING_STYLES 之一的 value
 */
export function detectThinkingStyle(model, apiBase) {
  const m = String(model || '').toLowerCase();
  const base = String(apiBase || '').toLowerCase();
  // 默认就思考、发参数反而可能 400 的模型，最先判断
  if (/deepseek-r1|deepseek-reasoner/.test(m)) return 'none';
  if (/(^|[^a-z0-9])glm/.test(m)) return 'glm';
  if (/qwen3/.test(m)) return 'qwen';
  // o3 / o3-mini / openai/o4-mini、gpt-5、各网关的 *reasoning* 命名 → reasoning_effort
  if (/(^|[^a-z0-9])o[134](-[a-z0-9.]+)*($|[^a-z0-9])/.test(m) || /gpt-5/.test(m) || /reasoning/.test(m)) {
    return 'openai';
  }
  if (/openrouter\.ai/.test(base)) return 'openrouter';
  return 'none';
}

/**
 * 解析最终风格：'auto'/未设置 → 自动识别；显式风格 → 原样返回（非法值按 auto 处理）。
 * @param {string} [style] 模型配置的 thinkingStyle
 * @param {string} [model]
 * @param {string} [apiBase]
 * @returns {string}
 */
export function resolveThinkingStyle(style, model, apiBase) {
  if (style && STYLE_VALUES.has(style) && style !== 'auto') return style;
  return detectThinkingStyle(model, apiBase);
}

/**
 * 风格 × 强度 → 需要并入请求体的参数对象（调用方 ... 展开）。
 * 约定：
 * - strength 为空（能力未启用）或 'default'（使用厂商默认，不发任何参数）时返回 {}，
 *   调用方可直接展开，无需自行判断；
 * - 'off' 显式传入（聊天页下拉选「关闭」）时：glm / qwen 发「显式禁用」参数
 *   （混合推理模型默认就思考，不发参数关不掉），其余风格不发送任何参数。
 * @param {string} style resolveThinkingStyle 的结果
 * @param {string} [strength] 'default'|'off'|'low'|'medium'|'high'
 * @returns {Record<string, any>}
 */
export function buildThinkingParams(style, strength) {
  if (!strength || strength === 'default') return {};
  const on = strength !== 'off';
  switch (style) {
    case 'openai':
      return on ? { reasoning_effort: strength } : {};
    case 'openrouter':
      return on ? { reasoning: { effort: strength } } : {};
    case 'glm':
      return { thinking: { type: on ? 'enabled' : 'disabled' } };
    case 'qwen':
      return on
        ? { enable_thinking: true, thinking_budget: QWEN_THINKING_BUDGET[strength] || 8192 }
        : { enable_thinking: false };
    default:
      return {};  // none：该模型不需要（或不接受）思考参数
  }
}

/**
 * 该风格下「思考强度」是否根本不起作用（选 low/medium/high 也不会发送任何参数）。
 * 直接从 buildThinkingParams 反查，免得另立一份风格名单与构造逻辑走偏。
 * @param {string} style resolveThinkingStyle 的结果
 * @returns {boolean}
 */
export function thinkingStyleIsInert(style) {
  return Object.keys(buildThinkingParams(style, 'medium')).length === 0;
}

/**
 * 这张卡上「思考强度」是否不起作用。
 * 风格枚举只描述 OpenAI 兼容网关——Anthropic / Gemini / Ollama 各发自己原生的
 * thinking budget / thinkingConfig / think 开关，低中高一律有差别；拿 OpenAI 的风格
 * 去判它们，会得出「该模型思考强度不可调」这种反事实的结论。
 * @param {{vendor?:string, thinkingStyle?:string, model?:string, apiBase?:string}} cfg
 * @returns {boolean}
 */
export function thinkingIsInert(cfg = {}) {
  if (cfg.vendor && cfg.vendor !== 'openai') return false;
  return thinkingStyleIsInert(resolveThinkingStyle(cfg.thinkingStyle, cfg.model, cfg.apiBase));
}

/**
 * 模型卡「最大输出 tokens」的建议文案。思考与正文共用这一份额度，而 SenseNova、
 * DeepSeek-R1 这类风格连开关参数都不发——强度选了也没用，只能靠更大的输出额度硬扛，
 * 所以建议值必须按风格区分（两处设置页共用一份，别各写一遍）。
 * @param {{vendor?:string, supportsThinking?:boolean, thinkingStyle?:string, model?:string, apiBase?:string}} cfg
 * @returns {string} 未开启思考时返回空串
 */
export function maxTokensHint(cfg = {}) {
  if (!cfg.supportsThinking) return '';
  return thinkingIsInert(cfg)
    ? '思考强度不可调（该模型默认思考、不发送任何开关）：建议 ≥32768，思考与正文共用这份额度'
    : '开启思考建议 ≥16384：思考会占用输出额度，过小会导致正文被截断';
}

/**
 * 剥离模型内联在正文里的思考块（不区分大小写）。
 * 不同模型/网关透出思考用的标签不统一（<think> / <thinking> / <thought> / <reasoning>），
 * 全部识别；开闭标签必须配对（<think>…</thinking> 这类错配不算思考块）。
 * 主形态是「回复以思考标签开头」，流式期间标签可能尚未闭合：此时已到达的部分
 * 全部算思考、正文为空，UI 据此把思考渲染进折叠区而不是把原始标签露给用户。
 * 少数弱模型会在正文中间再次输出思考块，此处一并剥离。
 * @param {string} [raw]
 * @returns {{think: string, answer: string}}
 */
export function splitInlineThink(raw) {
  let rest = String(raw || '');
  let think = '';
  let m;
  while ((m = rest.match(/^\s*<(think|thinking|thought|reasoning)>/i))) {
    rest = rest.slice(m[0].length);
    // 闭合标签按“思考族”任一变体匹配：马虎的模型会开 <think> 却用 </thinking> 收尾
    const close = /<\/(?:think|thinking|thought|reasoning)>/i.exec(rest);
    if (!close) { think += rest; rest = ''; break; }
    think += rest.slice(0, close.index);
    rest = rest.slice(close.index + close[0].length);
  }
  rest = rest.replace(/<(think|thinking|thought|reasoning)>([\s\S]*?)<\/\1>/gi, (_, tag, inner) => {
    think += (think ? '\n\n' : '') + inner;
    return '';
  });
  return { think: think.trim(), answer: rest.trim() };
}
