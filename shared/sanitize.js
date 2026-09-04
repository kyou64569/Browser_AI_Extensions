// shared/sanitize.js
// 文本/URL 消毒与脱敏工具。被 service worker 与前端共用。
//
// 背景：联网搜索的标题/摘要来自第三方 HTML，Agent 的页面正文来自任意网页。
// 这些数据即便是"纯文本"，也可能夹带 <script>、onerror= 等片段。当前链路大多用
// textContent 渲染，但只要有一处改成 innerHTML 就会变成 XSS。这里统一做纵深防御：
// 反序列化（解码实体）后再重新剥离标签，直到稳定，最后中和残留的标签起始符。

/** HTML 命名实体（只保留常见集合，够用且不引入依赖） */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  hellip: '…', mdash: '—', ndash: '–', middot: '·',
};

/**
 * 解码 HTML 实体（命名实体 + 十进制/十六进制数字实体）。
 * 供 stripHtmlText 内部循环使用，也单独导出便于测试与其它场景复用。
 * @param {string} s
 * @returns {string}
 */
export function decodeHtmlEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => {
      const v = NAMED_ENTITIES[name.toLowerCase()];
      return v === undefined ? m : v;
    });
}

// 排除控制字符与代理项区间，避免构造出畸形字符串
function safeCodePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  if (n >= 0xd800 && n <= 0xdfff) return '';
  if (n < 0x20 && n !== 0x09 && n !== 0x0a && n !== 0x0d) return '';
  try { return String.fromCodePoint(n); } catch (_) { return ''; }
}

/**
 * 解码「不带分号的 legacy 命名实体」。
 * HTML5 规范在文本态会解码这类实体：`&ltimg src=x onerror=...&gt` 浏览器解析出来就是
 * `<img ...>`。decodeHtmlEntities 要求分号，解码不了这种形态；若 stripHtmlText 不同步
 * 该行为，无分号序列会原样穿过标签剥离，成为「已消毒数据里藏着可复活标签结构」的隐患
 * （当前调用点走 textContent 尚不可利用，但任何下游改用 innerHTML 立刻成 XSS）。
 * @param {string} s
 * @returns {string}
 */
function decodeLegacyEntitiesNoSemicolon(s) {
  return String(s).replace(/&(lt|gt|amp|quot|nbsp)(?!;)/gi, (m, name) => {
    const v = NAMED_ENTITIES[name.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/**
 * 把 HTML 片段压成安全的纯文本。
 *
 * 关键点：必须在"解码实体"之后"再剥一次标签"。只做一遍
 * `去标签 → 解实体` 的话，`&lt;img src=x onerror=alert(1)&gt;` 会在解码后
 * 重新变成完整标签，一旦下游改用 innerHTML 注入即被利用。
 * 因此这里迭代到稳定（最多 3 轮），最后把残留的标签起始符降级为全角，彻底断根。
 *
 * @param {*} s 任意输入；非字符串按 String() 容错处理
 * @returns {string} 纯文本；保证不含可执行的标签结构
 */
export function stripHtmlText(s) {
  let out = String(s == null ? '' : s);
  for (let i = 0; i < 3; i++) {
    const before = out;
    out = out
      // 整块丢弃 script/style/iframe 内容，避免其文本残留后被误当作正文展示
      .replace(/<\s*(script|style|iframe|object|embed)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
      // 丢弃标签。刻意要求 `<` 后紧跟字母或 `!`（不允许空格），
      // 否则 "a < b" 这类比较文本会被误吃掉。末尾 `>` 可选，兼容被截断的标签。
      .replace(/<\/?[a-z!][^>]*>?/gi, ' ');
    out = decodeLegacyEntitiesNoSemicolon(decodeHtmlEntities(out));
    if (out === before) break;
  }
  // 兜底：中和仍"看起来像标签开头"的序列（解码后复活的 `<img`、未闭合的 `<script` 等）。
  // 同样要求 `<` 后紧跟字母/`/`/`!`，不影响 "a < b" 与 "<3" 这类正常文本。
  out = out.replace(/<(?=\/?[a-z!?])/gi, '＜');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * 只保留 http/https 的 URL，其余（javascript:、data:、file: 等）返回空串。
 * 用于联网搜索结果、Agent 跳转目标等外部输入的 URL 校验。
 * @param {string} raw
 * @returns {string} 合法则返回原 URL，否则 ''
 */
export function sanitizeHttpUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '';
  } catch (_) {
    return '';
  }
}

/**
 * HTML 文本转义（& < > " '）。用于 innerHTML 模板插值。
 * 注意必须连引号一起转义：只转义 & < > 的实现一旦被放进双引号属性
 * （如 value="${escapeHtml(x)}"）就能被 `"` 闭合属性注入 onerror 等事件。
 * @param {*} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 校验媒体资源地址（图片/音频/视频 src），返回可直接拼进 `src="..."` 的安全值，否则 ''。
 * 与 safeImageSrc 的差别：媒体 URL 常来自第三方网关的响应体（可能带查询参数、编码字符），
 * 因此不能像截图路径那样一刀切拒绝空白——用 URL 解析 + 全量转义代替字符黑名单：
 * 1) 协议白名单：http(s)、blob:、data:image|audio|video/<栅格或媒体格式>（不放行 svg：可携带脚本）
 * 2) 输出前把 & < > " ' 全部转成实体，属性上下文里也不可能逃逸
 * @param {string} raw
 * @returns {string}
 */
export function safeMediaSrc(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  let ok = false;
  if (/^data:(image\/(png|jpe?g|gif|webp|bmp|avif)|audio\/(mpeg|mp3|ogg|wav|webm|m4a|aac|flac)|video\/(mp4|webm|ogg|quicktime));/i.test(s)) ok = true;
  else if (/^blob:/i.test(s)) ok = true;
  else {
    try {
      const u = new URL(s);
      ok = u.protocol === 'http:' || u.protocol === 'https:';
    } catch (_) { ok = false; }
  }
  if (!ok) return '';
  return escapeHtml(s);
}

/**
 * 校验图片资源地址，返回一个可直接拼进 `src="..."` 的安全值，否则返回 ''。
 *
 * 两道过滤：
 * 1) 协议白名单 —— 只放行 data:image/<栅格格式>、blob:、http(s)，堵住
 *    `javascript:` 与 `data:text/html` 这类可执行协议。
 *    刻意不放行 data:image/svg+xml：SVG 内可携带脚本，而我们只会产出 PNG 截图，
 *    放行它没有任何收益却多一个攻击面。
 * 2) 属性安全 —— 拒绝含引号/尖括号/空白的值，防止提前闭合 src 属性后再追加事件属性。
 *
 * @param {string} raw
 * @returns {string}
 */
export function safeImageSrc(raw) {
  const s = String(raw == null ? '' : raw);
  if (!s) return '';
  // 提前闭合属性或引入标签的字符一律拒绝
  if (/["'<>]/.test(s)) return '';
  const t = s.trim();
  if (/^data:image\/(png|jpe?g|gif|webp|bmp);/i.test(t)) return t;
  if (/^blob:/i.test(t)) return t;
  return sanitizeHttpUrl(t);
}

/**
 * 把 URL 降级为可安全写入日志/错误提示的形态：只留 origin + path，去掉 query 与 hash。
 *
 * 原因：Gemini 等厂商把 API Key 放在 query（`?key=xxx`），OpenRouter 之类代理的
 * apiBase 也可能带 token；完整 URL 一旦进错误消息就会随日志/截图外泄。
 * 保留 path 是因为定位"apiBase 配错"这类问题必须看到路径。
 *
 * @param {string} raw
 * @returns {string}
 */
export function redactUrl(raw) {
  const s = String(raw == null ? '' : raw);
  if (!s) return '';
  try {
    const u = new URL(s);
    return u.origin + (u.pathname || '');
  } catch (_) {
    // 解析失败（相对路径 / 非法串）：至少砍掉 query 与 hash
    return s.split(/[?#]/)[0];
  }
}
