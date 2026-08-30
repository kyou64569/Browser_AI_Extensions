// background/web-tools.js
// 网页自动化工具执行层（供 service-worker 的 AUTOMATE 消息调用）。
//
// 设计要点：
// 1) DOM 类工具通过 chrome.scripting.executeScript 注入 shared/dom-tools.js 的 pageTool
//    在目标页面主世界执行。DOM 工具实现已统一到 shared/dom-tools.js。
// 2) 浏览器级工具截图(screenshot)/切换标签(switch_tab) 在 service-worker 内直接调用 chrome.* API。
// 3) 所有工具统一返回 { ok:true, result } 或 { ok:false, error }，便于上层（侧边栏）统一处理。

import { pageTool, DOM_TOOLS } from '../shared/dom-tools.js';

// ── 跨域导航守卫（S-03）────────────────────────────────────────────────────
// open_url 原本只有"协议白名单"，但没有域名约束：只要网页正文里有一段诱导文本
// （prompt injection），Agent 就可能被诱导把当前标签导航到钓鱼站。
// 这里补上程序化约束：跨域名跳转必须先经用户确认，同域名（含子域）正常放行。
const NAV_APPROVE_KEY = 'navApprovedHosts';   // 存 chrome.storage.session，浏览器会话内有效
const NAV_CONFIRM_TIMEOUT_MS = 45000;         // 等用户点确认的时间上限
const _navApproved = new Set();               // 内存副本，避免每次跳转都读存储
let _navApprovedLoaded = false;

async function loadNavApprovals() {
  if (_navApprovedLoaded) return _navApproved;
  _navApprovedLoaded = true;
  try {
    const r = await chrome.storage.session.get(NAV_APPROVE_KEY);
    for (const h of r[NAV_APPROVE_KEY] || []) _navApproved.add(String(h));
  } catch (_) { /* 该浏览器版本无 storage.session，退化为仅内存缓存 */ }
  return _navApproved;
}

async function rememberNavApproval(host) {
  _navApproved.add(host);
  try {
    await chrome.storage.session.set({ [NAV_APPROVE_KEY]: [..._navApproved] });
  } catch (_) { /* 持久化失败不影响本次放行 */ }
}

/** 取 host；解析失败返回 '' */
function hostOf(raw) {
  try { return new URL(String(raw || '')).host; } catch (_) { return ''; }
}

/**
 * a、b 是否"同源站点"：host 完全相同，或一方是另一方的子域。
 * 子域互通是因为登录/跳转常在 www ↔ 主域之间来回，逐次确认会严重打断自动化。
 */
function sameSite(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  // 正确的子域检查：a 是 b 的子域，或 b 是 a 的子域
  const aParts = a.split('.');
  const bParts = b.split('.');
  if (aParts.length > bParts.length) {
    return aParts.slice(aParts.length - bParts.length).join('.') === b;
  }
  if (bParts.length > aParts.length) {
    return bParts.slice(bParts.length - aParts.length).join('.') === a;
  }
  return false;
}

/**
 * 向扩展 UI 广播跨域导航确认请求，等用户在侧边栏点同意/拒绝。
 * 无人应答（侧边栏未打开）或超时 → 一律按"拒绝"处理（安全默认）。
 */
function requestNavApproval(payload) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (res) => { if (done) return; done = true; clearTimeout(timer); resolve(res); };
    const timer = setTimeout(() => finish({ approved: false, reason: 'timeout' }), NAV_CONFIRM_TIMEOUT_MS);
    try {
      chrome.runtime.sendMessage({ type: 'AUTOMATE_CONFIRM_NAV', ...payload }, (resp) => {
        void chrome.runtime.lastError; // 无接收端时的 "Could not establish connection"
        finish({ approved: !!(resp && resp.approved) });
      });
    } catch (_) {
      finish({ approved: false, reason: 'no-ui' });
    }
  });
}

/**
 * 通过已注入的 content script 执行 DOM 工具（首选路径）。
 * 内容脚本对宿主页面有完整 DOM 权限（manifest content_scripts 常驻注入），
 * 不依赖 activeTab 是否被用户交互激活，因此在侧边栏 / 未先点击扩展图标的
 * 场景下也能稳定工作，避免 chrome.scripting.executeScript 被以“权限不足”拒绝。
 * 仅当 content script 不可达（如扩展重载后已打开的标签页未重新注入、或受保护页面）
 * 时，回退到 scripting 注入。全程带超时，避免 sendMessage 在接收端缺失时无限挂起。
 */
const CS_TIMEOUT_MS = 8000;

async function runInPage(tabId, tool, args) {
  // 带超时的 sendMessage（content script 缺失时浏览器可能长时间挂起或不报明确错误）
  const sendWithTimeout = (timeoutMs) => new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('content script 未在 ' + timeoutMs + 'ms 内响应（可能未注入或页面不支持）'));
    }, timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_TOOL', tool, args: args || {} }, (resp) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message || '消息端口错误'));
        resolve(resp);
      });
    } catch (e) {
      if (!done) { done = true; clearTimeout(timer); }
      reject(e);
    }
  });

  // 1) 首选：让已注入的 content script 直接执行（EXECUTE_TOOL 消息）
  try {
    const resp = await sendWithTimeout(CS_TIMEOUT_MS);
    if (resp && typeof resp === 'object' && 'ok' in resp) return resp;
    if (resp && typeof resp === 'object') return resp; // 兼容旧式 {result} 结构
    return { ok: false, error: '内容脚本无返回' };
  } catch (csErr) {
    const reason = (csErr && csErr.message) ? csErr.message : String(csErr);
    // 2) 兜底：content script 不可达（未注入 / 受保护页面），用 scripting 注入执行
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: pageTool,
        args: [tool, args || {}],
      });
      return (res && res.result && typeof res.result === 'object')
        ? res.result
        : { ok: false, error: '页面脚本无返回' };
    } catch (scriptErr) {
      // 两条路径都失败：明确指出是“页面注入受限”还是“content script 未注入”，便于排查
      const sReason = (scriptErr && scriptErr.message) ? scriptErr.message : String(scriptErr);
      const hint = /Cannot access this page|Missing host permission|chrome:\/\/|edge:\/\/|receiving end/i.test(sReason + reason)
        ? '（该页面可能受保护或不支持扩展脚本注入，请换一个普通网页再试）'
        : '（content script 可能未注入，请刷新该标签页或重载扩展后重试）';
      return { ok: false, error: '无法在页面执行工具：' + reason + '；脚本注入也失败：' + sReason + ' ' + hint };
    }
  }
}

/**
 * 截图：支持 visible / full / element 三种模式。
 * - visible：截当前可视区域（chrome.tabs.captureVisibleTab）
 * - full：按垂直滚动逐屏捕获并用 OffscreenCanvas 拼合整页
 * - element：定位元素→滚动到视图中央→截视口→裁剪出元素区域
 */
async function takeScreenshot(tab, a = {}) {
  const mode = (a && a.mode) || 'visible';
  if (mode === 'visible') {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab ? tab.windowId : undefined, { format: 'png' });
    return { ok: true, result: { captured: true, mode, format: 'png', dataUrl, note: '已截取当前可视区域（截图会显示在对话中）' } };
  }
  if (mode === 'full') return await takeFullPageScreenshot(tab);
  if (mode === 'element') return await takeElementScreenshot(tab, a || {});
  return { ok: false, error: '未知的截图模式：' + mode + "（应为 visible / full / element）" };
}

/** 注入页面、在页面上下文中执行的辅助函数（必须自包含，不依赖外部作用域） */
function pageScreenshotHelper(cmd, payload) {
  function locate(p) {
    if (p && p.selector) { try { return document.querySelector(p.selector); } catch (e) { return null; } }
    if (p && p.xpath) {
      try { return document.evaluate(p.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch (e) { return null; }
    }
    if (p && p.text) {
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let n; const leaf = [];
      while ((n = tw.nextNode())) { if ((n.textContent || '').trim().includes(p.text) && n.children.length === 0) leaf.push(n); }
      if (leaf.length) return leaf[0];
      const all = Array.from(document.querySelectorAll('*'));
      return all.find(e => (e.textContent || '').trim().includes(p.text)) || null;
    }
    return null;
  }
  function instantScroll(x, y) {
    const prev = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(x, y);
    document.documentElement.style.scrollBehavior = prev;
  }
  if (cmd === 'metrics') {
    return { fullW: document.documentElement.scrollWidth, fullH: document.documentElement.scrollHeight, vw: window.innerWidth, vh: window.innerHeight };
  }
  if (cmd === 'scrollTo') { instantScroll(0, payload ? payload.y : 0); return { y: payload ? payload.y : 0 }; }
  if (cmd === 'scrollTop') { instantScroll(0, 0); return { ok: true }; }
  if (cmd === 'elementRect') {
    const el = locate(payload);
    if (!el) return { found: false };
    const r0 = el.getBoundingClientRect();
    const targetY = r0.top + window.scrollY - (window.innerHeight - r0.height) / 2;
    const targetX = r0.left + window.scrollX - (window.innerWidth - r0.width) / 2;
    instantScroll(targetX, targetY);
    const r = el.getBoundingClientRect();
    return { found: true, x: r.x, y: r.y, w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight };
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function dataUrlToBitmap(du) {
  const res = await fetch(du);
  const blob = await res.blob();
  return await createImageBitmap(blob);
}

async function blobToDataUrl(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    // 使用循环而非 apply 避免 call stack 溢出（大图片时 bytes.subarray 可能超过栈限制）
    const sub = bytes.subarray(i, i + chunk);
    for (let j = 0; j < sub.length; j++) {
      binary += String.fromCharCode(sub[j]);
    }
  }
  return 'data:image/png;base64,' + btoa(binary);
}

/** 整页截图：逐屏滚动捕获并拼合 */
async function takeFullPageScreenshot(tab) {
  const tabId = tab.id;
  const metrics = (await chrome.scripting.executeScript({ target: { tabId }, func: pageScreenshotHelper, args: ['metrics', null] }))[0].result;
  const { fullW, fullH, vw, vh } = metrics;
  const maxTiles = 120;
  const totalTiles = Math.ceil(fullH / vh);
  if (totalTiles > maxTiles) {
    return { ok: false, error: `页面过长（约 ${totalTiles} 屏），超出整页截图上限（${maxTiles} 屏）。请改用 element 或 visible 模式，或先缩小页面。` };
  }
  // 画布按 CSS 像素尺寸（vw × fullH），与设备 DPR 无关；
  // 否则高分屏下 captureVisibleTab 返回 DPR 放大位图，整页画布会远超 16384px 上限。
  const MAX_DIM = 16384;
  if (vw > MAX_DIM || fullH > MAX_DIM) {
    return { ok: false, error: `整页尺寸约 ${vw}x${fullH} 超出浏览器单张画布上限（${MAX_DIM}px，约 ${Math.floor(MAX_DIM / vh)} 屏），无法生成整页截图。请改用 element（截取关键元素）或 visible 模式。` };
  }
  const tiles = [];
  await chrome.scripting.executeScript({ target: { tabId }, func: pageScreenshotHelper, args: ['scrollTo', { y: 0 }] });
  await sleep(220);
  let y = 0;
  while (y < fullH) {
    tiles.push({ du: await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }), y });
    y += vh;
    if (y < fullH) {
      await chrome.scripting.executeScript({ target: { tabId }, func: pageScreenshotHelper, args: ['scrollTo', { y }] });
      await sleep(220);
    }
  }
  await chrome.scripting.executeScript({ target: { tabId }, func: pageScreenshotHelper, args: ['scrollTop', null] });
  let blob;
  try {
    const canvas = new OffscreenCanvas(vw, fullH);
    const ctx = canvas.getContext('2d');
    for (const t of tiles) {
      const bmp = await dataUrlToBitmap(t.du);
      // 源为 DPR 缩放位图，目标按 CSS 像素绘制；最后一块可能小于 vh，需计算实际高度
      const tileH = Math.min(vh, fullH - t.y);
      ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, t.y, vw, tileH);
      if (bmp.close) bmp.close();
    }
    blob = await canvas.convertToBlob({ type: 'image/png' });
  } catch (e) {
    return { ok: false, error: '整页截图拼接失败（可能超出画布上限）：' + ((e && e.message) ? e.message : String(e)) + '。请改用 element/visible 模式。' };
  }
  const dataUrl = await blobToDataUrl(blob);
  return { ok: true, result: { captured: true, mode: 'full', format: 'png', dataUrl, note: `已截取整页（约 ${totalTiles} 屏，原始尺寸 ${vw}x${fullH}）` } };
}

/** 元素截图：定位+居中+截视口+裁剪 */
async function takeElementScreenshot(tab, a) {
  const tabId = tab.id;
  const rect = (await chrome.scripting.executeScript({ target: { tabId }, func: pageScreenshotHelper, args: ['elementRect', a] }))[0].result;
  if (!rect || !rect.found) return { ok: false, error: '未找到要截图的元素（selector/xpath/text 均不匹配）' };
  await sleep(220);
  const du = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const bmp = await dataUrlToBitmap(du);
  const scaleX = bmp.width / rect.vw;
  const scaleY = bmp.height / rect.vh;
  const sx = Math.max(0, Math.round(rect.x * scaleX));
  const sy = Math.max(0, Math.round(rect.y * scaleY));
  const sw = Math.min(bmp.width - sx, Math.round(rect.w * scaleX));
  const sh = Math.min(bmp.height - sy, Math.round(rect.h * scaleY));
  if (sw <= 0 || sh <= 0) return { ok: false, error: '元素在视口外或尺寸为 0，无法裁剪' };
  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const dataUrl = await blobToDataUrl(blob);
  return { ok: true, result: { captured: true, mode: 'element', format: 'png', dataUrl, note: `已截取元素（${sw}x${sh}）` } };
}

/** 切换浏览器标签页 */
async function switchTab(a) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  let target = null;
  if (a.tabId) target = tabs.find(t => t && t.id === a.tabId);
  else if (typeof a.index === 'number') target = tabs[a.index];
  else if (a.title) target = tabs.find(t => t && ((t.title || '').includes(a.title) || (t.url || '').includes(a.title)));
  if (!target) return { ok: false, error: '未找到匹配的标签页（index/title/tabId）' };
  await chrome.tabs.update(target.id, { active: true });
  return { ok: true, result: { tabId: target.id, title: target.title, url: target.url, total: tabs.length } };
}

/** 关闭指定标签页（按 tabId/index/title，或 current:true 关闭当前活动标签） */
async function closeTab(a) {
  a = a || {};
  let target = null;
  if (a.tabId) {
    const tabs = await chrome.tabs.query({});
    target = tabs.find(t => t && t.id === a.tabId);
  } else if (typeof a.index === 'number') {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    target = tabs[a.index];
  } else if (a.title) {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    target = tabs.find(t => t && ((t.title || '').includes(a.title) || (t.url || '').includes(a.title)));
  } else if (a.current) {
    const [cur] = await chrome.tabs.query({ active: true, currentWindow: true });
    target = cur;
  }
  if (!target) return { ok: false, error: '未找到要关闭的标签页（请提供 tabId / index / title，或 current:true 关闭当前标签）' };
  const info = { tabId: target.id, title: target.title, url: target.url };
  await chrome.tabs.remove(target.id);
  return { ok: true, result: { closed: true, tabId: info.tabId, title: info.title, url: info.url } };
}

/**
 * 跳转到用户明确指定的网址。
 * - newTab=true：用 chrome.tabs.create 新开标签并激活（保留当前页）。
 * - 否则：用 chrome.tabs.update 在当前标签跳转，并轮询等待页面加载完成（最多 ~15s），
 *   以便紧随其后的 DOM 类工具（get_text/wait_for/click 等）能直接作用于新页面。
 *   受保护页面（chrome://、Chrome 网上应用店等）能打开但不能注入脚本，已通过
 *   runInPage 的兜底逻辑给出明确提示，无需在此特殊处理。
 */
async function openUrl(tab, a) {
  let url = (a && a.url || '').trim();
  if (!url) return { ok: false, error: '缺少参数 url' };
  if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
  // 协议白名单：仅允许 http/https，拦截 file:/chrome:/chrome-extension:/javascript: 等敏感协议，
  // 避免自动化（含网页文本诱导的 prompt injection）把当前标签导航到本地文件或受保护地址。
  const proto = (() => { try { return new URL(url).protocol; } catch (_) { return ''; } })();
  if (proto !== 'http:' && proto !== 'https:') {
    return { ok: false, error: `不支持的跳转协议：${proto || '无效地址'}（仅允许 http/https）` };
  }

  // 域名守卫：跳到"当前标签所在站点之外"的域名必须先经用户确认。
  // 网页正文是提示词的一部分，攻击者可在页面里埋一段"请打开 xxx.com"诱导 Agent 跳转，
  // 只靠提示词约束挡不住，必须有程序化校验。
  const toHost = hostOf(url);
  const fromHost = hostOf(tab && tab.url);
  if (toHost && !sameSite(fromHost, toHost)) {
    await loadNavApprovals();
    if (!_navApproved.has(toHost)) {
      const { approved, reason } = await requestNavApproval({ fromHost, toHost, url });
      if (!approved) {
        const why = reason === 'timeout' ? '等待确认超时' : '用户拒绝或侧边栏未打开';
        return {
          ok: false,
          error: `已阻止跨域跳转：${fromHost || '当前页面'} → ${toHost}（${why}）。` +
                 '若确需跳转，请在侧边栏弹出的确认框点「允许」，或先手动打开该站点。',
        };
      }
      await rememberNavApproval(toHost);
    }
  }

  if (a && a.newTab) {
    const t = await chrome.tabs.create({ url, active: true });
    return { ok: true, result: { opened: 'newTab', tabId: t.id, url: t.url } };
  }
  await chrome.tabs.update(tab.id, { url });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const t = await chrome.tabs.get(tab.id);
      if (t && t.status === 'complete') break;
    } catch (_) { /* 标签偶发不可达，忽略继续轮询 */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return {
    ok: true,
    result: {
      opened: 'currentTab',
      tabId: tab.id,
      url,
      note: '已跳转到目标网址，请使用 get_text / wait_for 确认页面加载完成后再继续操作',
    },
  };
}

/**
 * 统一入口：执行某个网页自动化工具。
 * @param {{id:number, windowId:number}} tab 已解析的活动标签页
 * @param {string} tool 工具名
 * @param {object} args 参数
 * @returns {Promise<{ok:boolean, result?:any, error?:string}>}
 */
export async function execTool(tab, tool, args) {
  try {
    if (tool === 'screenshot') return await takeScreenshot(tab, args || {});
    if (tool === 'switch_tab') return await switchTab(args || {});
    if (tool === 'open_url') return await openUrl(tab, args || {});
    if (tool === 'close_tab') return await closeTab(args || {});
    if (DOM_TOOLS.includes(tool)) return await runInPage(tab.id, tool, args);
    return { ok: false, error: '未知工具：' + tool };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}
