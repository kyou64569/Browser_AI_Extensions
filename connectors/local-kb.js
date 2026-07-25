// connectors/local-kb.js
// 本地知识库连接器：调用本地自建的知识库服务（接口见 D:/work/knowledge-base/README.md）。
// API 前缀 /api/v1：检索 GET /api/v1/search，健康检查 GET /api/v1/health，
// 知识库列表（书源）GET /api/v1/admin/book-sources。
// 所有请求由后台 Service Worker 发起（配合 <all_urls> 宿主权限），不受页面 CORS 限制。

import { KnowledgeBaseConnector } from './knowledge-base.js';
import { fetchWithTimeout } from '../core/http.js';

export class LocalKbConnector extends KnowledgeBaseConnector {
  /**
   * @param {object} cfg { baseUrl, apiKey?, timeoutMs? }
   *   baseUrl: 知识库服务根地址，如 http://localhost:8000
   */
  constructor(cfg = {}) {
    super();
    this.baseUrl = (cfg.baseUrl || '').replace(/\/$/, '');
    this.apiKey = cfg.apiKey || '';
    this.timeoutMs = cfg.timeoutMs || 15000;
    this.searchPath = cfg.searchPath || '/api/v1/search';
    this.healthPath = cfg.healthPath || '/api/v1/health';
    this.sourcesPath = cfg.sourcesPath || '/api/v1/admin/book-sources';
  }

  _headers() {
    const h = { Accept: 'application/json' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  /**
   * 校验地址：仅允许 localhost / 127.0.0.1 / 常见局域网网段，阻止公网地址（防误连外部服务）。
   * @param {string} url
   * @returns {boolean}
   */
  _isValidUrl(url) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return false;
      const h = parsed.hostname;
      if (h === 'localhost' || h === '127.0.0.1') return true;
      if (h.startsWith('192.168.')) return true;
      if (h.startsWith('10.')) return true;
      // 仅放行 RFC1918 私有网段 172.16.0.0/12（即 172.16.x–172.31.x）。
      // 原 startsWith('172.') 会误放行 172.0/1/200 等公网地址 → SSRF 过滤绕过。
      if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true;
      return false;
    } catch {
      return false;
    }
  }

  async _get(path, params = {}) {
    if (!this.baseUrl) throw new Error('未配置本地知识库服务地址');
    if (!this._isValidUrl(this.baseUrl)) {
      throw new Error('知识库地址无效或不被允许（仅支持 localhost / 局域网）');
    }
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
    const res = await fetchWithTimeout(url.toString(), { method: 'GET', headers: this._headers() }, this.timeoutMs);
    return res.json();
  }

  /** 连接测试：GET /api/v1/health → { status: 'healthy' } */
  async test() {
    const json = await this._get(this.healthPath);
    const ok = json && (json.status === 'healthy' || json.status === 'ok');
    if (!ok) throw new Error('服务未就绪：' + JSON.stringify(json).slice(0, 120));
    return { ok: true, status: json.status, version: json.version };
  }

  /**
   * 列出知识库（书源）：GET /api/v1/admin/book-sources → { sources:[{path,label,files}] }
   * 若接口不可用，回退为单个“全部”知识库（id 为空，检索时不按路径过滤）。
   * @returns {Promise<Array<{id:string,name:string,contentCount:number,all?:boolean}>>}
   */
  async listKb() {
    try {
      const json = await this._get(this.sourcesPath);
      const sources = (json && json.sources) || [];
      if (sources.length) {
        return sources.map((s) => ({
          id: s.path || '',
          name: s.label || s.path || '未命名书源',
          contentCount: s.files || 0,
        }));
      }
    } catch (e) {
      // 书源接口可能未启用，回退到“整个知识库”
      console.warn('[local-kb] 读取书源列表失败，回退为单库：', e?.message || e);
    }
    return [{ id: '', name: '本地知识库（全部）', contentCount: 0, all: true }];
  }

  /**
   * 检索：GET /api/v1/search?q=&top_k=&knowledge_base=
   * @param {string} query
   * @param {object} [opts] { topK, knowledgeBaseId }
   * @returns {Promise<KbChunk[]>}
   */
  async search(query, opts = {}) {
    if (!this.baseUrl) {
      console.warn('[local-kb] 未配置地址，跳过检索');
      return [];
    }
    try {
      const json = await this._get(this.searchPath, {
        q: query,
        top_k: opts.topK || 6,
        knowledge_base: opts.knowledgeBaseId || undefined,
      });
      const results = (json && json.results) || [];
      return results
        .filter((r) => r && (r.content || (r.metadata && r.metadata.content)))
        .map((r, i) => {
          const meta = r.metadata || {};
          const content = (r.content || (meta && meta.content) || '').toString().slice(0, 2000);
          return {
            id: r.id || `c${i}`,
            content,
            score: typeof r.score === 'number' ? r.score : undefined,
            source: meta.title || meta.source || meta.author || '',
          };
        });
    } catch (e) {
      console.warn('[local-kb] 检索失败:', e?.message || e);
      return [];
    }
  }

  /** 本地知识库以“文件入库”方式写入，聊天增强不涉及，返回 false（不阻断主流程） */
  async add() {
    return false;
  }
}
