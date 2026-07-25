// core/translate-rate.js
// 网页翻译优化核心工具（纯逻辑，无 chrome.* 依赖）：
//   1) estimateTokens  —— 文本 → token 数近似估算
//   2) splitSentences  —— 在句/段边界切分长文本，保留分隔符以便还原
//   3) chunkUnits      —— 把「翻译项」扩展为句子级单元后，按 token 预算分块
//   4) RateGate        —— TPM/RPM 60 秒滑动窗口限流 + 429(TPM) 自适应下调
// 设计目标（对应优化需求）：控制单批 token 量避免超 TPM；在边界切分不破坏语义；
// 主动限流 + 监控配额动态调整并发；遗漏单元可重试。

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.min(ms, 60000)));
}

/**
 * 估算一段文本的 token 数（通用近似）。
 * - CJK/日文/韩文字符：约 1 token/字符
 * - 其它字符（拉丁字母等）：约 4 字符/token
 * 这是用于「限流预算」与「分块」的近似，不要求精确，误差偏向保守即可。
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  let cjk = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (
      (c >= 0x3400 && c <= 0x4DBF) || (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0xF900 && c <= 0xFAFF) ||
      (c >= 0x3000 && c <= 0x303F) || (c >= 0xFF00 && c <= 0xFFEF) ||
      (c >= 0x3040 && c <= 0x309F) || (c >= 0x30A0 && c <= 0x30FF) ||
      (c >= 0xAC00 && c <= 0xD7AF)
    ) cjk++;
  }
  const other = s.length - cjk;
  return Math.ceil(cjk * 1.0 + other / 4);
}

/**
 * 在句子 / 段落边界切分长文本，保留每项末尾的分隔符（标点、换行）。
 * 返回 [{ text, sep }]，sep 为该项末尾分隔符，翻译后按 text+sep 重新拼接即可还原结构。
 * 切分点天然落在句/段边界，避免破坏语义完整性（优化需求 1）。
 * @param {string} text
 * @returns {{text:string, sep:string}[]}
 */
export function splitSentences(text) {
  const s = String(text || '');
  if (!s.trim()) return [];
  // 匹配「若干非分隔符 + 若干分隔符」，或「行尾剩余的非分隔符串」
  const re = /[^。.!?！？\n]*[。.!?！？\n]+|[^。.!?！？\n]+$/g;
  const parts = s.match(re);
  if (!parts || parts.length === 0) return [{ text: s, sep: '' }];
  const out = [];
  for (const p of parts) {
    const m = p.match(/^([\s\S]*?)([。.!?！？\n]*)$/);
    const body = m ? m[1] : p;
    const sep = m ? m[2] || '' : '';
    out.push({ text: body, sep });
  }
  if (out.length === 0) out.push({ text: s, sep: '' });
  return out;
}

/**
 * 把若干「翻译项」扩展为句子级单元，再按 token 预算分块。
 * @param {{i:number, t:string}[]} items  翻译项：i = 在原 texts 数组中的索引，t = 原文
 * @param {number} maxBatchTokens  单批 token 软上限
 * @returns {Array<Array<{itemIndex:number, partIndex:number, text:string, sep:string, tok:number}>>}
 *   外层为批（chunk），内层为单元（unit）。itemIndex 用于跨批重排拼回原项；
 *   partIndex 用于把同一项被拆到多处/多批的子句正确排序拼接。
 */
export function chunkUnits(items, maxBatchTokens) {
  // 1) 扩展为句子级单元（仅对明显偏长的项切句，避免小题大做）
  const expanded = [];
  for (const it of items) {
    const t = it.t || '';
    const parts = splitSentences(t);
    if (parts.length > 1) {
      parts.forEach((p, k) => {
        // 跳过完全空白的片段（body 与 sep 皆空）
        if (!p.text.trim() && !p.sep.trim()) return;
        expanded.push({
          itemIndex: it.i,
          partIndex: k,
          text: p.text,
          sep: p.sep,
          tok: estimateTokens(p.text),
        });
      });
      continue;
    }
    expanded.push({ itemIndex: it.i, partIndex: 0, text: t, sep: '', tok: estimateTokens(t) });
  }

  // 2) 按 token 预算累积分块（flush 点天然落在句边界）
  const chunks = [];
  let cur = [];
  let curTok = 0;
  for (const u of expanded) {
    if (cur.length && curTok + u.tok > maxBatchTokens) {
      chunks.push(cur);
      cur = [];
      curTok = 0;
    }
    cur.push(u);
    curTok += u.tok;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * TPM / RPM 滑动窗口限流器（窗口默认 60 秒，与厂商配额口径一致）。
 * - reserve(tokens)：阻塞直到「本请求的输入+输出 token 量」与「请求数」都在窗口额度内，再记账放行。
 * - onTokenRateLimit()：实际触发 429(TPM) 后，把 tpm 上限自适应下调到观测值的 0.8（保留下限），
 *   实现「未显式配置配额时也能从第一次 429 自我学习真实上限」。
 * 返回值为本次预约实际等待的毫秒数（供上层动态调整并发）。
 */
export class RateGate {
  /**
   * @param {{tpm?:number, rpm?:number, windowMs?:number}} cfg
   *   tpm/rpm 为 undefined 或 <=0 时视为 Infinity（不限流，保留向后兼容与付费模型吞吐）。
   */
  constructor({ tpm = Infinity, rpm = Infinity, windowMs = 60000 } = {}) {
    this.windowMs = windowMs;
    this.tpm = (typeof tpm === 'number' && tpm > 0) ? tpm : Infinity;
    this.rpm = (typeof rpm === 'number' && rpm > 0) ? rpm : Infinity;
    this.tokenLog = []; // {t, n}
    this.reqLog = [];   // {t}  （每项 n=1）
    this._floor = 2000; // tpm 自适应下限，防止瞬态误判把额度压到 0
    this._origTpm = this.tpm; // 记录原始配置上限，用于限流下调后的回弹封顶
    this._limitedAt = 0;      // 上次触发 TPM 限流的时间戳
  }

  _clean(now) {
    const cut = now - this.windowMs;
    while (this.tokenLog.length && this.tokenLog[0].t <= cut) this.tokenLog.shift();
    while (this.reqLog.length && this.reqLog[0].t <= cut) this.reqLog.shift();
  }

  // 计算还需等待多久，直到窗口内用量降到 need 以下（仅当已超限时返回 >0）
  _waitFor(log, now, need) {
    let used = log.reduce((s, x) => s + x.n, 0);
    if (used <= need) return 0;
    let i = 0;
    while (i < log.length && used - log[i].n > need) {
      used -= log[i].n;
      i++;
    }
    if (i >= log.length) return this.windowMs; // 极端：全部都得等满一个窗口
    return Math.max(0, log[i].t + this.windowMs - now);
  }

  /**
   * 预约一次请求的额度（输入+输出 token 估算）。返回实际等待毫秒数。
   * @param {number} tokens 预估的本次请求总 token 消耗（输入+输出）
   */
  async reserve(tokens) {
    let totalWaited = 0;
    for (;;) {
      const now = Date.now();
      this._clean(now);
      this._maybeRecover(now);
      const tokUsed = this.tokenLog.reduce((s, x) => s + x.n, 0);
      const reqUsed = this.reqLog.length;
      const tokNeed = this.tpm === Infinity ? 0 : this.tpm - tokens;
      const reqNeed = this.rpm === Infinity ? 0 : this.rpm - 1;

      const tokOk = this.tpm === Infinity || tokUsed <= tokNeed;
      const reqOk = this.rpm === Infinity || reqUsed <= reqNeed;
      if (tokOk && reqOk) {
        this.tokenLog.push({ t: now, n: tokens });
        this.reqLog.push({ t: now });
        return totalWaited;
      }

      const waitTok = this.tpm === Infinity ? 0 : this._waitFor(this.tokenLog, now, Math.max(0, tokNeed));
      const waitReq = this.rpm === Infinity ? 0 : this._waitFor(this.reqLog, now, Math.max(0, reqNeed));
      const wait = Math.max(waitTok, waitReq);
      if (wait <= 0) {
        // 边界：额度其实已够（浮点/时序），直接记账放行
        this.tokenLog.push({ t: now, n: tokens });
        this.reqLog.push({ t: now });
        return totalWaited;
      }
      const actual = Math.min(wait, 2000) + Math.floor(Math.random() * 50); // 上限 2s + 抖散并发
      await sleep(actual);
      totalWaited += actual;
    }
  }

  /** 实际触发 TPM 限流后调用：把上限压到观测窗口用量的 0.8（保留下限），避免再次立即超限。 */
  onTokenRateLimit() {
    const now = Date.now();
    this._clean(now);
    const used = this.tokenLog.reduce((s, x) => s + x.n, 0);
    const observed = used || (typeof this.tpm === 'number' ? this.tpm : 0);
    this.tpm = Math.max(this._floor, Math.floor((observed || 1) * 0.8));
    this._limitedAt = now;
    console.warn(`[rate] 检测到 TPM 限流，自适应下调限速上限至 ${this.tpm} tokens/min`);
  }

  /** 距上次限流已超过一个窗口、且尚未回到原始上限时，缓慢回弹 tpm（每次 ×1.2，封顶原始配置值），避免一次瞬态 429 永久限速 */
  _maybeRecover(now) {
    if (this._origTpm === Infinity) return;
    if (this.tpm >= this._origTpm) return;
    if (this._limitedAt && now - this._limitedAt < this.windowMs) return;
    this.tpm = Math.min(this._origTpm, Math.floor(this.tpm * 1.2) || this._origTpm);
  }

  /** 当前配额占用快照（用于监控/日志）。 */
  stats() {
    const now = Date.now();
    this._clean(now);
    return {
      tpm: this.tpm === Infinity ? null : this.tpm,
      rpm: this.rpm === Infinity ? null : this.rpm,
      usedTokens: this.tokenLog.reduce((s, x) => s + x.n, 0),
      usedRequests: this.reqLog.length,
    };
  }
}
