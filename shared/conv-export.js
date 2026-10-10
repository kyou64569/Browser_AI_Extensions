// shared/conv-export.js
// 会话导出：把会话对象转成 Markdown（人类可读、可归档）。
// 纯函数、不碰 DOM / chrome API，可在 Node 下单测；下载动作由 preview.js 负责。
//
// 会话对象结构与 preview.js 的持久化格式一致：
//   { id, title, createdAt, updatedAt, messages: [{role, content, tool?}] }
// tool 消息为自动化 Agent 的工具调用记录 {name, args, ok, summary?, error?}。

/**
 * 会话消息（与 preview.js 持久化格式对齐）
 * @typedef {Object} ConvMessage
 * @property {string} role         'user' | 'assistant'
 * @property {string} [content]    文本内容（tool 消息可为空）
 * @property {{name?:string, args?:Object, ok?:boolean, summary?:string, error?:string}} [tool] 工具调用记录
 * @property {{total?:number, items?:Array<{name?:string, phase?:string, ms?:number, thinking?:string, text?:string, error?:string}>}} [subs] 多模型协作的子模型明细
 */

/**
 * 会话对象（与 preview.js 持久化格式对齐）
 * @typedef {Object} Conversation
 * @property {string} [id]
 * @property {string} [title]
 * @property {number|string} [createdAt] 创建时间（时间戳或 ISO 字符串）
 * @property {number|string} [updatedAt] 更新时间（时间戳或 ISO 字符串）
 * @property {ConvMessage[]} [messages]
 */

/**
 * 协作模式下单个子模型的运行明细（实时采集与持久化共用同一形状）
 * @typedef {Object} SubModelRecord
 * @property {string} [name] 模型名
 * @property {string} [phase] 'start' 进行中 | 'done' 完成 | 'empty' 跑完但零正文 | 'error' 失败
 * @property {number} [ms] 耗时
 * @property {string} [thinking] 思考全文（持久化时按上限截断）
 * @property {string} [text] 返回正文（持久化时按上限截断）
 * @property {string} [error] 失败原因
 * @property {string} [reason] phase='empty' 时的成因（额度被思考占满 / 厂商截断 / 无输出）
 */

/**
 * 子模型明细的持久化预算。会话是整份写进 storage.local 的（无配额管理，很快写爆），
 * 而协作模式一次要存 N 个子模型的思考全文，单个思考动辄上万字——不封顶的话一条会话
 * 就能顶掉整个存储。按「条数 × 单条长度」封顶，最坏情况与主模型思考的上限同量级：
 * MAX_PERSIST_SUBS × (SUB_THINK + SUB_TEXT) = 6 × 3000 = 18000 字。
 */
export const MAX_PERSIST_SUBS = 6;
export const MAX_PERSIST_SUB_THINK_CHARS = 1000;
export const MAX_PERSIST_SUB_TEXT_CHARS = 2000;

/** 尾部截断标记 */
const CLIP_MARK = '…（已截断）';

/**
 * 尾部截断并留标记：让回放与导出能看出「这不是全文」，而不是静默少一段。
 * 截断后的长度不超过 max，因此对同一份数据重复截断是幂等的——会话每轮都会整份重写，
 * 非幂等的话「已截断」标记会每轮叠一次，把内容越截越长。
 */
function clip(s, max) {
  const str = String(s == null ? '' : s);
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - CLIP_MARK.length)) + CLIP_MARK;
}

/** 可持久化的子模型阶段。认不出的值一律按 'done' 收，别让脏数据进会话 */
const SUB_PHASES = new Set(['start', 'done', 'empty', 'error']);

/**
 * 把协作模式的子模型运行明细裁成可持久化形态。
 * 超出条数上限的后续子模型不再记录（total 仍保留真实总数，界面能看出「只记了前若干个」）。
 * @param {{total?:number, items?:SubModelRecord[]}|SubModelRecord[]} [subs] 原始明细（数组或 {total,items}）
 * @returns {{total:number, items:SubModelRecord[]}|undefined} 无可记录内容时返回 undefined
 */
export function trimSubsForPersist(subs) {
  const items = Array.isArray(subs) ? subs : (subs && subs.items);
  if (!Array.isArray(items) || !items.length) return undefined;
  const total = (subs && !Array.isArray(subs) && Number.isFinite(subs.total)) ? subs.total : items.length;
  const out = [];
  for (const s of items.slice(0, MAX_PERSIST_SUBS)) {
    if (!s || typeof s !== 'object') continue;
    const rec = { name: String(s.name || ''), phase: SUB_PHASES.has(s.phase) ? s.phase : 'done' };
    if (Number.isFinite(s.ms)) rec.ms = Math.max(0, Math.round(s.ms));
    if (s.error) rec.error = clip(s.error, 300);
    if (s.reason) rec.reason = clip(s.reason, 200);
    const think = clip(s.thinking || '', MAX_PERSIST_SUB_THINK_CHARS);
    const text = clip(s.text || '', MAX_PERSIST_SUB_TEXT_CHARS);
    if (think) rec.thinking = think;
    if (text) rec.text = text;
    out.push(rec);
  }
  return out.length ? { total, items: out } : undefined;
}

/**
 * 生成文件名安全的一段文本：去掉文件系统非法字符与首尾空白。
 * @param {string} s
 * @returns {string}
 */
export function safeFilename(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || '未命名会话';
}

/**
 * 把单条消息渲染为 Markdown 行数组。
 * @param {ConvMessage} m
 * @returns {string[]}
 */
function messageToLines(m) {
  if (m.tool) {
    const lines = [`### 🛠 工具调用：${m.tool.name || '未知'}（${m.tool.ok ? '成功' : '失败'}）`, '', '```json', JSON.stringify(m.tool.args || {}, null, 2), '```'];
    if (m.tool.summary) lines.push('', `结果：${m.tool.summary}`);
    if (m.tool.error) lines.push('', `错误：${m.tool.error}`);
    return lines;
  }
  const who = m.role === 'user' ? '👤 用户' : m.role === 'assistant' ? '🤖 AI' : m.role;
  const lines = [`## ${who}`, '', m.content || ''];
  // 多模型协作：把每个子模型的思考与返回一并存档（内容已按持久化预算截断）
  const subs = m.subs && Array.isArray(m.subs.items) ? m.subs.items : (Array.isArray(m.subs) ? m.subs : null);
  if (subs && subs.length) {
    const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const total = (m.subs && m.subs.total) || subs.length;
    lines.push('', `**多模型协作 · 子模型 ${subs.length}/${total} 条记录**`, '');
    for (const s of subs) {
      const state = s.phase === 'error' ? '失败' : s.phase === 'start' ? '未完成' : s.phase === 'empty' ? '无正文' : '完成';
      const head = `- ${s.name || '未命名'}（${state}${Number.isFinite(s.ms) ? ` · ${s.ms}ms` : ''}）`;
      lines.push(s.error ? `${head}：${flat(s.error)}` : (s.reason ? `${head}：${flat(s.reason)}` : head));
      if (s.thinking) lines.push(`  - 思考：${flat(s.thinking)}`);
      if (s.text) lines.push(`  - 返回：${flat(s.text)}`);
    }
  }
  return lines;
}

/**
 * 会话 -> Markdown 文本。
 * @param {Conversation|null} conv 会话对象（可为空字段，函数需健壮）
 * @param {object} [opts]
 * @param {Date|number|string} [opts.exportedAt] 导出时间（默认取当前时间）
 * @returns {string}
 */
export function conversationToMarkdown(conv, opts = {}) {
  const title = (conv && conv.title) || '未命名会话';
  const exportedAt = opts.exportedAt != null ? new Date(opts.exportedAt) : new Date();
  const lines = [`# ${title}`, ''];

  const fmt = (d) => (d && !isNaN(d.getTime())) ? d.toLocaleString('zh-CN') : '';
  const created = conv && conv.createdAt != null ? new Date(conv.createdAt) : null;
  const header = ['导出时间：' + (fmt(exportedAt) || '未知'), created ? `创建时间：${fmt(created)}` : '']
    .filter(Boolean).join('　');
  if (header) lines.push(`> ${header}`, '');

  for (const m of (conv && conv.messages) || []) {
    if (!m) continue;
    lines.push(...messageToLines(m), '');
  }
  return lines.join('\n').replace(/\n{3,}$/,'\n');
}
