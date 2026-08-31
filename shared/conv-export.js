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
  return [`## ${who}`, '', m.content || ''];
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
