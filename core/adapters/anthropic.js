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
 * 8192-1024=7168 可保证「模型卡留空」时发出去的 max_tokens=8192 仍然合法，不会触发 400。
 * 卡片填了更大值就按更大值发（见 effMaxTokens）。
 * 3.5 系本身不支持 thinking 参数，400 会如实透出（属用户配置问题）。
 */
const ANTHROPIC_MAX_THINKING_BUDGET = 7168;

/** 把 thinkingStrength 转成 Anthropic thinking 参数；'default'（厂商默认）/'off'/无则返回 null */
function mapAnthropicThinking(strength) {
  if (!strength || strength === 'off' || strength === 'default') return null;
  const budget = ANTHROPIC_THINKING_BUDGET[strength];
  if (!budget) return null;
  return { type: 'enabled', budget_tokens: Math.min(budget, ANTHROPIC_MAX_THINKING_BUDGET) };
}

/**
 * max_tokens = max(用户设定, budget+1024)。只保证合法性下限——Anthropic 要求
 * max_tokens 大于 budget_tokens；上限一律以模型卡「最大输出 tokens」为准，不再替用户封顶。
 * 留空时按 1024 起算（该厂商 max_tokens 是必填项）。
 * 填得比该模型的真实输出上限还大，会由厂商自己报错，归因清楚，好过这里静默改数。
 */
function effMaxTokens(maxTokens, thinking) {
  const budget = thinking?.budget_tokens || 0;
  return Math.max(maxTokens ?? 1024, budget + 1024);
}

export class AnthropicAdapter extends ModelClient {
  get endpoint() {
    return normalizeApiBase(this.config.apiBase) + '/messages';
  }

  /** 思考档位会把 max_tokens 顶到 budget+1024，判读额度时要用这个值而不是模型卡 */
  outputCap(req) {
    const { maxTokens, thinkingStrength } = (req && req.options) || {};
    const t = effMaxTokens(maxTokens, mapAnthropicThinking(thinkingStrength));
    return Number.isFinite(t) && t > 0 ? t : null;
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

    let finishReason = '';
    for await (const line of streamLines(res.body)) {
      const data = sseData(line);
      if (data == null) continue;
      let json;
      try { json = JSON.parse(data); } catch (_) { continue; }
      // 流内 error 事件（overloaded_error 等）：不抛出会被上层误判为「空输出的成功调用」
      if (json.type === 'error') {
        throw new HttpError('server', `Anthropic 流式错误: ${json.error?.message || json.error?.type || 'unknown'}`);
      }
      if (json.type === 'message_delta' && json.delta?.stop_reason) finishReason = json.delta.stop_reason;
      if (json.type === 'content_block_delta') {
        const d = json.delta || {};
        // 思考块增量（thinking_delta）与正文增量（text）分两路产出；
        // signature_delta 是思考块签名，仅供厂商校验，对用户无意义，忽略
        if (d.type === 'thinking_delta' && d.thinking) {
          yield { delta: '', thinking: d.thinking, done: false };
        } else if (d.text) {
          yield { delta: d.text, done: false, meta: { raw: json } };
        }
      } else if (json.type === 'message_stop') {
        yield { delta: '', done: true, ...(finishReason ? { finishReason } : {}) };
        return;
      }
    }
    yield { delta: '', done: true, ...(finishReason ? { finishReason } : {}) };
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
    let text = '', think = '';
    for (const c of json.content || []) {
      if (c.type === 'thinking' && c.thinking) think += c.thinking;
      else text += c.text || '';
    }
    if (think) yield { delta: '', thinking: think, done: false };
    yield { delta: text, done: true, ...(json.stop_reason ? { finishReason: json.stop_reason } : {}), meta: { raw: json } };
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
