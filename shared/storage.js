// shared/storage.js
// chrome.storage.local 封装。所有模型配置/API Key 存这里，不写死在代码里。

const KEYS = {
  MODELS: 'models',        // ModelConfig[]
  KB: 'kb',                // { type:'local'|'online', cfg }
  SETTINGS: 'settings',    // 杂项
};

export async function getModels() {
  const r = await chrome.storage.local.get(KEYS.MODELS);
  return r[KEYS.MODELS] || [];
}

export async function saveModels(models) {
  await chrome.storage.local.set({ [KEYS.MODELS]: models });
}

export async function getKbConfig() {
  const r = await chrome.storage.local.get(KEYS.KB);
  return r[KEYS.KB] || { type: 'local', cfg: { baseUrl: '' } };
}

export async function saveKbConfig(cfg) {
  await chrome.storage.local.set({ [KEYS.KB]: cfg });
}

export async function getSettings() {
  const r = await chrome.storage.local.get(KEYS.SETTINGS);
  return r[KEYS.SETTINGS] || {};
}
