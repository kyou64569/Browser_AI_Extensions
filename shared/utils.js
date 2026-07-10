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
