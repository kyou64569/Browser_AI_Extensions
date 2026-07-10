// core/model-client.js
// ModelClient 工厂 + adapter 注册表。上层只通过本接口调用，不感知具体厂商。
// 基类定义在 ./model-base.js，避免与 adapter 注册表形成循环依赖。

import { OpenAIAdapter } from './adapters/openai.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { GeminiAdapter } from './adapters/gemini.js';
import { OllamaAdapter } from './adapters/ollama.js';
import { validateModelConfig } from './model-config.js';
import { ModelClient } from './model-base.js';

export { ModelClient };

const REGISTRY = {
  openai: OpenAIAdapter,
  anthropic: AnthropicAdapter,
  gemini: GeminiAdapter,
  ollama: OllamaAdapter,
};

/**
 * 根据配置创建对应 adapter 实例。
 * @param {import('./model-config.js').ModelConfig} config
 * @returns {ModelClient}
 */
export function createClient(config) {
  const errs = validateModelConfig(config);
  if (errs.length) throw new Error(`ModelConfig 无效: ${errs.join('; ')}`);
  const Cls = REGISTRY[config.vendor];
  if (!Cls) throw new Error(`未注册的厂商: ${config.vendor}`);
  return new Cls(config);
}

/**
 * 注册新的厂商 adapter（扩展点：未来第三方厂商/Skill 可热注册）
 * @param {string} vendor
 * @param {typeof ModelClient} cls
 */
export function registerAdapter(vendor, cls) {
  REGISTRY[vendor] = cls;
}
