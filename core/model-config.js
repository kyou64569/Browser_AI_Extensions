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
 * @property {boolean} supportsVision  是否设为视觉模型（图片识别专用，全局互斥）
 * @property {boolean} supportsStream  是否支持流式
 * @property {number} timeoutMs    单次调用超时（默认 60000）
 * @property {boolean} [enabled]   是否启用（默认 true；仅"多模型协作"模式下参与协作对话）
 * @property {boolean} [isPrimary] 是否设为主模型（仅"多模型协作"模式生效，单选）
 * @property {boolean} [supportsThinking] 是否开启"思考"能力（UI 展示思考选择器；Anthropic 直接据此发 thinking budget）
 * @property {string}  [thinkingStrength] 思考强度：'default'|'off'|'low'|'medium'|'high'。
 *   'default'=不传任何思考参数（用厂商默认行为，与混合推理模型的默认思考兼容）；'off'=显式关闭。
 *   新建配置默认 'off'（openai 兼容通道下不发参数，行为与 'default' 相同）。
 * @property {string}  [thinkingStyle] OpenAI 兼容厂商专用：思考参数风格。
 *   'auto'（默认，按模型名自动识别，见 shared/thinking.js）| 'none'（不发参数）|
 *   'openai'（reasoning_effort）| 'openrouter'（reasoning）| 'glm'（thinking）| 'qwen'（enable_thinking）。
 *   取代旧的 reasoningEffortSupported 布尔开关（存储迁移见 migrateModels）。
 * @property {number}  [temperature] 采样温度（可选，透传厂商 API）
 * @property {number}  [top_p] 核采样阈值（可选，透传厂商 API）
 * @property {number}  [maxTokens] 单次回复最大 token 数（可选，透传厂商 API）
 * @property {number}  [tpm] 翻译限速用：该模型每分钟 Token 上限（TPM）。留空则由限流器用宽松默认 + 429 自适应学习。
 * @property {number}  [rpm] 翻译限速用：该模型每分钟请求数上限（RPM）。留空同上。
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
    timeoutMs: overrides.timeoutMs || 120000,
    enabled: overrides.enabled ?? true,
    isPrimary: overrides.isPrimary ?? false,
    supportsThinking: overrides.supportsThinking ?? false,
    thinkingStrength: overrides.thinkingStrength || 'off',
    thinkingStyle: overrides.thinkingStyle || 'auto',
    tpm: overrides.tpm,
    rpm: overrides.rpm,
  };
}

/**
 * 模型配置存储迁移（就地修改并返回）。
 * v2：reasoningEffortSupported 布尔开关 → thinkingStyle 风格枚举。
 * 旧配置勾了「推理」的迁移为 'openai'（reasoning_effort），其余 'auto'（按模型名自动识别）。
 * 兼容：迁移不删除旧字段，避免用户降级版本后旧代码读到 undefined。
 * 入参放宽为 any[]：迁移要读取的正是「不再符合当前 ModelConfig 类型」的历史数据。
 * @param {Array<any>} [models]
 * @returns {Array<any>}
 */
export function migrateModels(models) {
  for (const m of models || []) {
    if (!m || typeof m !== 'object') continue;
    if (!m.thinkingStyle) {
      m.thinkingStyle = m.reasoningEffortSupported ? 'openai' : 'auto';
    }
  }
  return models;
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
