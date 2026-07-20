// connectors/online-kb.js
// 在线知识库连接器：当前实现「腾讯 ima」OpenAPI（2026-07 官方接口）。
//
// 鉴权：自定义 HTTP Header `ima-openapi-clientid` / `ima-openapi-apikey`（非 Bearer）。
// Base：`https://ima.qq.com`
// 关键约束：
//   - 检索 search_knowledge 必须带 knowledge_base_id（不能搜全部），故上层需先 listKb 让用户选库。
//   - 返回的是命中摘要 highlight_content（短），适合做 RAG 上下文；非全文。
//   - Windows 保存的 apiKey 若带 BOM（\uFEFF）会导致鉴权失败（错误码 20004），读取时须去 BOM + trim。
//   - 知识库是「增强项」，任何失败都应兜底返回空数组 / 友好错误，绝不拖垮主流程（总结、聊天）。

import { KnowledgeBaseConnector } from './knowledge-base.js';

const IMA_BASE = 'https://ima.qq.com';

/** 清洗密钥：去 BOM（\uFEFF）+ 两侧空白，规避 Windows 保存带 BOM 导致的鉴权失败 */
function cleanSecret(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/^﻿/, '').trim();
}

/** 把 ima search_knowledge 的单条结果映射为本项目的 KbChunk 契约 */
function toChunk(it, i) {
  const content = (it && (it.highlight_content || it.content || it.title || '')).toString();
  const source = (it && (it.title || '')).toString();
  return {
    id: (it && (it.doc_id || it.kb_doc_id)) || ('c' + i),
    content,
    source,
    score: (it && it.score != null) ? Number(it.score) : undefined,
  };
}

export class OnlineKbConnector extends KnowledgeBaseConnector {
  /**
   * @param {object} cfg { provider:'ima', clientId, apiKey, knowledgeBaseId? }
   */
  constructor(cfg = {}) {
    super();
    this.cfg = cfg || {};
    this.provider = this.cfg.provider || 'ima';
  }

  _headers() {
    return {
      'Content-Type': 'application/json',
      'ima-openapi-clientid': cleanSecret(this.cfg.clientId),
      'ima-openapi-apikey': cleanSecret(this.cfg.apiKey),
    };
  }

  async _post(path, body) {
    const url = IMA_BASE + path;
    const res = await fetch(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body || {}),
    });
    let json = {};
    try {
      json = await res.json();
    } catch (_) { /* 非 JSON 响应（如网关错误） */ }
    if (!res.ok) {
      const detail = json && json.msg ? `（${json.msg}）` : '';
      throw new Error(`ima 接口返回 HTTP ${res.status}${detail}`);
    }
    // ima 成功约定 code === 0；非零为业务错误（如 20004 鉴权失败）
    if (json.code !== 0 && json.code !== undefined) {
      throw new Error(`ima 错误：${json.msg || '未知错误'}(code=${json.code})`);
    }
    return json;
  }

  /** 列出知识库（游标分页聚合，最多拉 20 页） */
  async listKb(opts = {}) {
    // ima search_knowledge_base 的 limit 必须在 (0, 20] 区间，超出报 code=51。
    // 这里把单页 limit 钳到 20，分页循环仍会聚合多页，因此用户库数 >20 也能拉全。
    const perPage = Math.min((opts.limit || 20), 20);
    let cursor = '';
    const out = [];
    for (let page = 0; page < 20; page++) {
      const json = await this._post('/openapi/wiki/v1/search_knowledge_base', { query: '', cursor, limit: perPage });
      const data = json.data || {};
      const list = data.info_list || [];
      for (const it of list) {
        out.push({ id: it.kb_id, name: it.kb_name, contentCount: it.content_count || 0 });
      }
      if (data.is_end || !data.next_cursor || list.length === 0) break;
      cursor = data.next_cursor;
    }
    return out;
  }

  /** 连接测试：列一次知识库，返回数量即可 */
  async test() {
    const list = await this.listKb({ limit: 10 });
    return { ok: true, count: list.length };
  }

  /**
   * 检索指定知识库（游标分页聚合，最多取 limit 条去重结果）。
   * @param {string} query
   * @param {object} [opts] { knowledgeBaseId, limit }
   * @returns {Promise<KbChunk[]>}
   */
  async search(query, opts = {}) {
    const kbId = (opts && opts.knowledgeBaseId) || this.cfg.knowledgeBaseId;
    if (!kbId) {
      console.warn('[online-kb] 未指定 knowledge_base_id，无法检索');
      return [];
    }
    const limit = (opts && opts.limit) || 6;
    let cursor = '';
    const chunks = [];
    const seen = new Set();
    for (let page = 0; page < 10; page++) {
      let json;
      try {
        json = await this._post('/openapi/wiki/v1/search_knowledge', {
          query,
          knowledge_base_id: kbId,
          cursor,
          limit: 20,
        });
      } catch (e) {
        // 检索为增强项：失败不抛，返回已收集的部分 + 日志，主流程继续
        console.warn('[online-kb] 检索失败：', e.message);
        break;
      }
      const data = json.data || {};
      const list = data.info_list || [];
      for (const it of list) {
        const c = toChunk(it, chunks.length);
        if (c.content && !seen.has(c.content)) {
          seen.add(c.content);
          chunks.push(c);
        }
        if (chunks.length >= limit) break;
      }
      if (chunks.length >= limit || data.is_end || !data.next_cursor || list.length === 0) break;
      cursor = data.next_cursor;
    }
    return chunks.slice(0, limit);
  }

  /**
   * 写入知识库（ima 暂无稳定的公开写入接口，待调研）。
   * 保持与基类同一契约，未来接入 import_doc 等接口即可启用。
   */
  async add() {
    throw new Error('[online-kb] ima 暂不支持从插件直接写入知识库');
  }
}
