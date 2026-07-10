// core/list-models.js
// 根据厂商配置拉取可用模型列表，供配置界面自动填充下拉框。
import { fetchWithTimeout, HttpError } from './http.js';

// Anthropic 不提供公开的“列出模型”接口，使用已知可用模型兜底。
const ANTHROPIC_FALLBACK = [
  'claude-3-5-sonnet-latest',
  'claude-3-5-haiku-latest',
  'claude-3-opus-latest',
  'claude-3-7-sonnet-latest',
];

/**
 * 拉取某配置下的可用模型 id 列表（与接口实际返回完全同步）。
 * @param {{vendor:string, apiBase?:string, apiKey?:string, timeoutMs?:number}} cfg
 * @returns {Promise<string[]>}
 */
export async function listModels(cfg) {
  const vendor = cfg.vendor;
  const key = (cfg.apiKey || '').trim();
  const base = (cfg.apiBase || '').trim().replace(/\/$/, '') ||
    (vendor === 'ollama' ? 'http://localhost:11434' : '');
  const timeout = cfg.timeoutMs || 15000;

  if (vendor === 'ollama') {
    const res = await fetchWithTimeout(base + '/api/tags', { method: 'GET' }, timeout);
    const json = await res.json();
    const list = (json.models || []).map(m => m.name).filter(Boolean);
    if (!list.length) throw new HttpError('unknown', 'Ollama 未返回任何模型');
    return list;
  }

  if (vendor === 'gemini') {
    if (!key) throw new HttpError('auth', '请填写 API Key');
    const url = base + '/models?key=' + encodeURIComponent(key);
    const res = await fetchWithTimeout(url, { method: 'GET' }, timeout);
    const json = await res.json();
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
  const json = await res.json();
  const list = (json.data || []).map(m => m.id).filter(Boolean);
  if (!list.length) throw new HttpError('unknown', '接口未返回任何模型');
  return list;
}
