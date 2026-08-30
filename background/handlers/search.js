// background/handlers/search.js
// 联网搜索：service worker 中无 DOMParser，故用 fetch 抓取搜索引擎的免密 HTML
// 结果页并以正则解析。利用 host_permissions <all_urls>，后台发起的请求不受页面 CORS 限制。
//
// 降级策略：DDG html.duckduckgo.com 是遗留接口，搜索结果质量逐年退化，
// 摘要常为空、内容偏向聚合页而非正文。DDG 返回 0 结果或全为无摘要链接时，
// 自动回退到 Bing HTML 搜索（无需 API Key，结果更结构化）。

import { stripHtmlText, sanitizeHttpUrl } from '../../shared/sanitize.js';

const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';
const DDG_TIMEOUT_MS = 15000;
const BING_TIMEOUT_MS = 20000;

/** 还原 DuckDuckGo 结果链接（去掉 //duckduckgo.com/l/?uddg= 重定向包装） */
function decodeDdgUrl(href) {
  try {
    let h = String(href || '').replace(/&amp;/g, '&');
    if (h.startsWith('//')) h = 'https:' + h;
    const u = new URL(h);
    const uddg = u.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : h;
  } catch (_) {
    return href;
  }
}

/**
 * 解析 DuckDuckGo HTML 结果页。
 * @param {string} html
 * @param {number} maxResults
 * @returns {{title:string, url:string, snippet:string}[]}
 */
export function parseDdgResults(html, maxResults) {
  const results = [];
  // DDG 真实 class 为 result__a（小写）；统一加 i 标志做大小写不敏感匹配，
  // 避免旧写法 result__A 大写导致永远匹配不到、联网搜索返回空。
  const titleRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = titleRe.exec(html)) && results.length < maxResults) {
    const title = stripHtmlText(m[2]);
    if (!title) continue;
    // 结果 URL 来自第三方页面：只放行 http/https，挡掉 javascript: / data: 等可执行协议，
    // 防止下游把它当链接渲染时变成注入点。
    const url = sanitizeHttpUrl(decodeDdgUrl(m[1]));
    if (!url) continue;
    results.push({ title, url, snippet: '' });
  }
  const snipRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let sm, i = 0;
  while ((sm = snipRe.exec(html)) && i < results.length) {
    results[i].snippet = stripHtmlText(sm[1]);
    i++;
  }
  return results;
}

// ---------- Bing 降级引擎（DDG 结果质量不足时自动触发）----------
const BING_PATTERNS = [
  {
    block: /<li[^>]*class="[^"]*b_algo[^"]*"[\s\S]*?<\/li>/gi,
    title: /<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/i,
    snippet: /<p[^>]*>([\s\S]*?)(?:<\/p>|<a\s|<strong>|<span[^>]*class=")/i,
  },
];

/** 解析 Bing HTML 搜索结果页 */
export function parseBingResults(html, maxResults) {
  const results = [];
  for (const pat of BING_PATTERNS) {
    let bm;
    while ((bm = pat.block.exec(html)) && results.length < maxResults) {
      const blockHtml = bm[0];
      const tm = pat.title.exec(blockHtml);
      if (!tm) continue;
      const title = stripHtmlText(tm[2]);
      if (!title) continue;
      let url = tm[1];
      if (url.startsWith('/')) url = 'https://www.bing.com' + url;
      const sm = pat.snippet.exec(blockHtml);
      const snippet = sm ? stripHtmlText(sm[1]) : '';
      const safeUrl = sanitizeHttpUrl(url);
      if (!safeUrl) continue;
      results.push({ title, url: safeUrl, snippet });
    }
    if (results.length) break;
  }
  return results;
}

/** Bing HTML 搜索 */
async function searchBing(query, maxResults) {
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(query) +
    '&setlang=zh-cn&count=' + Math.min(maxResults * 2, 20);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BING_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'text/html',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        // 注：Bing 对非浏览器 UA 会返回降级页面，故此处保留桌面浏览器 UA。
        // 审查报告已将其列为 S-06（可能违反 Bing 服务条款），属已知取舍。
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('Bing 返回 HTTP ' + res.status);
    return parseBingResults(await res.text(), maxResults);
  } finally {
    clearTimeout(timeoutId);
  }
}

/** 超过半数结果无摘要 → 低质量（聚合页/无正文）*/
function isLowQualityResults(results) {
  if (!results || results.length === 0) return true;
  const withSnippet = results.filter(r => r.snippet && r.snippet.length > 0);
  return withSnippet.length < Math.ceil(results.length / 2);
}

/** 抓取联网搜索结果：DDG 优先，质量不足时回退 Bing */
export async function webSearch(query, maxResults = 6) {
  // ──── 引擎1: DuckDuckGo（GET，失败再试 POST）────
  const headers = { 'Accept': 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' };
  let html = '';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DDG_TIMEOUT_MS);
  try {
    const res = await fetch(DDG_ENDPOINT + '?q=' + encodeURIComponent(query), { method: 'GET', headers, signal: controller.signal });
    if (res.ok) html = await res.text();
  } catch (e) {
    console.warn('[webSearch] DDG GET 失败，尝试 POST:', e?.message || String(e));
  } finally {
    clearTimeout(timeoutId);
  }

  let results = html ? parseDdgResults(html, maxResults) : [];
  if (!results.length) {
    const controller2 = new AbortController();
    const timeoutId2 = setTimeout(() => controller2.abort(), DDG_TIMEOUT_MS);
    try {
      const res = await fetch(DDG_ENDPOINT, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'q=' + encodeURIComponent(query),
        signal: controller2.signal,
      });
      if (res.ok) results = parseDdgResults(await res.text(), maxResults);
    } catch (e) {
      console.warn('[webSearch] DDG POST 也失败:', e?.message || String(e));
    } finally {
      clearTimeout(timeoutId2);
    }
  }

  // ──── 质量检测：低质量 → 引擎2: Bing ────
  if (isLowQualityResults(results)) {
    const withSnippet = results.filter(r => r.snippet && r.snippet.length > 0).length;
    console.warn('[webSearch] DDG 质量不足（' + results.length + ' 条，有效摘要 ' + withSnippet + '），转 Bing');
    try {
      const bingResults = await searchBing(query, maxResults);
      if (bingResults.length > 0) {
        console.info('[webSearch] Bing 降级成功，' + bingResults.length + ' 条结果');
        return bingResults;
      }
    } catch (e) {
      console.warn('[webSearch] Bing 降级也失败:', e?.message || String(e));
    }
    // 两者都失败：返回 DDG 结果 + 质量提示
    if (results.length > 0) {
      results.push({
        title: '⚠ 搜索结果不完整', url: '',
        snippet: '当前搜索引擎结果摘要为空（多为聚合页面而非正文）。建议换更具体的关键词重试。',
      });
    }
  }

  return results;
}
