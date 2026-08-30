// content/translate.js
// 网页翻译 —— 无 UI 的页面 Worker（不再注入浮动控件）。
// 通过 chrome.runtime.onMessage 接收侧边栏指令：
//   WEB_TRANSLATE_EXECUTE  → 收集文本 → 调用后台翻译 → 替换页面文本
//   WEB_TRANSLATE_RESTORE  → 还原原文
//   WEB_TRANSLATE_STATUS   → 返回当前状态（是否已翻译、段数等）
//
// 保留自动模式：同站 SPA 跳转后自动重翻（从 storage 读取预存参数）。

(function () {
  'use strict';
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
  const translatedSet = new Set(); // 已翻译节点集合（内容刷新去重，避免重复翻译已处理内容）
  let isTranslating = false;       // 翻译写入期间，抑制内容观察器自触发
  let contentObserver = null;      // 监听页面内容动态变化（局部刷新 / 站内 tab 切换）
  let contentChangeTimer = null;
  const CONTENT_CHANGE_DELAY = 1000;   // 内容变更防抖（ms）
  const CONTENT_CHANGE_MIN_CHARS = 40; // 触发重翻的最小新增文本量（过滤通知角标等微变更）
  let pageSeq = 0;                     // 页面身份序号：每次“页面 URL/内容变更”自增，使译文/还原状态与具体页面绑定
  let lastNavUrl = location.href;      // 上次已处理的导航 URL，用于判断 URL 是否真的发生变化

  // ---------- 文本节点收集 ----------
  function collectTextGroups(rootEl) {
    const groups = [];
    // 显式递归遍历 DOM，按“连续的非代码文本片段”分组，正确处理 <code> 边界：
    //   1) 命中 <code>（及 SKIP 列表元素）时整体跳过其子树，绝不翻译其内部文字；
    //   2) 跳过标签后，继续遍历其后续兄弟 / 父级文本节点（即 </code> 之后照常收集翻译）；
    //   3) 同一父级下被任意数量 <code> 分隔的文本片段，均按 DOM 顺序逐段收集并参与翻译，
    //      翻译结果按原节点顺序回填，保持 DOM 结构与节点顺序不变。
    function walk(el) {
      let pending = [];
      const flush = () => {
        if (pending.length) {
          groups.push({
            nodes: pending,
            text: pending.map(nd => nd.nodeValue).join(''),
            getOrig: n => n.nodeValue,
            setTrans: (n, t) => { n.nodeValue = t; },
          });
          pending = [];
        }
      };
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const v = child.nodeValue;
          if (v && v.trim()) pending.push(child);          // 收集非空白文本节点
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          if (SKIP.has(child.tagName) || child.isContentEditable) {
            flush();                                        // 先收尾已收集的片段
            continue;                                      // 跳过 code 等标签的整个子树（其内部文字不翻译）
          }
          flush();                                         // 进入子元素前，收尾本层已积累的直接文本
          walk(child);                                     // 递归遍历（继续处理其内部及后续文本节点）
          flush();                                         // 回到本层后，收尾直接文本，确保 </code> 之后的文本继续被收集
        }
      }
      flush();
    }
    walk(rootEl);
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

  // 标记一组已被翻译：写入原文备份(__aiOrig) + 记入 translatedSet，供“内容刷新”去重
  function markTranslated(g, originals) {
    g.nodes.forEach((n, i) => {
      if (n.nodeType === Node.TEXT_NODE || n.nodeType === Node.ELEMENT_NODE) {
        n.__aiOrig = (originals && originals[i] != null) ? originals[i] : g.getOrig(n);
      }
      translatedSet.add(n);
    });
  }
  // 周期性清理已脱离文档的节点引用，避免 translatedSet 长期膨胀
  function pruneTranslatedSet() {
    if (translatedSet.size < 4000) return;
    let checked = 0;
    const MAX_CHECK = 200;
    for (const n of translatedSet) {
      if (!n.isConnected) translatedSet.delete(n);
      if (++checked >= MAX_CHECK) break;
    }
  }

  // ---------- 翻译主流程 ----------
  async function doTranslate(modelId, lang) {
    if (isTranslating) return { ok: false, error: '正在翻译中' };
    if (!modelId) return { ok: false, error: '未选择翻译模型' };
    const groups = collectTextGroups(document.body);
    if (!groups.length) return { ok: false, error: '未找到可翻译的文本内容' };
    pruneTranslatedSet();

    // 区分“已翻译节点”（上一次翻译已将源文存入 __aiOrig）→ 直接跳过，避免内容刷新后重复翻译；
    // 其余节点当前值即原文，参与缓存命中 / API 翻译。
    const groupOriginals = groups.map(g => g.nodes.map(n => (n.__aiOrig != null ? n.__aiOrig : g.getOrig(n))));

    isTranslating = true;
    try {
      // 检查缓存（已翻译节点直接跳过）
      const uncached = [];
      groups.forEach((g, i) => {
        if (g.nodes.length > 0 && g.nodes.every(n => translatedSet.has(n))) return; // 已翻译，跳过
        const cached = translationCache.get(g.text);
        if (cached !== undefined) {
          distributeText(g.nodes, cached, g.setTrans);
          markTranslated(g, groupOriginals[i]);
        } else {
          uncached.push({ idx: i, text: g.text });
        }
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
        originalSnapshot = { pageSeq, groups: groups.map((g, i) => ({ nodes: g.nodes, originals: groupOriginals[i], setTrans: g.setTrans })) };
        active = true; activeHost = location.hostname;
        notifyTranslateDone();
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
        if (trans) { setCache(u.text, trans); distributeText(groups[u.idx].nodes, trans, groups[u.idx].setTrans); markTranslated(groups[u.idx], groupOriginals[u.idx]); }
      });

      originalSnapshot = { pageSeq, groups: groups.map((g, i) => ({ nodes: g.nodes, originals: groupOriginals[i], setTrans: g.setTrans })) };
      active = true; activeHost = location.hostname;
      notifyTranslateDone();
      return { ok: true, total: groups.length, translated: count };
    } finally {
      isTranslating = false;
    }
  }

  // 还原原文。
  // 关键修复（还原失效 + 跨页错乱）：
  //  - 页面重渲染/导航后旧节点脱离文档，对其赋值页面无变化 → 看似“已还原”实则无效；
  //  - 更危险的：若快照属于【上一页】（同 tab 内 SPA/整页导航，或自动模式重翻窗口期），
  //    旧逻辑会退化为 cur.nodes[i] 按【下标】把上一页原文写进【当前页】节点 → 文字全乱。
  // 现改为：用 pageSeq 绑定“快照所属页面”，还原前先校验仍属当前页；
  // 任一不满足（页面已变/节点已脱离文档）则【直接作废快照、绝不写入】，保证不会损坏当前页面。
  function doRestore() {
    if (!originalSnapshot) { active = false; return 0; }
    // 1) 页面身份不符（快照属于上一页：同 tab 内整页/SPA 导航会 bump pageSeq）→ 作废，不还原、不损坏
    if (originalSnapshot.pageSeq !== pageSeq) {
      originalSnapshot = null; translatedSet.clear(); active = false;
      return 0;
    }
    // 2) 逐节点还原：仅写入【仍连在当前文档】的记录节点。
    //    - 记录节点只来自“翻译时”的页面，跨 tab/跨文档的页面节点根本不在快照里，
    //      因此绝不可能把上一页原文错位写进当前页（无需再按“当前同序节点”兜底，那正是旧版损坏根因）。
    //    - 页面局部重渲染会使部分旧节点脱离文档，这些节点直接跳过即可（最佳努力还原），
    //      不再要求“整页文本组数量完全一致”，避免页面稍有动态变化就整体失效、点了没反应。
    let restoredGroups = 0;
    originalSnapshot.groups.forEach(g => {
      let groupRestored = 0;
      g.nodes.forEach((n, i) => {
        if (g.originals[i] == null) return;
        if (!n.isConnected || !document.contains(n)) return; // 节点已脱离当前文档 → 跳过，绝不兜底写入
        (g.setTrans || ((node, val) => { node.nodeValue = val; }))(n, g.originals[i]);
        groupRestored++;
      });
      if (groupRestored > 0) restoredGroups++;
    });
    active = false;
    originalSnapshot = null;
    translatedSet.clear(); // 还原后内容已回到原文，清除“已翻译”标记，便于下次内容刷新重新翻译
    return restoredGroups;
  }

  // ---------- 消息监听 ----------
  // 翻译完成通知：侧边栏（扩展页面）监听到后刷新“还原”按钮启用状态。
  // 关键：手动模式下由侧边栏点击后自行刷新；自动模式下翻译发生在内容脚本内部，
  // 必须主动通知侧边栏，否则“还原”按钮会一直停在初始的【置灰】状态，点击毫无反应。
  function notifyTranslateDone() {
    try {
      const p = chrome.runtime.sendMessage({ type: 'WEB_TRANSLATE_DONE' });
      if (p && typeof p.catch === 'function') p.catch(() => {}); // 侧边栏未打开时忽略
    } catch (_) {}
  }

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
      sendResponse({ ok: true, restored: doRestore() });
      return true;
    }
  });

  // ---------- 页面语言检测（自动模式用于判断是否需要翻译）----------
  // 目标：给出页面的归一化语言码（zh/en/ja/ko/fr/de/es/ru/ar/th/vi…）；
  // 若页面已与该语言匹配（多为 <html lang> 或正文文种），自动模式应跳过翻译。
  function normalizeLangCode(raw) {
    if (!raw) return null;
    const s = String(raw).trim().toLowerCase();
    const m = s.match(/[a-z]{2,3}/);
    const code = m ? m[0] : null;
    if (!code) return null;
    // 中英映射（含地区子码 zh-cn/zh-tw/zh-hans…）
    if (code === 'zh' || code === 'zh-cn' || code === 'zh-hans' || code === 'zh-hant' || code === 'zh-tw' || code === 'cmn' || code === 'yue') return 'zh';
    if (code === 'en' || code === 'eng') return 'en';
    if (code === 'ja' || code === 'jpn') return 'ja';
    if (code === 'ko' || code === 'kor') return 'ko';
    if (code === 'fr' || code === 'fra') return 'fr';
    if (code === 'de' || code === 'deu' || code === 'ger') return 'de';
    if (code === 'es' || code === 'spa') return 'es';
    if (code === 'ru' || code === 'rus') return 'ru';
    if (code === 'ar' || code === 'ara') return 'ar';
    if (code === 'th' || code === 'tha') return 'th';
    if (code === 'vi' || code === 'vie') return 'vi';
    return code;
  }
  function scriptOf(text) {
    if (!text) return null;
    let cjk = 0, latin = 0, cyr = 0, thai = 0, arabic = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp >= 0x4e00 && cp <= 0x9fff) cjk++;
      else if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0xac00 && cp <= 0xd7af)) cjk++; // 假名 / 谚文
      else if ((cp >= 0x0041 && cp <= 0x024f)) latin++;
      else if (cp >= 0x0400 && cp <= 0x04ff) cyr++;
      else if (cp >= 0x0e00 && cp <= 0x0e7f) thai++;
      else if (cp >= 0x0600 && cp <= 0x06ff) arabic++;
    }
    if (cjk >= latin && cjk >= cyr && cjk >= thai && cjk >= arabic && cjk > 0) return 'cjk';
    if (latin > 0 && latin >= cjk && latin >= cyr && latin >= thai && latin >= arabic) return 'latin';
    if (cyr > 0) return 'cyr';
    if (thai > 0) return 'thai';
    if (arabic > 0) return 'arabic';
    return null;
  }
  function getPageLang() {
    const hl = document.documentElement.getAttribute('lang');
    const code = normalizeLangCode(hl);
    if (code) return code;
    // 退化：使用 TreeWalker 快速采样可见文本（上限 800 字符即止，避免完整 DOM 遍历）
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let sample = '';
    while (tw.nextNode()) {
      const v = tw.currentNode.nodeValue;
      if (v && v.trim()) {
        sample += v;
        if (sample.length >= 800) break;
      }
    }
    sample = sample.slice(0, 800);
    const s = scriptOf(sample);
    if (s === 'cjk') return 'zh';        // 中文站最常见；翻译以中→外为主，足够判断“是否已是目标语言”
    if (s === 'latin') return 'en';
    if (s === 'cyr') return 'ru';
    if (s === 'thai') return 'th';
    if (s === 'arabic') return 'ar';
    return null;
  }
  // 目标语言显示串 → 归一化码；用于“页面已是目标语言则跳过”
  function targetCodeOf(targetLang) {
    if (!targetLang) return null;
    if (targetLang.indexOf('中文') >= 0) return 'zh';
    if (targetLang.indexOf('English') >= 0 || targetLang.indexOf('英语') >= 0) return 'en';
    if (targetLang.indexOf('日本語') >= 0 || targetLang.indexOf('日语') >= 0) return 'ja';
    if (targetLang.indexOf('한국어') >= 0 || targetLang.indexOf('韩语') >= 0) return 'ko';
    if (targetLang.indexOf('Français') >= 0 || targetLang.indexOf('法语') >= 0) return 'fr';
    if (targetLang.indexOf('Deutsch') >= 0 || targetLang.indexOf('德语') >= 0) return 'de';
    if (targetLang.indexOf('Español') >= 0 || targetLang.indexOf('西班牙语') >= 0) return 'es';
    if (targetLang.indexOf('Русский') >= 0 || targetLang.indexOf('俄语') >= 0) return 'ru';
    if (targetLang.indexOf('العربية') >= 0 || targetLang.indexOf('阿拉伯') >= 0) return 'ar';
    if (targetLang.indexOf('ภาษาไทย') >= 0 || targetLang.indexOf('泰语') >= 0) return 'th';
    if (targetLang.indexOf('Tiếng Việt') >= 0 || targetLang.indexOf('越南语') >= 0) return 'vi';
    return null;
  }

  // ---------- 自动模式：每次进入新页面都检测语言并自动翻译 ----------
  function autoTranslate(delay) {
    if (mode !== 'auto') return;
    clearTimeout(navTimer);
    navTimer = setTimeout(async () => {
      if (mode !== 'auto') return;
      const currentReq = Symbol();
      pendingTranslate = currentReq;
      try {
        const p = await chrome.storage.local.get('translatePrefs');
        const prefs = p.translatePrefs || {};
        if (pendingTranslate !== currentReq) return; // 已被取消（导航又变了）
        const modelId = prefs.modelId, targetLang = prefs.targetLang;
        if (!modelId) return; // 未配置翻译模型，无法自动翻译（侧边栏会提示）
        // 检测页面语言：若已是目标语言则跳过，避免无意义的翻译
        const pageLang = getPageLang();
        const tCode = targetCodeOf(targetLang);
        if (pageLang && tCode && pageLang === tCode) {
          active = false; originalSnapshot = null; activeHost = location.hostname;
          return;
        }
        await doTranslate(modelId, targetLang); // 成功则把 active/activeHost 设为当前页
      } catch (_) {}
    }, delay || 800);
  }
  function onUrlChange() {
    // URL 真的变化（新页面 / 站内跳转 / SPA pushState）→ 自增页面序号并重置翻译状态，
    // 让每个页面独立维护“已翻译/未翻译”状态：上一页的译文与还原快照不会串到新页面。
    // 注意：切换“自动/手动”模式不会改 URL，因此不会误触发此处重置（模式切换由 storage 监听处理）。
    if (location.href !== lastNavUrl) {
      lastNavUrl = location.href;
      pageSeq++;
      originalSnapshot = null;
      translatedSet.clear();
      active = false;
    }
    if (mode === 'manual') {
      // 手动模式：停止自动行为；译文保持可见（不自动还原），仅等用户主动触发
    } else {
      autoTranslate(800); // 自动模式：任何导航（含跨站 / SPA）都重新检测并翻译
    }
    curHost = location.hostname;
  }
  window.addEventListener('load', () => { curHost = location.hostname; });
  const _ps = history.pushState, _rs = history.replaceState;
  // 覆写 pushState/replaceState 以拦截 SPA 站内导航（如 React Router / Vue Router 的
  // pushState 调用）。由于本脚本在 document_idle 注入（页面脚本已执行完毕），
  // _ps / _rs 捕获的是 SPA 框架的 patched 版本（若有），apply 调用时走回 SPA 逻辑，
  // 保证 onUrlChange 在 URL 更新后触发，不破坏 SPA 路由行为。
  history.pushState = function () { const r = _ps.apply(this, arguments); onUrlChange(); return r; };
  history.replaceState = function () { const r = _rs.apply(this, arguments); onUrlChange(); return r; };
  window.addEventListener('popstate', onUrlChange);
  window.addEventListener('hashchange', onUrlChange);
  const titleEl = document.querySelector('title');
  if (titleEl) {
    let lastTitle = titleEl.textContent;
    // 仅“自动模式”下才因标题变化触发重翻：标题动态变化（通知角标等）不是导航，
    // 手动模式下绝不可因此清空 originalSnapshot，否则还原会失效（见 doRestore 修复）。
    new MutationObserver(() => {
      if (titleEl.textContent !== lastTitle) { lastTitle = titleEl.textContent; if (mode === 'auto') onUrlChange(); }
    }).observe(titleEl, { childList: true, characterData: true, subtree: true });
  }

  // ---------- 自动模式：监听页面内容动态变化（局部刷新 / 站内 tab 切换）----------
  // 触发条件：任意“实质内容变更”（新增/修改文本量超阈值），忽略属性变化（如 tab 高亮切换）。
  // 触发后重新检测语言并翻译【新增内容】；已翻译节点因 translatedSet 去重而不会被重复翻译。
  function startContentObserver() {
    if (contentObserver || mode !== 'auto') return;
    const target = document.body || document.documentElement;
    if (!target) return;
    contentObserver = new MutationObserver((mutations) => {
      if (mode !== 'auto' || isTranslating) return; // 翻译写入期间不自触发，避免回环
      let added = 0;
      for (const m of mutations) {
        if (m.type === 'attributes') continue;        // 忽略 class/style 等属性变化
        // 仅统计【新增节点】的文本内容；刻意忽略 characterData（已有文本节点的 nodeValue 变化）。
        // 原因：①「还原」按钮把译文写回原文是 in-place 的 characterData 变更，若计入会立即触发
        //   自动重翻，导致“还原后页面又被翻译回来、看起来还原没生效”；② 直播/计数器类的
        //   文本刷屏是 characterData，不应触发重翻。站内 tab / 局部刷新通常【替换节点】，
        // 表现为 addedNodes，仍能被正常捕获并重翻。
        if (m.type === 'characterData') continue;
        for (const nd of m.addedNodes) {
          if (nd.nodeType === Node.TEXT_NODE) { added += (nd.nodeValue || '').length; continue; }
          if (nd.nodeType === Node.ELEMENT_NODE && (nd.offsetParent === null || nd.closest('[type=password]') || nd.closest('[autocomplete=off]'))) continue;
          added += (nd.textContent || '').length;
        }
      }
      if (added < CONTENT_CHANGE_MIN_CHARS) return;    // 少量变更（通知角标等）不触发重翻
      if (contentChangeTimer) clearTimeout(contentChangeTimer);
      contentChangeTimer = setTimeout(() => {
        contentChangeTimer = null;
        autoTranslate(0);                              // 重新检测语言 + 翻译新增内容
      }, CONTENT_CHANGE_DELAY);
    });
    contentObserver.observe(target, { childList: true, subtree: true, characterData: true });
  }

  // 启动时读取历史偏好：自动模式下对新加载的页面立即检测语言并自动翻译（无需手动点按）
  chrome.storage.local.get('translatePrefs').then(r => {
    const p = r.translatePrefs || null;
    if (p) {
      mode = p.mode || 'manual';
      if (p.mode === 'auto') {
        // 注意：不再依赖存储里的 active/activeHost（那是上一页的残留），
        // 直接对新页面做语言检测 + 自动翻译。
        active = false; activeHost = null;
        autoTranslate(1200); // 等正文基本就绪后再翻译（避免翻译空页面）
        startContentObserver(); // 启动内容观察：后续局部刷新 / 站内 tab 切换也会自动翻译
      }
    }
  }).catch(e => {
    console.error('Failed to load translate prefs:', e);
  });

  // ---------- 运行时模式同步（侧边栏切换“自动/手动”时实时生效）----------
  // 根因：translatePrefs 仅在启动时读取一次，运行时切换模式后内部 mode 不更新，
  // 导致手动模式下内容观察器仍以“自动”逻辑触发翻译（切站内 tab 自动出译文）。
  // 监听 storage 变化，使 mode 与侧边栏保持一致，并按模式启停自动翻译行为。
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.translatePrefs) return;
      const np = changes.translatePrefs.newValue || {};
      const op = changes.translatePrefs.oldValue || {};
      const newMode = np.mode || 'manual';
      if (newMode === mode) {
        // 模式未变：自动模式下若模型/目标语言改变，用新参数重新翻译
        if (mode === 'auto' && (np.modelId !== op.modelId || np.targetLang !== op.targetLang)) {
          autoTranslate(800);
        }
        return;
      }
      mode = newMode;
      if (mode === 'auto') {
        // 切回自动：重新检测并翻译当前页，并启动内容观察（站内 tab / 局部刷新自动翻译）
        active = false; activeHost = null; originalSnapshot = null;
        if (!contentObserver) startContentObserver();
        autoTranslate(800);
      } else {
        // 切到手动：仅停止“自动翻译”行为（断开内容观察器 + 清防抖定时器），
        // 但【保留已显示的译文】，不在此处还原原文。
        // 手动模式只表示“不再自动翻译”，已翻译内容持续可见；
        // 只有用户点击“还原”按钮才会回退原文（doRestore 由还原按钮调用）。
        // 因此不调用 doRestore()，也不清空 originalSnapshot / translatedSet / active，
        // 以保证“还原”按钮在手动模式下仍可用。
        if (contentObserver) { contentObserver.disconnect(); contentObserver = null; }
        if (contentChangeTimer) { clearTimeout(contentChangeTimer); contentChangeTimer = null; }
      }
    });
  }
})();
