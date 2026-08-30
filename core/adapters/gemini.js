// core/adapters/gemini.js
// Gemini 格式 adapter。generateContent / streamGenerateContent。
// 注意：Gemini 把角色归并为 user/model，system  Instruction 单独字段。

import { ModelClient } from '../model-base.js';
import { postJson, fetchWithTimeout, HttpError } from '../http.js';
import { normalizeApiBase } from '../../shared/utils.js';
import { redactUrl } from '../../shared/sanitize.js';

export class GeminiAdapter extends ModelClient {
  /** 流式与非流式 endpoint 不同（流式加 ?alt=sse） */
  _endpoint(stream) {
    const base = normalizeApiBase(this.config.apiBase);
    return `${base}/models/${this.config.model}:${stream ? 'streamGenerateContent' : 'generateContent'}`;
  }

  /**
   * 密钥走 x-goog-api-key 请求头，绝不拼进 URL。
   * 放在 query 时会被网关/CDN 访问日志、代理日志、浏览器历史以及本文件的错误提示
   * 原样记录，等同于泄露密钥；官方也支持并推荐 header 方式。
   */
  _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) h['x-goog-api-key'] = this.config.apiKey;
    return h;
  }

  _toVendor(req) {
    let systemInstruction;
    const contents = [];
    for (const m of req.messages) {
      if (m.role === 'system') {
        systemInstruction = { parts: [{ text: m.content }] };
        continue;
      }
      const role = m.role === 'assistant' ? 'model' : 'user';
      const parts = [{ text: m.content }];
      if (m.attachments && m.attachments.length) {
        for (const a of m.attachments) {
          const m2 = a.data.match(/^data:(.+?);base64,(.+)$/);
          if (m2) parts.push({ inlineData: { mimeType: m2[1], data: m2[2] } });
          else if (/^https?:\/\//.test(a.data)) parts.push({ fileData: { fileUri: a.data } });
        }
      }
      contents.push({ role, parts });
    }
    return { systemInstruction, contents };
  }

  async *_stream(req, signal) {
    const { maxTokens, temperature, topP, top_p } = req.options || {};
    const body = this._toVendor(req);
    const generationConfig = {
      ...(maxTokens != null ? { maxOutputTokens: maxTokens } : {}),
      ...(temperature != null ? { temperature } : {}),
      ...(topP != null ? { topP } : {}),
      ...(top_p != null ? { topP: top_p } : {}),
    };
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    const res = await fetchWithTimeout(this._endpoint(true), {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
      signal,
    }, this.config.timeoutMs);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const json = JSON.parse(t);
          const candidate = json.candidates?.[0];
          if (!candidate?.content?.parts) continue;
          const text = candidate.content.parts.map(p => p.text || '').join('') || '';
          if (text) yield { delta: text, done: false, meta: { raw: json } };
        } catch (e) { console.warn('[gemini] Failed to parse stream chunk:', e); }
      }
    }
    yield { delta: '', done: true };
  }

  async *_nonStream(req, signal) {
    const { maxTokens, temperature, topP, top_p } = req.options || {};
    const body = this._toVendor(req);
    const generationConfig = {
      ...(maxTokens != null ? { maxOutputTokens: maxTokens } : {}),
      ...(temperature != null ? { temperature } : {}),
      ...(topP != null ? { topP } : {}),
      ...(top_p != null ? { topP: top_p } : {}),
    };
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    const json = await postJson(this._endpoint(false), body, this._headers(), this.config.timeoutMs, signal);
    const candidate = json.candidates?.[0];
    if (!candidate?.content?.parts) {
      yield { delta: '', done: true, meta: { raw: json } };
      return;
    }
    const text = candidate.content.parts.map(p => p.text || '').join('') || '';
    yield { delta: text, done: true, meta: { raw: json } };
  }

  async *chat(req) {
    const signal = req.signal;
    try {
      if (req.stream && this.config.supportsStream) {
        yield* this._stream(req, signal);
      } else {
        yield* this._nonStream(req, signal);
      }
    } catch (e) {
      // 只透出 origin+path：去掉 query 可防密钥/令牌随错误消息外泄，
      // 保留 path 仍足以判断"apiBase 是否配错"。
      const urlTip = `（请求地址：${redactUrl(this._endpoint(!!(req.stream && this.config.supportsStream)))}）`;
      if (e instanceof HttpError && (e.status === 404 || e.kind === 'network')) {
        throw new HttpError(e.kind, (e.message || '请求失败') + ' ' + urlTip, e.status);
      }
      throw e;
    }
  }
}
