// core/message.js
// 统一的内部消息格式。不绑定任何厂商，上层只感知这里的定义。
// 所有 adapter 负责把本结构 <-> 厂商格式 互转。

/**
 * 消息角色
 * @typedef {'system'|'user'|'assistant'} Role
 */

/**
 * 多模态附件（图片等）。统一用 base64 或远程 URL 表达，不绑定厂商字段。
 * @typedef {Object} Attachment
 * @property {'image'} type      附件类型，当前仅 image；后续可扩展 audio/file
 * @property {string} data       图片数据：data URL（data:image/png;base64,...）或 https URL
 * @property {string} [mime]     可选 MIME，如 'image/png'
 */

/**
 * 单条消息
 * @typedef {Object} Message
 * @property {Role} role
 * @property {string} content      文本内容
 * @property {Attachment[]} [attachments]  可选多模态附件（仅 user 消息使用）
 */

/**
 * 一次请求的归一化输入
 * @typedef {Object} ChatRequest
 * @property {Message[]} messages
 * @property {Object}   [options]  可选参数：temperature / maxTokens 等，adapter 自行忽略不支持的
 * @property {boolean}  [stream]   是否要求流式
 * @property {AbortSignal} [signal] 取消信号
 * @property {string} [kind] 调用类型标注（chat/summarize/translate/agent…），仅用于用量统计
 */

/**
 * 归一化响应片段（流式与非流式共用）
 * @typedef {Object} ChatResponseChunk
 * @property {string}   delta      增量文本（非流式时整段一次给出）
 * @property {boolean}  done       是否结束
 * @property {Object}   [meta]     厂商原始 meta（usage / model / id 等），透传不解析
 */

/**
 * 厂商类型枚举
 * @typedef {'openai'|'anthropic'|'gemini'|'ollama'} VendorType
 */

/** @type {VendorType[]} 受支持的厂商 */
export const VENDORS = ['openai', 'anthropic', 'gemini', 'ollama'];

/**
 * 把任意消息数组序列化为可读文本（便于日志/调试，不参与实际调用）
 * @param {Message[]} messages
 * @returns {string}
 */
export function dumpMessages(messages) {
  return messages.map(m => `[${m.role}] ${m.content}`).join('\n');
}
