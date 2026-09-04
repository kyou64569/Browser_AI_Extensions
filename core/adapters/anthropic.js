// core/adapters/anthropic.js
// Anthropic 格式 adapter。Messages API。
// 注意：Anthropic 要求 system 单独成字段，且图片以 base64 source 表达。

import { ModelClient } from '../model-base.js';
import { postJson, fetchWithTimeout, HttpError } from '../http.js';
import { streamLines, sseData } from '../sse.js';
import { normalizeApiBase } from '../../shared/utils.js';
import { redactUrl } from '../../shared/sanitize.js';

/** Anthropic 思考预算（tokens）档位映射 */
const ANTHROPIC_THINKING_BUDGET = { low: 2000, medium: 8000, high: 16000 };

/**
 * 思考预算上限。Anthropic 要求 max_tokens > budget_tokens，而 max_tokens 不得超过
 * 模型输出上限：接受 thinking 参数的模型（3.7+/4 系）上限均 ≥8192，因此预算压到
 * 8192-1024=7168 可保证任何档位下 max_tokens=8192 都合法，不会再触发 400。
 * 3.5 系本身不支持 thinking 参数，400 会如实透出（属用户配置问题）。
 */
const ANTHROPIC_MAX_THINKING_BUDGET = 7168;

/** 把 thinkingStrength 转成 Anthropic thinking 参数；'off'/无则返回 null */
function mapAnthropicThinking(strength) {
  if (!strength || strength === 'off') return null;
  const budget = ANTHROPIC_THINKING_BUDGET[strength];
  if (!budget) return null;
  return { type: 'enabled', budget_tokens: Math.min(budget, ANTHROPIC_MAX_THINKING_BUDGET) };
}

/**
 * max_tokens = max(用户设定, budget+1024)。启用 thinking 时整体压到 8192 内
 * （理由同上）；未启用时用户显式设置的 maxTokens 原样透传，不做截断。
 */
function effMaxTokens(maxTokens, thinking) {
  const budget = thinking?.budget_tokens || 0;
  const want = Math.max(maxTokens ?? 1024, budget + 1024);
  return budget ? Math.min(want, budget + 1024) : want;
}

export class AnthropicAdapter extends ModelClient {
  get endpoint() {
    return normalizeApiBase(this.config.apiBase) + '/messages';
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
            /** @type {any} */ (content).push({
              type: 'image',
              source: { type: 'base64', media_type: m2[1], data: m2[2] },
            });
          } else if (/^https?:\/\//.test(a.data)) {
            /** @type {any} */ (content).push({ type: 'image', source: { type: 'url', url: a.data } });
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
    const body = {
      model: this.config.model,
      messages,
      max_tokens: effMaxTokens(maxTokens, thinking),
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

    for await (const line of streamLines(res.body)) {
      const data = sseData(line);
      if (data == null) continue;
      let json;
      try { json = JSON.parse(data); } catch (_) { continue; }
      // 流内 error 事件（overloaded_error 等）：不抛出会被上层误判为「空输出的成功调用」
      if (json.type === 'error') {
        throw new HttpError('server', `Anthropic 流式错误: ${json.error?.message || json.error?.type || 'unknown'}`);
      }
      if (json.type === 'content_block_delta' && json.delta?.text) {
        yield { delta: json.delta.text, done: false, meta: { raw: json } };
      } else if (json.type === 'message_stop') {
        yield { delta: '', done: true };
        return;
      }
    }
    yield { delta: '', done: true };
  }

  async *_nonStream(req, signal) {
    const { system, messages } = this._toVendor(req);
    const { maxTokens, thinkingStrength, ...otherOptions } = req.options || {};
    const thinking = mapAnthropicThinking(thinkingStrength);
    const body = {
      model: this.config.model,
      messages,
      max_tokens: effMaxTokens(maxTokens, thinking),
      stream: false,
      ...(system ? { system } : {}),
      ...(thinking ? { thinking } : {}),
      ...otherOptions,
    };
    const json = await postJson(
      this.endpoint, body,
      { 'x-api-key': this.config.apiKey, 'anthropic-version': '2023-06-01' },
      this.config.timeoutMs,
      signal
    );
    const text = (json.content || []).map(c => c.text || '').join('');
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
      // 同上：错误信息只透出 origin+path，不泄露 query 中可能携带的凭证。
      const urlTip = `（请求地址：${redactUrl(this.endpoint)}）`;
      if (e instanceof HttpError && (e.status === 404 || e.kind === 'network')) {
        throw new HttpError(e.kind, (e.message || '请求失败') + ' ' + urlTip, e.status);
      }
      throw e;
    }
  }
}
