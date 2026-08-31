// connectors/online-kb.js
// 在线知识库连接器：当前实现「腾讯 ima」OpenAPI（2026-07 官方接口）。
//
// 鉴权：自定义 HTTP Header `ima-openapi-clientid` / `ima-openapi-apikey`（非 Bearer）。
// Base：`https://ima.qq.com`
// 关键约束：
//   - 检索 search_knowledge 必须带 knowledge_base_id（不能搜全部），故上层需先 listKb 让用户选库。
//   - 返回的是命中摘要 highlight_content（短），适合做 RAG 上下文；非全文。
//   - Windows 保存的 apiKey 若带 BOM（\uFEFF）会导致鉴权失败（错误码 20004），读取时须去 BOM + trim。
//   - 知识库是「增强项」，任何失败都应兜底返回空数组 / 友好错误，绝不拖垮主流程（总结、聊天）。

import { KnowledgeBaseConnector } from './knowledge-base.js';

const IMA_BASE = 'https://ima.qq.com';

/** 清洗密钥：去 BOM（\uFEFF）+ 两侧空白，规避 Windows 保存带 BOM 导致的鉴权失败 */
function cleanSecret(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/^﻿/, '').trim();
}

// ima 真实接口的字段名与技能包文档可能不一致（已踩坑：kb_id/kb_name 才是线上字段）。
// search_knowledge 的正文片段可能出现在以下任一字段，全部尝试，取第一个非空字符串，
// 避免「文档命中但正文字段名对不上 → content 退化成标题」导致模型拿不到正文。
const CONTENT_FIELDS = [
  'highlight_content', 'content', 'snippet', 'fragment', 'excerpt',
  'abstract', 'text', 'summary', 'preview', 'description', 'body', 'chunk',
];

function pickContent(it) {
  if (!it || typeof it !== 'object') return { content: '', field: null };
  for (const f of CONTENT_FIELDS) {
    const v = it[f];
    if (typeof v === 'string' && v.trim()) return { content: v.trim(), field: f };
  }
  return { content: '', field: null };
}

// ── 共享字节工具（供 fetchUrlText 的 gzip/brotli 回退解压使用）────────────────────
// fetch 拿到的响应可能是未声明 Content-Encoding 的 gzip/brotli 压缩体，需用 DecompressionStream
// 解压；并须用逐字节映射（byte-exact）的 byteString 还原字符串——绝不能用 TextDecoder('latin1')
// （规范指向 windows-1252，会改写 0x80–0xFF 字节，破坏二进制头）。

/** 用 DecompressionStream 解压（gzip / brotli / deflate 等格式由 fmt 指定） */
async function inflateBytes(buf, fmt) {
  const ds = new DecompressionStream(fmt);
  // 守卫：Node/部分环境里解压失败会以未捕获的 'error' 事件抛出，
  // 这里把它转成 Promise 拒绝，避免进程崩溃（浏览器中 read() 通常直接 reject）。
  let streamErr = null;
  // Node 的 ReadableStream 没有 .on()，浏览器才有；防御性判断后按任意对象处理
  const readableWithOn = /** @type {any} */ (ds.readable);
  if (typeof readableWithOn.on === 'function') {
    readableWithOn.on('error', (e) => { streamErr = e || new Error('inflate error'); });
  }
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(buf);
  writer.close();
  const parts = [];
  let total = 0;
  for (;;) {
    if (streamErr) throw streamErr;
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  if (streamErr) throw streamErr; // 再次检查：防止错误在循环结束后（如 writer.close 时）触发
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** 把字节逐字映射为字符串（byte-exact）。注意：绝不能用 TextDecoder('latin1')——
 *  规范里 'latin1' 实际指向 windows-1252，会错误改写 0x80-0xFF 的字节（如 0x9C→'?'），
 *  破坏二进制头，导致解压（gzip/brotli 等）报 "incorrect header check"。
 *  使用循环而非 apply() 避免 V8 参数上限导致的栈溢出。 */
function byteString(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

/** 二进制文件型媒体类型（PDF/Word/PPT/Excel/图片/Xmind）。
 *  这些类型的 url_info.url 若是「来源页」而非文件直链，拿到的是 HTML/压缩体，
 *  不能当正文注入 RAG（图片还需 OCR，本扩展不支持）。 */
const BINARY_FILE_MT = new Set([1, 3, 4, 5, 9, 14]);

/** 从标题末尾提取文档扩展名（小写，不含点），无则返回 ''。
 *  例：「微表情心理学全书套装共3册)[www.rejoiceblog.com].pdf」→ 'pdf' */
function docExtOf(title) {
  if (typeof title !== 'string') return '';
  const t = title.replace(/[\]）】]+$/g, '').trim().toLowerCase();
  const m = t.match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

// 文本型文档：直接当文本抓取即可（md/txt 等），不需要真实字节。
const TEXT_DOC_EXT = new Set(['md', 'txt', 'markdown', 'csv']);
// 二进制文件型文档：本扩展不解析其二进制，且 ima OpenAPI 不暴露其原文，
// get_media_info 给的 url 往往是「来源页 URL」（如原导入站点域名根路径）或文件二进制体，不能当正文。
const BINARY_DOC_EXT = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'epub', 'mobi']);

/** 判断一个文档是否为「文件型」（需要真实字节），依据 media_type 或标题扩展名。
 *  注意：md/txt 虽标题带扩展名，但属文本型，单独用 isTextDoc 判定，不在此列。
 *  关键：URL 导入型 PDF 的 media_type 常被报成网页(2~6)，所以必须靠标题扩展名兜底识别，
 *  而不能靠 media_type，也不能靠「URL 字面是否带 .pdf」预判（COS 哈希直链常不带后缀）。 */
function isBinaryDocMedia(mediaType, title) {
  const mt = (mediaType != null) ? Number(mediaType) : NaN;
  if (BINARY_FILE_MT.has(mt)) return true;
  return BINARY_DOC_EXT.has(docExtOf(title));
}

/** 判定一段文本是否为「二进制碎片」（被错误解码的压缩体 / 控制字符流）。
 *  用于在 search_knowledge 直接返回的 highlight_content 中挡住乱码，以及 fetch 结果的最终兜底。
 *  含 U+FFFD 替换符即视为解码错误；超过少量 C0 控制字符(0x00-0x1F，空白除外)即判定为二进制。 */
function isBinaryText(str) {
  if (typeof str !== 'string' || str.length === 0) return false;
  if (/�/.test(str)) return true; // 替换符 = 编码错误
  let ctrl = 0;
  const n = Math.min(str.length, 2000);
  for (let i = 0; i < n; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0A && c !== 0x0D) ctrl++;
  }
  return ctrl > 4; // 超过 4 个 C0 控制字符 → 二进制碎片
}

/** 把字节按服务端 charset 解码为字符串。
 *  中文站点（如 rejoiceblog.com）多为 GBK，若用 UTF-8 解码会得到乱码；
 *  故先按 Content-Type 里的 charset 解码，失败再回退 UTF-8。
 *  注意：仅 gb2312 需映射为 gbk（TextDecoder 无 gb2312 标签）；gb18030/big5 均原生支持，
 *  绝不能映射成 gbk——big5 繁体页面按 gbk 解码必乱码，且会让回退循环中的多编码尝试失效。 */
function decodeBytes(u8, charset) {
  let cs = (charset || 'utf-8').toLowerCase();
  if (cs === 'gb2312') cs = 'gbk';
  try {
    return new TextDecoder(cs).decode(u8);
  } catch (_) {
    return new TextDecoder('utf-8').decode(u8);
  }
}

/** 从 HTML 中抽取可见正文文本（去脚本/样式/标签/常见实体，折叠空白） */
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n || 32))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16) || 32))
    .replace(/[ \t\r\n ]+/g, ' ')
    .trim();
}

/** 内容质量校验：剔除「二进制乱码」与过短内容，避免污染 RAG 并撑爆模型上下文导致超时。
 *  返回 true 表示是可引用的可读文本。判定标准：
 *   - 含 U+FFFD 替换符（说明按错误编码解码出了二进制/损坏内容）→ 直接判为乱码；
 *   - 可打印字符（含中日韩/字母/数字/常见标点）占比 ≥ 55%。 */
function isReadableText(text) {
  if (!text || text.length < 40) return false;
  if (/�/.test(text)) return false; // 出现替换符 → 编码错乱/二进制乱码
  const printable = (text.match(/[一-鿿 A-Za-z0-9，。、；：？！“”‘’（）【】\-—…·.,!?:;'"()\[\]{}<>\/%@#&*+=_~$|]/g) || []).length;
  return printable / text.length >= 0.55;
}

/** 把 ima search_knowledge 的单条结果映射为本项目的 KbChunk 契约 */
function toChunk(it, i) {
  const { content, field } = pickContent(it);
  // 兼容文档字段(title)与真实接口可能存在的别名(kb_title / name)
  const source = (it && (it.title || it.kb_title || it.name || '')).toString();
  return {
    id: (it && (it.media_id || it.doc_id || it.kb_doc_id)) || ('c' + i),
    content,             // 正文片段（可能为空；空说明只命中文档标题，没有可引用正文）
    contentField: field, // 诊断：实际命中的正文片段字段名（可能为 null）
    source,
    mediaType: (it && it.media_type != null) ? Number(it.media_type) : undefined,
    score: (it && it.score != null) ? Number(it.score) : undefined,
  };
}

// ── 内容召回（Content Recall）─────────────────────────────────────────────
// ima OpenAPI 的固有限制：search_knowledge 只返回「检索词所在的那句话」
// （highlight_content），当检索词只命中文档标题时 highlight_content 为空；
// 而原生 ima 的全文 RAG 能力不通过开放 API 暴露，故上传的文件型文档拿不到全文。
// 唯一能改善的办法：用「从命中标题提炼出的、更可能出现在正文里的关键词」再搜一次，
// 争取拿到 highlight_content 正文片段。
const TITLE_SUFFIX_RE = /(心理学|全书|套装共\d+册|精读版?|笔记|详解|解读|导读|手册|指南|教程|入门|实战|漫谈|故事|讲义|课件|摘要|总结|读后感|书评|精华|摘录|要点|核心|全集|选集|pdf|md|docx?|pptx?|txt|\[\w+\])$/i;

function deriveRecallQueries(titles, originalQuery) {
  const out = [];
  const seen = new Set();
  const push = (q) => {
    const k = (q || '').trim();
    if (k.length >= 2 && !seen.has(k) && k !== originalQuery) { seen.add(k); out.push(k); }
  };
  for (const t of titles) {
    if (!t) continue;
    let s = t.trim();
    // 去文件扩展名、前缀标记（如「[www.xxx.com]」）、常见「榨干一本书-」包装
    s = s.replace(/\.[a-z0-9]+$/i, '').replace(/^\[[^\]]*\]\s*/, '').replace(/^榨干一本书[-\s]*/, '');
    push(s);                                   // 完整标题（正文可能含完整书名）
    const core = s.replace(TITLE_SUFFIX_RE, '').trim();
    if (core && core !== s) push(core);        // 去书名后缀后的核心词（如「微表情心理学」→「微表情」）
    const head = s.slice(0, 4).trim();         // 标题前 2~4 字兜底核心词
    if (head.length >= 2) push(head);
  }
  return out;
}

export class OnlineKbConnector extends KnowledgeBaseConnector {
  /**
   * @param {{provider?:string, clientId?:string, apiKey?:string, knowledgeBaseId?:string, timeoutMs?:number}} cfg ima OpenAPI 连接配置
   */
  constructor(cfg = {}) {
    super();
    this.cfg = cfg || {};
    this.provider = this.cfg.provider || 'ima';
  }

  _headers() {
    return {
      'Content-Type': 'application/json',
      'ima-openapi-clientid': cleanSecret(this.cfg.clientId),
      'ima-openapi-apikey': cleanSecret(this.cfg.apiKey),
    };
  }

  async _post(path, body) {
    const url = IMA_BASE + path;
    const timeoutMs = (this.cfg && this.cfg.timeoutMs) ? this.cfg.timeoutMs : 15000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(body || {}),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error(`ima 接口请求超时（${timeoutMs}ms）`);
      throw e;
    }
    clearTimeout(timer);
    let json = {};
    try {
      json = await res.json();
    } catch (_) { /* 非 JSON 响应（如网关错误） */ }
    if (!res.ok) {
      const detail = json && json.msg ? `（${json.msg}）` : '';
      throw new Error(`ima 接口返回 HTTP ${res.status}${detail}`);
    }
    // ima 成功约定 code === 0；非零为业务错误（如 20004 鉴权失败）
    if (json.code !== 0 && json.code !== undefined) {
      throw new Error(`ima 错误：${json.msg || '未知错误'}(code=${json.code})`);
    }
    return json;
  }

  /** 列出知识库（分页聚合，最多拉 5 页≈100 个库，避免单次调用消耗过多配额） */
  async listKb(opts = {}) {
    const perPage = Math.min((opts.limit || 20), 20);
    const MAX_PAGES = 5; // 减少分页上限：5页×20条=最多100个库，常规用户足够了
    let cursor = '';
    const out = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const json = await this._post('/openapi/wiki/v1/search_knowledge_base', { query: '', cursor, limit: perPage });
      const data = json.data || {};
      const list = data.info_list || [];
      for (const it of list) {
        // 兼容两种返回字段命名：
        //  - 官方技能包文档约定为 { id, name, cover_url }
        //  - 线上真实接口（部分账号/旧版）实际返回 { kb_id, kb_name, content_count }
        // 任一种都正确取出，避免 name 为 undefined 导致预览端 escapeHtml(undefined) 崩溃。
        const id = it.id || it.kb_id || it.knowledge_base_id || '';
        const name = it.name || it.kb_name || id || '(未命名知识库)';
        out.push({ id, name, contentCount: it.content_count || 0 });
      }
      if (data.is_end || !data.next_cursor || list.length === 0) break;
      cursor = data.next_cursor;
    }
    return out;
  }

  /** 连接测试：仅拉 1 页验证连通性，不消耗过多配额 */
  async test() {
    const json = await this._post('/openapi/wiki/v1/search_knowledge_base', { query: '', cursor: '', limit: 1 });
    const data = json.data || {};
    const list = data.info_list || [];
    return { ok: true, count: list.length };
  }

  /**
   * 检索指定知识库（游标分页聚合，最多取 limit 条去重结果）。
   * @param {string} query
   * @param {{knowledgeBaseId?:string, limit?:number}} [opts]
   * @returns {Promise<import('./knowledge-base.js').KbChunk[]>}
   */
  async search(query, opts = {}) {
    const kbId = (opts && opts.knowledgeBaseId) || this.cfg.knowledgeBaseId;
    if (!kbId) {
      this._lastMeta = { error: '未指定 knowledge_base_id' };
      console.warn('[online-kb] 未指定 knowledge_base_id，无法检索');
      return [];
    }
    const limit = (opts && opts.limit) || 6;
    let cursor = '';
    const chunks = [];        // 仅含「带正文片段」的结果，供 RAG 注入
    const allChunks = [];     // 全部命中文档（含只有标题的），用于诊断命中数
    const seen = new Set();
    let firstRaw = null;      // 首条原始 item，供诊断 ima 真实返回字段
    let recallUsed = [];      // 实际命中的内容召回词（用于诊断）
    let recallAttempted = []; // 尝试过的召回词
    let urlFetched = 0;       // 通过 get_media_info 直接取到原文的 URL 数
    // 使用局部 meta 对象，避免并发请求互相覆盖 _lastMeta。
    // 方法结束时赋值给 this._lastMeta 供外部诊断读取。
    const meta = { kbId, code: null, rawListLen: 0, parsedLen: 0, nonEmptyContent: 0, matchedDocs: 0, withContent: 0, titleOnlyMatch: false, topKeys: [], dataKeys: [], sampleItemKeys: [], sampleContentLens: {}, recallUsed: [], recallAttempted: [], urlFetched: 0, noteFetched: 0, inaccessible: 0, nonFileUrl: 0, mediaTypesSeen: {}, perDoc: [], lastFetch: null };
    for (let page = 0; page < 3; page++) { // 3 页→最多 60 条候选，够用且省配额
      let json;
      try {
        json = await this._post('/openapi/wiki/v1/search_knowledge', {
          query,
          knowledge_base_id: kbId,
          cursor,
        });
      } catch (e) {
        // 检索失败：不再静默吞掉。抛出后由后台返回 { error }，前端才能区分
        // "检索接口报错"与"检索为空"——否则两者都显示成误导性的"未找到相关内容"。
        meta.error = e.message;
        this._lastMeta = meta;
        console.warn('[online-kb] 检索失败：', e.message);
        throw e;
      }
      const data = json.data || {};
      const list = data.info_list || [];
      // 累计诊断指标（多页聚合）
      meta.code = json.code;
      meta.rawListLen += list.length;
      meta.topKeys = Object.keys(json);
      meta.dataKeys = Object.keys(data);
      if (list.length) meta.sampleItemKeys = Object.keys(list[0]);
      // 诊断日志（service worker 控制台；用户侧看不到，仅用于开发排查）
      console.log('[online-kb] search_knowledge 响应：code=', json.code, '| info_list长度=', list.length,
        '| is_end=', data.is_end, '| kbId=', kbId, '| query=', query);
      if (list.length === 0) {
        console.log('[online-kb] 检索返回空。顶层响应 keys=', JSON.stringify(Object.keys(json)),
          '| data keys=', JSON.stringify(Object.keys(data)),
          '| data 预览=', JSON.stringify(data).slice(0, 300));
      } else {
        console.log('[online-kb] 首条 item 字段名=', JSON.stringify(Object.keys(list[0])),
          '| 首条预览=', JSON.stringify(list[0]).slice(0, 240));
      }
      for (const it of list) {
        const c = toChunk(it, allChunks.length);
        allChunks.push(c);
        if (!chunks.length && !firstRaw) firstRaw = it; // 记录首条原始 item 供诊断
        if (c.content && !isBinaryText(c.content) && !seen.has(c.content)) {
          seen.add(c.content);
          chunks.push(c); // chunks 仅含「带正文」的片段，供 RAG 使用
        }
        if (chunks.length >= limit) break;
      }
      if (chunks.length >= limit || data.is_end || !data.next_cursor || list.length === 0) break;
      cursor = data.next_cursor;
    }

    // ── 阶段二：内容召回 ───────────────────────────────────────────────
    // 主检索只命中标题（无正文片段）时，用「从标题提炼的正文关键词」再搜一次，
    // 争取拿到 highlight_content 正文片段。ima OpenAPI 不暴露上传文件的全文，
    // 这是目前唯一能改善「这本书讲了什么」类提问的可行手段。
    if (chunks.length === 0 && allChunks.length > 0) {
      const titles = allChunks.map(c => c.source).filter(Boolean);
      const recallQs = deriveRecallQueries(titles, query).slice(0, 3); // 上限 3 次召回，控配额
      recallAttempted = recallQs;
      for (const rq of recallQs) {
        if (chunks.length >= limit) break;
        try {
          const json = await this._post('/openapi/wiki/v1/search_knowledge', {
            query: rq, knowledge_base_id: kbId, cursor: '',
          });
          const list = (json.data || {}).info_list || [];
          for (const it of list) {
            const c = toChunk(it, chunks.length);
            if (c.content && !isBinaryText(c.content) && !seen.has(c.content)) {
              seen.add(c.content);
              chunks.push(c);
              if (!recallUsed.includes(rq)) recallUsed.push(rq);
            }
            if (chunks.length >= limit) break;
          }
        } catch (e) {
          console.warn('[online-kb] 内容召回失败：', rq, e.message);
        }
      }
    }

    // ── 阶段三：逐篇 get_media_info 取正文（覆盖 网页/微信 URL、笔记、文件 三态）──
    // 这是 ima agent 推荐流程的落地：search 只给了 media_id + 标题，要拿到正文必须
    // 对每个 media_id 调 get_media_info，再按 media_type 分支：
    //   - 有 url_info.url          → 直接抓取（网页/微信/部分 URL 型文档）
    //   - media_type === 11(笔记)   → 调 notes 模块的 get_doc_content 取笔记正文
    //   - 其它（文件型 PDF/Word）     → url_info 为空，ima OpenAPI 不暴露全文，标记不可访问
    // 无论哪类，能取到的正文都注入 RAG；取不到的如实计入诊断，前端据此明确告知用户。
    if (chunks.length === 0) {
      let noteFetched = 0, inaccessible = 0;
      const mediaTypesSeen = {};
      const probed = new Set();
      const maxProbe = limit * 2; // 控配额：最多探查 limit*2 个 media

      // 单篇探查：get_media_info → 按 media_type 分支取正文。成功则 push 进 chunks 并立即返回
      //（对应原串行版的 continue 语义），失败继续尝试笔记分支，最终计入「不可访问」。
      // meta 为请求级局部对象，并发请求互不覆盖。
      const probeOne = async (c) => {
        if (chunks.length >= limit || probed.has(c.id)) return;
        probed.add(c.id);
        try {
          const info = await this.getMediaInfo(c.id);
          const mt = (info.mediaType != null) ? Number(info.mediaType)
                   : (c.mediaType != null ? c.mediaType : '?');
          mediaTypesSeen[mt] = (mediaTypesSeen[mt] || 0) + 1;
          // 识别「文件型」文档：媒体类型命中，或标题带文档扩展名。
          // URL 导入型文档 get_media_info 常把 media_type 报成网页(2~6)，但本质仍是文件，
          // 须用标题兜底识别，否则下面会把来源页 URL 当正文抓进来。
          // 判断文档类型：文件型（PDF/Word 等，需要真实字节）vs 文本型（md/txt）vs 网页型
          const isBinaryDoc = isBinaryDocMedia(mt, c.source);
          const isTextDoc = TEXT_DOC_EXT.has(docExtOf(c.source));
          // 分支1：可访问 URL 直接抓原文
          const kind = isBinaryDoc ? 'file' : (isTextDoc ? 'text' : 'web');
          // recorded：确保每篇文档只向 perDoc 记录一条（避免分支1 的 skip 与分支3 的 inaccessible 重复）
          let recorded = false;
          const rec = (outcome, reason) => {
            if (recorded) return;
            meta.perDoc.push({ source: c.source.slice(0, 36), mt: String(mt), kind, url: (info.url || '').slice(0, 120), outcome, reason });
            recorded = true;
          };
          if (info.url) {
            // 文件型文档（PDF/Word 等二进制）：fetchUrlText 内部会直接判为不可访问，不会注入正文。
            // 文本型/md 与网页型：直接按文本/HTML 解码抓取。
            const text = await this.fetchUrlText(info.url, info.headers, mt, isBinaryDoc, meta);
            const fr = meta.lastFetch || {};
            if (text && !isBinaryText(text) && !seen.has(c.id)) {
              if (chunks.length >= limit) { rec('skip', 'limit-reached'); return; }
              seen.add(c.id);
              chunks.push({ id: c.id, content: text, source: c.source, mediaType: mt, fromUrl: true, score: undefined });
              urlFetched++;
              rec('fetched', fr.reason);
              return;
            }
            // fetchUrlText 返回 null：文件/文本型文档拿不到可用正文（多为来源页 URL 或不可解析的二进制体）
            if (isBinaryDoc || isTextDoc) meta.nonFileUrl++;
            rec('skip', fr.reason || 'no-content');
          } else {
            rec('no-url', 'get_media_info 无 url');
          }
          // 分支2：笔记类型 → notes 模块 get_doc_content（ima agent 提示：notebook_id 当作 note_id 传）
          if (mt === 11 && info.notebookId) {
            const text = (await this.getNoteContent(info.notebookId)).slice(0, 4000);
            if (text && !seen.has(c.id)) {
              if (chunks.length >= limit) { rec('skip', 'limit-reached'); return; }
              seen.add(c.id);
              chunks.push({ id: c.id, content: text, source: c.source, mediaType: mt, fromNote: true, score: undefined });
              noteFetched++;
              rec('fetched', 'note-content');
              return;
            }
            rec('skip', 'note 无正文');
          }
          // 分支3：以上都没取到正文 → 计入「不可访问」诊断计数（perDoc 已由 rec 记录一条，不重复）
          inaccessible++;
        } catch (e) {
          console.warn('[online-kb] get_media_info/get_doc_content 失败：', c.id, e.message);
          inaccessible++;
          meta.perDoc.push({ source: (c.source || '').slice(0, 36), mt: '?', kind: '?', url: '', outcome: 'error', reason: String(e.message || '').slice(0, 60) });
        }
      };

      // 并发限流：最多探查 maxProbe 篇，每批 CONCURRENCY 个并行
      const probeList = allChunks.filter(c => c.id && !probed.has(c.id)).slice(0, maxProbe);
      const CONCURRENCY = 3;
      for (let p = 0; p < probeList.length; p += CONCURRENCY) {
        if (chunks.length >= limit) break;
        await Promise.all(probeList.slice(p, p + CONCURRENCY).map(probeOne));
      }
      meta.noteFetched = noteFetched;
      meta.inaccessible = inaccessible;
      meta.mediaTypesSeen = mediaTypesSeen;
    }

    // 诊断：区分「命中文档但无正文片段」(titleOnlyMatch) 与「完全没命中」，
    // 这样 UI 才能明确告诉用户是 query 问题还是索引问题，而不是一句误导性的"未找到"。
    meta.matchedDocs = allChunks.length;
    meta.withContent = chunks.length;
    meta.titleOnlyMatch = allChunks.length > 0 && chunks.length === 0;
    meta.parsedLen = chunks.length;
    meta.nonEmptyContent = chunks.length;
    meta.recallUsed = recallUsed;
    meta.recallAttempted = recallAttempted;
    meta.urlFetched = urlFetched;
    if (firstRaw) {
      const lens = {};
      for (const f of CONTENT_FIELDS) {
        const v = firstRaw[f];
        if (v != null) lens[f] = (typeof v === 'string') ? v.length : String(v).length;
      }
      meta.sampleContentLens = lens;
    }
    this._lastMeta = meta;
    return chunks.slice(0, limit);
  }

  /** 获取媒体访问信息（get_media_info）。返回 { mediaType, url, headers, notebookId } */
  async getMediaInfo(mediaId) {
    const json = await this._post('/openapi/wiki/v1/get_media_info', { media_id: mediaId });
    const data = json.data || {};
    const ui = data.url_info || null;
    const nb = data.notebook_ext_info || null;
    return {
      mediaType: data.media_type,
      url: ui ? ui.url : null,
      headers: ui ? (ui.headers || null) : null,
      notebookId: nb ? nb.notebook_id : null,
    };
  }

  /** 获取笔记正文（notes 模块 get_doc_content）。返回纯文本；失败返回空串。 */
  async getNoteContent(noteId) {
    const json = await this._post('/openapi/note/v1/get_doc_content', {
      note_id: noteId,
      target_content_format: 0, // 0=PLAINTEXT
    });
    const data = json.data || {};
    const c = data.content || '';
    return c ? c.toString() : '';
  }

  /** 抓取 URL 原文（用于网页/微信型媒体，以及 ima 返回的来源页 URL）。
   *  - 文本/HTML 按服务端 charset 解码（中文站点多为 GBK）、清洗标签，并用「可读字符占比」剔除二进制乱码；
   *  - 单条截断到 4000 字，避免超长无效内容撑爆模型上下文触发超时；
   *  - 任何解析失败/不可读均安全降级为 null（由上层计入「不可访问」诊断）。
   *  - 文件型文档（PDF/Word/PPT 等二进制）：本扩展不解析其二进制，且 ima OpenAPI 也不暴露其原文，
   *    即使 get_media_info 返回的 url 能抓到内容，也多为来源页 HTML 或二进制文件体，无法作为正文注入 RAG，
   *    一律按不可访问处理。 */
  async fetchUrlText(url, headers, mediaType, isBinaryDoc, meta) {
    if (typeof url !== 'string' || !url) return null;
    const fd = { url: url.slice(0, 120), reason: '', contentType: '', bodyPrefix: '' };
    const mark = (reason, extra) => { Object.assign(fd, { reason }, extra || {}); if (meta) meta.lastFetch = fd; };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, { headers: headers || {}, signal: ctrl.signal, redirect: 'follow' });
      if (!res.ok) { mark('http-' + res.status); return null; }
      const buf = await res.arrayBuffer();
      const u8 = new Uint8Array(buf);
      // 文件型/二进制文档（PDF/Word/PPT/...）：本扩展不解析二进制文件，且 ima OpenAPI 不暴露其原文，
      // 即使能抓到内容也多为来源页 HTML 或文件二进制体，无法作为正文注入 RAG，一律按不可访问处理。
      if (isBinaryDoc) {
        console.warn('[online-kb] 文件型文档(url=', url.slice(0, 80), ') 内容不可解析，按不可访问处理');
        mark('file-no-bytes'); // 文件型二进制，无可用正文
        return null;
      }
      // 文本/HTML：按服务端 charset 解码（中文站点常见 GBK，UTF-8 解码会乱码）
      const ct = (res.headers && res.headers.get) ? (res.headers.get('content-type') || '') : '';
      let charset = (ct.match(/charset=([^\s;]+)/i) || [])[1];
      // 服务端未声明 charset 时，从 <meta> 标签嗅探（中文站点极常见，否则 GBK 页会被当 UTF-8 解成乱码）
      if (!charset) {
        const probe = new TextDecoder('utf-8').decode(u8.subarray(0, 2048));
        const m = probe.match(/<meta[^>]+charset=["']?\s*([a-z0-9_-]+)/i)
              || probe.match(/content=["'][^"']*charset=([a-z0-9_-]+)/i);
        if (m) charset = m[1];
      }
      let text = decodeBytes(u8, charset || 'utf-8');
      // HTML 页面：抽取可见正文
      if (/html/i.test(ct) || /<html[\s>]/i.test(text.slice(0, 2000))) {
        text = stripHtml(text);
      }
      // 可读性不达标时，尝试以其它常见中文编码重新解码（如 GBK 页面但服务端未声明 charset）
      if (!isReadableText(text)) {
        for (const alt of ['gbk', 'gb18030', 'big5']) {
          if (alt === (charset || 'utf-8')) continue;
          const t2 = decodeBytes(u8, alt);
          const c2 = /html/i.test(ct) || /<html[\s>]/i.test(t2.slice(0, 2000)) ? stripHtml(t2) : t2;
          if (isReadableText(c2)) { text = c2; break; }
        }
      }
      // 仍不可读：尝试把原始字节当 gzip/brotli 压缩体解压（服务端漏声明 Content-Encoding 的罕见情况）
      if (!isReadableText(text)) {
        const isGzip = u8[0] === 0x1f && u8[1] === 0x8b;
        const isBrotli = u8[0] === 0xce && u8[1] === 0xb2;
        let inflated = null;
        for (const fmt of (isGzip ? ['gzip'] : isBrotli ? ['brotli'] : [])) {
          try { inflated = await inflateBytes(u8, fmt); break; } catch (_) { /* 不是该格式 */ }
        }
        if (inflated) {
          const it = byteString(inflated);
          const cleaned = /html/i.test(ct) || /<html[\s>]/i.test(it.slice(0, 2000)) ? stripHtml(it) : it;
          if (isReadableText(cleaned)) text = cleaned;
        }
      }
      // 可读性校验：二进制乱码（如 ima 返回的原博客 URL 实为压缩/重定向体）在此被剔除，
      // 既避免把乱码喂给模型，也防止超长无效内容导致模型请求超时。
      if (isBinaryText(text)) { mark('binary-text'); return null; }
      if (!isReadableText(text)) { mark('unreadable', { contentType: ct, bodyPrefix: text.slice(0, 80) }); return null; }
      mark('ok', { contentType: ct });
      return text.slice(0, 4000); // 截断，避免超长原文导致模型请求超时
    } catch (e) {
      console.warn('[online-kb] fetchUrlText 失败：', e.message);
      // 网络错误/超时 abort：必须写 mark()，否则阶段三读取 lastFetch 会残留上一篇的结果，
      // 导致 perDoc 诊断显示错误的 reason（如把上一篇的 'ok' 记到本篇头上）。
      try { mark('fetch-error', { reason: String(e.message || 'fetch error').slice(0, 80) }); } catch (_) {}
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 写入知识库（ima 暂无稳定的公开写入接口，待调研）。
   * 保持与基类同一契约，未来接入 import_doc 等接口即可启用。
   * @param {string} content
   * @param {Object} [meta]
   * @returns {Promise<boolean>}
   */
  async add(content, meta) {
    throw new Error('[online-kb] ima 暂不支持从插件直接写入知识库');
  }
}
