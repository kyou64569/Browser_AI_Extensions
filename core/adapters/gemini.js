// core/adapters/gemini.js
// Gemini 格式 adapter。generateContent / streamGenerateContent。
// 注意：Gemini 把角色归并为 user/model，system  Instruction 单独字段。

import { ModelClient } from '../model-base.js';
import { postJson, fetchWithTimeout, HttpError } from '../http.js';
import { streamLines, sseData } from '../sse.js';
import { normalizeApiBase } from '../../shared/utils.js';
import { redactUrl } from '../../shared/sanitize.js';

/**
 * Gemini 2.5 系列的思考预算（tokens）档位映射。thinkingBudget 正是随 2.5 引入的参数。
 * 不用 0 兜底：thinkingBudget: 0 的语义是「关闭思考」，拿它当默认值会把不认识的档位
 * 静默变成不思考。
 */
const GEMINI_THINKING_BUDGET = { low: 1024, medium: 4096, high: 12288 };

/** Gemini 3 及以后的思考档位。官方口径：thinkingLevel 自 3 起为推荐参数 */
const GEMINI_THINKING_LEVEL = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' };

/**
 * 该模型该用哪种思考参数。
 * 官方文档：thinkingBudget 随 Gemini 2.5 引入；Gemini 3 及以后推荐 thinkingLevel
 * （在 3.x 上继续发 budget 官方标注「may result in unexpected performance」，能用但不该用）。
 * 认不出版本的一律按 2.5 的 budget 走：两代都接受 budget，而给 2.5 发 level 属于
 * 「参数不匹配会被直接拒绝」那一类，宁可退化成一个不理想的参数也不要 400。
 * @param {string} [model]
 * @returns {'level'|'budget'}
 */
export function geminiThinkingMode(model) {
  const v = String(model || '').toLowerCase().match(/gemini[-_ /]*(\d+)/);   // gemini-3.1-flash / google/gemini-3-5 / models/gemini2.5
  if (!v) return 'budget';
  return Number(v[1]) >= 3 ? 'level' : 'budget';
}

/**
 * 生成 thinkingConfig 本体；返回 null 表示这次不发思考参数（档位不认识，或根本不需要发）。
 * includeThoughts 两代都要显式开启：官方写明思考摘要默认不返回，只有 part 上的
 * thought:true 出现后 UI 才有内容可显示。
 * @param {string|undefined} model 模型名（决定 budget 还是 level）
 * @param {string} [thinkingStrength] low|medium|high|minimal
 * @returns {{thinkingBudget:number, includeThoughts:true}|{thinkingLevel:string, includeThoughts:true}|null}
 */
export function geminiThinkingConfig(model, thinkingStrength) {
  if (geminiThinkingMode(model) === 'level') {
    const level = GEMINI_THINKING_LEVEL[thinkingStrength || ''];
    return level ? { thinkingLevel: level, includeThoughts: true } : null;
  }
  const budget = GEMINI_THINKING_BUDGET[thinkingStrength || ''];
  return budget ? { thinkingBudget: budget, includeThoughts: true } : null;
}

export class GeminiAdapter extends ModelClient {
  /**
   * 流式与非流式 endpoint 不同。
   * 流式必须带 ?alt=sse：官方 REST 不带该参数时返回的是 JSON 数组
   * （数组模式还带尾逗号，逐行 JSON.parse 根本无法解析），只有 alt=sse 才是 SSE 事件流。
   */
  _endpoint(stream) {
    const base = normalizeApiBase(this.config.apiBase);
    const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return `${base}/models/${this.config.model}:${method}`;
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
          if (m2) /** @type {any} */ (parts).push({ inlineData: { mimeType: m2[1], data: m2[2] } });
          else if (/^https?:\/\//.test(a.data)) /** @type {any} */ (parts).push({ fileData: { fileUri: a.data } });
        }
      }
      contents.push({ role, parts });
    }
    return { systemInstruction, contents };
  }

  /**
   * 挂上思考参数到请求体。以下三种情况都不发：未启用、档位为 default（厂商默认）、
   * 以及档位值认不出来（见 geminiThinkingConfig，绝不用 0 兜底）。
   */
  _applyThinking(body, thinkingStrength) {
    if (!thinkingStrength || thinkingStrength === 'off' || thinkingStrength === 'default') return;
    const thinkCfg = geminiThinkingConfig(this.config.model, thinkingStrength);
    if (!thinkCfg) return;
    body.generationConfig = body.generationConfig || {};
    body.generationConfig.thinkingConfig = thinkCfg;
  }

  async *_stream(req, signal) {
    const { maxTokens, temperature, topP, top_p, thinkingStrength } = req.options || {};
    const body = this._toVendor(req);
    const generationConfig = {
      ...(maxTokens != null ? { maxOutputTokens: maxTokens } : {}),
      ...(temperature != null ? { temperature } : {}),
      ...(topP != null ? { topP } : {}),
      ...(top_p != null ? { topP: top_p } : {}),
    };
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    this._applyThinking(body, thinkingStrength);
    const res = await fetchWithTimeout(this._endpoint(true), {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
      signal,
    }, this.config.timeoutMs);
    let finishReason = '';
    for await (const line of streamLines(res.body)) {
      const data = sseData(line);
      if (data == null) continue;
      let json;
      try { json = JSON.parse(data); } catch (_) { continue; }
      // 流内错误帧：官方在 HTTP 200 的 SSE 里也可能下发 error 事件（如配额/内部错误），
      // 不抛出会被上层误判为「空输出的成功调用」
      if (json.error) {
        throw new HttpError('server', `Gemini 流式错误: ${json.error.message || JSON.stringify(json.error).slice(0, 200)}`);
      }
      if (json.promptFeedback?.blockReason) {
        throw new HttpError('unknown', `Gemini 安全拦截: ${json.promptFeedback.blockReason}`);
      }
      const candidate = json.candidates?.[0];
      if (candidate?.finishReason === 'SAFETY') {
        throw new HttpError('unknown', 'Gemini 安全拦截: SAFETY');
      }
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      if (!candidate?.content?.parts) continue;
      // 思考摘要片段带 thought:true 标志，必须与正文分开产出——
      // 混在一起会把思考文本原样拼进回答正文
      let text = '', think = '';
      for (const p of candidate.content.parts) {
        if (!p || !p.text) continue;
        if (p.thought) think += p.text;
        else text += p.text;
      }
      if (think) yield { delta: '', thinking: think, done: false };
      if (text) yield { delta: text, done: false, meta: { raw: json } };
    }
    yield { delta: '', done: true, ...(finishReason ? { finishReason } : {}) };
  }

  async *_nonStream(req, signal) {
    const { maxTokens, temperature, topP, top_p, thinkingStrength } = req.options || {};
    const body = this._toVendor(req);
    const generationConfig = {
      ...(maxTokens != null ? { maxOutputTokens: maxTokens } : {}),
      ...(temperature != null ? { temperature } : {}),
      ...(topP != null ? { topP } : {}),
      ...(top_p != null ? { topP: top_p } : {}),
    };
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    this._applyThinking(body, thinkingStrength);
    const json = await postJson(this._endpoint(false), body, this._headers(), this.config.timeoutMs, signal);
    if (json.error) {
      throw new HttpError('server', `Gemini 错误: ${json.error.message || JSON.stringify(json.error).slice(0, 200)}`);
    }
    if (json.promptFeedback?.blockReason) {
      throw new HttpError('unknown', `Gemini 安全拦截: ${json.promptFeedback.blockReason}`);
    }
    const candidate = json.candidates?.[0];
    if (candidate?.finishReason === 'SAFETY') {
      throw new HttpError('unknown', 'Gemini 安全拦截: SAFETY');
    }
    if (!candidate?.content?.parts) {
      yield { delta: '', done: true, meta: { raw: json } };
      return;
    }
    let text = '', think = '';
    for (const p of candidate.content.parts) {
      if (!p || !p.text) continue;
      if (p.thought) think += p.text;
      else text += p.text;
    }
    if (think) yield { delta: '', thinking: think, done: false };
    yield { delta: text, done: true, ...(candidate?.finishReason ? { finishReason: candidate.finishReason } : {}), meta: { raw: json } };
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
