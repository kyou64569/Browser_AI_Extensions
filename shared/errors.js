// shared/errors.js
// 把模型/网络层的原始错误翻译成用户能看懂的提示。
//
// 背景：此前侧边栏直接把 `e.message` 原文抛给用户，例如
//   HTTP 429: {"error":{"message":"Rate limit exceeded for TPM"}}
//   Whisper HTTP 400：{"error":{"message":"no audio track found in file"}}
// 这类文案对开发者有用、对用户是噪音。这里做一层"分类 + 可读文案 + 技术细节分离"：
// 主文案说清"出了什么问题 + 该做什么"，原始错误收到 detail 里折叠展示，排障时仍可展开。
//
// 只做展示层的翻译，不改变任何错误处理/重试逻辑。

/** 错误分类（与 core/http.js 的 HttpErrorKind 对齐，并补充展示层需要的两类） */
export const ERROR_KIND = {
  AUTH: 'auth',                 // 401/403 密钥无效
  CREDENTIAL: 'credential',     // 压根没配密钥
  RATE_LIMIT: 'rate_limit',     // 429 限流 / 配额用尽
  SERVER: 'server',             // 5xx 服务侧故障
  TIMEOUT: 'timeout',           // 请求超时
  ABORTED: 'aborted',           // 用户主动停止（不是故障）
  NETWORK: 'network',           // 连不上（DNS/代理/CORS/apiBase 配错）
  BAD_REQUEST: 'bad_request',   // 400 类：参数或音频格式问题
  UNKNOWN: 'unknown',
};

/** 每类的展示文案：title = 出了什么事，hint = 该做什么 */
const MESSAGES = {
  [ERROR_KIND.AUTH]: {
    title: 'API Key 无效或已过期',
    hint: '请到「设置 → 模型配置」检查该模型的密钥是否正确、是否已被服务商停用。',
  },
  [ERROR_KIND.CREDENTIAL]: {
    title: '模型缺少有效凭证',
    hint: '请到「设置 → 模型配置」为该模型填写 API Key（本地 Ollama 除外）。',
  },
  [ERROR_KIND.RATE_LIMIT]: {
    title: '请求过于频繁，已被限流',
    hint: '系统已自动退避重试并降级到备用模型。若持续出现，请降低并发或在设置里调小每批文本量。',
  },
  [ERROR_KIND.SERVER]: {
    title: '模型服务暂时不可用',
    hint: '通常是服务商侧故障，已自动重试。若持续报错，可切换到备用模型稍后再试。',
  },
  [ERROR_KIND.TIMEOUT]: {
    title: '请求超时',
    hint: '请检查网络，或到设置里把该模型的超时时间调大一些。',
  },
  [ERROR_KIND.ABORTED]: {
    title: '已停止生成',
    hint: '',
  },
  [ERROR_KIND.NETWORK]: {
    title: '无法连接到模型服务',
    hint: '请检查网络/代理，并确认「设置 → 模型配置」里的 API Base 地址填写正确（含 /v1 等路径）。',
  },
  [ERROR_KIND.BAD_REQUEST]: {
    title: '请求被服务端拒绝（参数或格式问题）',
    hint: '请检查模型名是否填写正确；若是语音识别报错，通常是音频格式不被服务端接受。',
  },
  [ERROR_KIND.UNKNOWN]: {
    title: '请求失败',
    hint: '',
  },
};

/**
 * 判定错误类别。
 * 优先用 HttpError 自带的 kind/status（core/http.js 已分类），
 * 退化到按消息文本匹配——因为很多错误来自 fetch 之外的路径（FormData、Whisper、storage）。
 *
 * @param {unknown} e
 * @returns {string} ERROR_KIND 之一
 */
export function classifyError(e) {
  const msg = (e && e.message) ? String(e.message) : String(e || '');
  const status = (e && typeof e.status === 'number') ? e.status : 0;
  const kind = (e && e.kind) ? String(e.kind) : '';

  // 1) 结构化信息优先
  if (kind === 'aborted') return ERROR_KIND.ABORTED;
  if (kind === 'auth' || status === 401 || status === 403) return ERROR_KIND.AUTH;
  if (kind === 'rate_limit' || status === 429) return ERROR_KIND.RATE_LIMIT;
  if (kind === 'server' || (status >= 500 && status < 600)) return ERROR_KIND.SERVER;
  if (kind === 'timeout') return ERROR_KIND.TIMEOUT;
  if (kind === 'network') return ERROR_KIND.NETWORK;
  if (status === 400) return ERROR_KIND.BAD_REQUEST;

  const s = msg.toLowerCase();

  // 2) 凭证缺失（本项目的自定义文案，须先于 auth 判定，避免误报成"密钥无效"）
  if (/缺少有效凭证|缺少有效凭证（api key）|请先在设置添加模型|未找到可用.*模型/.test(msg)) {
    return ERROR_KIND.CREDENTIAL;
  }
  // 3) 文本匹配兜底
  if (/401|403|unauthorized|forbidden|invalid api key|incorrect api key|api key|鉴权|密钥无效/.test(s)) {
    return ERROR_KIND.AUTH;
  }
  if (/\b429\b|rate.?limit|too many requests|quota|tpm|tokens per minute/.test(s)) {
    return ERROR_KIND.RATE_LIMIT;
  }
  if (/\b(500|502|503|504)\b|bad gateway|service unavailable|internal server error|overloaded/.test(s)) {
    return ERROR_KIND.SERVER;
  }
  if (/timeout|超时|aborted/.test(s)) return ERROR_KIND.TIMEOUT;
  if (/failed to fetch|networkerror|network|econnrefused|dns|enotfound|certificate|cors|getaddrinfo/.test(s)) {
    return ERROR_KIND.NETWORK;
  }
  if (/\b400\b|bad request|no audio track|invalid_request_error/.test(s)) return ERROR_KIND.BAD_REQUEST;

  return ERROR_KIND.UNKNOWN;
}

/**
 * 生成展示用的错误描述。
 *
 * @param {unknown} e 任意错误（Error / HttpError / 字符串 / null）
 * @param {object} [opts]
 * @param {string} [opts.fallbackTitle] 无法归类时的兜底主文案（默认"请求失败"）
 * @returns {{kind:string, title:string, hint:string, detail:string, status:number}}
 *   detail 为技术细节（原始消息），供"详情"折叠区展示；无细节时为空串。
 */
export function describeError(e, opts = {}) {
  const kind = classifyError(e);
  const preset = MESSAGES[kind] || MESSAGES[ERROR_KIND.UNKNOWN];
  const raw = (e && e.message) ? String(e.message) : (e ? String(e) : '');

  // 归类成功 → 用可读文案，原始消息降级为 detail
  if (kind !== ERROR_KIND.UNKNOWN) {
    return {
      kind,
      title: preset.title,
      hint: preset.hint,
      detail: raw,
      status: (e && typeof e.status === 'number') ? e.status : 0,
    };
  }

  // 无法归类：直接展示原始消息（仍是用户能读的中文业务错误，如"PPT 没有幻灯片内容"）
  return {
    kind,
    title: raw || opts.fallbackTitle || preset.title,
    hint: '',
    detail: '',
    status: (e && typeof e.status === 'number') ? e.status : 0,
  };
}

/**
 * 单行紧凑版本（用于状态条、toast 等只能放一行文字的地方）。
 * 有技术细节时以「（详情：…）」截断追加，避免整屏 JSON。
 *
 * @param {unknown} e
 * @param {number} [detailMax=60] 追加的技术细节最大长度，0 表示不追加
 */
export function formatErrorLine(e, detailMax = 60) {
  const d = describeError(e);
  if (!d.detail || !detailMax) return d.title;
  const brief = d.detail.length > detailMax ? d.detail.slice(0, detailMax) + '…' : d.detail;
  return `${d.title}（${brief}）`;
}
