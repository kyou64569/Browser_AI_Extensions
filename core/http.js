// core/http.js
// 通用 fetch 封装：超时、错误分类、JSON 友好。
// 被各 adapter 复用，避免重复处理网络细节。

/**
 * 把响应归类为可识别的错误类型，供 fallback 机制判断是否可重试。
 * aborted 表示"调用方主动中止"（用户点停止），不属于故障，fallback 不应重试。
 * @typedef {'timeout'|'aborted'|'auth'|'rate_limit'|'server'|'network'|'unknown'} HttpErrorKind
 */
export class HttpError extends Error {
  /**
   * @param {HttpErrorKind} kind
   * @param {string} message
   * @param {number} [status]
   */
  constructor(kind, message, status) {
    super(message);
    this.name = 'HttpError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * 根据 HTTP 状态码归类错误类型
 * @param {number} status
 * @returns {HttpErrorKind}
 */
function classifyStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'unknown';
}

/**
 * 发起带超时的请求。
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} [timeoutMs] 0 或不传表示不超时
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, init = {}, timeoutMs = 0) {
  let timer;
  const controller = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  if (timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  try {
    const res = await fetch(url, { ...init, signal });
    if (!res.ok) {
      const kind = classifyStatus(res.status);
      const text = await res.text().catch(() => '');
      throw new HttpError(kind, `HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    return res;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e?.name === 'AbortError') {
      // 区分两类中止：调用方主动停止（用户点"停止生成"）与内部超时看门狗。
      // 混淆会把用户中止误报成"请求超时"。
      if (init.signal && init.signal.aborted) {
        throw new HttpError('aborted', '请求已被用户中止', 0);
      }
      throw new HttpError('timeout', `请求超时（>${timeoutMs}ms）`, 0);
    }
    throw new HttpError('network', e?.message || 'network error', 0);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * POST JSON
 * @param {string} url
 * @param {object} body
 * @param {object} headers
 * @param {number} [timeoutMs]
 * @param {AbortSignal} [signal]
 */
export async function postJson(url, body, headers = {}, timeoutMs = 0, signal) {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  }, timeoutMs);
  try {
    return await res.json();
  } catch (e) {
    throw new HttpError('unknown', `Invalid JSON response: ${e.message}`, res.status);
  }
}
