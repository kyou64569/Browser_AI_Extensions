// background/web-tools.js
// 网页自动化工具执行层（供 service-worker 的 AUTOMATE 消息调用）。
//
// 设计要点：
// 1) DOM 类工具（click/type/select_option/check/uncheck/scroll/wait_for/get_text/navigate
//    press_key/hover/get_attribute/double_click/right_click/drag_and_drop）
//    通过 chrome.scripting.executeScript 注入 pageTool 在目标页面主世界执行。
// ⚠️ 与 content/extract.js 中的 pageTool 为两份重复实现（内容脚本无法 import 模块），
//    两边 handlers 必须同步修改，新增 DOM 工具请同时改这两个文件。
// 2) 浏览器级工具截图(screenshot)/切换标签(switch_tab) 在 service-worker 内直接调用 chrome.* API。
// 3) 所有工具统一返回 { ok:true, result } 或 { ok:false, error }，便于上层（侧边栏）统一处理。

/** 在目标标签页主世界执行 DOM 类工具。必须自包含（不引用模块外作用域），以便被序列化注入。 */
async function pageTool(tool, args) {
  args = args || {};

  /** 按 selector / xpath / text 解析元素集合 */
  function resolveEl(a) {
    let els = [];
    if (a.xpath) {
      const xr = document.evaluate(a.xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < xr.snapshotLength; i++) els.push(xr.snapshotItem(i));
    } else if (a.selector) {
      els = Array.from(document.querySelectorAll(a.selector));
    } else if (a.text) {
      const q = 'a,button,input,select,textarea,label,[role="button"],[role="checkbox"]';
      const needle = String(a.text).trim().toLowerCase();
      els = Array.from(document.querySelectorAll(q)).filter(e => {
        const t = (e.textContent || '').trim().toLowerCase();
        return t && t.includes(needle);
      });
    }
    return els;
  }

  /** 用原生 setter 设置表单值并派发 input/change（兼容 React/Vue 等受控组件） */
  function setNativeValue(el, value) {
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value; // 兜底
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** 等待元素出现（轮询），超时抛错 */
  function waitFor(a, timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const els = resolveEl(a);
        if (els.length) return resolve(els);
        if (Date.now() - start > timeoutMs) return reject(new Error('等待超时：元素未出现（' + timeoutMs + 'ms）'));
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  /** 把按键名映射为 keyCode（兼容仍读取 keyCode 的旧站） */
  function keyCodeFor(key) {
    const map = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Space: 32, Return: 13 };
    if (key in map) return map[key];
    if (key.length === 1) return key.toUpperCase().charCodeAt(0);
    return 0;
  }

  /** 从参数里挑出定位键（selector/xpath/text），忽略未定义的键 */
  function locate(a) {
    const r = {};
    if (a.selector) r.selector = a.selector;
    if (a.xpath) r.xpath = a.xpath;
    if (a.text) r.text = a.text;
    return r;
  }

  const handlers = {
    click(a) {
      const els = resolveEl(a);
      if (!els.length) throw new Error('未找到可点击元素（selector/xpath/text 无匹配）');
      const el = els[Math.max(0, Math.min(a.index || 0, els.length - 1))];
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.click();
      return { count: els.length, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 80) };
    },
    type(a) {
      if (a.value == null) throw new Error('缺少参数 value');
      const els = resolveEl(a);
      if (!els.length) throw new Error('未找到输入元素（selector/xpath/text 无匹配）');
      const el = els[Math.max(0, Math.min(a.index || 0, els.length - 1))];
      if (a.clear) setNativeValue(el, '');
      const cur = (el.value || '');
      setNativeValue(el, a.append ? cur + a.value : a.value);
      return { count: els.length, value: el.value };
    },
    select_option(a) {
      const els = resolveEl(a);
      if (!els.length) throw new Error('未找到 <select> 元素（selector/xpath/text 无匹配）');
      const el = els[Math.max(0, Math.min(a.index || 0, els.length - 1))];
      if (a.value != null) el.value = a.value;
      else if (a.label) {
        const opt = Array.from(el.options).find(o =>
          o.text.trim() === a.label || o.text.trim().toLowerCase().includes(String(a.label).toLowerCase()));
        if (opt) el.value = opt.value;
      }
      if (!el.value && (a.value != null || a.label)) throw new Error('未能匹配到选项（value/label 不存在）');
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { count: els.length, selected: el.value, selectedText: el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : '' };
    },
    check(a) { return toggleCheck(a, true); },
    uncheck(a) { return toggleCheck(a, false); },
    scroll(a) {
      if (a.selector || a.xpath || a.text) {
        const els = resolveEl(a);
        if (!els.length) throw new Error('未找到可滚动元素（selector/xpath/text 无匹配）');
        const el = els[Math.max(0, Math.min(a.index || 0, els.length - 1))];
        if (a.position === 'top') el.scrollTop = 0;
        else if (a.position === 'bottom') el.scrollTop = el.scrollHeight;
        else el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        if (a.x || a.y) el.scrollBy(a.x || 0, a.y || 0);
        return { scrolledElement: true };
      }
      if (a.position === 'top') window.scrollTo(0, 0);
      else if (a.position === 'bottom') window.scrollTo(0, document.body.scrollHeight);
      else window.scrollBy(a.x || 0, a.y || 0);
      return { scrollX: window.scrollX, scrollY: window.scrollY };
    },
    wait_for(a) {
      const timeout = Math.min(Math.max(Number(a.timeout) || 10000, 0), 30000);
      return waitFor(a, timeout).then(els => ({ found: true, count: els.length }));
    },
    get_text(a) {
      if (a.selector || a.xpath || a.text) {
        const els = resolveEl(a);
        if (!els.length) throw new Error('未找到匹配元素（selector/xpath/text 无匹配）');
        const texts = els.map(e => (e.innerText || e.textContent || '').trim());
        return { count: els.length, text: texts.join('\n---\n') };
      }
      const root = document.querySelector('article') || document.querySelector('main') || document.body;
      const clone = root.cloneNode(true);
      clone.querySelectorAll('script,style,noscript,nav,header,footer,aside').forEach(e => e.remove());
      return { count: 1, text: (clone.innerText || clone.textContent || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() };
    },
    navigate(a) {
      const dir = a.direction || 'back';
      if (dir === 'back') history.back();
      else if (dir === 'forward') history.forward();
      else if (dir === 'reload') location.reload();
      else history.back();
      return { direction: dir };
    },
    press_key(a) {
      let el = document.activeElement;
      if (a.selector || a.xpath || a.text) {
        const els = resolveEl(a);
        if (els.length) el = els[Math.max(0, Math.min(a.index || 0, els.length - 1))];
      }
      if (!el || el === document.documentElement) el = document.body;
      const key = a.key || 'Enter';
      const mods = { ctrlKey: !!a.ctrl, altKey: !!a.alt, shiftKey: !!a.shift, metaKey: !!a.meta };
      const code = ({ Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Space: 'Space', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight' })[key]
        || (/^[a-z]$/i.test(key) ? 'Key' + key.toUpperCase() : key);
      const kc = keyCodeFor(key);
      const fire = (type) => {
        const ev = new KeyboardEvent(type, {
          key, code, keyCode: kc, charCode: type === 'keypress' ? kc : 0, which: kc,
          bubbles: true, cancelable: true, view: window,
          ctrlKey: mods.ctrlKey, altKey: mods.altKey, shiftKey: mods.shiftKey, metaKey: mods.metaKey,
        });
        // KeyboardEventInit 不含 keyCode/which，手动覆盖以兼容旧站
        try { Object.defineProperty(ev, 'keyCode', { get: () => kc }); Object.defineProperty(ev, 'which', { get: () => kc }); } catch (_) {}
        el.dispatchEvent(ev);
      };
      try { el.focus(); } catch (_) {}
      fire('keydown'); fire('keypress'); fire('keyup');
      return { key, code, modifiers: mods, target: el.tagName || 'body' };
    },
    hover(a) {
      const els = resolveEl(a);
      if (!els.length) throw new Error('未找到可悬停元素（selector/xpath/text 无匹配）');
      const el = els[Math.max(0, Math.min(a.index || 0, els.length - 1))];
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
      for (const t of ['mouseover', 'mouseenter', 'mousemove', 'pointerover', 'pointerenter', 'pointermove']) {
        el.dispatchEvent(new MouseEvent(t, opts));
      }
      return { hovered: true, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 80) };
    },
    get_attribute(a) {
      const els = resolveEl(a);
      if (!els.length) throw new Error('未找到目标元素（selector/xpath/text 无匹配）');
      const el = els[Math.max(0, Math.min(a.index || 0, els.length - 1))];
      const attr = a.attr;
      if (attr) {
        if (attr === 'value') return { attr, value: (el.value !== undefined ? el.value : (el.getAttribute('value') || '')) };
        if (attr === 'text') return { attr, value: (el.innerText || el.textContent || '').trim() };
        if (attr === 'html') return { attr, value: el.innerHTML };
        return { attr, value: el.getAttribute(attr) };
      }
      const out = { tag: el.tagName, value: el.value, text: (el.innerText || el.textContent || '').trim().slice(0, 200) };
      for (const n of ['href', 'src', 'title', 'alt', 'id', 'name', 'type', 'placeholder']) {
        if (el.hasAttribute(n)) out[n] = el.getAttribute(n);
      }
      for (const at of el.attributes) {
        if (at.name.startsWith('data-') && !(at.name in out)) out[at.name] = at.value;
      }
      return { attrs: out };
    },
    double_click(a) {
      const els = resolveEl(a);
      if (!els.length) throw new Error('未找到目标元素（selector/xpath/text 无匹配）');
      const el = els[Math.max(0, Math.min(a.index || 0, els.length - 1))];
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      return { count: els.length, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 80) };
    },
    right_click(a) {
      const els = resolveEl(a);
      if (!els.length) throw new Error('未找到目标元素（selector/xpath/text 无匹配）');
      const el = els[Math.max(0, Math.min(a.index || 0, els.length - 1))];
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, view: window, button: 2,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      }));
      return { tag: el.tagName, text: (el.textContent || '').trim().slice(0, 80) };
    },
    drag_and_drop(a) {
      const srcs = resolveEl(locate({ selector: a.source_selector, xpath: a.source_xpath, text: a.source_text }));
      const tgts = resolveEl(locate({ selector: a.target_selector, xpath: a.target_xpath, text: a.target_text }));
      if (!srcs.length) throw new Error('未找到拖拽源（source_selector/xpath/text 无匹配）');
      if (!tgts.length) throw new Error('未找到拖拽目标（target_selector/xpath/text 无匹配）');
      const src = srcs[0], tgt = tgts[0];
      const s = src.getBoundingClientRect(), t = tgt.getBoundingClientRect();
      const sx = s.left + s.width / 2, sy = s.top + s.height / 2, tx = t.left + t.width / 2, ty = t.top + t.height / 2;
      const dt = (typeof DataTransfer !== 'undefined') ? new DataTransfer() : null;
      const dnd = (el, type) => { try { el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, view: window, dataTransfer: dt, clientX: tx, clientY: ty })); } catch (_) {} };
      const mse = (el, type, x, y) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }));
      dnd(src, 'dragstart');
      dnd(tgt, 'dragenter'); dnd(tgt, 'dragover'); dnd(tgt, 'drop'); dnd(src, 'dragend');
      mse(src, 'mousedown', sx, sy);
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: (sx + tx) / 2, clientY: (sy + ty) / 2, view: window }));
      mse(tgt, 'mousemove', tx, ty); mse(tgt, 'mouseup', tx, ty);
      return { dragged: true, from: src.tagName, to: tgt.tagName };
    },
  };

  function toggleCheck(a, desired) {
    const els = resolveEl(a);
    if (!els.length) throw new Error('未找到复选框（selector/xpath/text 无匹配）');
    const el = els[Math.max(0, Math.min(a.index || 0, els.length - 1))];
    const isInput = el.tagName === 'INPUT';
    const aria = el.getAttribute('role') === 'checkbox' || el.hasAttribute('aria-checked');
    if (isInput) {
      if (el.checked !== desired) el.click();
      return { count: els.length, checked: el.checked };
    }
    if (aria) {
      const cur = el.getAttribute('aria-checked') === 'true';
      if (cur !== desired) el.click();
      if (el.getAttribute('aria-checked') !== String(desired)) el.setAttribute('aria-checked', String(desired));
      return { count: els.length, checked: el.getAttribute('aria-checked') === 'true' };
    }
    throw new Error('目标元素不是复选框（input[type=checkbox] 或 role=checkbox）');
  }

  const h = handlers[tool];
  if (!h) return { ok: false, error: '未知工具：' + tool };
  try {
    const data = await h(args);
    return { ok: true, result: data };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
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
  if (a.tabId) target = tabs.find(t => t.id === a.tabId);
  else if (typeof a.index === 'number') target = tabs[a.index];
  else if (a.title) target = tabs.find(t => (t.title || '').includes(a.title) || (t.url || '').includes(a.title));
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
    target = tabs.find(t => t.id === a.tabId);
  } else if (typeof a.index === 'number') {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    target = tabs[a.index];
  } else if (a.title) {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    target = tabs.find(t => (t.title || '').includes(a.title) || (t.url || '').includes(a.title));
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

const DOM_TOOLS = ['click', 'type', 'select_option', 'check', 'uncheck', 'scroll', 'wait_for', 'get_text', 'navigate', 'press_key', 'hover', 'get_attribute', 'double_click', 'right_click', 'drag_and_drop'];

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
