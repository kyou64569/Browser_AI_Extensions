// core/adapters/anthropic.js
// Anthropic 格式 adapter。Messages API。
// 注意：Anthropic 要求 system 单独成字段，且图片以 base64 source 表达。

import { ModelClient } from '../model-base.js';
import { postJson, fetchWithTimeout } from '../http.js';

/** Anthropic 思考预算（tokens）档位映射 */
const ANTHROPIC_THINKING_BUDGET = { low: 2000, medium: 8000, high: 16000 };

/** 把 thinkingStrength 转成 Anthropic thinking 参数；'off'/无则返回 null */
function mapAnthropicThinking(strength) {
  if (!strength || strength === 'off') return null;
  const budget = ANTHROPIC_THINKING_BUDGET[strength];
  if (!budget) return null;
  return { type: 'enabled', budget_tokens: budget };
}

export class AnthropicAdapter extends ModelClient {
  get endpoint() {
    return this.config.apiBase.replace(/\/$/, '') + '/messages';
  }

  _toVendor(req) {
    let system;
    const messages = [];
    for (const m of req.messages) {
      if (m.role === 'system') { system = m.content; continue; }
      if (m.attachments && m.attachments.length) {
        const content = [{ type: 'text', text: m.content }];
        for (const a of m.attachments) {
          // a.data 期望 data:image/png;base64,xxxx 或 http(s) url
          const m2 = a.data.match(/^data:(.+?);base64,(.+)$/);
          if (m2) {
            content.push({
              type: 'image',
              source: { type: 'base64', media_type: m2[1], data: m2[2] },
            });
          } else if (/^https?:\/\//.test(a.data)) {
            content.push({ type: 'image', source: { type: 'url', url: a.data } });
          }
        }
        messages.push({ role: m.role, content });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }
    return { system, messages };
  }

  async *_stream(req, signal) {
    const { system, messages } = this._toVendor(req);
    const { maxTokens, thinkingStrength, ...otherOptions } = req.options || {};
    const thinking = mapAnthropicThinking(thinkingStrength);
    // Anthropic 要求 max_tokens 大于 thinking 预算
    const budget = thinking?.budget_tokens || 0;
    const maxTokensEff = Math.max(maxTokens ?? 1024, budget + 1024);
    const body = {
      model: this.config.model,
      messages,
      max_tokens: maxTokensEff,
      stream: true,
      ...(system ? { system } : {}),
      ...(thinking ? { thinking } : {}),
      ...otherOptions,
    };
    const res = await fetchWithTimeout(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
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
        try {
          const json = JSON.parse(data);
          if (json.type === 'content_block_delta' && json.delta?.text) {
            yield { delta: json.delta.text, done: false, meta: { raw: json } };
          } else if (json.type === 'message_stop') {
            yield { delta: '', done: true };
            return;
          }
        } catch (e) { console.warn('[anthropic] Failed to parse stream chunk:', e); }
      }
    }
    yield { delta: '', done: true };
  }

  async *_nonStream(req, signal) {
    const { system, messages } = this._toVendor(req);
    const { maxTokens, thinkingStrength, ...otherOptions } = req.options || {};
    const thinking = mapAnthropicThinking(thinkingStrength);
    const budget = thinking?.budget_tokens || 0;
    const maxTokensEff = Math.max(maxTokens ?? 1024, budget + 1024);
    const body = {
      model: this.config.model,
      messages,
      max_tokens: maxTokensEff,
      stream: false,
      ...(system ? { system } : {}),
      ...(thinking ? { thinking } : {}),
      ...otherOptions,
    };
    const json = await postJson(
      this.endpoint, body,
      { 'x-api-key': this.config.apiKey, 'anthropic-version': '2023-06-01' },
      this.config.timeoutMs
    );
    const text = (json.content || []).map(c => c.text || '').join('');
    yield { delta: text, done: true, meta: { raw: json } };
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
