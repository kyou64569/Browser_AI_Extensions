// features/placeholders.js
// 未实现模块的接口占位。仅定义契约与 TODO，方便后续逐个补，不破坏上层调用。

// 已实现的模块：
//   - WorkflowEngine：见 features/workflow.js
//   - Agent：见 features/agent.js
//   - PptExporter：见 features/ppt-exporter.js

/**
 * 1) 动态加载的 Skill 插件系统
 * TODO: 从远程/本地加载 skill 脚本并注册到 registerAdapter / WorkflowEngine。
 */
export class SkillLoader {
  // TODO: load(skillUrl) / enable(id) / disable(id)
  async load() {
    throw new Error('[SkillLoader] 尚未实现');
  }
}

/**
 * 5) 网页自动化操作：读取 DOM -> 模型返回操作指令 -> 执行
 * TODO: 定义 Action 指令格式（click/type/scroll...）与执行器。不实现具体执行逻辑。
 * @typedef {Object} DomAction 未来定义：{ type:'click'|'type'|'scroll', selector, value }
 */
export class WebAutomator {
  /**
   * @param {string} instruction
   * @returns {Promise<import('./message.js').DomAction[]>} 模型返回的操作序列
   */
  // TODO: 读取 DOM -> 拼接 prompt -> 调用模型 -> 解析为 DomAction[]
  async plan() {
    throw new Error('[WebAutomator] 尚未实现');
  }
  // TODO: execute(actions) 在 content script 中执行
}
