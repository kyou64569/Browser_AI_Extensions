// features/workflow.js
// 工作流引擎：DAG 编排执行器。
//
// 用途：将多个功能节点（提取、总结、翻译、知识库检索、自动化操作等）
// 串联为可复用的自动化流程，支持条件分支和上下文传递。
//
// 使用方式：
//   const engine = new WorkflowEngine();
//   engine.registerNode('extract', extractHandler);
//   engine.registerNode('summarize', summarizeHandler);
//   engine.registerNode('translate', translateHandler);
//   engine.registerNode('kb_search', kbSearchHandler);
//   engine.registerNode('automate', automateHandler);
//   engine.registerNode('condition', conditionHandler);
//   engine.registerNode('export_md', exportMdHandler);
//
//   const result = await engine.run(graph, input, (event) => {
//     console.log(event.nodeId, event.status);
//   });

/**
 * 节点执行上下文：每个节点都可以读写
 * @typedef {Object} WorkflowContext
 * @property {any} input 工作流初始输入
 * @property {Map<string, any>} results 各节点的输出结果
 * @property {Map<string, string>} errors 各节点的错误信息
 * @property {Map<string, any>} globals 跨节点共享数据（如 models、config）
 */

/**
 * 工作流节点定义
 * @typedef {Object} WorkflowNode
 * @property {string} id 节点唯一标识
 * @property {string} type 节点类型（对应已注册的 handler）
 * @property {object} [config] 节点配置参数
 * @property {boolean} [continueOnError=false] 出错时是否继续执行后续节点
 */

/**
 * 工作流边定义（依赖关系）
 * @typedef {Object} WorkflowEdge
 * @property {string} from 源节点 id
 * @property {string} to 目标节点 id
 * @property {string} [port] 源节点的输出端口名（多输出时用，默认 'default'）
 */

/**
 * 工作流图定义
 * @typedef {Object} WorkflowGraph
 * @property {WorkflowNode[]} nodes 节点列表
 * @property {WorkflowEdge[]} edges 边列表
 */

/**
 * 进度事件
 * @typedef {Object} ProgressEvent
 * @property {string} nodeId 节点 id
 * @property {'pending'|'running'|'done'|'error'|'skipped'} status 状态
 * @property {any} [result] 输出结果
 * @property {string} [error] 错误信息
 */

export class WorkflowEngine {
  constructor() {
    /** @type {Map<string, (input: any, config: object, ctx: WorkflowContext) => Promise<any>>} */
    this.nodeTypes = new Map();
    /** @type {Map<string, any>} 注入的全局 API/模型，run() 会透传给节点 ctx.globals */
    this.globals = new Map();
  }

  /**
   * 注册节点类型
   * @param {string} type 节点类型名
   * @param {(input: any, config: object, ctx: WorkflowContext) => Promise<any>} handler 处理函数
   */
  registerNode(type, handler) {
    if (typeof handler !== 'function') throw new Error(`节点 "${type}" 的 handler 必须是函数`);
    this.nodeTypes.set(type, handler);
  }

  /**
   * 批量注册节点
   * @param {Map<string, Function> | object} handlers
   */
  registerNodes(handlers) {
    const entries = handlers instanceof Map ? handlers.entries() : Object.entries(handlers);
    for (const [type, handler] of entries) {
      this.registerNode(type, handler);
    }
  }

  /**
   * 执行工作流
   * @param {WorkflowGraph} graph 工作流图
   * @param {any} input 初始输入
   * @param {(event: ProgressEvent) => void} [onProgress] 进度回调
   * @returns {Promise<WorkflowContext>} 执行上下文（含所有节点结果）
   */
  async run(graph, input, onProgress) {
    const ctx = {
      input,
      results: new Map(),
      errors: new Map(),
      globals: this.globals || new Map(),
    };

    const { nodes, edges } = this._validateGraph(graph);
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const statusMap = new Map(nodes.map(n => [n.id, 'pending']));

    const report = (nodeId, status, extra = {}) => {
      statusMap.set(nodeId, status);
      onProgress?.({ nodeId, status, ...extra });
    };

    // 拓扑排序确定执行顺序
    const sorted = this._topologicalSort(nodes, edges);

    for (const nodeId of sorted) {
      const node = nodeMap.get(nodeId);

      // 检查上游是否有错误（如果有且未设置 continueOnError，跳过）
      if (this._shouldSkip(nodeId, nodeMap, edges, ctx)) {
        report(nodeId, 'skipped', { error: '上游节点失败，跳过' });
        continue;
      }

      report(nodeId, 'running');

      const handler = this.nodeTypes.get(node.type);
      if (!handler) {
        const error = `未知节点类型: ${node.type}`;
        ctx.errors.set(nodeId, error);
        report(nodeId, 'error', { error });
        if (!node.continueOnError) break;
        continue;
      }

      try {
        const nodeInput = this._resolveInput(nodeId, nodeMap, edges, ctx);
        const result = await handler(nodeInput, node.config || {}, ctx);
        ctx.results.set(nodeId, result);
        report(nodeId, 'done', { result });
      } catch (e) {
        const error = e?.message || String(e);
        ctx.errors.set(nodeId, error);
        report(nodeId, 'error', { error });
        if (!node.continueOnError) break;
      }
    }

    return ctx;
  }

  /**
   * 验证图结构完整性
   * @private
   */
  _validateGraph(graph) {
    const nodes = graph.nodes || [];
    const edges = graph.edges || [];
    const nodeIds = new Set(nodes.map(n => n.id));

    if (!nodes.length) throw new Error('工作流至少需要一个节点');

    for (const node of nodes) {
      if (!node.id) throw new Error('节点缺少 id');
      if (!node.type) throw new Error(`节点 "${node.id}" 缺少 type`);
    }

    for (const edge of edges) {
      if (!nodeIds.has(edge.from)) throw new Error(`边引用了不存在的节点: ${edge.from}`);
      if (!nodeIds.has(edge.to)) throw new Error(`边引用了不存在的节点: ${edge.to}`);
    }

    return { nodes, edges };
  }

  /**
   * DAG 拓扑排序（Kahn 算法）
   * @private
   */
  _topologicalSort(nodes, edges) {
    const nodeIds = nodes.map(n => n.id);
    const inDegree = new Map(nodeIds.map(id => [id, 0]));
    const adjList = new Map(nodeIds.map(id => [id, []]));

    for (const edge of edges) {
      adjList.get(edge.from).push(edge.to);
      inDegree.set(edge.to, inDegree.get(edge.to) + 1);
    }

    const queue = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const sorted = [];
    while (queue.length) {
      const id = queue.shift();
      sorted.push(id);
      for (const next of adjList.get(id)) {
        inDegree.set(next, inDegree.get(next) - 1);
        if (inDegree.get(next) === 0) queue.push(next);
      }
    }

    if (sorted.length !== nodeIds.length) {
      throw new Error('工作流存在循环依赖，无法拓扑排序');
    }

    return sorted;
  }

  /**
   * 判断是否应跳过当前节点
   * @private
   */
  _shouldSkip(nodeId, nodeMap, edges, ctx) {
    const upstreamEdges = edges.filter(e => e.to === nodeId);
    for (const edge of upstreamEdges) {
      const upstream = nodeMap.get(edge.from);
      if (ctx.errors.has(edge.from) && !upstream?.continueOnError) {
        return true;
      }
    }
    return false;
  }

  /**
   * 解析当前节点的输入（从上游节点收集输出）
   * @private
   */
  _resolveInput(nodeId, nodeMap, edges, ctx) {
    const upstreamEdges = edges.filter(e => e.to === nodeId);

    if (upstreamEdges.length === 0) {
      return ctx.input;
    }

    if (upstreamEdges.length === 1) {
      const fromId = upstreamEdges[0].from;
      return ctx.results.has(fromId) ? ctx.results.get(fromId) : ctx.input;
    }

    // 多个上游：合并为对象 { nodeId: result }
    const combined = {};
    for (const edge of upstreamEdges) {
      const key = edge.port || edge.from;
      combined[key] = ctx.results.get(edge.from);
    }
    return combined;
  }
}

// ============================================================
// 内置节点实现
// ============================================================

/**
 * 提取节点：从当前页面或 URL 提取正文
 */
export async function extractNode(input, config, ctx) {
  const { extractMain } = ctx.globals.get('api') || {};
  if (typeof extractMain === 'function') {
    return await extractMain(input, config);
  }
  return input;
}

/**
 * 总结节点：对文本进行摘要
 */
export async function summarizeNode(input, config, ctx) {
  const { summarize } = ctx.globals.get('api') || {};
  if (typeof summarize === 'function') {
    return await summarize(input, config, ctx.globals.get('models'));
  }
  return typeof input === 'string' ? input : JSON.stringify(input);
}

/**
 * 翻译节点：翻译文本到目标语言
 */
export async function translateNode(input, config, ctx) {
  const { translate } = ctx.globals.get('api') || {};
  if (typeof translate === 'function') {
    const texts = Array.isArray(input) ? input : [input];
    return await translate(texts, config.targetLang || '中文（简体）', config.modelId, ctx.globals.get('models'));
  }
  return input;
}

/**
 * 知识库检索节点
 */
export async function kbSearchNode(input, config, ctx) {
  const { kbSearch } = ctx.globals.get('api') || {};
  if (typeof kbSearch === 'function') {
    const query = typeof input === 'string' ? input : input?.content || '';
    return await kbSearch(query, config);
  }
  return { chunks: [], error: '知识库 API 不可用' };
}

/**
 * 条件分支节点：根据条件决定输出方向
 */
export async function conditionNode(input, config, ctx) {
  const { field, operator, value } = config;
  let targetValue = input;
  if (field && typeof input === 'object') {
    targetValue = field.split('.').reduce((obj, k) => obj?.[k], input);
  }

  let result = false;
  switch (operator) {
    case 'eq': result = targetValue === value; break;
    case 'neq': result = targetValue !== value; break;
    case 'contains': result = String(targetValue).includes(value); break;
    case 'not_empty': result = !!(targetValue && (typeof targetValue !== 'string' || targetValue.trim())); break;
    case 'gt': result = Number(targetValue) > Number(value); break;
    case 'lt': result = Number(targetValue) < Number(value); break;
    default: result = !!targetValue;
  }

  return { ...input, _conditionResult: result };
}

/**
 * 导出 Markdown 节点
 */
export async function exportMdNode(input, config, ctx) {
  const title = config.title || '导出文档';
  const content = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  const markdown = `# ${title}\n\n${content}`;
  return { format: 'markdown', content: markdown, title };
}

/**
 * 等待节点：延迟或等待条件
 */
export async function waitNode(input, config, ctx) {
  if (config.delayMs) {
    await new Promise(r => setTimeout(r, config.delayMs));
  }
  return input;
}

/**
 * 自动化节点：执行网页操作
 */
export async function automateNode(input, config, ctx) {
  const { execTool } = ctx.globals.get('api') || {};
  if (typeof execTool === 'function' && config.tool) {
    return await execTool(config.tool, config.args || {});
  }
  return input;
}

/**
 * PPT 导出节点
 */
export async function exportPptNode(input, config, ctx) {
  const { exportPpt } = ctx.globals.get('api') || {};
  if (typeof exportPpt === 'function') {
    return await exportPpt(input, config);
  }
  return { format: 'pptx', error: 'PPT 导出 API 不可用' };
}

/**
 * 默认内置节点类型集合
 */
export const BUILT_IN_NODES = new Map([
  ['extract', extractNode],
  ['summarize', summarizeNode],
  ['translate', translateNode],
  ['kb_search', kbSearchNode],
  ['condition', conditionNode],
  ['export_md', exportMdNode],
  ['export_ppt', exportPptNode],
  ['wait', waitNode],
  ['automate', automateNode],
]);

/**
 * 创建预配置的工作流引擎（含内置节点）
 */
export function createWorkflowEngine() {
  const engine = new WorkflowEngine();
  engine.registerNodes(BUILT_IN_NODES);
  return engine;
}

/**
 * 预定义工作流模板
 */
export const WORKFLOW_TEMPLATES = {
  summarize_page: {
    name: '网页总结',
    description: '提取正文并生成摘要',
    graph: {
      nodes: [
        { id: 'extract', type: 'extract', config: {} },
        { id: 'summarize', type: 'summarize', config: { maxLength: 500 } },
      ],
      edges: [
        { from: 'extract', to: 'summarize' },
      ],
    },
  },
  translate_page: {
    name: '网页翻译',
    description: '提取正文并翻译',
    graph: {
      nodes: [
        { id: 'extract', type: 'extract', config: {} },
        { id: 'translate', type: 'translate', config: { targetLang: '中文（简体）' } },
      ],
      edges: [
        { from: 'extract', to: 'translate' },
      ],
    },
  },
  research_report: {
    name: '调研报告',
    description: '检索知识库并生成综合报告',
    graph: {
      nodes: [
        { id: 'kb_search', type: 'kb_search', config: {} },
        { id: 'summarize', type: 'summarize', config: { style: 'report' } },
        { id: 'export_md', type: 'export_md', config: { title: '调研报告' } },
      ],
      edges: [
        { from: 'kb_search', to: 'summarize' },
        { from: 'summarize', to: 'export_md' },
      ],
    },
  },
  summarize_to_ppt: {
    name: '总结导出 PPT',
    description: '提取网页正文，生成摘要，导出为 PPT',
    graph: {
      nodes: [
        { id: 'extract', type: 'extract', config: {} },
        { id: 'summarize', type: 'summarize', config: { ppt: true } },
        { id: 'export_ppt', type: 'export_ppt', config: { title: '总结报告' } },
      ],
      edges: [
        { from: 'extract', to: 'summarize' },
        { from: 'summarize', to: 'export_ppt' },
      ],
    },
  },
};
