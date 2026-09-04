// core/list-models.js
// 根据厂商配置拉取可用模型列表，供配置界面自动填充下拉框。
import { fetchWithTimeout, HttpError } from './http.js';
import { normalizeApiBase } from '../shared/utils.js';

// Anthropic 的 /v1/models 需要额外鉴权且部分网关不支持，用已知可用模型兜底。
const ANTHROPIC_FALLBACK = [
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'claude-opus-4-1',
  'claude-opus-4',
  'claude-3-7-sonnet-latest',
  'claude-3-5-sonnet-latest',
  'claude-3-5-haiku-latest',
];

/** 解析响应 JSON，失败时抛带可读信息的 HttpError（裸 TypeError 难排查） */
async function readJson(res, label) {
  try {
    return await res.json();
  } catch (e) {
    throw new HttpError('unknown', `${label} 返回的不是有效 JSON（HTTP ${res.status}）：${e?.message || e}`, res.status);
  }
}

/**
 * 拉取某配置下的可用模型 id 列表（与接口实际返回完全同步）。
 * @param {{vendor:string, apiBase?:string, apiKey?:string, timeoutMs?:number}} cfg
 * @returns {Promise<string[]>}
 */
export async function listModels(cfg) {
  const vendor = cfg.vendor;
  const key = (cfg.apiKey || '').trim();
  const base = normalizeApiBase(cfg.apiBase) ||
    (vendor === 'ollama' ? 'http://localhost:11434' : '');
  const timeout = cfg.timeoutMs || 15000;

  if (vendor === 'ollama') {
    const res = await fetchWithTimeout(base + '/api/tags', { method: 'GET' }, timeout);
    const json = await readJson(res, 'Ollama');
    const list = (json.models || []).map(m => m.name).filter(Boolean);
    if (!list.length) throw new HttpError('unknown', 'Ollama 未返回任何模型');
    return list;
  }

  if (vendor === 'gemini') {
    if (!key) throw new HttpError('auth', '请填写 API Key');
    if (!base) throw new HttpError('unknown', '请填写 API Base');
    // 密钥走 x-goog-api-key 请求头（官方支持）：拼进 query 会落入网关/代理访问日志，
    // 与 core/adapters/gemini.js 的安全准则保持一致
    const res = await fetchWithTimeout(base + '/models', {
      method: 'GET',
      headers: { 'x-goog-api-key': key },
    }, timeout);
    const json = await readJson(res, 'Gemini');
    const list = (json.models || [])
      .map(m => (m.name || '').replace(/^models\//, ''))
      .filter(Boolean);
    if (!list.length) throw new HttpError('unknown', 'Gemini 未返回任何模型');
    return list;
  }

  if (vendor === 'anthropic') {
    // 无公开列表接口，返回已知可用模型
    return ANTHROPIC_FALLBACK;
  }

  // openai 兼容（含 OpenRouter）：GET {base}/models
  if (!base) throw new HttpError('unknown', '请填写 API Base');
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const res = await fetchWithTimeout(base + '/models', { method: 'GET', headers }, timeout);
  const json = await readJson(res, 'OpenAI 兼容接口');
  const list = (json.data || []).map(m => m.id).filter(Boolean);
  if (!list.length) throw new HttpError('unknown', '接口未返回任何模型');
  return list;
}
