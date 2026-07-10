// features/placeholders.js
// 未实现模块的接口占位。仅定义契约与 TODO，方便后续逐个补，不实现具体逻辑。
// 这些扩展点应保持稳定，未来实现时替换内部即可，不破坏上层调用。

/**
 * 1) 通用可视化工作流编排器
 * TODO: 定义节点/边/执行引擎接口。当前仅占位。
 * 未来：节点 = 一个 feature 或 connector；编排器按 DAG 顺序执行并传递上下文。
 */
export class WorkflowEngine {
  // TODO: registerNode / connect / run(graph, input)
  async run() {
    throw new Error('[WorkflowEngine] 尚未实现');
  }
}

/**
 * 2) 完整自主 Agent（多步骤规划执行）
 * TODO: 规划-执行-反思循环。当前仅占位。
 */
export class Agent {
  // TODO: plan(goal) / step() / reflect()
  async run() {
    throw new Error('[Agent] 尚未实现');
  }
}

/**
 * 3) 动态加载的 Skill 插件系统
 * TODO: 从远程/本地加载 skill 脚本并注册到 registerAdapter / WorkflowEngine。
 */
export class SkillLoader {
  // TODO: load(skillUrl) / enable(id) / disable(id)
  async load() {
    throw new Error('[SkillLoader] 尚未实现');
  }
}

/**
 * 4) PPT 生成：结构化大纲 JSON -> 导出文件
 * TODO: 定义 Outline JSON schema，未来对接 pptx 生成库。
 * @typedef {Object} Outline 未来定义：{ title, slides: [{ heading, bullets[] }] }
 */
export class PptExporter {
  /**
   * @param {any} outline
   * @returns {Promise<Blob>} 导出的 pptx 文件
   */
  // TODO: 实现 outline -> pptx
  async export() {
    throw new Error('[PptExporter] 尚未实现');
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
