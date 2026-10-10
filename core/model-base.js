// core/model-base.js
// ModelClient 抽象基类（独立模块，避免与 adapter 注册表产生循环依赖）。
// 上层业务既可通过 ./model-client.js 的工厂创建实例，adapter 也可直接继承本基类。

/**
 * 所有 adapter 必须实现的接口。
 * @interface ModelClient
 */
export class ModelClient {
  /**
   * @param {import('./model-config.js').ModelConfig} config
   */
  constructor(config) {
    this.config = config;
  }

  /**
   * 归一化请求 -> 厂商调用 -> 流式/非流式响应
   * 子类实现时返回 AsyncIterable<import('./message.js').ChatResponseChunk>
   * @param {import('./message.js').ChatRequest} req
   * @returns {AsyncIterable<import('./message.js').ChatResponseChunk>}
   */
   
  async *chat(req) {
    throw new Error('chat() 未实现');
  }

  /**
   * 本次请求实际发出的输出上限（token），null = 不发送该字段（走厂商默认）。
   * 思考预算保护与「正文被截断」的判读必须用它，而不是模型卡的 cfg.maxTokens：
   * 降级时请求体沿用主模型的 options，而部分厂商对 max_tokens 另有规则（见 AnthropicAdapter）。
   * @param {import('./message.js').ChatRequest} req
   * @returns {number|null}
   */
  outputCap(req) {
    const t = req && req.options ? req.options.maxTokens : undefined;
    return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null;
  }
}
