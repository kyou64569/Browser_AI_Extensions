// core/adapters/openai.js
// OpenAI 兼容格式 adapter。适用于 OpenAI、OpenRouter 及各类国产兼容接口。
// 输入：统一 ChatRequest -> 输���：厂�� /v1/chat/completions -> 转回 ChatResponseChunk

import { ModelClient } from '../model-base.js';
import { postJson, fetchWithTimeout, HttpError } from '../http.js';
import { streamLines, sseData } from '../sse.js';
import { normalizeApiBase } from '../../shared/utils.js';
import { resolveThinkingStyle, buildThinkingParams } from '../../shared/thinking.js';
import { redactUrl } from '../../shared/sanitize.js';
import { THINKING_MIN_TIMEOUT_MS } from '../../shared/constants.js';

/** 从 delta / message 对象提取思考文本：DeepSeek/Qwen/GLM 系走 reasoning_content，OpenRouter 走 reasoning */
function pickThinking(o) {
  if (!o) return '';
  if (typeof o.reasoning_content === 'string') return o.reasoning_content;
  if (typeof o.reasoning === 'string') return o.reasoning;
  return '';
}



/**
 * 本次调用是否会产出思考。
 * 判据不能只看「发出了思考参数」：SenseNova / DeepSeek-R1 这类 thinkingStyle 不可调的模型
 * 默认就思考、也没有开关参数可发，按旧判据会被算成「不思考」而只拿模型卡那点超时，
 * 于是用户把输出额度调大、思考变长之后，报错从「max_tokens 截断」变成更难排查的「请求超时」。
 * 超时只是安全上限，勾选了「支持思考」就一律按会思考处理。
 * @param {{supportsThinking?:boolean}} config 模型配置
 * @param {Record<string, any>} [thinkParams] _thinkingParams 的结果（空对象 = 本次未发思考参数）
 * @returns {boolean}
 */
export function willProduceThinking(config, thinkParams) {
  return Object.keys(thinkParams || {}).length > 0 || !!(config && config.supportsThinking);
}

/**
 * 计算本次调用的有效超时：会产出思考时不低于 THINKING_MIN_TIMEOUT_MS；
 * timeoutMs 为 0（用户显式「永不超时」）时保持 0。
 * @param {number} [timeoutMs] 模型卡配置的超时
 * @param {boolean} [willThink] 本次是否会产出思考（见 willProduceThinking）
 * @returns {number}
 */
export function effectiveTimeoutMs(timeoutMs, willThink) {
  const t = timeoutMs || 0;
  if (!t) return 0;
  return willThink ? Math.max(t, THINKING_MIN_TIMEOUT_MS) : t;
}

export class OpenAIAdapter extends ModelClient {
  get endpoint() {
    return normalizeApiBase(this.config.apiBase) + '/chat/completions';
  }

  /** 思考参数：按模型配置的 thinkingStyle（'auto' 时按模型名识别）× 强度生成；'default'/未启用不发 */
  _thinkingParams(thinkingStrength) {
    if (thinkingStrength == null || thinkingStrength === 'default') return {};
    const style = resolveThinkingStyle(this.config.thinkingStyle, this.config.model, this.config.apiBase);
    return buildThinkingParams(style, thinkingStrength);
  }

  /** 统一消息 -> OpenAI messages */
  _toVendor(req) {
    return req.messages.map(m => {
      if (m.attachments && m.attachments.length) {
        // 多模态：content 变成 parts
        const parts = /** @type {Array<Object>} */ ([{ type: 'text', text: m.content }]);
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
    const thinkParams = this._thinkingParams(thinkingStrength);
    const body = {
      model: this.config.model,
      messages: this._toVendor(req),
      stream: true,
      ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
      ...thinkParams,
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
    }, effectiveTimeoutMs(this.config.timeoutMs, willProduceThinking(this.config, thinkParams)));

    let finishReason = '';
    for await (const line of streamLines(res.body)) {
      const data = sseData(line);
      if (data == null) continue;
      if (data === '[DONE]') {
        yield { delta: '', done: true, ...(finishReason ? { finishReason } : {}) };
        return;
      }
      let json;
      try { json = JSON.parse(data); } catch (_) { continue; }
      // 流内错误帧：部分网关在 HTTP 200 的 SSE 里下发 {"error": ...}，必须抛出而非吞掉
      if (json.error) {
        throw new HttpError('server', `流式错误: ${json.error.message || JSON.stringify(json.error).slice(0, 200)}`);
      }
      const fr = json.choices?.[0]?.finish_reason;
      if (fr) finishReason = fr;
      const d = json.choices?.[0]?.delta || {};
      // 思考增量与正文增量相互独立、可交错到达；思考帧不携带 meta（无 usage 价值）
      const think = pickThinking(d);
      if (think) yield { delta: '', thinking: think, done: false };
      const delta = d.content || '';
      if (delta) yield { delta, done: false, meta: { raw: json } };
    }
    yield { delta: '', done: true, ...(finishReason ? { finishReason } : {}) };
  }

  async *_nonStream(req, signal) {
    const { maxTokens, thinkingStrength, ...otherOptions } = req.options || {};
    const thinkParams = this._thinkingParams(thinkingStrength);
    const body = {
      model: this.config.model,
      messages: this._toVendor(req),
      stream: false,
      ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
      ...thinkParams,
      ...otherOptions,
    };
    const json = await postJson(
      this.endpoint, body,
      { Authorization: `Bearer ${this.config.apiKey}` },
      effectiveTimeoutMs(this.config.timeoutMs, willProduceThinking(this.config, thinkParams)),
      signal
    );
    const msg = json.choices?.[0]?.message || {};
    const think = pickThinking(msg);
    const fr = json.choices?.[0]?.finish_reason;
    if (think) yield { delta: '', thinking: think, done: false };
    yield { delta: msg.content || '', done: true, ...(fr ? { finishReason: fr } : {}), meta: { raw: json } };
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
      // 附加请求 URL 到错误信息，方便定位"apiBase 配置是否正确"；
      // 只透出 origin+path（redactUrl），避免自定义代理把 token 写在 query 上时外泄。
      const urlTip = `（请求地址：${redactUrl(this.endpoint)}）`;
      if (e instanceof HttpError && (e.status === 404 || e.kind === 'network')) {
        throw new HttpError(e.kind, (e.message || '请求失败') + ' ' + urlTip, e.status);
      }
      throw e;
    }
  }
}
