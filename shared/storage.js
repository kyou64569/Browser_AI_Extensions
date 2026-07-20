// shared/storage.js
// chrome.storage.local 封装。所有模型配置/API Key 存这里，不写死在代码里。

const KEYS = {
  MODELS: 'models',        // ModelConfig[]
  WHISPER: 'whisperModels',// Whisper 语音识别模型配置 []
  MULTIMODAL: 'multimodalModels', // 多模态模型配置 [{...modalities:{image,audio,video}}]
  KB: 'kb',                // 知识库多 provider 状态：{ active, providers:{ <id>:{type,cfg} } }
  SETTINGS: 'settings',    // 杂项
};

export async function getModels() {
  const r = await chrome.storage.local.get(KEYS.MODELS);
  return r[KEYS.MODELS] || [];
}

export async function saveModels(models) {
  await chrome.storage.local.set({ [KEYS.MODELS]: models });
}

/** 知识库默认状态（多 provider 可切换）。notebooklm 为占位，尚未实现。 */
export function defaultKbState() {
  return {
    active: 'ima',
    providers: {
      ima: { type: 'ima', cfg: { clientId: '', apiKey: '' } },
      local: { type: 'local', cfg: { baseUrl: '', apiKey: '' } },
      notebooklm: { type: 'notebooklm', placeholder: true, cfg: {} },
    },
  };
}

/**
 * 把任意存储值规整为合法的知识库状态（补齐缺失 provider、兼容旧格式）。
 * 旧格式 { type, cfg }（type==='online'|'ima'|'local'）会被迁移为 providers 字典。
 */
export function normalizeKbState(raw) {
  const def = defaultKbState();
  if (!raw || typeof raw !== 'object') return def;
  // 兼容旧单配置格式
  if (raw.type && !raw.providers) {
    const providers = JSON.parse(JSON.stringify(def.providers));
    if (raw.type === 'online' || raw.type === 'ima') {
      providers.ima.cfg = { ...providers.ima.cfg, ...(raw.cfg || {}) };
      return { active: 'ima', providers };
    }
    if (raw.type === 'local') {
      providers.local.cfg = { ...providers.local.cfg, ...(raw.cfg || {}) };
      return { active: 'local', providers };
    }
    return def;
  }
  // 新格式：合并默认 provider，校验 active
  const providers = { ...def.providers };
  for (const [id, p] of Object.entries(raw.providers || {})) {
    if (p && typeof p === 'object' && p.type) {
      providers[id] = { type: p.type, cfg: p.cfg || {}, placeholder: p.placeholder };
    }
  }
  const active = providers[raw.active] && !providers[raw.active].placeholder ? raw.active : 'ima';
  return { active, providers };
}

export async function getKbState() {
  const r = await chrome.storage.local.get(KEYS.KB);
  return normalizeKbState(r[KEYS.KB]);
}

export async function saveKbState(state) {
  await chrome.storage.local.set({ [KEYS.KB]: state });
}

/** 兼容旧接口：返回当前激活 provider 的 { type, cfg }（后台 summarize 用） */
export async function getKbConfig() {
  const s = await getKbState();
  const p = s.providers[s.active] || s.providers.local;
  return { type: p.type, cfg: p.cfg || {} };
}

/**
 * 读取 Whisper 模型配置（用于实时字幕的语音转写）。
 * @returns {Promise<Array>}
 */
export async function getWhisperModels() {
  const r = await chrome.storage.local.get(KEYS.WHISPER);
  return r[KEYS.WHISPER] || [];
}

/**
 * 读取多模态模型配置（聊天中的图像/音频/视频生成任务路由）。
 * @returns {Promise<Array>}
 */
export async function getMultimodalModels() {
  const r = await chrome.storage.local.get(KEYS.MULTIMODAL);
  return r[KEYS.MULTIMODAL] || [];
}

/**
 * 保存多模态模型配置。
 * @param {Array} arr
 */
export async function saveMultimodalModels(arr) {
  await chrome.storage.local.set({ [KEYS.MULTIMODAL]: arr || [] });
}

export async function getSettings() {
  const r = await chrome.storage.local.get(KEYS.SETTINGS);
  return r[KEYS.SETTINGS] || {};
}
