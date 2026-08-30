// background/handlers/kb.js
// 知识库（多 provider 可切换）：连接测试 / 列出知识库 / 检索。
//
// 凭证来自 getKbState()，按 msg.provider 取对应 provider 的配置并实例化连接器。
// 后台发起请求配合 host_permissions <all_urls>，不受 CORS 限制。
//
// KB 列表缓存：避免每次打开选择器都反复调用 API 耗尽配额。缓存 5 分钟，按 provider 隔离；
// KB_SEARCH 不缓存（需要实时结果）。持久化到 chrome.storage.local，
// MV3 service worker 休眠后可恢复，避免反复请求 API。

import { getKbState } from '../../shared/storage.js';
import { createKbConnector, getKbProviderDef } from '../../connectors/kb-registry.js';
import { withSafetyTimeout } from '../messaging.js';
import { TIMEOUT_KB_MS, KB_LIST_CACHE_KEY, KB_LIST_CACHE_MS } from '../../shared/constants.js';

const _kbListCache = new Map(); // providerId -> { list, ts }
const _kbListPending = new Map(); // providerId -> Promise (去重并发请求)
let _kbListCacheLoadPromise = null;
let _kbListCachePersistDirty = false;
let _kbListCachePersistTimer = null;

export async function loadKbListCache() {
  if (_kbListCache.size > 0) return _kbListCache;
  if (_kbListCacheLoadPromise) return _kbListCacheLoadPromise;
  _kbListCacheLoadPromise = (async () => {
    try {
      const r = await chrome.storage.local.get(KB_LIST_CACHE_KEY);
      const obj = r[KB_LIST_CACHE_KEY] || {};
      const now = Date.now();
      for (const [k, v] of Object.entries(obj)) {
        if (v && v.list && v.ts && now - v.ts < KB_LIST_CACHE_MS) {
          _kbListCache.set(k, { list: v.list, ts: v.ts });
        }
      }
    } catch (_) { /* 读取失败，使用空缓存 */ }
    return _kbListCache;
  })();
  return _kbListCache;
}

function persistKbListCache() {
  if (!_kbListCachePersistDirty) return;
  _kbListCachePersistDirty = false;
  if (_kbListCachePersistTimer) { clearTimeout(_kbListCachePersistTimer); _kbListCachePersistTimer = null; }
  const obj = {};
  for (const [k, v] of _kbListCache) obj[k] = { list: v.list, ts: v.ts };
  chrome.storage.local.set({ [KB_LIST_CACHE_KEY]: obj }).catch(() => {});
}

function scheduleKbListCachePersist() {
  _kbListCachePersistDirty = true;
  if (_kbListCachePersistTimer) return;
  _kbListCachePersistTimer = setTimeout(persistKbListCache, 1000);
}

/**
 * KB_TEST / KB_LIST / KB_SEARCH 统一入口。
 * @param {object} msg
 * @param {{respond:(payload:object)=>void}} ctx
 */
export function handleKbMessage(msg, { respond }) {
  return withSafetyTimeout(
    async () => {
      let kb = null; // 在 catch 中也可读取 _lastMeta 诊断
      try {
        await loadKbListCache();
        const state = await getKbState();
        const providerId = msg.provider || state.active;
        const provider = state.providers[providerId];
        if (!provider || provider.placeholder) {
          return { error: `未配置知识库来源「${providerId}」` };
        }
        const def = getKbProviderDef(providerId);
        if (def && def.placeholder) {
          return { error: `「${def.label}」尚未支持` };
        }
        kb = createKbConnector(provider.type, provider.cfg);
        if (!kb) {
          return { error: `暂不支持的知识库类型：${provider.type}` };
        }
        if (msg.type === 'KB_TEST') {
          const r = await kb.test();
          return { ok: true, info: r };
        }
        if (msg.type === 'KB_LIST') {
          await loadKbListCache();
          const cached = _kbListCache.get(providerId);
          if (cached && Date.now() - cached.ts < KB_LIST_CACHE_MS) {
            return { ok: true, list: cached.list };
          }
          if (_kbListPending.has(providerId)) {
            const list = await _kbListPending.get(providerId);
            return { ok: true, list };
          }
          const pending = kb.listKb({ limit: 100 }).then(list => {
            _kbListCache.set(providerId, { list, ts: Date.now() });
            scheduleKbListCachePersist();
            _kbListPending.delete(providerId);
            return list;
          }).catch(err => {
            _kbListPending.delete(providerId);
            throw err;
          });
          _kbListPending.set(providerId, pending);
          const list = await pending;
          return { ok: true, list };
        }
        if (msg.type === 'KB_SEARCH') {
          const chunks = await kb.search(msg.query || '', {
            knowledgeBaseId: msg.knowledgeBaseId || undefined,
          });
          return { ok: true, chunks, meta: kb._lastMeta || null };
        }
        return { error: '未知的知识库消息类型：' + msg.type };
      } catch (e) {
        return { error: e?.message || '知识库请求失败', meta: kb ? kb._lastMeta || null : null };
      }
    },
    { sendResponse: respond, timeoutMs: TIMEOUT_KB_MS, label: '知识库请求' }
  );
}
