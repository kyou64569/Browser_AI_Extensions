// content/translate.js
// 网页翻译 —— 无 UI 的页面 Worker（不再注入浮动控件）。
// 通过 chrome.runtime.onMessage 接收侧边栏指令：
//   WEB_TRANSLATE_EXECUTE  → 收集文本 → 调用后台翻译 → 替换页面文本
//   WEB_TRANSLATE_RESTORE  → 还原原文
//   WEB_TRANSLATE_STATUS   → 返回当前状态（是否已翻译、段数等）
//
// 保留自动模式：同站 SPA 跳转后自动重翻（从 storage 读取预存参数）。

(function () {
  if (window.self !== window.top) return;
  if (window.__aiTranslateWorker) return;
  window.__aiTranslateWorker = true;

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA',
    'CODE', 'PRE', 'SVG', 'PATH', 'SYMBOL', 'USE', 'TEMPLATE']);
  let originalSnapshot = null;   // { groups: [{ nodes, originals }] }
  const MAX_CACHE_SIZE = 1000;
  const translationCache = new Map();
  let active = false;
  let mode = 'manual';
  let activeHost = null;
  let curHost = location.hostname;
  let navTimer = null;
  let pendingTranslate = null; // 用于取消进行中的翻译请求

  // ---------- 文本节点收集 ----------
  function collectTextGroups(rootEl) {
    const raw = [];
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const v = node.nodeValue;
        if (!v || !v.trim()) return NodeFilter.FILTER_REJECT;
        let p = node.parentElement;
        while (p) {
          if (SKIP.has(p.tagName) || p.isContentEditable) return NodeFilter.FILTER_REJECT;
          p = p.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) raw.push(n);
    const groups = [];
    let i = 0;
    while (i < raw.length) {
      const nodes = [raw[i]];
      let j = i + 1;
      while (j < raw.length && raw[j].parentNode === raw[i].parentNode) { nodes.push(raw[j]); j++; }
      groups.push({
        nodes,
        text: nodes.map(nd => nd.nodeValue).join(''),
        getOrig: n => n.nodeValue,
        setTrans: (n, t) => { n.nodeValue = t; },
      });
      i = j;
    }
    // 按钮型 input 的 value 属性（每项 single-node 组）
    document.querySelectorAll('input[type="submit"], input[type="button"], input[type="reset"]').forEach(el => {
      const v = (el.value || '').trim();
      if (v) groups.push({ nodes: [el], text: v, getOrig: n => n.value, setTrans: (n, t) => { n.value = t; } });
    });
    // 占位符（input / textarea 的 placeholder 属性）
    document.querySelectorAll('input[placeholder], textarea[placeholder]').forEach(el => {
      const v = (el.placeholder || '').trim();
      if (v) groups.push({ nodes: [el], text: v, getOrig: n => n.placeholder, setTrans: (n, t) => { n.placeholder = t; } });
    });
    // aria-label（按钮 / 链接 / 角色为按钮的元素）
    document.querySelectorAll('button[aria-label], a[aria-label], [role="button"][aria-label], [role="link"][aria-label], [role="tab"][aria-label]').forEach(el => {
      const v = (el.getAttribute('aria-label') || '').trim();
      if (v) groups.push({ nodes: [el], text: v, getOrig: n => n.getAttribute('aria-label'), setTrans: (n, t) => { n.setAttribute('aria-label', t); } });
    });
    return groups;
  }

  function distributeText(nodes, translatedText, setTrans) {
    // 自定义 setter（用于 placeholder、aria-label、input.value 等非文本节点属性）
    if (setTrans) { setTrans(nodes[0], translatedText); return; }
    if (nodes.length === 1) { nodes[0].nodeValue = translatedText; return; }
    const totalLen = nodes.reduce((sum, n) => sum + (n.nodeValue ? n.nodeValue.length : 0), 0);
    if (totalLen === 0) { nodes.forEach(n => { n.nodeValue = ''; }); return; }
    let pos = 0;
    for (let k = 0; k < nodes.length; k++) {
      const ratio = (nodes[k].nodeValue ? nodes[k].nodeValue.length : 0) / totalLen;
      const end = k === nodes.length - 1 ? translatedText.length : Math.round(pos + ratio * translatedText.length);
      nodes[k].nodeValue = translatedText.slice(pos, end);
      pos = end;
    }
  }

  // ---------- 翻译主流程 ----------
  async function doTranslate(modelId, lang) {
    if (!modelId) return { ok: false, error: '未选择翻译模型' };
    const groups = collectTextGroups(document.body);
    if (!groups.length) return { ok: false, error: '未找到可翻译的文本内容' };
    const groupOriginals = groups.map(g => g.nodes.map(n => g.getOrig(n)));

    // 检查缓存
    const uncached = [];
    groups.forEach((g, i) => {
      const cached = translationCache.get(g.text);
      if (cached !== undefined) distributeText(g.nodes, cached, g.setTrans);
      else uncached.push({ idx: i, text: g.text });
    });

    // 缓存大小限制（LRU 淘汰）
    function setCache(key, value) {
      if (translationCache.size >= MAX_CACHE_SIZE) {
        const firstKey = translationCache.keys().next().value;
        translationCache.delete(firstKey);
      }
      translationCache.set(key, value);
    }
    const toTranslate = uncached.map(u => u.text);
    const count = toTranslate.filter(Boolean).length;

    if (count === 0) {
      originalSnapshot = { groups: groups.map((g, i) => ({ nodes: g.nodes, originals: groupOriginals[i], setTrans: g.setTrans })) };
      active = true; activeHost = location.hostname;
      return { ok: true, total: groups.length, cached: groups.length };
    }

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'TRANSLATE_PAGE', modelId, targetLang: lang || '中文（简体）', texts: toTranslate });
    } catch (e) {
      return { ok: false, error: '通信失败：' + (e && e.message ? e.message : e) };
    }
    if (!resp || !resp.ok) return { ok: false, error: (resp && resp.error) || '翻译失败' };
    const tr = resp.translations || [];

    uncached.forEach((u, i) => {
      const trans = (tr[i] != null && tr[i] !== '') ? tr[i] : '';
      if (trans) { setCache(u.text, trans); distributeText(groups[u.idx].nodes, trans, groups[u.idx].setTrans); }
    });

    originalSnapshot = { groups: groups.map((g, i) => ({ nodes: g.nodes, originals: groupOriginals[i], setTrans: g.setTrans })) };
    active = true; activeHost = location.hostname;
    return { ok: true, total: groups.length, translated: count };
  }

  function doRestore() {
    if (originalSnapshot) {
      originalSnapshot.groups.forEach(g => {
        g.nodes.forEach((n, i) => {
          if (g.originals[i] == null) return;
          // 使用组的 setTrans 写入原始值（兼容 text-node / value / placeholder / aria-label）
          (g.setTrans || ((node, val) => { node.nodeValue = val; }))(n, g.originals[i]);
        });
      });
    }
    active = false;
  }

  // ---------- 消息监听 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'WEB_TRANSLATE_STATUS') {
      sendResponse({ active, count: originalSnapshot ? originalSnapshot.groups.length : 0 });
      return true;
    }
    if (msg.type === 'WEB_TRANSLATE_EXECUTE') {
      (async () => {
        try { sendResponse(await doTranslate(msg.modelId, msg.targetLang)); }
        catch (e) { sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }); }
      })();
      return true;
    }
    if (msg.type === 'WEB_TRANSLATE_RESTORE') {
      doRestore();
      sendResponse({ ok: true });
      return true;
    }
  });

  // ---------- 站内跳转自动重翻 ----------
  function scheduleAuto() {
    if (!(mode === 'auto' && active && location.hostname === activeHost)) return;
    // 取消之前的请求
    pendingTranslate = null;
    clearTimeout(navTimer);
    navTimer = setTimeout(async () => {
      if (!(mode === 'auto' && active && location.hostname === activeHost)) return;
      const currentReq = Symbol();
      pendingTranslate = currentReq;
      try {
        const p = await chrome.storage.local.get('translatePrefs');
        const prefs = p.translatePrefs || {};
        if (pendingTranslate !== currentReq) return; // 已被取消
        await doTranslate(prefs.modelId, prefs.targetLang);
      } catch (_) {}
    }, 800);
  }
  function onUrlChange() {
    if (mode === 'manual') { active = false; originalSnapshot = null; }
    else if (location.hostname === curHost) scheduleAuto();
    curHost = location.hostname;
  }
  window.addEventListener('load', () => { curHost = location.hostname; });
  const _ps = history.pushState, _rs = history.replaceState;
  history.pushState = function () { const r = _ps.apply(this, arguments); onUrlChange(); return r; };
  history.replaceState = function () { const r = _rs.apply(this, arguments); onUrlChange(); return r; };
  window.addEventListener('popstate', onUrlChange);
  window.addEventListener('hashchange', onUrlChange);
  const titleEl = document.querySelector('title');
  if (titleEl) {
    let lastTitle = titleEl.textContent;
    new MutationObserver(() => {
      if (titleEl.textContent !== lastTitle) { lastTitle = titleEl.textContent; onUrlChange(); }
    }).observe(titleEl, { childList: true, characterData: true, subtree: true });
  }

  // 启动时读取历史偏好，让自动模式在已有激活态下恢复
  chrome.storage.local.get('translatePrefs').then(r => {
    const p = r.translatePrefs || null;
    if (p) {
      mode = p.mode || 'manual';
      if (p.mode === 'auto') { active = !!p.active; activeHost = p.activeHost || null; }
    }
  }).catch(e => {
    console.error('Failed to load translate prefs:', e);
  });
})();
