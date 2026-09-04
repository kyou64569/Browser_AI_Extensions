// background/handlers/ppt.js
// PPT 导出与自定义模板管理。
//
// 原实现把 sanitizeFilename / base64ToBytes / resolvePptOpts 等函数定义在
// chrome.runtime.onMessage 的回调内部——每条消息到达都会重新创建一遍函数闭包，
// 既浪费又难以复用。抽成模块后函数只创建一次，各消息分支共享。

import { PptExporter, parseMarkdownOutline, parseTemplate, PPT_THEMES } from '../../features/ppt-exporter.js';

const PPT_CUSTOM_KEY = 'pptCustomTemplate';
const PPT_CUSTOM_ID = '__custom__';

/** 清洗文件名：移除 Windows 非法字符与控制字符、防 ".." 路径穿越，避免 chrome.downloads.download 异常 */
export function sanitizeFilename(name, fallback = '演示文稿') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\.{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 80) || fallback;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** @returns {Promise<{name?:string, palette?:any, layoutPhs?:any, raw?:Uint8Array}|null>} 存储的自定义模板原始数据 */
async function loadCustomTemplate() {
  try {
    const r = await chrome.storage.local.get(PPT_CUSTOM_KEY);
    return /** @type {any} */ (r[PPT_CUSTOM_KEY]) || null;
  } catch (_) { return null; }
}

/**
 * 把存储中的自定义模板还原成 exporter 可用的对象（media 为 Uint8Array）。
 * 新格式存了整份模板原始字节（raw），此处实时重新解析，保证拿到最新且完整的母版/主题/媒体。
 */
async function reviveCustomTemplate(stored) {
  if (!stored) return null;
  if (stored.raw) {
    return await parseTemplate(base64ToBytes(stored.raw));
  }
  // 旧格式兼容：media 为 base64 字符串
  const media = {};
  if (stored.media) {
    for (const [name, b64] of Object.entries(stored.media)) media[name] = base64ToBytes(b64);
  }
  return { ...stored, media };
}

/**
 * 根据请求里的 template 决定传给 exporter 的 opts：
 * - 内置主题 id → { template }
 * - '__custom__' 或缺失且有已上传模板 → { custom }
 * - 其它 → 回退 classic-blue
 */
export async function resolvePptOpts(msg) {
  const t = msg && msg.template;
  if (t && t !== PPT_CUSTOM_ID && PPT_THEMES.some(x => x.id === t)) {
    return { template: t };
  }
  if (t === PPT_CUSTOM_ID) {
    const custom = await loadCustomTemplate();
    if (custom) return { custom: await reviveCustomTemplate(custom) };
    return { template: 'classic-blue' };
  }
  // 未指定具体内置主题：若有自定义模板则优先套用
  const custom = await loadCustomTemplate();
  if (custom) return { custom: await reviveCustomTemplate(custom) };
  return { template: 'classic-blue' };
}

/** GET_PPT_THEMES：内置主题 + 已上传自定义模板信息 */
export async function getPptThemes() {
  const raw = await loadCustomTemplate();
  let customInfo = null;
  if (raw) {
    const parsed = /** @type {any} */ (await reviveCustomTemplate(raw));
    customInfo = /** @type {any} */ ({
      name: raw.name,
      palette: raw.palette,
      layoutPhs: raw.layoutPhs,
      layouts: (parsed.layouts || []).map(l => ({
        num: l.num, type: l.type, name: l.layoutName,
        hasBody: !!(l.phs && l.phs.body),
        hasTitle: !!(l.phs && l.phs.title),
      })),
    });
  }
  return { ok: true, themes: PPT_THEMES, custom: customInfo };
}

/** PPT_IMPORT_TEMPLATE：解析用户上传的 .pptx 并存入 storage（作为默认模板） */
export async function importPptTemplate({ data, name }) {
  if (!data) return { ok: false, error: '未收到模板数据' };
  let bytes;
  try {
    bytes = base64ToBytes(data);
  } catch (e) {
    return { ok: false, error: '模板数据不是有效的 base64：' + ((e && e.message) || e) };
  }
  let parsed;
  try {
    parsed = await parseTemplate(bytes);
  } catch (e) {
    // 损坏/非 pptx 文件此前会被笼统报成「模板解析失败」而丢失真实原因
    return { ok: false, error: '模板解析失败：' + ((e && e.message) || e) };
  }
  // 存整份模板原始字节（base64）+ 轻量元数据；导出时实时重解析，
  // 这样 parseTemplate 的任何改进都能自动生效，无需用户反复重传。
  const stored = {
    name: name || '自定义模板',
    raw: data,
    mediaExts: parsed.mediaExts,
    layoutPhs: parsed.layoutPhs,
    palette: parsed.palette,
    sldSz: parsed.sldSz,
  };
  // storage 的 Promise API 配额超限时以异常形式抛出（回调式的 lastError 检查在此路径下是死代码）
  try {
    await chrome.storage.local.set({ [PPT_CUSTOM_KEY]: stored });
  } catch (e) {
    return { ok: false, error: '模板过大无法保存（' + ((e && e.message) || '存储配额超限') + '），请换用体积更小的模板' };
  }
  return {
    ok: true, name: stored.name, palette: parsed.palette, layoutPhs: parsed.layoutPhs,
    mediaCount: Object.keys(parsed.media).length,
    layouts: (/** @type {any} */ (parsed).layouts || []).map(l => ({ num: l.num, type: l.type, name: l.layoutName, hasBody: !!(l.phs && l.phs.body) })),
  };
}

/** DELETE_PPT_TEMPLATE：删除自定义模板 */
export async function deletePptTemplate() {
  try {
    await chrome.storage.local.remove(PPT_CUSTOM_KEY);
  } catch (e) {
    return { ok: false, error: '删除失败：' + ((e && e.message) || '未知错误') };
  }
  return { ok: true };
}

/** Blob → dataURL（Promise 化 FileReader） */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * PPT_EXPORT：结构化大纲 JSON / markdown → .pptx 文件（dataURL 形式返回给侧边栏）。
 * @param {{outline?:{title?:string, slides?:Array<any>}, markdown?:string, template?:string}} msg
 * @returns {Promise<{ok:true, dataUrl:string, filename:string}|{ok:false, error:string}>}
 */
export async function exportPpt(msg = {}) {
  const exporter = new PptExporter();
  let outline = msg.outline;
  if (!outline && msg.markdown) {
    outline = parseMarkdownOutline(msg.markdown);
  }
  if (!outline || !outline.slides) {
    return { ok: false, error: '缺少大纲数据' };
  }
  const blob = await exporter.export(outline, await resolvePptOpts({ template: msg.template }));
  const dataUrl = await blobToDataUrl(blob);
  return { ok: true, dataUrl, filename: sanitizeFilename(outline.title) + '.pptx' };
}

/**
 * AUTOMATE 分支里的 export_ppt 工具：直接触发 chrome.downloads.download 下载。
 * @param {{title?:string, slides?:Array<any>, template?:string}} args
 */
export async function exportPptForAutomate(args = {}) {
  try {
    const exporter = new PptExporter();
    const outline = { title: args.title || '演示文稿', slides: args.slides || [] };
    if (!outline.slides.length) return { ok: false, error: 'PPT 没有幻灯片内容' };
    const blob = await exporter.export(outline, await resolvePptOpts({ template: args.template }));
    const dataUrl = await blobToDataUrl(blob);
    // downloads.download 是回调式 API：lastError（配额/文件名非法/用户取消）不读会变成
    // "Unchecked runtime.lastError"，且这里必须如实向 Agent 回报失败，否则模型会谎称完成
    const ok = await new Promise((resolve) => {
      try {
        chrome.downloads.download({ url: dataUrl, filename: sanitizeFilename(outline.title) + '.pptx' }, (downloadId) => {
          const err = chrome.runtime.lastError;
          resolve(!err && downloadId != null);
        });
      } catch (_) {
        resolve(false);
      }
    });
    if (!ok) return { ok: false, error: 'PPT 文件下载失败（浏览器拒绝下载或用户取消）' };
    return { ok: true, result: { message: `PPT「${outline.title}」已下载`, slideCount: outline.slides.length, filename: sanitizeFilename(outline.title) + '.pptx' } };
  } catch (e) {
    return { ok: false, error: 'PPT 导出失败：' + (e?.message || e) };
  }
}
