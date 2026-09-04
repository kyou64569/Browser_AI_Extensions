// core/retry.js
// 统一的「限流退避重试」高阶函数。
//
// 原先 chatAllWithRetry 与 chatStreamWithRetry 是两个几乎逐行重复的实现
// （429 判定、retry-after 解析、TPM 长退避 vs RPM 指数退避），只差一个 onDelta 回调。
// 这里收成一个 withRateLimitRetry：把"跑一次调用"作为 run 传进来，
// 增量文本通过 onDelta 回调出去，流式与非流式共用同一套退避策略。

import {
  RETRY_MAX_ROUNDS,
  RETRY_TPM_BACKOFF_MS,
  RETRY_BASE_BACKOFF_MS,
} from '../shared/constants.js';

/** @param {number} ms */
export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 错误是否为限流（429 / rate limit / quota）。
 * HttpError 当前不携带响应头，只能从消息文本判断，故用较宽松的正则。
 */
export function isRateLimit(e) {
  const s = (e && e.message) ? e.message : String(e || '');
  return /\b429\b|rate.?limit|too many requests|quota/i.test(s);
}

/**
 * 是否为 TPM（tokens per minute）限流。
 * 与 RPM 不同，TPM 是 60 秒滚动窗口——必须等旧 token 从窗口滑出才有额度，
 * 原来 0.8~2.4s 的短退避毫无作用，会立刻再次 429 直到放弃整批（表现为漏翻）。
 */
export function isTokenRateLimit(e) {
  const s = (e && e.message) ? e.message : String(e || '');
  return /\bTPM\b|tokens per minute|tokens\/min|token limit|token rate/i.test(s);
}

/**
 * 尽力从错误文本解析服务端给的 retry-after（秒）。
 * 部分厂商会塞进 body/header，但 HttpError 不携带响应头，故此解析仅为"锦上添花"，
 * 失败则回退到固定退避。
 * @returns {number|null}
 */
export function parseRetryAfterSec(e) {
  const s = (e && e.message) ? e.message : '';
  const m = s.match(/retry-after[:\s]+(\d+)/i)
    || s.match(/try again in\s+(\d+)\s*s/i)
    || s.match(/reset in\s+(\d+)\s*s/i);
  return m ? Number(m[1]) : null;
}

/** 单次退避上限：畸形/超大的 retry-after（如 86400）不应卡死整批翻译 */
const RETRY_BACKOFF_CAP_MS = 2 * 60 * 1000;

/**
 * 计算本次退避时长（ms）。
 * @param {Error} e
 * @param {number} round 当前轮次（0 起）
 */
export function backoffMs(e, round) {
  const explicit = parseRetryAfterSec(e);
  let ms;
  if (isTokenRateLimit(e)) ms = (explicit != null ? explicit : RETRY_TPM_BACKOFF_MS / 1000) * 1000;
  else ms = explicit != null ? explicit * 1000 : RETRY_BASE_BACKOFF_MS * (round + 1);
  return Math.min(ms, RETRY_BACKOFF_CAP_MS);
}

/**
 * 带限流退避地执行 run()，收集其产出的全部文本。
 *
 * @param {() => AsyncGenerator<{delta?: string}>} run
 *        每次重试都会重新调用它（新建一次 chat 迭代器）。
 * @param {object} [opts]
 * @param {(accumulated: string) => void} [opts.onDelta]
 *        每个增量到达后回调（累计文本），用于翻译进度上报。
 * @param {(waitMs: number, round: number, total: number) => void} [opts.onRetry]
 *        退避开始前回调，便于上层打日志/上报进度。
 * @param {number} [opts.maxRounds]
 * @returns {Promise<string>} 累计文本；全部轮次失败则抛出最后一次错误
 */
export async function withRateLimitRetry(run, opts = {}) {
  const { onDelta, onRetry, maxRounds = RETRY_MAX_ROUNDS } = opts;
  let lastErr;
  for (let round = 0; round < maxRounds; round++) {
    try {
      let out = '';
      for await (const c of run()) {
        out += (c && c.delta) || '';
        if (onDelta) onDelta(out);
      }
      return out;
    } catch (e) {
      lastErr = e;
      if (round < maxRounds - 1 && isRateLimit(e)) {
        const wait = backoffMs(e, round);
        if (onRetry) onRetry(wait, round + 1, maxRounds - 1);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}
