// connectors/online-kb.js
// 在线知识库连接器预留位：NotebookLM / 腾讯 ima 等。
//
// TODO(调研确认): 这类产品目前大多没有开放稳定的官方 API。能否对接、怎么对接
// （官方接口 / 浏览器自动化模拟操作 / 逆向私有接口）需要另外调研，不要臆造接口格式。
// 因此此处仅留空实现，保持与 KbConnector 同一契约，未来作为新的实现替换即可。

import { KnowledgeBaseConnector } from './knowledge-base.js';

export class OnlineKbConnector extends KnowledgeBaseConnector {
  /**
   * @param {object} cfg 调研确定后填充（如产品类型、认证方式等）
   */
  constructor(cfg = {}) {
    super();
    this.cfg = cfg;
    this.provider = cfg.provider || 'unknown'; // 'notebooklm' | 'ima' | ...
  }

  async search() {
    // TODO: 调研该 provider 的接入方式后实现
    throw new Error(`[online-kb] ${this.provider} 接入方式待调研，暂未实现`);
  }

  async add() {
    // TODO: 同上
    throw new Error(`[online-kb] ${this.provider} 接入方式待调研，暂未实现`);
  }
}
