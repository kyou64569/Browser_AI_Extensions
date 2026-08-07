// content/extract.js
// 内容脚本：提取网页正文 + 监听划词 + 执行网页自动化工具。
// 通过 chrome.runtime.sendMessage 与 background 通信，不直接持有密钥。
//
// 关键说明：网页自动化工具（click/type/get_text…）在本内容脚本内直接执行，
// 因为内容脚本对宿主页面拥有完整 DOM 权限（manifest 的 content_scripts.matches
// 为 <all_urls> 且常驻注入），不依赖 activeTab 是否被用户交互激活。
// DOM 工具实现已统一到 shared/dom-tools.js，本文件通过 import 复用，避免重复实现。
// 这能规避在侧边栏 / 未先点击扩展图标的场景下，background 用
// chrome.scripting.executeScript 注入被浏览器以“权限不足”拒绝的问题。

(function () {
  // 扩展更新/重载后会重新注入本脚本；若已存在旧 listener，先移除，
  // 避免旧内容脚本的 EXECUTE_TOOL 响应抢占并返回"未知工具"。
  if (window.__aiAssistantExtractListener) {
    try { chrome.runtime.onMessage.removeListener(window.__aiAssistantExtractListener); } catch (_) {}
  }
  window.__aiAssistantExtractInjected = true;

  let pageTool = null;
  let pageToolLoading = null;

  function ensurePageTool() {
    if (pageTool) return Promise.resolve(pageTool);
    if (!pageToolLoading) {
      pageToolLoading = import(chrome.runtime.getURL('shared/dom-tools.js'))
        .then(mod => { pageTool = mod.pageTool; return pageTool; })
        .catch(err => { pageToolLoading = null; throw err; });
    }
    return pageToolLoading;
  }

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

  // 暴露给 background 调用（把 listener 存到全局，便于扩展重载时先 remove 旧的）
  function extractMessageListener(msg, sender, sendResponse) {
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
      (async () => {
        try {
          const tool = await ensurePageTool();
          const out = await tool(msg.tool, msg.args || {});
          try { sendResponse(out); } catch (_) { /* 消息通道已关闭，忽略 */ }
        } catch (e) {
          try { sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) }); } catch (_) { /* 消息通道已关闭，忽略 */ }
        }
      })();
      return true;
    }
    return false;
  }
  window.__aiAssistantExtractListener = extractMessageListener;
  chrome.runtime.onMessage.addListener(extractMessageListener);

  ensurePageTool();

  const SELECTION_BAR = '__aiSelectionBar';
  const SELECTION_RESULT = '__aiSelectionResult';
  let selectionText = '';
  let selectionHideTimer = null;
  let selectionResultPort = null;

  function getSelectionBar() {
    return document.getElementById(SELECTION_BAR);
  }

  function getSelectionResult() {
    return document.getElementById(SELECTION_RESULT);
  }

  function hideSelectionUI() {
    const bar = getSelectionBar();
    const result = getSelectionResult();
    if (bar) bar.style.display = 'none';
    if (result) result.style.display = 'none';
    if (selectionResultPort) {
      try { selectionResultPort.disconnect(); } catch (_) {}
      selectionResultPort = null;
    }
  }

  function getSelectionRect() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      const span = document.createElement('span');
      span.textContent = '\u200b';
      range.insertNode(span);
      const r = span.getBoundingClientRect();
      span.remove();
      return r;
    }
    return rect;
  }

  function showSelectionBar() {
    if (selectionHideTimer) { clearTimeout(selectionHideTimer); selectionHideTimer = null; }

    const rect = getSelectionRect();
    if (!rect) return;

    let bar = getSelectionBar();
    if (!bar) {
      bar = document.createElement('div');
      bar.id = SELECTION_BAR;
      bar.style.cssText = [
        'position:fixed;z-index:2147483647;',
        'display:flex;align-items:center;gap:2px;',
        'padding:4px 6px;border-radius:8px;',
        'background:rgba(30,30,30,.92);',
        'box-shadow:0 4px 16px rgba(0,0,0,.25);',
        'backdrop-filter:blur(6px);',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
        'font-size:13px;user-select:none;',
      ].join('');
      const actions = [
        { id: 'translate', label: '翻译', icon: '译' },
        { id: 'explain', label: '解释', icon: '释' },
        { id: 'ask', label: '追问', icon: '问' },
      ];
      for (const a of actions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.action = a.id;
        btn.title = a.label;
        btn.style.cssText = [
          'display:flex;align-items:center;justify-content:center;',
          'min-width:28px;height:28px;padding:0 8px;',
          'border:none;border-radius:6px;',
          'background:transparent;color:#fff;',
          'cursor:pointer;font-size:13px;',
          'transition:background .15s;',
        ].join('');
        btn.textContent = `${a.icon} ${a.label}`;
        btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,255,255,.15)'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', () => handleSelectionAction(a.id));
        bar.appendChild(btn);
      }
      document.documentElement.appendChild(bar);
    }

    bar.style.display = 'flex';
    const barW = bar.offsetWidth;
    const barH = bar.offsetHeight;
    let x = rect.left;
    let y = rect.top - barH - 6;
    if (y < 4) y = rect.bottom + 6;
    if (x + barW > window.innerWidth - 4) x = window.innerWidth - barW - 4;
    if (x < 4) x = 4;
    bar.style.left = x + 'px';
    bar.style.top = y + 'px';
  }

  function showSelectionResult(content) {
    let result = getSelectionResult();
    if (!result) {
      result = document.createElement('div');
      result.id = SELECTION_RESULT;
      result.style.cssText = [
        'position:fixed;z-index:2147483646;',
        'width:360px;max-width:calc(100vw - 32px);',
        'max-height:240px;overflow-y:auto;',
        'padding:12px 14px;border-radius:10px;',
        'background:rgba(30,30,30,.94);',
        'box-shadow:0 6px 24px rgba(0,0,0,.3);',
        'backdrop-filter:blur(6px);',
        'color:#eee;font-size:14px;line-height:1.6;',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
        'white-space:pre-wrap;word-break:break-word;',
      ].join('');
      const closeBtn = document.createElement('span');
      closeBtn.textContent = '✕';
      closeBtn.style.cssText = 'position:absolute;top:8px;right:10px;cursor:pointer;color:rgba(255,255,255,.5);font-size:12px;';
      closeBtn.addEventListener('click', hideSelectionUI);
      result.style.position = 'fixed';
      result.appendChild(closeBtn);
      document.documentElement.appendChild(result);
    }

    result.style.display = 'block';
    const bar = getSelectionBar();
    let x = 4, y = 4;
    if (bar && bar.style.display !== 'none') {
      const barRect = bar.getBoundingClientRect();
      x = barRect.left;
      y = barRect.bottom + 6;
    }
    if (x + 360 > window.innerWidth - 4) x = window.innerWidth - 360 - 4;
    if (y + 240 > window.innerHeight - 4) y = window.innerHeight - 240 - 4;
    result.style.left = Math.max(4, x) + 'px';
    result.style.top = Math.max(4, y) + 'px';

    const closeBtn = result.querySelector('span');
    result.innerHTML = '';
    if (closeBtn) result.appendChild(closeBtn);
    const contentEl = document.createElement('div');
    contentEl.style.paddingRight = '20px';
    contentEl.textContent = content;
    result.appendChild(contentEl);
  }

  function isContextInvalidated() {
    try { return !chrome.runtime?.id; } catch (_) { return true; }
  }

  function handleSelectionAction(action) {
    hideResultPort();
    if (isContextInvalidated()) {
      showSelectionResult('扩展已更新，请刷新当前页面后重试');
      return;
    }
    let receivedAnyChunk = false;
    showSelectionResult('正在处理...');
    try {
      selectionResultPort = chrome.runtime.connect({ name: 'selection-result' });
      selectionResultPort.onMessage.addListener((msg) => {
        if (msg.type === 'chunk') {
          if (!receivedAnyChunk) {
            receivedAnyChunk = true;
            clearResultContent();
          }
          appendResultText(msg.delta);
        } else if (msg.type === 'done') {
          if (!receivedAnyChunk) showSelectionResult('（无返回结果）');
        } else if (msg.type === 'error') {
          showSelectionResult('错误：' + msg.error);
        }
      });
      selectionResultPort.onDisconnect.addListener(() => {
        if (selectionResultPort && isContextInvalidated()) {
          showSelectionResult('扩展已更新，请刷新当前页面后重试');
          selectionResultPort = null;
        }
      });
      selectionResultPort.postMessage({ type: action, text: selectionText });
    } catch (e) {
      const msg = String(e?.message || e);
      if (/invalidated|context/i.test(msg)) {
        showSelectionResult('扩展已更新，请刷新当前页面后重试');
      } else {
        showSelectionResult('连接失败：' + msg);
      }
    }
  }

  function hideResultPort() {
    if (selectionResultPort) {
      try { selectionResultPort.disconnect(); } catch (_) {}
      selectionResultPort = null;
    }
  }

  function clearResultContent() {
    const result = getSelectionResult();
    if (!result) return;
    const contentEl = result.querySelector('div:last-child');
    if (contentEl) contentEl.textContent = '';
  }

  function appendResultText(delta) {
    const result = getSelectionResult();
    if (!result) return;
    const contentEl = result.querySelector('div:last-child');
    if (contentEl) contentEl.textContent += delta;
  }

  function isSelectionInEditable() {
    const ae = document.activeElement;
    if (!ae || ae === document.body) return false;
    if (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') return true;
    if (ae.isContentEditable || ae.getAttribute('contenteditable') === 'true') return true;
    return false;
  }

  function onSelectionChange() {
    if (selectionHideTimer) clearTimeout(selectionHideTimer);
    if (isSelectionInEditable()) return;
    selectionHideTimer = setTimeout(() => {
      if (isSelectionInEditable()) return;
      const text = window.getSelection().toString().trim();
      if (text.length >= 2) {
        selectionText = text;
        showSelectionBar();
      } else {
        hideSelectionUI();
      }
    }, 250);
  }

  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('mousedown', (e) => {
    if (isSelectionInEditable()) return;
    const bar = getSelectionBar();
    const result = getSelectionResult();
    if (bar && !bar.contains(e.target) && (!result || !result.contains(e.target))) {
      if (!window.getSelection().toString().trim()) {
        hideSelectionUI();
      }
    }
  });
  document.addEventListener('scroll', () => { hideSelectionUI(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideSelectionUI(); });
})();
