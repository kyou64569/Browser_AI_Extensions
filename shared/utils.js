// shared/utils.js
// 共享工具函数

/**
 * 清洗 API Base URL：去空白 / BOM / 行尾斜杠 / 已含路径后缀。
 * 防范因 copy-paste 带入的不可见字符（空格、BOM、换行等）导致 URL 编码后 HTTP 404；
 * 同时处理用户粘贴完整接口地址（如 .../v1/chat/completions）到 apiBase 的常见误用。
 * @param {*} raw 任意输入；非字符串返回空串
 * @returns {string} 已清洗、去除尾部斜杠、不包含已知子路径的纯 Base URL
 */
export function normalizeApiBase(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw
    .replace(/^\uFEFF/, '')   // 去 BOM（Windows 保存的 UTF-8 BOM）
    .trim();
  // 去掉尾部斜杠
  s = s.replace(/\/+$/, '');
  // 去掉用户误填的已知子路径（避免双叠成 /chat/completions/chat/completions）
  s = s.replace(/\/chat\/completions\/?$/, '');
  s = s.replace(/\/messages\/?$/, '');
  s = s.replace(/\/api\/chat\/?$/, '');
  s = s.replace(/\/models\/?$/, '');
  return s;
}

/**
 * 检查模型配置是否有有效凭证（容忍部分字段的配置对象，缺字段按无凭证处理）
 * @param {{vendor?:string, apiKey?:string, [k:string]:any}} m
 * @returns {boolean}
 */
export function hasCred(m) {
  return m.vendor === 'ollama' || !!(m.apiKey && String(m.apiKey).trim().length > 0);
}

/**
 * 从模型配置中提取采样参数，作为 ChatRequest.options 透传给适配器。
 * 仅当字段为合法数值时才包含，避免把 undefined 发往 API（保持各厂商默认行为）。
 * @param {Partial<import('../core/model-config.js').ModelConfig>} [m] 可为部分字段（函数逐字段容错判断）
 * @returns {Record<string, any>} 仅含合法数值选项；thinkingStrength 为字符串档位
 */
export function optionsFromModel(m = {}) {
  const o = {};
  if (typeof m.temperature === 'number') o.temperature = m.temperature;
  if (typeof m.top_p === 'number') o.top_p = m.top_p;
  if (typeof m.maxTokens === 'number') o.maxTokens = m.maxTokens;
  // 思考强度：仅 low/medium/high 透传给适配器。
  // 'default'（使用厂商默认）与未启用思考等效，不发任何思考参数；
  // 'off'（显式关闭）不经过模型配置透传，只在聊天页下拉显式选择时经 opts 直达适配器
  //（GLM/Qwen/Ollama 风格下适配器会发禁用参数）。
  // 是否发送、发哪种思考参数由各适配器按 thinkingStyle 决定（shared/thinking.js）：
  // 'auto' 识别不出的模型解析为 'none'——不发任何参数，因此这里不再需要
  // 旧 reasoningEffortSupported 门槛来防普通模型 HTTP 400。
  const s = m.thinkingStrength;
  const wantThink = m.supportsThinking && s && s !== 'off' && s !== 'default';
  if (wantThink) o.thinkingStrength = s;
  return o;
}

/**
 * 判断厂商的结束原因是否为「输出被 token 上限截断」。
 * 各厂商取值：openai length / anthropic max_tokens / gemini MAX_TOKENS / ollama length。
 * @param {string} [reason] 适配器透出的 finishReason（原始厂商值）
 * @returns {boolean}
 */
export function isTruncatedFinish(reason) {
  return !!reason && /length|max_tokens/i.test(String(reason));
}

/**
 * 思考强度下拉选项，按厂商动态生成。
 * 'default'（不传任何思考参数、由厂商/模型按默认行为决定）与 'off'（显式关闭：
 * GLM/Qwen/Ollama 等混合推理模型需要发禁用参数才关得掉）是两种不同语义。
 * OpenAI 兼容（reasoning_effort）与 Anthropic 兼容（thinking budget）展示不同档位。
 * @param {string} vendor
 * @returns {{value:string, label:string}[]}
 */
export function thinkingLevels(vendor) {
  if (vendor === 'anthropic') {
    return [
      { value: 'default', label: '思考：默认（不传参数）' },
      { value: 'off', label: '思考：关闭' },
      { value: 'low', label: '思考：低 (2K)' },
      { value: 'medium', label: '思考：中 (8K)' },
      { value: 'high', label: '思考：高 (16K)' },
    ];
  }
  // openai / gemini / ollama 等：通用档位（OpenAI 走 reasoning_effort）
  return [
    { value: 'default', label: '思考：默认（不传参数）' },
    { value: 'off', label: '思考：关闭' },
    { value: 'low', label: '思考：低' },
    { value: 'medium', label: '思考：中' },
    { value: 'high', label: '思考：高' },
  ];
}
