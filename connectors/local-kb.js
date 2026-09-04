// connectors/local-kb.js
// 本地知识库连接器：调用本地自建的知识库服务（需自建，接口见项目文档）。
// API 前缀 /api/v1：检索 GET /api/v1/search，健康检查 GET /api/v1/health，
// 知识库列表（书源）GET /api/v1/admin/book-sources。
// 所有请求由后台 Service Worker 发起（配合 <all_urls> 宿主权限），不受页面 CORS 限制。

import { KnowledgeBaseConnector } from './knowledge-base.js';
import { fetchWithTimeout } from '../core/http.js';

export class LocalKbConnector extends KnowledgeBaseConnector {
  /**
   * @param {{baseUrl?:string, apiKey?:string, timeoutMs?:number, searchPath?:string, healthPath?:string, sourcesPath?:string}} cfg
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
   * 校验地址：仅允许 localhost / 127.0.0.1 / 私有网段 IP 字面量，阻止公网地址（防误连外部服务）。
   * 主机名必须先判定为 IP 字面量再做网段匹配：裸 startsWith('192.168.') 会被
   * http://192.168.evil.com 这类普通域名绕过（域名前缀撞上私有网段）。
   * 非字面量主机名只放行 localhost 变体；LAN 主机名（如 nas.local）在此不予放行，
   * 用户可直接填写其 IP。DNS 重绑定（域名解析到内网 IP）无法在扩展侧解析 DNS，
   * 由「不放行任意域名 + 302 重定向一律拒绝」两道闸兜底。
   * @param {string} url
   * @returns {boolean}
   */
  _isValidUrl(url) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return false;
      const h = parsed.hostname.toLowerCase().replace(/\.$/, ''); // 去掉 FQDN 尾点
      if (h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || h === '::1') return true;
      // IPv4 字面量：四个 0-255 十进制段（ prevents 192.168.evil.com 之类域名混入）
      const m4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
      if (m4) {
        const oct = m4.slice(1).map(Number);
        if (oct.some((n) => n > 255)) return false;
        const [a, b] = oct;
        if (a === 127) return true;                              // loopback
        if (a === 10) return true;                               // 10/8
        if (a === 192 && b === 168) return true;                 // 192.168/16
        if (a === 172 && b >= 16 && b <= 31) return true;        // 172.16/12
        if (a === 169 && b === 254) return true;                 // link-local（保守放行本地场景）
        return false;
      }
      // IPv6 字面量（URL.hostname 形如 [xxxx]）：只放行 ULA fc00::/7 与 loopback
      if (h.startsWith('[') && h.endsWith(']')) {
        const v6 = h.slice(1, -1).toLowerCase();
        if (v6 === '::1') return true;
        return /^f[cd][0-9a-f]{2}:/.test(v6);
      }
      return false; // 其余一律是域名：不放行
    } catch {
      return false;
    }
  }

  async _get(path, params = {}) {
    if (!this.baseUrl) throw new Error('未配置本地知识库服务地址');
    if (!this._isValidUrl(this.baseUrl)) {
      throw new Error('知识库地址无效或不被允许（仅支持 localhost / 局域网 IP）');
    }
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
    // redirect: 'error' —— 内网服务不应 302 跳公网；跟随重定向会让
    // 「已通过白名单的 baseUrl」经一次跳转把带 Authorization 的请求发到任意主机
    const res = await fetchWithTimeout(url.toString(), { method: 'GET', headers: this._headers(), redirect: 'error' }, this.timeoutMs);
    // 非 JSON 响应（如网关返回 HTML 错误页）给出可读错误，而非裸 TypeError
    try {
      return await res.json();
    } catch (e) {
      throw new Error('本地知识库返回的不是 JSON（HTTP ' + res.status + '）：' + ((e && e.message) || e));
    }
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
   * @param {{topK?:number, knowledgeBaseId?:string}} [opts] { topK, knowledgeBaseId }
   * @returns {Promise<import('./knowledge-base.js').KbChunk[]>}
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
