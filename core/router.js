// core/router.js
// 任务路由：先做成简单规则表，不做真正的 MoE 调度。
// 设计上 selectModel 接收 taskType + requirements，返回候选模型列表（已排序）。
// 未来可把内部 _strategy 替换为更复杂的策略（成本/延迟/LRU 等），上层无需改动。

/**
 * 任务类型
 * @typedef {'summarize'|'translate'|'explain'|'ask'|'generic'} TaskType
 */

/**
 * 路由要求
 * @typedef {Object} Requirements
 * @property {boolean} [vision]   需要视觉能力
 * @property {boolean} [stream]   需要流式
 * @property {boolean} [preferFree] 优先免费额度大的
 * @property {(c:object)=>boolean} [custom] 自定义筛选函数（扩展点）
 */

/**
 * 规则表：任务类型 -> 默认要求模板。后续可在此扩展每个任务的偏好。
 * @type {Record<TaskType, Requirements>}
 */
const RULES = {
  summarize: { stream: true },
  translate: { stream: true },
  explain: { stream: true },
  ask: { stream: true, vision: false },
  generic: {},
};

export class Router {
  /**
   * @param {import('./model-config.js').ModelConfig[]} models 已启用的模型列表
   */
  constructor(models = []) {
    this.models = models;
  }

  /**
   * 设置模型列表
   * @param {import('./model-config.js').ModelConfig[]} models
   */
  setModels(models) {
    this.models = models;
  }

  /**
   * 从模型列表按条件筛选并排序。
   * @param {TaskType} taskType
   * @param {Partial<Requirements>} [extra] 调用方额外要求，覆盖/补充规则
   * @returns {import('./model-config.js').ModelConfig[]} 候选列表（按优先级排序）
   */
  selectModel(taskType, extra = {}) {
    const req = { ...(RULES[taskType] || {}), ...extra };
    let list = this.models.filter(m => m.enabled !== false);

    if (req.vision) list = list.filter(m => m.supportsVision);
    if (req.stream) list = list.filter(m => m.supportsStream);
    if (req.custom) list = list.filter(req.custom);

    // 简单排序策略：preferFree 优先排前面（此处以 vendor==='ollama' 视为免费本地）
    if (req.preferFree) {
      list = [...list].sort((a, b) => (a.vendor === 'ollama' ? -1 : 0) - (b.vendor === 'ollama' ? -1 : 0));
    }
    return list;
  }
}
