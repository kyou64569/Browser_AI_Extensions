// shared/constants.js
// 后台（service worker）侧的可调参数集中地。
// 原先这些数字散落在 service-worker.js 各处：翻译预算在第 136 行、缓存上限在第 315 行、
// 各类兜底超时则写在每个消息分支里。集中后便于统一调优，也避免"改了一处漏了另一处"。
//
// 注：content script 与 offscreen 文档运行在各自独立的世界里，无法直接 import 本文件
// （content script 非模块、offscreen 只能动态 import 且需登记 web_accessible_resources）。
// 因此这两处的常量仍留在各自的 `// ---- 可调参数 ----` 区块内并已逐条注释。

// ── 网页翻译 ──────────────────────────────────────────────────────────────
/** 每批 token 预算（软上限）：按估算 token 分块，而非固定段数，兼顾弱模型可靠性与额度消耗 */
export const TRANSLATE_MAX_BATCH_TOKENS = 2200;
/** 动态并发范围：在 TPM 配额允许内适度并发；遇 429 自适应下调 */
export const TRANSLATE_INITIAL_CONCURRENCY = 2;
export const TRANSLATE_MIN_CONCURRENCY = 1;
export const TRANSLATE_MAX_CONCURRENCY = 6;
/** 模型未显式配置 tpm/rpm 时的宽松默认：基本不主动限流，真正保护来自 429 自适应下调 */
export const DEFAULT_TPM = 1000000;
export const DEFAULT_RPM = 60;
/** 翻译是确定性任务，temperature 不读模型配置，强制调低以减少漏翻与幻觉式复制原文 */
export const TRANSLATE_TEMPERATURE = 0.1;
/** 输出 token 上限区间（按每批输入长度动态估算并夹在区间内） */
export const MIN_TRANS_TOKENS = 2048;
export const MAX_TRANS_TOKENS = 8192;
/** 输入字符 → 输出 token 的粗略系数（中文约 1.5 字符/token） */
export const TRANS_TOKENS_PER_CHAR = 0.8;

// ── 429 退避重试 ──────────────────────────────────────────────────────────
/** 限流重试轮数上限 */
export const RETRY_MAX_ROUNDS = 3;
/** TPM 是 60 秒滚动窗口，短退避无效；无 retry-after 时退避到接近一个窗口周期 */
export const RETRY_TPM_BACKOFF_MS = 25000;
/** 其它限流（RPM 等）的指数退避基数 */
export const RETRY_BASE_BACKOFF_MS = 800;

// ── 翻译缓存 ──────────────────────────────────────────────────────────────
export const TRANSLATE_CACHE_KEY = 'translateCache';
/** LRU 条目上限，超出从头（最旧）淘汰 */
export const TRANSLATE_CACHE_MAX = 3000;
/** chrome.storage.local 单键安全线（字节）；超出按 FIFO 淘汰 */
export const TRANSLATE_CACHE_QUOTA_BYTES = 4_500_000;
export const TRANSLATE_CACHE_EVICT_TO_BYTES = 4_000_000;
/** 估算单条缓存字节贡献时的固定开销（引号/逗号/花括号等） */
export const TRANSLATE_CACHE_ENTRY_OVERHEAD = 50;

// ── 实时字幕 ───────────────────────────────────────────────────────────────
/** 单轮转写总时长上限（ms） */
export const WHISPER_TOTAL_TIMEOUT_MS = 120000;
/** 一轮内所有 Whisper 模型都失败时的最大重试轮数 */
export const WHISPER_MAX_ROUNDS = 3;
/** 单个 Whisper 模型请求默认超时（ms） */
export const WHISPER_DEFAULT_TIMEOUT_MS = 60000;
/** SSE 缓冲上限（字节） */
export const WHISPER_MAX_SSE_BUFFER = 1024 * 1024;
/** 转写文本上限（字符） */
export const WHISPER_MAX_FULL_TEXT = 20000;
/** 429 退避重试的延迟基数（ms） */
export const WHISPER_RETRY_BACKOFF_MS = 700;

// ── 网页自动化 ─────────────────────────────────────────────────────────────
/** 跨域导航确认等待超时（ms） */
export const NAV_CONFIRM_TIMEOUT_MS = 45000;
/** Content script 响应超时（ms） */
export const CONTENT_SCRIPT_TIMEOUT_MS = 8000;
/** 整页截图最大屏数 */
export const FULL_PAGE_MAX_TILES = 120;
/** 画布单维度上限（px） */
export const CANVAS_MAX_DIM = 16384;
/** 滚动等待延迟（ms） */
export const SCROLL_WAIT_MS = 220;
/** 翻译并发调整等待阈值（ms） */
export const TRANSLATE_CONCURRENCY_WAIT_THRESHOLD_MS = 1500;
/** KB 列表缓存持久化延迟（ms） */
export const KB_CACHE_PERSIST_DELAY_MS = 1000;
/** 旧捕获释放等待延迟（ms） */
export const CAPTURE_RELEASE_WAIT_MS = 200;

// ── 知识库列表缓存 ────────────────────────────────────────────────────────
export const KB_LIST_CACHE_KEY = 'kbListCache';
/** KB 列表缓存有效期（ms）；KB_SEARCH 不缓存，需要实时结果 */
export const KB_LIST_CACHE_MS = 5 * 60 * 1000;

// ── 消息兜底超时 ──────────────────────────────────────────────────────────
// 每条后台消息都挂一个 setTimeout 兜底，保证 sendResponse 一定被调用一次，
// 避免端口悬挂导致发送端报 "The message port closed before a response was received."。
// 取值均略小于对应前端超时，确保前端先收到明确错误而不是被浏览器掐断。
export const TIMEOUT_AUTOMATE_MS = 55000;   // 前端 60s
export const TIMEOUT_KB_MS = 25000;         // 前端 searchKbInChat 30s
export const TIMEOUT_PPT_EXPORT_MS = 30000;
export const TIMEOUT_AGENT_MS = 280000;     // 4.6min，Agent 多步任务可能很长
export const TIMEOUT_WORKFLOW_MS = 240000;  // 4min

// ── 其它 ──────────────────────────────────────────────────────────────────
/** Agent 上下文里注入的页面正文长度上限（避免吃满提示词窗口） */
export const AGENT_PAGE_TEXT_LIMIT = 8000;
/** 联网搜索默认返回条数 */
export const WEB_SEARCH_DEFAULT_MAX = 6;
