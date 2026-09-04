// core/fallback.js
// 备用模型 / 降级机制。
// - 按传入的候选列表（已排序）依次尝试
// - 遇到可重试错误（timeout/auth/rate_limit/server/network）自动切下一个
// - 记录最近失败原因+时间，COOLDOWN_MS 内跳过刚失败过的模型（避免反复重试已知失败）
// - 通过 onFallback(index, config, reason) 回调通知 UI 当前用的是第几个备用模型

import { createClient } from './model-client.js';
import { HttpError } from './http.js';
import { recordCall } from '../shared/usage.js';

/** 失败冷却时间：10 分钟内不再重试该模型 */
export const COOLDOWN_MS = 10 * 60 * 1000;

/**
 * 失败记录表（模块级：跨 FallbackManager 实例共享）。
 * 调用方（chat/summarize/selection 等）每次调用都 new 一个 FallbackManager，
 * 若把失败记录挂在实例上，冷却机制永远不生效。挂到模块级后在 SW 存活期内
 * 跨调用生效；SW 休眠重启后重置——MV3 下这是可接受的粒度。
 * @type {Map<string,{reason:string,time:number}>}
 */
const FAIL_LOG = new Map();

export class FallbackManager {
  /**
   * @param {object} opts
   * @param {(index:number, config:object, reason:string)=>void} [opts.onFallback] UI 提示回调
   */
  constructor(opts = {}) {
    this.onFallback = opts.onFallback || (() => {});
  }

  /**
   * 记录失败
   * @param {string} id
   * @param {string} reason
   */
  _recordFailure(id, reason) {
    FAIL_LOG.set(id, { reason, time: Date.now() });
  }

  /**
   * 该模型是否处于冷却中（刚失败过）
   * @param {string} id
   * @returns {boolean}
   */
  _inCooldown(id) {
    const f = FAIL_LOG.get(id);
    if (!f) return false;
    if (Date.now() - f.time > COOLDOWN_MS) {
      FAIL_LOG.delete(id);
      return false;
    }
    return true;
  }

  /**
   * 调用：依次尝试 candidates（ModelConfig 数组）。
   * @param {import('./model-config.js').ModelConfig[]} candidates
   * @param {import('./message.js').ChatRequest} req
   * @returns {Promise<{text:string, used:import('./model-config.js').ModelConfig, tried:number}>}
   */
  async call(candidates, req) {
    // 过滤冷却中模型，但至少保留一个，避免全部冷却时无法工作
    const usable = candidates.filter(c => !this._inCooldown(c.id));
    const pool = usable.length ? usable : candidates;

    let lastErr;
    for (let i = 0; i < pool.length; i++) {
      const cfg = pool[i];
      const t0 = Date.now();
      try {
        const client = createClient(cfg);
        let text = '';
        let used = cfg;
        for await (const chunk of client.chat(req)) {
          text += chunk.delta || '';
        }
        if (!text.trim()) {
          // 空响应（弱模型偶发）不应当作成功，记录失败并走降级路径
          this._recordFailure(cfg.id, 'empty response');
          throw new Error('模型返回空响应');
        }
        if (i > 0) this.onFallback(i, cfg, '自动降级');
        recordCall({ model: cfg.name, vendor: cfg.vendor, kind: req && req.kind, ok: true,
          messages: req && req.messages, completion: text, durationMs: Date.now() - t0 });
        return { text, used, tried: i + 1 };
      } catch (e) {
        // 用户主动中止：不属于模型故障，不记冷却、不降级、不记用量，直接上抛
        if (req && req.signal && req.signal.aborted) throw e;
        const reason = e instanceof HttpError ? `${e.kind}(${e.status})` : (e?.message || 'unknown error');
        this._recordFailure(cfg.id, reason);
        lastErr = e;
        recordCall({ model: cfg.name, vendor: cfg.vendor, kind: req && req.kind, ok: false,
          messages: req && req.messages, completion: '', durationMs: Date.now() - t0 });
        if (i < pool.length - 1) this.onFallback(i + 1, pool[i + 1], `上一模型失败: ${reason}`);
        // 继续尝试下一个
      }
    }
    throw lastErr || new Error('所有模型均不可用');
  }

  /**
   * 流式调用：依次尝试 candidates，按需降级。
   * 仅在「尚未产出任何内容」时才会切到下一个模型（已产出后中途失败则直接抛出，
   * 避免向 UI 推送半成品又切换模型造成错乱）。
   * @param {import('./model-config.js').ModelConfig[]} candidates
   * @param {import('./message.js').ChatRequest} req
   * @yields {{delta:string, done?:boolean, meta?:object, model:string, index:number}}
   */
  async *callStream(candidates, req) {
    const usable = candidates.filter(c => !this._inCooldown(c.id));
    const pool = usable.length ? usable : candidates;

    let lastErr;
    for (let i = 0; i < pool.length; i++) {
      const cfg = pool[i];
      let produced = false;
      let text = '';
      const t0 = Date.now();
      try {
        const client = createClient(cfg);
        for await (const chunk of client.chat(req)) {
          produced = true;
          text += chunk.delta || '';
          yield { ...chunk, model: cfg.name, index: i };
        }
        // 流式同样要查空响应：流「正常结束」但零产出（弱模型偶发/错误帧被吞）不应当作成功。
        // 尚未产出内容时可安全降级；已产出则保持原状视为成功（半成品不能重放）。
        if (!text.trim() && !produced) {
          this._recordFailure(cfg.id, 'empty response');
          throw new Error('模型返回空响应');
        }
        if (i > 0) this.onFallback(i, cfg, '自动降级');
        recordCall({ model: cfg.name, vendor: cfg.vendor, kind: req && req.kind, ok: true,
          messages: req && req.messages, completion: text, durationMs: Date.now() - t0 });
        return;
      } catch (e) {
        // 用户主动中止：不属于模型故障，不记冷却、不降级、不记用量，直接上抛
        if (req && req.signal && req.signal.aborted) throw e;
        const reason = e instanceof HttpError ? `${e.kind}(${e.status})` : (e?.message || 'unknown error');
        this._recordFailure(cfg.id, reason);
        lastErr = e;
        recordCall({ model: cfg.name, vendor: cfg.vendor, kind: req && req.kind, ok: false,
          messages: req && req.messages, completion: text, durationMs: Date.now() - t0 });
        if (produced) {
          // 已产出内容，不能安全降级
          throw e;
        }
        if (i < pool.length - 1) {
          this.onFallback(i + 1, pool[i + 1], `上一模型失败: ${reason}`);
          continue; // 尚未产出内容，可安全降级
        }
        // 已是最后一个候选：抛出，由调用方处理
        throw e;
      }
    }
    throw lastErr || new Error('所有模型均不可用');
  }

  /** 清除某个模型的失败记录（手动重试时有用） */
  clearFailure(id) {
    FAIL_LOG.delete(id);
  }
}
