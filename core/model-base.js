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
  // eslint-disable-next-line no-unused-vars
  async *chat(req) {
    throw new Error('chat() 未实现');
  }
}
