// core/fallback.js
// 备用模型 / 降级机制。
// - 按传入的候选列表（已排序）依次尝试
// - 遇到可重试错误（timeout/auth/rate_limit/server/network）自动切下一个
// - 记录最近失败原因+时间，COOLDOWN_MS 内跳过刚失败过的模型（避免反复重试已知失败）
// - 通过 onFallback(index, config, reason) 回调通知 UI 当前用的是第几个备用模型

import { createClient } from './model-client.js';
import { HttpError } from './http.js';
import { isTruncatedFinish } from '../shared/utils.js';
import { thinkingIsInert } from '../shared/thinking.js';
import { recordCall, estimateTokens } from '../shared/usage.js';

/** 失败冷却时间：10 分钟内不再重试该模型 */
export const COOLDOWN_MS = 10 * 60 * 1000;

/**
 * 思考预算保护阈值：正文迟迟不出现、而累计思考已用到申请额度的这个比例时就主动收手。
 * 厂商要撞满 max_tokens 才回 length，等于整份额度白花还要等它跑完；到九成还没吐出第一个字，
 * 基本可以断定这一轮不会自己结束（要么额度真不够，要么题面条件冲突导致思考永不收敛）。
 */
export const THINKING_BUDGET_GUARD_RATIO = 0.9;

/** 挂在错误上的标记：思考预算保护不是模型故障，不能据此降级/冷却 */
export const THINKING_GUARD_FLAG = 'thinkingBudgetGuard';

/**
 * 本次调用是否「思考快把额度吃光、正文仍未开始」。
 * cap 必须是 client.outputCap(req) —— 本次真正发出的 max_tokens，而不是模型卡的
 * cfg.maxTokens：降级时请求体沿用主模型的 options，两者不等值时按卡片判会算错阈值。
 * 未设置 max_tokens 时不启用：我们不知道厂商的实际上限，误杀正常回复比省点 token 更糟。
 * @param {number|null} cap 本次实际发出的输出上限
 * @param {string} think 已累计的思考文本
 * @returns {boolean}
 */
export function isThinkingBudgetBlown(cap, think) {
  if (!Number.isFinite(cap) || cap <= 0) return false;
  return estimateTokens(think) >= cap * THINKING_BUDGET_GUARD_RATIO;
}

/**
 * 「思考占满输出额度」的判读与建议，两种触发场景共用（厂商截断 / 我方提前保护）。
 * 必须带上实测数字：光叫用户「调大 max_tokens」是瞎猜——思考字数远小于申请的额度时，
 * 调大数值根本没用（厂商钳了自己的上限，或压根不认这个字段）。
 * @param {Partial<import('./model-config.js').ModelConfig>} [cfg] 本次使用的模型卡（给对的建议）
 * @param {string} think 已累计的思考文本
 * @param {number|null} [cap] 本次实际发出的输出上限（见 isThinkingBudgetBlown）
 * @returns {{nums:string, verdict:string}}
 */
function describeThinkingBudget(cfg = {}, think = '', cap = null) {
  const est = estimateTokens(think);
  const nums = `本次思考约 ${think.length} 字 / 估算 ${est} token，请求 max_tokens=${cap != null ? cap : '未设置（走厂商默认）'}`;
  const inert = thinkingIsInert(cfg);
  let verdict;
  if (cap == null) {
    verdict = '没设输出额度，撞的是厂商自己的上限——请在模型卡填「最大输出 tokens」';
  } else if (est >= cap * 0.8) {
    verdict = '思考确实把额度吃满了：' + (inert
      ? '该模型思考强度不可调（选「低/中/高」也不会发送任何参数），只能调大额度或换思考可控的模型'
      : '请调大「最大输出 tokens」，或把思考强度调低一档');
  } else {
    verdict = `思考字数远不到申请的 ${cap}：厂商多半没按这个值截（被它自己的上限钳住，或不认 max_tokens），继续调大数值不会有用`;
  }
  return { nums, verdict };
}

/**
 * 构造「正文为空」的精准错误：
 * - 有思考产出且厂商标记 length/max_tokens → 输出额度被思考占满（截断），给带数字的判读；
 * - 有思考产出但无截断标记 → 流在思考阶段被中断；
 * - 两者皆无 → 保持原有的「空响应」措辞。
 * @param {string} think 已累计的思考文本
 * @param {string} finishReason 厂商结束原因
 * @param {import('./model-config.js').ModelConfig} [cfg] 本次使用的模型卡（用于给对的建议）
 * @param {number|null} [cap] 本次实际发出的输出上限
 * @returns {Error}
 */
function emptyResponseError(think, finishReason, cfg, cap) {
  if (think) {
    if (isTruncatedFinish(finishReason)) {
      const { nums, verdict } = describeThinkingBudget(cfg, think, cap);
      return new Error(`正文被 max_tokens 截断（${nums}）——${verdict}。`
        + '另外：题面条件互相冲突时思考永远不会收尾，先用一句简单问题验证额度链路是否正常');
    }
    return new Error('模型只返回了思考、没有正文（流在思考阶段被中断），请重试或检查网关');
  }
  return new Error('模型返回空响应');
}

/** 思考预算保护的错误：正文未出现前思考已逼近申请额度，我方主动中止（不是厂商回的 length） */
function thinkingBudgetError(cfg, think, cap) {
  const { nums, verdict } = describeThinkingBudget(cfg, think, cap);
  const e = new Error(`思考还没收尾就已逼近输出上限（${nums}，正文仍为空），已主动停止以免白烧额度——${verdict}。`
    + '若换成简单问题就正常，说明是题目条件本身冲突让思考无法结束');
  e[THINKING_GUARD_FLAG] = true;
  return e;
}

/**
 * 失败记录表（模块级：跨 FallbackManager 实例共享）。
 * 调用方（chat/summarize/selection 等）每次调用都 new 一个 FallbackManager，
 * 若把失败记录挂在实例上，冷却机制永远不生效。挂到模块级后在 SW 存活期内
 * 跨调用生效；SW 休眠重启后重置——MV3 下这是可接受的粒度。
 * 注：MV3 service worker 为单线程，FAIL_LOG 的读写操作均为同步（set/get/delete），
 * 在当前代码结构下不会产生真正的竞态条件。
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
        const cap = client.outputCap(req);
        let text = '';
        let think = '';
        let finishReason = '';
        for await (const chunk of client.chat(req)) {
          text += chunk.delta || '';
          think += chunk.thinking || '';
          if (chunk.finishReason) finishReason = chunk.finishReason;
        }
        if (!text.trim()) {
          // 空响应（弱模型偶发）不应当作成功，记录失败并走降级路径
          this._recordFailure(cfg.id, 'empty response');
          throw emptyResponseError(think, finishReason, cfg, cap);
        }
        if (i > 0) this.onFallback(i, cfg, '自动降级');
        recordCall({ model: cfg.name, vendor: cfg.vendor, kind: req && req.kind, ok: true,
          messages: req && req.messages, completion: text, thinking: think, durationMs: Date.now() - t0 });
        return { text, used: cfg, tried: i + 1 };
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
   * @yields {{delta:string, thinking?:string, done?:boolean, meta?:object, model:string, index:number}}
   */
  async *callStream(candidates, req) {
    const usable = candidates.filter(c => !this._inCooldown(c.id));
    const pool = usable.length ? usable : candidates;

    let lastErr;
    for (let i = 0; i < pool.length; i++) {
      const cfg = pool[i];
      // produced 只统计正文：仅吐出思考文本就失败的调用仍允许降级
      //（思考区由 UI 折叠展示，降级后接续展示下一个模型的思考，可接受）
      let produced = false;
      let text = '';
      let think = '';
      let finishReason = '';
      const t0 = Date.now();
      try {
        const client = createClient(cfg);
        const cap = client.outputCap(req);
        for await (const chunk of client.chat(req)) {
          if (chunk.delta) { produced = true; text += chunk.delta; }
          think += chunk.thinking || '';
          if (chunk.finishReason) finishReason = chunk.finishReason;
          yield { ...chunk, model: cfg.name, index: i };
          // 思考预算保护：正文一个字没出、思考却已逼近申请的额度 → 主动断开流。
          // 等厂商撞满 max_tokens 才回 length，代价是多烧完剩下的额度再白等几十秒。
          if (!produced && isThinkingBudgetBlown(cap, think)) throw thinkingBudgetError(cfg, think, cap);
        }
        // 流式同样要查空响应：流「正常结束」但零产出（弱模型偶发/错误帧被吞）不应当作成功。
        // 尚未产出内容时可安全降级；已产出则保持原状视为成功（半成品不能重放）。
        if (!text.trim() && !produced) {
          this._recordFailure(cfg.id, 'empty response');
          throw emptyResponseError(think, finishReason, cfg, cap);
        }
        if (i > 0) this.onFallback(i, cfg, '自动降级');
        recordCall({ model: cfg.name, vendor: cfg.vendor, kind: req && req.kind, ok: true,
          messages: req && req.messages, completion: text, thinking: think, durationMs: Date.now() - t0 });
        return;
      } catch (e) {
        // 用户主动中止：不属于模型故障，不记冷却、不降级、不记用量，直接上抛
        if (req && req.signal && req.signal.aborted) throw e;
        // 思考预算保护同样不是模型故障：备用模型面对同一个问题会一样想不完，
        // 降级只会把第二份额度也烧掉，所以既不记冷却也不换模型。
        if (e && e[THINKING_GUARD_FLAG]) throw e;
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
