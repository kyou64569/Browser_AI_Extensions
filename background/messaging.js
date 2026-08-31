// background/messaging.js
// 后台消息处理的两个通用守卫。
//
// 背景：MV3 的 chrome.runtime.onMessage 用 sendResponse 回包时，
// 1) 如果异步分支抛异常或忘记调用，发送端会一直挂到超时，报
//    "The message port closed before a response was received."，且看不到真实原因；
// 2) SW 可能在长任务期间被终止，同样导致回包丢失。
//
// 拆分 service-worker.js 前必须先把这两个模式抽出来——原先它们在 6 个消息分支里
// 逐字重复（settled 标志 + SAFETY_MS 定时器 + try/catch），漏一处就是一次挂死。

/**
 * 包裹一个异步 handler，保证 sendResponse 一定被调用一次：
 * - 正常返回 → 回包 handler 的返回值
 * - 抛异常   → 回包 { ok:false, error }
 * - 超时     → 回包 { ok:false, error }，且不打断 handler 继续执行
 *
 * 另外提供 respond() 供 handler 提前回包（提前回包后超时/异常都不会再回第二次）。
 *
 * @param {(ctx:{respond:(payload:object)=>void}) => Promise<object|void>} fn
 * @param {object} opts
 * @param {(payload:{ok?:boolean, error?:string, [k:string]:any})=>void} opts.sendResponse chrome 的回包函数
 * @param {number} opts.timeoutMs 兜底超时
 * @param {string} opts.label 超时/错误文案前缀，便于定位是哪个消息超时
 * @returns {true} 固定返回 true，供 onMessage 直接 return（表示异步回包）
 */
export function withSafetyTimeout(fn, { sendResponse, timeoutMs, label }) {
  let settled = false;
  const respond = (payload) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { sendResponse(payload); } catch (_) { /* 端口已关闭，无能为力 */ }
  };
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    try { sendResponse({ ok: false, error: `${label}超时（>${Math.round(timeoutMs / 1000)}s）` }); }
    catch (_) {}
  }, timeoutMs);

  Promise.resolve()
    .then(() => fn({ respond }))
    .then((payload) => { if (payload !== undefined) respond(payload); })
    .catch((e) => {
      console.error(`[${label}] 处理失败：`, e);
      respond({ ok: false, error: (e && e.message) ? e.message : `${label}失败` });
    });

  return true;
}

/**
 * 简化版：不需要兜底超时、同步就能算完的消息分支。
 * 只做一层"异常不吞、一定回包"的保护。
 *
 * @param {(payload:object)=>void} sendResponse
 * @param {() => Promise<object>} fn 返回要回包的负载
 * @returns {true}
 */
export function withSafeResponse(sendResponse, fn) {
  let settled = false;
  const respond = (payload) => {
    if (settled) return;
    settled = true;
    try { sendResponse(payload); } catch (_) {}
  };
  Promise.resolve()
    .then(fn)
    .then(respond)
    .catch((e) => respond({ ok: false, error: (e && e.message) ? e.message : '处理失败' }));
  return true;
}
