// shared/storage.js
// chrome.storage.local 封装。所有模型配置/API Key 存这里，不写死在代码里。

const KEYS = {
  MODELS: 'models',        // ModelConfig[]
  WHISPER: 'whisperModels',// Whisper 语音识别模型配置 []
  MULTIMODAL: 'multimodalModels', // 多模态模型配置 [{...modalities:{image,audio,video}}]
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

/**
 * 读取 Whisper 模型配置（用于实时字幕的语音转写）。
 * @returns {Promise<Array>}
 */
export async function getWhisperModels() {
  const r = await chrome.storage.local.get(KEYS.WHISPER);
  return r[KEYS.WHISPER] || [];
}

export async function saveKbConfig(cfg) {
  await chrome.storage.local.set({ [KEYS.KB]: cfg });
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
