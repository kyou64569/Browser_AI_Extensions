// shared/dom-tools.js
// 共享的 DOM 工具执行函数，供 background/web-tools.js 和 content/extract.js 共用。
//
// 设计说明：
// - background 通过 import 引入本模块（ES module）。
// - content/extract.js 通过动态 import() 引入本模块（content script 作为 ES module 加载）。
// - 该函数必须在页面主世界执行（通过 chrome.scripting.executeScript 注入或由已注入的 content script 调用）。
//
// SYNC_MARKER:v1-DOM_TOOLS:click,type,select_option,check,uncheck,scroll,wait_for,get_text,navigate,press_key,hover,get_attribute,double_click,right_click,drag_and_drop

/**
 * 在页面主世界执行 DOM 类工具。必须自包含（不引用外部作用域），以便被序列化注入。
 * @param {string} tool 工具名
 * @param {object} args 参数
 * @returns {Promise<{ok:boolean, result?:any, error?:string}>}
 */
export async function pageTool(tool, args) {
  args = args || {};

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
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

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

  function keyCodeFor(key) {
    const map = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Space: 32, Return: 13 };
    if (key in map) return map[key];
    if (key.length === 1) return key.toUpperCase().charCodeAt(0);
    return 0;
  }

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
      const clone = /** @type {HTMLElement} */ (root.cloneNode(true));
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
        try { Object.defineProperty(ev, 'keyCode', { get: () => kc }); Object.defineProperty(ev, 'which', { get: () => kc }); } catch (_) {}
        el.dispatchEvent(ev);
      };
      try { /** @type {HTMLElement} */ (el).focus(); } catch (_) {}
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

export const DOM_TOOLS = ['click', 'type', 'select_option', 'check', 'uncheck', 'scroll', 'wait_for', 'get_text', 'navigate', 'press_key', 'hover', 'get_attribute', 'double_click', 'right_click', 'drag_and_drop'];
