// background/web-tools.js
// 网页自动化工具执行层（供 service-worker 的 AUTOMATE 消息调用）。
//
// 设计要点：
// 1) DOM 类工具（click/type/select_option/check/uncheck/scroll/wait_for/get_text/navigate）
//    通过 chrome.scripting.executeScript 注入 pageTool 在目标页面主世界执行。
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

/** 通过 scripting API 在页面内执行 DOM 工具 */
async function runInPage(tabId, tool, args) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: pageTool,
    args: [tool, args || {}],
  });
  return (res && res.result) ? res.result : { ok: false, error: '页面脚本无返回' };
}

/** 截图当前可视区域 */
async function takeScreenshot(tab) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab ? tab.windowId : undefined, { format: 'png' });
  return { ok: true, result: { captured: true, format: 'png', dataUrl, note: '已截取当前可视区域（截图会显示在对话中）' } };
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

const DOM_TOOLS = ['click', 'type', 'select_option', 'check', 'uncheck', 'scroll', 'wait_for', 'get_text', 'navigate'];

/**
 * 统一入口：执行某个网页自动化工具。
 * @param {{id:number, windowId:number}} tab 已解析的活动标签页
 * @param {string} tool 工具名
 * @param {object} args 参数
 * @returns {Promise<{ok:boolean, result?:any, error?:string}>}
 */
export async function execTool(tab, tool, args) {
  try {
    if (tool === 'screenshot') return await takeScreenshot(tab);
    if (tool === 'switch_tab') return await switchTab(args || {});
    if (DOM_TOOLS.includes(tool)) return await runInPage(tab.id, tool, args);
    return { ok: false, error: '未知工具：' + tool };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}
