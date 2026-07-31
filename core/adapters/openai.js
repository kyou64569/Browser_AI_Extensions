// core/adapters/openai.js
// OpenAI 兼容格式 adapter。适用于 OpenAI、OpenRouter 及各类国产兼容接口。
// 输入：统一 ChatRequest -> 输���：厂�� /v1/chat/completions -> 转回 ChatResponseChunk

import { ModelClient } from '../model-base.js';
import { postJson, fetchWithTimeout, HttpError } from '../http.js';
import { normalizeApiBase } from '../../shared/utils.js';

export class OpenAIAdapter extends ModelClient {
  get endpoint() {
    return normalizeApiBase(this.config.apiBase) + '/chat/completions';
  }

  /** 统一消息 -> OpenAI messages */
  _toVendor(req) {
    return req.messages.map(m => {
      if (m.attachments && m.attachments.length) {
        // 多模态：content 变成 parts
        const parts = [{ type: 'text', text: m.content }];
        for (const a of m.attachments) {
          parts.push({
            type: 'image_url',
            image_url: { url: a.data },
          });
        }
        return { role: m.role, content: parts };
      }
      return { role: m.role, content: m.content };
    });
  }

  async *_stream(req, signal) {
    const { maxTokens, thinkingStrength, ...otherOptions } = req.options || {};
    const body = {
      model: this.config.model,
      messages: this._toVendor(req),
      stream: true,
      ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
      // reasoning_effort 仅对真正支持的推理模型发送；否则普通模型会返回 HTTP 400
      ...(this.config.reasoningEffortSupported && thinkingStrength && thinkingStrength !== 'off'
          ? { reasoning_effort: thinkingStrength } : {}),
      ...otherOptions,
    };
    const res = await fetchWithTimeout(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
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
        if (!t || !t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') {
          yield { delta: '', done: true };
          return;
        }
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content || '';
          if (delta) yield { delta, done: false, meta: { raw: json } };
        } catch (e) { console.warn('[openai] Failed to parse stream chunk:', e); }
      }
    }
    yield { delta: '', done: true };
  }

  async *_nonStream(req, signal) {
    const { maxTokens, thinkingStrength, ...otherOptions } = req.options || {};
    const body = {
      model: this.config.model,
      messages: this._toVendor(req),
      stream: false,
      ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
      ...(this.config.reasoningEffortSupported && thinkingStrength && thinkingStrength !== 'off'
          ? { reasoning_effort: thinkingStrength } : {}),
      ...otherOptions,
    };
    const json = await postJson(
      this.endpoint, body,
      { Authorization: `Bearer ${this.config.apiKey}` },
      this.config.timeoutMs,
      signal
    );
    const text = json.choices?.[0]?.message?.content || '';
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
      // 附加请求 URL 到错误信息，方便定位"apiBase 配置是否正确"
      const urlTip = `（请求地址：${this.endpoint}）`;
      if (e instanceof HttpError && (e.status === 404 || e.kind === 'network')) {
        throw new HttpError(e.kind, (e.message || '请求失败') + ' ' + urlTip, e.status);
      }
      throw e;
    }
  }
}
