// background/handlers/agent.js
// 自主 Agent（规划-执行-反思）与工作流引擎（WORKFLOW_RUN）的执行入口。
//
// 两者都是"单条消息内跑 1~5 分钟"的长任务，统一用 withSafetyTimeout 包裹：
// 兜底超时 + 异常不吞 + 保证 sendResponse 恰好调用一次。
// 长任务期间通过 chrome.runtime.sendMessage 广播进度事件（AGENT_PROGRESS / WORKFLOW_PROGRESS）。

import { getModels, getKbState } from '../../shared/storage.js';
import { summarizePage } from '../../features/summarize.js';
import { createKbConnector } from '../../connectors/kb-registry.js';
import { execTool } from '../web-tools.js';
import { hasCred, optionsFromModel } from '../../shared/utils.js';
import { Agent } from '../../features/agent.js';
import { createWorkflowEngine, WORKFLOW_TEMPLATES } from '../../features/workflow.js';
import { PptExporter, parseMarkdownOutline } from '../../features/ppt-exporter.js';
import { FallbackManager } from '../../core/fallback.js';
import { extractMainTextInPage } from '../../shared/extract.js';
import { translateSegments } from './translate.js';
import { resolvePptOpts, sanitizeFilename, exportPptForAutomate } from './ppt.js';
import { withSafetyTimeout } from '../messaging.js';
import { getActiveTab, getRunningAgent, setRunningAgent } from '../state.js';
import { TIMEOUT_AGENT_MS, TIMEOUT_WORKFLOW_MS } from '../../shared/constants.js';

/** 广播进度事件到侧边栏（发送失败静默：侧边栏未打开时无意义） */
function broadcast(type, payload) {
  try {
    chrome.runtime.sendMessage({ type, payload: { ...payload, ts: Date.now() } }, () => { void chrome.runtime.lastError; });
  } catch (_) {}
}

/**
 * AGENT_RUN：规划-执行-反思循环。
 * @param {object} msg
 * @param {{respond:(payload:object)=>void}} ctx
 */
export function handleAgentRun(msg, { respond }) {
  console.log('[Agent-RUN] 收到 AGENT_RUN 消息:', msg.goal?.slice(0, 50));
  return withSafetyTimeout(
    async () => {
      const models = await getModels();
      const enabledModels = models.filter(m => m.enabled !== false);
      if (!enabledModels.length) return { ok: false, error: '未配置可用模型' };

      const chatModel = enabledModels.find(m => m.id === msg.modelId)
        || enabledModels.find(m => m.isPrimary)
        || enabledModels[0];
      if (!hasCred(chatModel)) return { ok: false, error: '模型缺少有效凭证（API Key）' };

      const agent = new Agent({
        models: enabledModels,
        maxSteps: msg.maxSteps || 15,
        chatFn: async (messages, opts) => {
          const fb = new FallbackManager({});
          const candidates = [chatModel, ...enabledModels.filter(m => m !== chatModel)];
          const options = { ...optionsFromModel(chatModel) };
          if (msg.thinkingStrength) options.thinkingStrength = msg.thinkingStrength;
          return fb.callStream(candidates, { messages, stream: false, options });
        },
        execTool: async (tool, args) => {
          if (tool === 'export_ppt') return await exportPptForAutomate(args || {});
          const tab = await getActiveTab();
          if (!tab || !tab.id) return { ok: false, error: '无法获取当前标签页' };
          return await execTool(tab, tool, args || {});
        },
        onEvent: (event) => broadcast('AGENT_PROGRESS', event),
      });
      setRunningAgent(agent);
      try {
        if (msg.signal?.aborted) agent.abort();
        const ctx = msg.context || {};
        if (!ctx.pageInfo?.text) {
          try {
            const tab = await getActiveTab();
            console.log('[Agent-RUN] activeTab:', tab?.id, tab?.url?.slice(0, 60));
            if (tab && tab.id) {
              let pageText = '';
              try {
                const page = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PAGE' });
                pageText = page?.text || '';
                console.log('[Agent-RUN] EXTRACT_PAGE 结果长度:', pageText.length);
              } catch (e1) {
                console.warn('[Agent-RUN] EXTRACT_PAGE 失败:', e1?.message);
                try {
                  const [res] = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: extractMainTextInPage,
                  });
                  pageText = (res?.result) || '';
                  console.log('[Agent-RUN] executeScript 结果长度:', pageText.length);
                } catch (e2) {
                  console.warn('[Agent-RUN] executeScript 也失败:', e2?.message);
                }
              }
              ctx.pageInfo = {
                title: tab.title || '',
                url: tab.url || '',
                text: pageText.slice(0, 8000),
              };
            } else {
              console.warn('[Agent-RUN] 无有效 tab');
            }
          } catch (e) {
            console.error('[Agent-RUN] 提取页面内容异常:', e?.message);
          }
        } else {
          console.log('[Agent-RUN] 已有页面内容，长度:', ctx.pageInfo.text.length);
        }
        const result = await agent.run(msg.goal || '', ctx);
        respond({
          ok: true, ...result,
          _debug: { pageInfoLen: ctx.pageInfo?.text?.length || 0, hasPageInfo: !!ctx.pageInfo?.text },
        });
      } finally {
        setRunningAgent(null);
      }
      return undefined; // 已用 respond 回包，避免重复
    },
    { sendResponse: respond, timeoutMs: TIMEOUT_AGENT_MS, label: 'Agent 执行' }
  );
}

/** AGENT_ABORT：中止运行中的 Agent */
export function handleAgentAbort({ respond }) {
  // 直接调用运行中 Agent 实例的 abort()，使其内部的 this._aborted 置位
  const agent = getRunningAgent();
  if (agent) agent.abort();
  try { chrome.runtime.sendMessage({ type: 'AGENT_PROGRESS', payload: { phase: 'abort' } }, () => { void chrome.runtime.lastError; }); } catch (_) {}
  respond({ ok: true });
  return true;
}

/**
 * WORKFLOW_RUN：DAG 工作流引擎执行。
 * engine.globals 里的 api 对象向工作流节点暴露：extractMain / summarize / translate /
 * kbSearch / execTool / exportPpt。
 * @param {object} msg
 * @param {{respond:(payload:object)=>void}} ctx
 */
export function handleWorkflowRun(msg, { respond }) {
  return withSafetyTimeout(
    async () => {
      const engine = createWorkflowEngine();
      const models = await getModels();
      const enabledModels = models.filter(m => m.enabled !== false);
      const tab = await getActiveTab();
      engine.globals = new Map();
      engine.globals.set('models', enabledModels);
      engine.globals.set('api', {
        extractMain: async () => {
          if (!tab?.id) return '';
          try {
            return await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PAGE' });
          } catch (_) {
            const [res] = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: extractMainTextInPage,
            });
            return { text: (res?.result) || '' };
          }
        },
        summarize: async (input, cfg) => {
          const page = typeof input === 'string' ? { text: input } : (input?.text ? input : { text: JSON.stringify(input) });
          const instruction = cfg?.ppt
            ? '请将内容整理为适合直接制作 PPT 的结构化大纲：用 # 表示每张幻灯片标题，用 - 表示要点；建议 5-10 页，每页 3-6 个要点。' +
              '请在合适的页面使用语义清晰的标题，以便系统自动匹配模板版式：封面页用标题概括主题；目录/议程页标题含「目录」或「大纲」；' +
              '章节/分区页标题含「第X章」「章节」或「Part」；结尾/致谢页标题含「谢谢」「总结」或「联系我们」；其余为内容页（页标题 + 要点）。' +
              '若需要强制某页版式，可在标题行末尾加 @layout=cover|toc|section|content|closing。'
            : '';
          const result = await summarizePage({ models: enabledModels }, page, { stream: false, instruction });
          return result.text;
        },
        translate: async (texts, targetLang, modelId) => {
          const m = enabledModels.find(x => x.id === modelId) || enabledModels.find(x => x.isPrimary) || enabledModels[0];
          return await translateSegments(m, texts, targetLang || '中文（简体）', {});
        },
        kbSearch: async (query, cfg) => {
          const state = await getKbState();
          const kbCfg = state.providers[state.active];
          if (!kbCfg) return { chunks: [], error: '未配置知识库' };
          const kb = createKbConnector(kbCfg.type, kbCfg.cfg);
          if (!kb) return { chunks: [], error: '知识库连接器不可用' };
          return await kb.search(query, { knowledgeBaseId: cfg.knowledgeBaseId });
        },
        execTool: async (tool, args) => {
          if (!tab?.id) return { ok: false, error: '无法获取当前标签页' };
          return await execTool(tab, tool, args || {});
        },
        exportPpt: async (input, cfg) => {
          const exporter = new PptExporter();
          let outline;
          if (cfg.markdown) {
            outline = parseMarkdownOutline(cfg.markdown);
          } else if (typeof input === 'string') {
            outline = parseMarkdownOutline(input);
          } else {
            outline = input;
          }
          const blob = await exporter.export(outline, await resolvePptOpts({ template: cfg.template || msg.template }));
          const reader = new FileReader();
          const dataUrl = await new Promise((resolve) => {
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
          return { format: 'pptx', dataUrl, filename: sanitizeFilename(outline?.title) + '.pptx' };
        },
      });

      const graph = msg.graph || (msg.templateId && WORKFLOW_TEMPLATES[msg.templateId]?.graph);
      if (!graph) return { ok: false, error: '缺少工作流图定义' };

      const result = await engine.run(graph, msg.input || '', (event) => broadcast('WORKFLOW_PROGRESS', event));
      const resultsObj = {};
      const errorsObj = {};
      for (const [k, v] of result.results) resultsObj[k] = v;
      for (const [k, v] of result.errors) errorsObj[k] = v;
      return { ok: true, results: resultsObj, errors: errorsObj };
    },
    { sendResponse: respond, timeoutMs: TIMEOUT_WORKFLOW_MS, label: '工作流执行' }
  );
}
