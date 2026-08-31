// shared/prompt-templates.js
// Prompt 模板库：内置常用模板 + 用户自定义模板的变量插值。
// 纯函数、零依赖、不碰 DOM / chrome API，可在 Node 下单测。
// 存储由 preview.js 负责（chrome.storage.local，key = promptTemplates）。

/**
 * 模板变量出现的位置（用于 UI 提示，不参与插值逻辑本身）
 * @typedef {'page_title'|'selection'|'input'|'date'} TemplateVarName
 */

/**
 * @typedef {Object} PromptTemplate
 * @property {string} id          唯一 id（内置模板以 'builtin:' 前缀开头）
 * @property {string} name        模板名（列表展示）
 * @property {string} content     模板正文，支持 {{page_title}} / {{selection}} / {{input}} / {{date}} 变量
 * @property {boolean} [builtin]  是否内置（内置模板不可删除，可复制后修改）
 */

/** 变量说明（UI 展示用） */
export const TEMPLATE_VARS = {
  page_title: '当前网页标题',
  selection: '选中的文本',
  input: '用户输入的内容',
  date: '今天的日期',
};

/** 内置模板（只读；用户可复制为自定义模板后修改） */
export const BUILTIN_TEMPLATES = [
  {
    id: 'builtin:summarize',
    name: '总结网页',
    builtin: true,
    content: '请总结以下网页的核心内容，按「一句话概括 → 关键要点（分点） → 结论/建议」组织，保持简洁：\n\n网页标题：{{page_title}}\n\n{{input}}',
  },
  {
    id: 'builtin:translate-polish',
    name: '中译英润色',
    builtin: true,
    content: '把下面的内容翻译成流畅、地道的英文，保留原意并适当润色，只输出译文：\n\n{{input}}',
  },
  {
    id: 'builtin:code-review',
    name: '代码审查',
    builtin: true,
    content: '请审查下面的代码，从 正确性 / 边界条件 / 性能 / 可读性 四个角度给出问题清单和改进建议，按严重程度排序：\n\n{{input}}',
  },
  {
    id: 'builtin:explain-code',
    name: '解释代码',
    builtin: true,
    content: '请逐段解释下面的代码在做什么，指出关键逻辑与潜在的坑：\n\n{{input}}',
  },
  {
    id: 'builtin:email-polish',
    name: '邮件润色',
    builtin: true,
    content: '请把下面的内容润色成一封礼貌、专业的邮件，保持原意，输出时包含合适的称呼与落款占位：\n\n{{selection}}',
  },
];

/**
 * 对模板正文做变量插值。
 * - 未知变量名原样保留（不吞内容），方便发现拼写问题
 * - 值为 undefined/null 时替换为空串
 * - 大小写敏感：{{DATE}} 不算变量
 *
 * @param {string} content 模板正文
 * @param {Record<string, string|undefined|null>} [vars] 变量取值
 * @returns {{text: string, usedVars: string[]}} 插值结果 + 实际命中的变量名列表
 */
export function applyTemplate(content, vars = {}) {
  if (typeof content !== 'string') return { text: '', usedVars: [] };
  const usedVars = [];
  const text = content.replace(/\{\{(\w+)\}\}/g, (raw, name) => {
    if (!(name in vars) || vars[name] == null) {
      if (!(name in vars)) return raw; // 未知变量名原样保留
      return '';
    }
    if (!usedVars.includes(name)) usedVars.push(name);
    return String(vars[name]);
  });
  return { text, usedVars };
}

/**
 * 列出模板中引用的已知变量（去重），供 UI 提示"该模板需要哪些输入"。
 * @param {string} content
 * @returns {TemplateVarName[]}
 */
export function listTemplateVars(content) {
  if (typeof content !== 'string') return [];
  const known = new Set(Object.keys(TEMPLATE_VARS));
  const found = [];
  for (const m of content.matchAll(/\{\{(\w+)\}\}/g)) {
    if (known.has(m[1]) && !found.includes(m[1])) found.push(/** @type {TemplateVarName} */ (m[1]));
  }
  return found;
}

/**
 * 把内置模板复制为可编辑的自定义模板。
 * @param {PromptTemplate} tpl
 * @returns {PromptTemplate} 新对象（id 随机生成，builtin: false）
 */
export function cloneTemplate(tpl) {
  return {
    id: 'tpl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: (tpl.name || '未命名') + '（副本）',
    content: tpl.content || '',
    builtin: false,
  };
}

/**
 * 校验一条自定义模板，返回错误信息数组（空数组 = 合法）。
 * @param {{id?:string, name?:string, content?:string}} tpl
 * @returns {string[]}
 */
export function validateTemplate(tpl) {
  const errs = [];
  if (!tpl || typeof tpl !== 'object') return ['模板必须是对象'];
  if (!tpl.name || !String(tpl.name).trim()) errs.push('模板名称不能为空');
  if (!tpl.content || !String(tpl.content).trim()) errs.push('模板内容不能为空');
  if (String(tpl.name || '').length > 40) errs.push('模板名称过长（≤40 字）');
  return errs;
}
