// core/adapters/ollama.js
// 本地 Ollama adapter。走 OpenAI 兼容接口 /api/chat（默认 http://localhost:11434）。
// 本地模型通常无 apiKey，config.apiKey 可为空。

import { ModelClient } from '../model-base.js';
import { postJson, fetchWithTimeout, HttpError } from '../http.js';
import { streamLines, sseData } from '../sse.js';
import { normalizeApiBase } from '../../shared/utils.js';

export class OllamaAdapter extends ModelClient {
  get endpoint() {
    // 优先用用户填的 apiBase，否则默认本地
    const base = normalizeApiBase(this.config.apiBase) || 'http://localhost:11434';
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
    // thinkingStrength 从 otherOptions 中剥离（解构后弃用）：Ollama 不识别该参数，透传会 400
    const { maxTokens, thinkingStrength: _thinkingStrength, ...otherOptions } = req.options || {};
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
    for await (const line of streamLines(res.body)) {
      const data = sseData(line); // Ollama 是 NDJSON，sseData 对无前缀行原样放行
      if (data == null) continue;
      let json;
      try { json = JSON.parse(data); } catch (_) { continue; }
      // 流内错误帧（{"error": "..."}）：不抛出会被上层误判为「空输出的成功调用」
      if (json.error) {
        throw new HttpError('server', `Ollama 流式错误: ${typeof json.error === 'string' ? json.error : JSON.stringify(json.error).slice(0, 200)}`);
      }
      const delta = json.message?.content || '';
      if (delta) yield { delta, done: false, meta: { raw: json } };
      if (json.done) { yield { delta: '', done: true }; return; }
    }
    yield { delta: '', done: true };
  }

  async *_nonStream(req, signal) {
    const { maxTokens, thinkingStrength: _thinkingStrength, ...otherOptions } = req.options || {};
    const body = { model: this.config.model, messages: this._toVendor(req), stream: false, ...(maxTokens != null ? { max_tokens: maxTokens } : {}), ...otherOptions };
    const json = await postJson(this.endpoint, body, {}, this.config.timeoutMs, signal);
    if (json.error) {
      throw new HttpError('server', `Ollama 错误: ${typeof json.error === 'string' ? json.error : JSON.stringify(json.error).slice(0, 200)}`);
    }
    yield { delta: json.message?.content || '', done: true, meta: { raw: json } };
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
      const urlTip = `（请求地址：${this.endpoint}）`;
      if (e instanceof HttpError && (e.status === 404 || e.kind === 'network')) {
        throw new HttpError(e.kind, (e.message || '请求失败') + ' ' + urlTip, e.status);
      }
      throw e;
    }
  }
}
