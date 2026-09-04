// connectors/knowledge-base.js
// 知识库连接器抽象接口。上层功能模块（网页总结/划词）只依赖本接口，
// 不关心背后是本地知识库还是在线知识库（NotebookLM/腾讯 ima 等）。
//
// 检索能力由知识库服务本身提供，插件内不实现向量检索。
// 回答问题时，把 search() 返回的相关片段拼进 prompt 上下文即可。

/**
 * 检索返回的单条片段
 * @typedef {Object} KbChunk
 * @property {string} id       片段唯一 id
 * @property {string} content 片段正文
 * @property {number} [score]  相关度（0~1），可选
 * @property {string} [source] 来源（文档名/URL），可选
 * @property {string} [title]  文档标题（部分连接器提供），可选
 */

/**
 * @interface KnowledgeBaseConnector
 */
export class KnowledgeBaseConnector {
  /**
   * 检索
   * @param {string} query
   * @param {Object} [opts] 可选：topK、过滤条件等
   * @returns {Promise<KbChunk[]>}
   */
   
  async search(query, opts) {
    throw new Error('search() 未实现');
  }

  /**
   * 写入
   * @param {string} content
   * @param {Object} [meta] 可选元数据
   * @returns {Promise<boolean>} 是否成功
   */
   
  async add(content, meta) {
    throw new Error('add() 未实现');
  }
}
