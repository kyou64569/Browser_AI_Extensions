// shared/utils.js
// 共享工具函数

/**
 * 检查模型配置是否有有效凭证
 * @param {import('../core/model-config.js').ModelConfig} m
 * @returns {boolean}
 */
export function hasCred(m) {
  return m.vendor === 'ollama' || !!(m.apiKey && String(m.apiKey).trim().length > 0);
}

/**
 * 从模型配置中提取采样参数，作为 ChatRequest.options 透传给适配器。
 * 仅当字段为合法数值时才包含，避免把 undefined 发往 API（保持各厂商默认行为）。
 * @param {import('../core/model-config.js').ModelConfig} [m]
 * @returns {Record<string, number>}
 */
export function optionsFromModel(m = {}) {
  const o = {};
  if (typeof m.temperature === 'number') o.temperature = m.temperature;
  if (typeof m.top_p === 'number') o.top_p = m.top_p;
  if (typeof m.maxTokens === 'number') o.maxTokens = m.maxTokens;
  // 思考强度：仅当明确开启思考且非 'off' 时透传，避免把无关字段发往 API
  if (m.supportsThinking && m.thinkingStrength && m.thinkingStrength !== 'off') {
    o.thinkingStrength = m.thinkingStrength;
  }
  return o;
}

/**
 * 思考强度下拉选项，按厂商动态生成。
 * OpenAI 兼容（reasoning_effort）与 Anthropic 兼容（thinking budget）展示不同档位；
 * 其余厂商给出通用档位（适配器按需忽略，不报错）。
 * @param {string} vendor
 * @returns {{value:string, label:string}[]}
 */
export function thinkingLevels(vendor) {
  if (vendor === 'anthropic') {
    return [
      { value: 'off', label: '思考：关闭' },
      { value: 'low', label: '思考：低 (2K)' },
      { value: 'medium', label: '思考：中 (8K)' },
      { value: 'high', label: '思考：高 (16K)' },
    ];
  }
  // openai / gemini / ollama 等：通用档位（OpenAI 走 reasoning_effort）
  return [
    { value: 'off', label: '思考：关闭' },
    { value: 'low', label: '思考：低' },
    { value: 'medium', label: '思考：中' },
    { value: 'high', label: '思考：高' },
  ];
}
