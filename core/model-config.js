// core/model-config.js
// ModelConfig 数据结构：从 chrome.storage.local 读取，不写死在代码里。

/**
 * @typedef {import('./message.js').VendorType} VendorType
 */

/**
 * 单个模型配置
 * @typedef {Object} ModelConfig
 * @property {string} id           唯一标识（用户自定义，如 'gpt4o'）
 * @property {VendorType} vendor   厂商类型
 * @property {string} name         展示名
 * @property {string} apiBase      API Base URL（如 https://api.openai.com/v1）
 * @property {string} apiKey       API Key（存于 storage.local，明文不入库）
 * @property {string} model        厂商模型名（如 gpt-4o、claude-3-5-sonnet）
 * @property {boolean} supportsVision  是否支持视觉/多模态
 * @property {boolean} supportsStream  是否支持流式
 * @property {number} timeoutMs    单次调用超时（默认 60000）
 * @property {boolean} [enabled]   是否启用（默认 true）
 */

/**
 * 默认配置模板（无密钥，仅结构）
 * @param {Partial<ModelConfig>} overrides
 * @returns {ModelConfig}
 */
export function createModelConfig(overrides = {}) {
  return {
    id: overrides.id || `model-${Date.now()}`,
    vendor: overrides.vendor || 'openai',
    name: overrides.name || overrides.model || 'untitled',
    apiBase: overrides.apiBase || '',
    apiKey: overrides.apiKey || '',
    model: overrides.model || '',
    supportsVision: overrides.supportsVision ?? false,
    supportsStream: overrides.supportsStream ?? true,
    timeoutMs: overrides.timeoutMs || 60000,
    enabled: overrides.enabled ?? true,
  };
}

/**
 * 基本校验
 * @param {ModelConfig} cfg
 * @returns {string[]} 错误信息数组（空表示通过）
 */
export function validateModelConfig(cfg) {
  const errs = [];
  if (!cfg.id) errs.push('缺少 id');
  if (!['openai', 'anthropic', 'gemini', 'ollama'].includes(cfg.vendor)) errs.push('未知 vendor');
  if (!cfg.apiBase && cfg.vendor !== 'ollama') errs.push('缺少 apiBase');
  if (!cfg.model) errs.push('缺少 model');
  if (cfg.vendor !== 'ollama' && !cfg.apiKey) errs.push('缺少 apiKey');
  return errs;
}
