// content/extract.js
// 内容脚本：提取网页正文 + 监听划词 + 执行网页自动化工具。
// 通过 chrome.runtime.sendMessage 与 background 通信，不直接持有密钥。
//
// 关键说明：网页自动化工具（click/type/get_text…）在本内容脚本内直接执行，
// 因为内容脚本对宿主页面拥有完整 DOM 权限（manifest 的 content_scripts.matches
// 为 <all_urls> 且常驻注入），不依赖 activeTab 是否被用户交互激活。
// 这能规避在侧边栏 / 未先点击扩展图标的场景下，background 用
// chrome.scripting.executeScript 注入被浏览器以“权限不足”拒绝的问题。

/** 在页面主世界执行 DOM 类工具。必须自包含（不引用外部作用域），以便被本脚本复用。 */
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

(function () {
  /** 简单正文提取：优先 article/main，否则 body 文本 */
  function extractMainText() {
    const root =
      document.querySelector('article') ||
      document.querySelector('main') ||
      document.body;
    const clone = root.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,nav,header,footer,aside').forEach(e => e.remove());
    const text = (clone.innerText || clone.textContent || '')
      .replace(/\s+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text;
  }

  // 暴露给 background 调用
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'EXTRACT_PAGE') {
      try {
        sendResponse({ title: document.title, text: extractMainText(), url: location.href });
      } catch (e) {
        sendResponse({ title: document.title, text: '', url: location.href, error: e.message });
      }
      return true;
    }
    if (msg.type === 'GET_SELECTION') {
      try {
        sendResponse({ text: window.getSelection().toString() });
      } catch (e) {
        sendResponse({ text: '', error: e.message });
      }
      return true;
    }
    if (msg.type === 'EXECUTE_TOOL') {
      // 网页自动化工具在内容脚本内直接执行（对宿主页面有完整 DOM 权限，
      // 不依赖 background 的 scripting.executeScript，规避 activeTab 未激活时的权限拒绝）。
      (async () => {
        try {
          const out = await pageTool(msg.tool, msg.args || {});
          sendResponse(out);
        } catch (e) {
          sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) });
        }
      })();
      return true; // 异步 sendResponse
    }
    return false;
  });

  // TODO: 划词快捷操作浮层（翻译/解释/追问），后续在此挂载 UI，调用 features/selection。
})();
