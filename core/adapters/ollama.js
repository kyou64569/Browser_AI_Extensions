// core/adapters/ollama.js
// 本地 Ollama adapter。走 OpenAI 兼容接口 /api/chat（默认 http://localhost:11434）。
// 本地模型通常无 apiKey，config.apiKey 可为空。

import { ModelClient } from '../model-base.js';
import { postJson, fetchWithTimeout } from '../http.js';

export class OllamaAdapter extends ModelClient {
  get endpoint() {
    // 优先用用户填的 apiBase，否则默认本地
    const base = (this.config.apiBase || 'http://localhost:11434').replace(/\/$/, '');
    return base + '/api/chat';
  }

  _toVendor(req) {
    const messages = req.messages.map(m => {
      if (m.attachments && m.attachments.length) {
        const images = m.attachments
          .map(a => {
            const m2 = a.data.match(/^data:(.+?);base64,(.+)$/);
            return m2 ? m2[2] : null; // Ollama 图片要裸 base64（m2[2] 为 base64 数据，m2[1] 是 MIME）
          })
          .filter(Boolean);
        return { role: m.role, content: m.content, images };
      }
      return { role: m.role, content: m.content };
    });
    return messages;
  }

  async *_stream(req, signal) {
    const { maxTokens, ...otherOptions } = req.options || {};
    const body = {
      model: this.config.model,
      messages: this._toVendor(req),
      stream: true,
      ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
      ...otherOptions,
    };
    const res = await fetchWithTimeout(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
          const delta = json.message?.content || '';
          if (delta) yield { delta, done: false, meta: { raw: json } };
          if (json.done) { yield { delta: '', done: true }; return; }
        } catch (e) { console.warn('[ollama] Failed to parse stream chunk:', e); }
      }
    }
    yield { delta: '', done: true };
  }

  async *_nonStream(req, signal) {
    const { maxTokens, ...otherOptions } = req.options || {};
    const body = { model: this.config.model, messages: this._toVendor(req), stream: false, ...(maxTokens != null ? { max_tokens: maxTokens } : {}), ...otherOptions };
    const json = await postJson(this.endpoint, body, {}, this.config.timeoutMs);
    yield { delta: json.message?.content || '', done: true, meta: { raw: json } };
  }

  async *chat(req) {
    const signal = req.signal;
    if (req.stream && this.config.supportsStream) {
      yield* this._stream(req, signal);
    } else {
      yield* this._nonStream(req, signal);
    }
  }
}
