// connectors/local-kb.js
// 本地知识库连接器：通过 HTTP 调用你自建的知识库服务。
//
// TODO(你提供): 当前 endpoint / 请求体 / 响应格式均为占位，待你给出真实接口后替换。
// 设计上保持 search()->KbChunk[] 与 add()->boolean 的契约不变即可，上层无需改。

import { KnowledgeBaseConnector } from './knowledge-base.js';
import { postJson, fetchWithTimeout } from '../core/http.js';

export class LocalKbConnector extends KnowledgeBaseConnector {
  /**
   * @param {object} cfg { baseUrl, apiKey?, timeoutMs?, retrievePath?, addPath? }
   *   baseUrl: 你的知识库服务根地址，如 http://localhost:8000
   *   retrievePath / addPath: 接口路径，默认 /retrieve 和 /add
   */
  constructor(cfg = {}) {
    super();
    this.baseUrl = (cfg.baseUrl || '').replace(/\/$/, '');
    this.apiKey = cfg.apiKey || '';
    this.timeoutMs = cfg.timeoutMs || 15000;
    this.retrievePath = cfg.retrievePath || '/retrieve';
    this.addPath = cfg.addPath || '/add';
  }

  /**
   * 验证 URL 格式，防止 SSRF 攻击
   * @param {string} url
   * @returns {boolean}
   */
  _isValidUrl(url) {
    try {
      const parsed = new URL(url);
      // 只允许 http 和 https 协议
      if (!['http:', 'https:'].includes(parsed.protocol)) return false;
      const hostname = parsed.hostname;
      // 仅允许 localhost/127.0.0.1
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return true;
      }
      // 阻止内网地址
      if (hostname.startsWith('192.168.') || hostname.startsWith('10.') || hostname.startsWith('172.')) {
        return false;
      }
      // 阻止外部 URL
      return false;
    } catch {
      return false;
    }
  }

  async search(query, opts = {}) {
    if (!this.baseUrl) {
      // 未配置：返回空，不影响主流程（知识库是增强项，非必需）
      console.warn('[local-kb] 未配置 baseUrl，跳过检索');
      return [];
    }
    if (!this._isValidUrl(this.baseUrl)) {
      console.warn('[local-kb] baseUrl 格式无效或不安全，跳过检索');
      return [];
    }
    try {
      const json = await postJson(
        this.baseUrl + this.retrievePath,
        { query, top_k: opts.topK || 5, ...opts },
        this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        this.timeoutMs
      );
      // TODO(你提供): 按真实响应字段映射为 KbChunk[]
      // 假设响应形如 { results: [{ id, text, score, source }] }
      const results = json.results || json.chunks || json.data || [];
      return results.map(r => ({
        id: r.id ?? r.doc_id,
        content: r.text ?? r.content ?? '',
        score: r.score,
        source: r.source ?? r.doc_name,
      }));
    } catch (e) {
      console.warn('[local-kb] 检索失败:', e?.message || e);
      return [];
    }
  }

  async add(content, meta = {}) {
    if (!this.baseUrl) return false;
    if (!this._isValidUrl(this.baseUrl)) {
      console.warn('[local-kb] baseUrl 格式无效或不安全，跳过写入');
      return false;
    }
    try {
      const json = await postJson(
        this.baseUrl + this.addPath,
        { content, meta },
        this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        this.timeoutMs
      );
      return json.ok !== false;
    } catch (e) {
      console.warn('[local-kb] 写入失败:', e?.message || e);
      return false;
    }
  }
}
