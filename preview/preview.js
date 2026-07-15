// preview/preview.js
// 侧边栏应用入口：复用同一套核心模块（core / connectors / features）。
// 三个视图：chat（主） / features / settings，单页切换，无整页刷新。

import { chatStream } from '../features/chat.js';
import { summarizePage, summarizeStream } from '../features/summarize.js';
import { processSelection } from '../features/selection.js';
import { LocalKbConnector } from '../connectors/local-kb.js';
import { buildToolSystemPrompt, parseToolCalls, parseToolCall, stripToolCall } from '../features/automation.js';
import { listModels } from '../core/list-models.js';
import { thinkingLevels } from '../shared/utils.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ---------- 本地存储（模拟 chrome.storage.local）----------
const LS = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
};

// ---------- 保活连接：防止 MV3 service worker 在执行异步任务（网页自动化 executeScript 等）期间被终止 ----------
// 若不保持长连接，background 在执行 AUTOMATE 等异步 chrome.* 调用时可能因 SW 被杀而触发
// "The message port closed before a response was received"。保持侧边栏端口打开即可维持 SW 存活。
let _bgPort = null;
let _bgHeartbeat = null;
function ensureBgPort() {
  if (_bgPort) return _bgPort;
  try {
    _bgPort = chrome.runtime.connect({ name: 'sidepanel' });
    _bgPort.onDisconnect.addListener(() => {
      // 关键：读取并“消费” runtime.lastError，否则当端口因页面进入
      // 前进/后退缓存（bfcache）被浏览器强制关闭时，会抛出
      // "Unchecked runtime.lastError: The page keeping the extension port
      // is moved into back/forward cache, so the message channel is closed."
      const err = chrome.runtime.lastError;
      _bgPort = null;
      if (_bgHeartbeat) { clearInterval(_bgHeartbeat); _bgHeartbeat = null; }
      // SW 重启 / 页面从 bfcache 恢复后自动重连，维持保活
      setTimeout(ensureBgPort, 200);
    });
    // 心跳：周期性轻量消息，确保浏览器认为该连接始终处于活动状态，
    // 防止 MV3 service worker 在长时间异步自动化操作（executeScript 最长 ~30s）期间被闲置回收，
    // 从而避免 AUTOMATE 响应端口在收到响应前被关闭。
    _bgHeartbeat = setInterval(() => {
      try { _bgPort && _bgPort.postMessage({ type: 'PING' }); } catch (_) {}
    }, 20000);
  } catch (_) {
    _bgPort = null;
  }
  return _bgPort;
}
ensureBgPort();

// ---------- bfcache 生命周期处理 ----------
// 当用户通过前进/后退按钮导航，使“持有本扩展端口”的页面进入前进/后退缓存
// （back/forward cache，简称 bfcache）时，浏览器会冻结该页面并强制关闭其消息通道，
// 触发 onDisconnect（runtime.lastError 即上述 bfcache 文案）。
// 在冻结前主动释放端口、恢复后重建，可避免向已死通道发送消息导致消息静默丢失，
// 也避免页面 JS 被冻结期间定时器（心跳）与在途请求被挂起。
window.addEventListener('pagehide', (e) => {
  if (e.persisted) { // 页面被缓存（而非真正卸载）
    if (_bgPort) { try { _bgPort.disconnect(); } catch (_) {} _bgPort = null; }
    if (_bgHeartbeat) { clearInterval(_bgHeartbeat); _bgHeartbeat = null; }
  }
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted) { _bgPort = null; ensureBgPort(); } // 从 bfcache 恢复，重建端口
});
// Page Lifecycle API：部分场景下比 pagehide/pageshow 更早、更可靠
document.addEventListener('freeze', () => {
  if (_bgPort) { try { _bgPort.disconnect(); } catch (_) {} _bgPort = null; }
  if (_bgHeartbeat) { clearInterval(_bgHeartbeat); _bgHeartbeat = null; }
});
document.addEventListener('resume', () => { _bgPort = null; ensureBgPort(); });

function defaultModel() {
  return {
    id: 'm' + Date.now().toString(36),
    vendor: 'openai', name: 'openai/gpt-4o-mini',
    apiBase: 'https://openrouter.ai/api/v1', apiKey: '',
    model: 'openai/gpt-4o-mini',
    supportsVision: false, supportsStream: true, timeoutMs: 60000, enabled: true,
    isPrimary: false, supportsThinking: false, thinkingStrength: 'off',
  };
}

/** 备用模型配置：仅保留模型选择与基础配置项（无 temperature/top_p、无 5 个复选框） */
function defaultBackupModel() {
  return {
    id: 'b' + Date.now().toString(36),
    vendor: 'openai', name: 'openai/gpt-4o-mini',
    apiBase: 'https://openrouter.ai/api/v1', apiKey: '',
    model: 'openai/gpt-4o-mini',
    timeoutMs: 60000,
  };
}

// ---------- 配置存储统一层 ----------
// 真实扩展里，模型 / 知识库配置由选项页（ui/options）写入 chrome.storage.local；
// 侧边栏此前只读自己的 localStorage，导致“在选项页配置的模型”在侧边栏里看不到，
// 于是始终回退到默认空 Key 模型 → 走演示分支、显示示例内容。
// 统一为：优先读 chrome.storage.local（与选项页同源），无则用 localStorage 兜底（独立预览）。
function hasChromeStorage() {
  return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
}
async function loadModelsFromStorage() {
  if (hasChromeStorage()) {
    try {
      const r = await chrome.storage.local.get('models');
      if (Array.isArray(r.models) && r.models.length) return r.models;
    } catch (_) { /* 退回 localStorage */ }
  }
  return LS.get('preview.models', [defaultModel()]);
}
async function loadKbFromStorage() {
  if (hasChromeStorage()) {
    try {
      const r = await chrome.storage.local.get('kb');
      if (r.kb) return r.kb;
    } catch (_) { /* 退回 localStorage */ }
  }
  return LS.get('preview.kb', { baseUrl: '' });
}
async function persistModelsToStorage(arr) {
  models = arr;
  LS.set('preview.models', arr);
  if (hasChromeStorage()) {
    try { await chrome.storage.local.set({ models: arr }); } catch (_) {}
  }
}
async function persistKbToStorage(cfg) {
  kbCfg = cfg;
  LS.set('preview.kb', cfg);
  if (hasChromeStorage()) {
    try { await chrome.storage.local.set({ kb: cfg }); } catch (_) {}
  }
}
async function loadImgUploadFromStorage() {
  if (hasChromeStorage()) {
    try {
      const r = await chrome.storage.local.get('imgUpload');
      if (r.imgUpload) return r.imgUpload;
    } catch (_) { /* 退回 localStorage */ }
  }
  return LS.get('preview.imgUpload', { url: '', auth: '', path: '' });
}
async function persistImgUploadToStorage(cfg) {
  imgUploadCfg = cfg;
  LS.set('preview.imgUpload', cfg);
  if (hasChromeStorage()) {
    try { await chrome.storage.local.set({ imgUpload: cfg }); } catch (_) {}
  }
}
async function loadConversationsFromStorage() {
  if (hasChromeStorage()) {
    try {
      const r = await chrome.storage.local.get('conversations');
      if (Array.isArray(r.conversations)) return r.conversations;
    } catch (_) { /* 退回 localStorage */ }
  }
  return LS.get('preview.conversations', []);
}
async function persistConversationsToStorage() {
  LS.set('preview.conversations', conversations);
  if (hasChromeStorage()) {
    try { await chrome.storage.local.set({ conversations }); } catch (_) {}
  }
}
async function loadWhisperFromStorage() {
  if (hasChromeStorage()) {
    try {
      const r = await chrome.storage.local.get('whisperModels');
      if (Array.isArray(r.whisperModels) && r.whisperModels.length) return r.whisperModels;
    } catch (_) { /* 退回 localStorage */ }
  }
  return LS.get('preview.whisperModels', []);
}
async function persistWhisperToStorage(arr) {
  whisperModels = arr;
  LS.set('preview.whisperModels', arr);
  if (hasChromeStorage()) {
    try { await chrome.storage.local.set({ whisperModels: arr }); } catch (_) {}
  }
}
/** 启动或存储变更后：从权威源（chrome.storage）同步配置到内存并重渲染 */
async function syncConfigFromStorage() {
  const loaded = await loadModelsFromStorage();
  if (loaded && loaded !== models) {
    models = loaded;
    persistModelsToStorage(models);
    renderModels();
    renderModelSelect();
  }
  const wm = await loadWhisperFromStorage();
  if (wm && wm !== whisperModels) {
    whisperModels = wm;
    LS.set('preview.whisperModels', wm);
    renderWhisperModels();
  }
  const kb = await loadKbFromStorage();
  if (kb && JSON.stringify(kb) !== JSON.stringify(kbCfg)) {
    kbCfg = kb;
    LS.set('preview.kb', kbCfg);
  }
  const imgUp = await loadImgUploadFromStorage();
  if (imgUp && JSON.stringify(imgUp) !== JSON.stringify(imgUploadCfg)) {
    imgUploadCfg = imgUp;
    LS.set('preview.imgUpload', imgUploadCfg);
  }
}

let models = LS.get('preview.models', [defaultModel()]);
let backupModels = LS.get('preview.backupModels', []);
let kbCfg = LS.get('preview.kb', { baseUrl: '' });
let imgUploadCfg = LS.get('preview.imgUpload', { url: '', auth: '', path: '' });
let conversations = LS.get('preview.conversations', []); // 历史会话列表
let whisperModels = LS.get('preview.whisperModels', []);  // Whisper 语音识别模型配置 []
let ccWhisperRefresh = null;  // 实时字幕卡中 Whisper 复选列表的刷新钩子（initLiveCaption 内赋值）
let currentConvId = null;                          // 当前会话 id（null = 尚未归入某个会话）
let messages = [];          // 聊天历史 {role, content}
let attachments = [];       // 待发送附件 {name, type, content}
let chatModelId = models[0]?.id || null;  // 当前聊天所选模型（'__collab__' 表示多模型协作）
let thinkingStrength = 'off';             // 聊天界面“思考强度”下拉的当前选择
let streaming = false;
let activeMode = null;      // 当前激活的功能模式（null | {type:'summarize'|'translate'|'explain'|'ocr'|'file', label?:string}）
let translateTarget = '';    // 翻译模式下的目标语言（空 = 未选择，翻译不可用）

// 翻译目标语言列表（主流语言，下拉默认“选择语言”）
const TARGET_LANGS = [
  '中文', '英语', '日语', '韩语', '法语', '德语', '西班牙语', '俄语',
  '阿拉伯语', '葡萄牙语', '意大利语', '泰语', '越南语', '印度尼西亚语',
  '印地语', '土耳其语', '波兰语', '荷兰语',
];
const fetchedModels = {};   // 各配置的已获取模型列表（按 model.id 缓存，不持久化）

// ============================================================
// 视图导航
// ============================================================
const VIEWS = ['chat', 'features', 'settings', 'conversations'];
const TITLES = { chat: 'AI 助手', features: '功能', settings: '设置', conversations: '会话列表' };

function showView(name) {
  VIEWS.forEach(v => $('#view-' + v).classList.toggle('is-active', v === name));
  $('#navFeatures').classList.toggle('active', name === 'features');
  $('#navSettings').classList.toggle('active', name === 'settings');
  $('#navConversations').classList.toggle('active', name === 'conversations');
  $('#barTitle').textContent = TITLES[name];
  if (name === 'chat') { renderModelSelect(); updateSendState(); }
  if (name === 'conversations') renderConversationList();
}

$('#navFeatures').onclick = () => showView($('#view-features').classList.contains('is-active') ? 'chat' : 'features');
$('#navSettings').onclick = () => showView($('#view-settings').classList.contains('is-active') ? 'chat' : 'settings');
$('#navConversations').onclick = () => showView($('#view-conversations').classList.contains('is-active') ? 'chat' : 'conversations');
$('#barTitle').parentElement.onclick = () => showView('chat'); // 点标题返回聊天

// ============================================================
// 会话管理：列表 / 新建 / 自动保存 / 恢复 / 删除
// ============================================================
function showWelcome() {
  if ($('#welcome')) return;
  chatScroll.innerHTML =
    `<div class="welcome" id="welcome">
       <div class="welcome-logo">AI</div>
       <h2>有什么可以帮你的？</h2>
       <p>提问、翻译、解释、总结 —— 都由统一模型链路驱动。</p>
     </div>`;
}

// 由首条用户消息推导会话标题（去掉翻译 / 解释注入的指令前缀，取用户实际输入）
function deriveTitle(text) {
  let t = (text || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(?:请将下面的文本翻译为.+?，只输出翻译后的内容，不要添加任何解释、注释或额外说明：\n\n|请用通俗语言解释下面的文本，必要时举例子：\n\n)([\s\S]*)$/);
  if (m) t = m[2];
  if (!t) return '新会话';
  return t.length > 20 ? t.slice(0, 20) + '…' : t;
}

function formatConvTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// 把当前 messages 持久化为一个会话：首次发送自动创建，之后每次发送自动更新
function persistActiveConversation() {
  if (!messages.length) return;
  let conv = conversations.find(c => c.id === currentConvId);
  if (!conv) {
    conv = {
      id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      title: '',
      messages: [],
      createdAt: Date.now(),
    };
    currentConvId = conv.id;
    conversations.unshift(conv);
  }
  conv.messages = messages.map(m => {
    const o = {
      role: m.role,
      content: m.content,
      ...(m.attachments ? { attachments: m.attachments.map(a => ({ ...a })) } : {}),
    };
    // 保留工具调用结构化信息（历史回放时仍以 AI 消息归属渲染为工具卡片）
    if (m.tool) {
      o.tool = {
        name: m.tool.name,
        args: m.tool.args,
        ok: m.tool.ok,
        summary: m.tool.summary || null,
        error: m.tool.error || null,
        // 注意：不持久化 shot（截图 base64），以免撑爆 chrome.storage
      };
    }
    return o;
  });
  conv.updatedAt = Date.now();
  if (!conv.title) {
    const firstUser = messages.find(m => m.role === 'user');
    conv.title = deriveTitle(firstUser ? firstUser.content : '新会话');
  }
  persistConversationsToStorage();
  if ($('#view-conversations').classList.contains('is-active')) renderConversationList();
}

// 新建会话：清空当前聊天，回到空白欢迎态
function startNewChat() {
  messages = [];
  currentConvId = null;
  attachments = [];
  renderAttachments();
  clearFuncMode();
  chatScroll.innerHTML = '';
  showWelcome();
  showView('chat');
  updateSendState();
  input.focus();
}

// 恢复历史会话：将其聊天记录加载到主界面，可继续对话
function loadConversation(id) {
  const conv = conversations.find(c => c.id === id);
  if (!conv) return;
  currentConvId = id;
  messages = (conv.messages || []).map(m => ({
    role: m.role,
    content: m.content,
    ...(m.attachments ? { attachments: m.attachments.map(a => ({ ...a })) } : {}),
  }));
  chatScroll.innerHTML = '';
  if (!messages.length) {
    showWelcome();
  } else {
    for (const m of messages) {
      if (m.role === 'user') {
        const imgs = (m.attachments || []).map(a => a.data).filter(Boolean);
        pushUser(m.content, imgs);
      } else if (m.tool) {
        // 工具调用消息：以工具卡片形式渲染，归属 AI（与实时展示完全一致）
        pushToolMessage({ role: m.role, content: m.content, tool: m.tool });
      } else {
        const el = document.createElement('div');
        el.className = 'msg assistant';
        el.innerHTML = `<div class="avatar">AI</div><div class="bubble"></div>`;
        el.querySelector('.bubble').textContent = m.content || '';
        chatScroll.appendChild(el);
      }
    }
  }
  scrollBottom();
  showView('chat');
  input.focus();
}

// 删除历史会话
function deleteConversation(id) {
  const idx = conversations.findIndex(c => c.id === id);
  if (idx < 0) return;
  const wasActive = currentConvId === id;
  conversations.splice(idx, 1);
  persistConversationsToStorage();
  if (wasActive) {
    // 被删除的是当前会话：清空主页面（聊天视图）DOM 并回到欢迎态，
    // 避免用户删除后返回主页面仍残留已删除会话的内容。
    currentConvId = null;
    messages = [];
    chatScroll.innerHTML = '';
    showWelcome();
    updateSendState();
  }
  // 会话列表始终基于最新 conversations 重渲染（即便当前不在列表视图，下次进入也已同步）
  if ($('#view-conversations').classList.contains('is-active')) renderConversationList();
  toast('已删除会话', 'ok');
}

// 渲染会话列表
function renderConversationList() {
  const list = $('#convList');
  if (!list) return;
  if (!conversations.length) {
    list.innerHTML = '<div class="conv-empty">暂无历史会话。<br/>在聊天中发送消息即可自动保存为历史会话。</div>';
    return;
  }
  list.innerHTML = conversations.map(c => {
    const firstUser = (c.messages || []).find(m => m.role === 'user');
    const preview = (firstUser && firstUser.content ? firstUser.content : '').replace(/\s+/g, ' ').trim();
    const previewText = preview ? (preview.length > 42 ? preview.slice(0, 42) + '…' : preview) : '（空会话）';
    const time = formatConvTime(c.updatedAt || c.createdAt);
    const active = c.id === currentConvId ? ' active' : '';
    return `
      <div class="conv-item${active}" data-id="${c.id}">
        <div class="conv-item-main">
          <div class="conv-item-title">${escapeHtml(c.title || '新会话')}</div>
          <div class="conv-item-preview">${escapeHtml(previewText)}</div>
        </div>
        <div class="conv-item-meta">
          <div class="conv-item-time">${time}</div>
          <button type="button" class="icon-btn conv-del" data-del="${c.id}" title="删除会话">${ICON_TRASH}</button>
        </div>
      </div>`;
  }).join('');
  list.querySelectorAll('.conv-item').forEach(it => it.onclick = (e) => {
    if (e.target.closest('.conv-del')) return;   // 删除按钮单独处理
    loadConversation(it.dataset.id);
  });
  list.querySelectorAll('.conv-del').forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    if (confirm('确定删除该会话？此操作不可恢复。')) deleteConversation(b.dataset.del);
  });
}

$('#newConvBtn').onclick = () => startNewChat();

// ============================================================
// 聊天视图
// ============================================================
const chatScroll = $('#chatScroll');
const chatStatus = $('#chatStatus');
const input = $('#chatInput');
const sendBtn = $('#sendBtn');

function setStatus(msg, kind = '') {
  chatStatus.textContent = msg;
  chatStatus.className = 'status-bar' + (kind ? ' ' + kind : '');
}
function scrollBottom() { chatScroll.scrollTop = chatScroll.scrollHeight; }

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
}
input.addEventListener('input', () => { autosize(); updateSendState(); });

function escapeHtml(s) {
  return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function pushUser(text, images) {
  const welcome = $('#welcome');
  if (welcome) welcome.remove();
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `<div class="avatar">你</div><div class="bubble"></div>`;
  const bubble = el.querySelector('.bubble');
  if (text && text.trim()) {
    const t = document.createElement('div');
    t.className = 'bubble-text';
    t.textContent = text;
    bubble.appendChild(t);
  }
  // 图片以缩略图渲染在气泡内，直接可见（保留原图清晰度）
  if (images && images.length) {
    const g = document.createElement('div');
    g.className = 'bubble-images';
    for (const src of images) {
      if (!src) continue;
      const im = document.createElement('img');
      im.className = 'bubble-img';
      im.src = src;
      im.loading = 'lazy';
      // 点击缩略图放大查看原图（原图即 data URL，清晰度不损失）
      im.onclick = () => openImagePreview(src);
      g.appendChild(im);
    }
    bubble.appendChild(g);
  }
  chatScroll.appendChild(el);
  scrollBottom();
}

// 图片预览弹窗：加载并展示原图（缩略图点击放大）
function openImagePreview(src) {
  if (!src) return;
  $('#imgLightboxImg').src = src;
  $('#imgLightbox').hidden = false;
}
function closeImagePreview() {
  const lb = $('#imgLightbox');
  lb.hidden = true;
  $('#imgLightboxImg').src = '';   // 释放原图引用
}
$('#imgLightboxClose').onclick = closeImagePreview;
// 点击遮罩空白处关闭；点击图片本身不关闭（图片已铺满，靠关闭按钮 / Esc）
$('#imgLightbox').onclick = (e) => { if (e.target.id === 'imgLightbox') closeImagePreview(); };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#imgLightbox').hidden) closeImagePreview();
});

function newAssistant() {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = `<div class="avatar">AI</div><div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>`;
  chatScroll.appendChild(el);
  const bubble = el.querySelector('.bubble');
  return {
    el,
    setText(t) { bubble.textContent = t; },
    stopTyping() { bubble.innerHTML = ''; },
  };
}

// 发送按钮状态：输入框为空且无附件时置灰禁用，否则激活
function updateSendState() {
  // 翻译模式：未选择目标语言则翻译不可用（禁用发送）
  if (activeMode && activeMode.type === 'translate') {
    sendBtn.disabled = !translateTarget || !input.value.trim() || streaming;
    return;
  }
  const empty = !input.value.trim() && attachments.length === 0;
  sendBtn.disabled = empty || streaming;
}

// 渲染当前附件：图片以缩略图形式显示，其余文件仍用文本 chip
function renderAttachments() {
  const box = $('#attachments');
  box.innerHTML = attachments.map((a, idx) => {
    if (a.type && a.type.startsWith('image/')) {
      // 图片附件：直接渲染缩略图（保留原图 data URL，清晰可见）；上传/读取中显示加载态
      return `<span class="attachment-thumb${a.uploading ? ' uploading' : ''}" data-idx="${idx}">`
        + (a.dataUrl
            ? `<img src="${a.dataUrl}" alt="${escapeHtml(a.name || '图片')}" />`
            : `<span class="thumb-ph"></span>`)
        + (a.uploading ? `<span class="thumb-spinner" aria-label="处理中"></span>` : '')
        + `<button type="button" class="thumb-x" data-idx="${idx}" title="移除">×</button>`
        + `</span>`;
    }
    return `<span class="attachment-chip">${escapeHtml(a.name)}<button type="button" class="x" data-idx="${idx}" title="移除">×</button></span>`;
  }).join('');
  box.querySelectorAll('.x, .thumb-x').forEach(b => b.onclick = () => {
    attachments.splice(+b.dataset.idx, 1);
    renderAttachments(); updateSendState();
    if (activeMode && activeMode.type === 'file') {
      if (attachments.length) syncFileTag();
      else clearFuncMode();   // 全部移除后文件标签消失
    }
  });
}

// 把文本与附件拼成正文：图片走多模态附件（不进正文），其余文本文件内联
function buildContent(text, atts) {
  let c = text;
  for (const a of atts) {
    if (a.type.startsWith('image/')) continue; // 图片经由 attachments 以多模态形式发送
    else c += `\n[文件附件: ${a.name}]\n${a.content || ''}`;
  }
  return c.trim();
}

async function send() {
  const text = input.value.trim();

  // 网页操作模式：交给 ReAct 工具循环处理（不包指令、不清理标签，循环结束再清理）
  if (activeMode && activeMode.type === 'automate') {
    if (streaming) return;
    if (!text) { setStatus('请描述要对当前网页执行的操作', 'err'); return; }
    const instruction = text;
    input.value = ''; autosize();
    attachments = []; renderAttachments();
    runAutomation(instruction);
    return;
  }

  // 翻译 / 解释 / OCR 功能模式：允许“按功能发送”；OCR 只需图片，其余需正文
  const funcMode = (activeMode && (activeMode.type === 'translate' || activeMode.type === 'explain' || activeMode.type === 'summarize' || activeMode.type === 'ocr'))
    ? activeMode.type : null;
  if (streaming) return;
  if (!funcMode && !text && attachments.length === 0) return;
  if (funcMode && !text && attachments.length === 0) {
    // OCR 仅需图片，无需输入文本；其余功能需正文
    if (funcMode === 'ocr') { setStatus('请先添加要识别的图片', 'err'); return; }
    setStatus('请先输入要' + (funcMode === 'translate' ? '翻译' : funcMode === 'explain' ? '解释' : '总结') + '的内容', 'err');
    return;
  }
  // 翻译模式必须选择目标语言，否则翻译不可用
  if (funcMode === 'translate' && !translateTarget) {
    setStatus('请先在翻译标签右侧选择目标语言', 'err');
    return;
  }
  // 总结网页：预填指令已在输入框，用户手动发送后才获取网页并总结
  if (funcMode === 'summarize') {
    const instruction = input.value.trim();
    input.value = ''; autosize();
    attachments = []; renderAttachments();
    clearFuncMode();
    runSummarizeInChat(instruction);
    return;
  }

  // 翻译 / 解释 / OCR：把用户输入包上指令前缀；其余情况正常拼装（图片走多模态附件）
  const content = funcMode
    ? (funcMode === 'translate'
        // 严格翻译：原封不动翻译为所选目标语言，仅输出译文，不附加任何解释/注释
        ? `请将下面的文本翻译为${translateTarget}，只输出翻译后的内容，不要添加任何解释、注释或额外说明：\n\n` + text
        : funcMode === 'explain'
          ? '请用通俗语言解释下面的文本，必要时举例子：\n\n' + text
          // OCR：识别并提取图片中的文字，只输出纯文本（无需用户输入正文）
          : '请识别并提取图片中的所有文字内容，只输出识别出的纯文本，不要添加任何解释、注释或额外说明。' + (text ? '\n\n补充说明：' + text : ''))
    : buildContent(text, attachments);
  // 图片转为多模态附件（data URL），文本文件保留正文
  const imageAttachments = attachments
    .filter(a => a.type.startsWith('image/') && a.dataUrl)
    .map(a => ({ type: 'image', data: a.dataUrl }));
  // OCR：只需图片即可（不再限制主模型是否支持视觉）；若已配置视觉模型，由视觉模型识别后回灌主模型整合。
  if (funcMode === 'ocr' && imageAttachments.length === 0) {
    setStatus('请先添加要识别的图片', 'err'); return;
  }
  const userMsg = { role: 'user', content, ...(imageAttachments.length ? { attachments: imageAttachments } : {}) };

  input.value = ''; autosize();
  attachments = []; renderAttachments();
  pushUser(content, imageAttachments.map(a => a.data));
  const apiMessages = [...messages, userMsg];

  // 决定模式与候选模型
  const mode = chatModelId === '__collab__' ? 'collab' : 'single';
  if (mode === 'collab') {
    // “多模型协作”：仅“已启用”模型参与，且必须指定一个“主模型”
    if (!models.filter(m => m.enabled !== false).some(m => m.isPrimary)) {
      alert('请在模型配置页面选择主模型后再进行聊天');
      return;
    }
  } else if (!models.some(m => m.id === chatModelId)) {
    alert('请先在设置中添加并启用模型');
    return;
  }

  // 思考强度：仅当选中参考模型开启“思考”时生效
  const ref = currentRefModel();
  const ts = (ref && ref.supportsThinking) ? thinkingStrength : undefined;

  const a = newAssistant();
  streaming = true; sendBtn.disabled = true;
  setStatus(funcMode === 'ocr' ? '正在识别图片中的文字…' : '思考中…');

  let acc = '';
  let started = false;
  try {
    for await (const chunk of chatStream({ models, backupModels }, apiMessages, {
      mode,
      selectedId: mode === 'single' ? chatModelId : undefined,
      thinkingStrength: ts,
      onFallback: (i, cfg, reason) => setStatus(`已切换到备用模型 #${i + 1}：${cfg.name}（${reason}）`),
    })) {
      if (chunk.error === 'NO_PRIMARY') {
        a.stopTyping();
        a.setText('请在模型配置页面选择主模型后再进行聊天');
        setStatus('未选择主模型', 'err');
        return;
      }
      if (!started) { started = true; a.stopTyping(); setStatus(funcMode === 'ocr' ? '正在返回识别结果…' : '正在回复…'); }
      else a.stopTyping();
      acc += chunk.delta;
      a.setText(acc);
      scrollBottom();
    }
    messages.push(userMsg);                 // 含图片附件，确保会话持久化保留原图数据
    messages.push({ role: 'assistant', content: acc });
    setStatus('');
  } catch (e) {
    a.stopTyping();
    a.setText(acc ? acc + '\n\n[中断] ' + e.message : '错误：' + e.message);
    setStatus('错误：' + e.message, 'err');
  } finally {
    streaming = false; updateSendState(); scrollBottom();
    // 发送消息后功能标签消失（翻译 / 解释 / 文件模式在此清除；总结网页为即时执行，
    // 标签在其执行期间保留，直至用户发送下一条消息或手动关闭）
    clearFuncMode();
    persistActiveConversation();   // 每次成功发送后自动保存 / 更新当前会话
  }
}

$('#composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

// ============================================================
// 网页操作模式：ReAct 工具循环
// AI 流式输出中若含 ```toolcall 块，则执行该工具并把结果回灌，
// 直至 AI 给出最终自然语言回答（或达到迭代上限）。
// ============================================================
const MAX_TOOL_ITERS = 15;

/** 单次发起 AUTOMATE 请求，带超时保护：无论成功 / 失败 / 超时都会 resolve，绝不悬挂 */
function sendAutomateOnce(name, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ ok: false, error: '工具执行超时（' + timeoutMs + 'ms 内未收到响应）' });
    }, timeoutMs);
    try {
      chrome.runtime.sendMessage({ type: 'AUTOMATE', tool: name, args: args || {} }, (resp) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) return resolve({ ok: false, error: err.message || '消息端口已关闭' });
        return resolve((resp && typeof resp === 'object') ? resp : { ok: false, error: '空响应' });
      });
    } catch (e) {
      if (!done) { done = true; clearTimeout(timer); }
      resolve({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });
}

/** 瞬时性错误（SW 重启 / 端口断开 / 扩展上下文失效）：可被重试自愈 */
const TRANSIENT_ERR = /port closed before a response|receiving end does not exist|extension context invalidated|cannot establish|message port|back\/forward cache|bfcache/i;

/**
 * 调用 background 的 AUTOMATE 接口执行某个网页工具。
 * 内置超时 + 重试：遇到瞬时端口错误会自动重建保活连接并重试（指数退避），
 * 确保响应完整性，避免 “The message port closed before a response was received.”。
 */
async function execToolCall(name, args, attempt = 0) {
  const MAX_ATTEMPTS = 3;
  const res = await sendAutomateOnce(name, args);
  if (res.ok || !TRANSIENT_ERR.test(res.error || '') || attempt >= MAX_ATTEMPTS - 1) {
    return res;
  }
  // 瞬时失败：重建保活连接 + 指数退避后重试
  console.warn('[automate] 工具调用瞬时失败，正在进行第 ' + (attempt + 1) + ' 次重试：', res.error);
  ensureBgPort();
  await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  return execToolCall(name, args, attempt + 1);
}

/** 由工具执行结果构建持久化 / 渲染用的结构化对象（归属 AI） */
function buildToolResult(name, args, result) {
  const ok = !!(result && result.ok);
  let shot = null, summary = null;
  if (ok && result.result) {
    const info = { ...result.result };
    if (info.dataUrl) { shot = info.dataUrl; delete info.dataUrl; }
    summary = Object.keys(info).length ? JSON.stringify(info) : null;
  }
  return {
    name,
    args: args || {},
    ok,
    shot,        // 仅用于实时展示（截图 dataUrl），持久化时剔除以免撑爆存储
    summary,
    error: ok ? null : (result && result.error ? String(result.error) : '工具执行失败'),
  };
}

/** 渲染一张“工具执行”卡片（工具名 / 参数 / 结果 / 截图），始终作为 AI 消息归属。
 *  live 展示与历史回放共用，确保重新打开会话后归属与样式一致。 */
function pushToolMessage(m) {
  const t = m.tool || {};
  const ok = !!t.ok;
  const el = document.createElement('div');
  el.className = 'msg tool';
  let body = '';
  // AI 的自然语言备注（若有且不只是一条通用占位）作为卡片上方小字说明
  if (m.content && m.content.trim() && !/^调用工具[:：]/.test(m.content.trim())) {
    body += `<div class="tool-note">${escapeHtml(m.content)}</div>`;
  }
  body += `<div class="tool-head">🛠 ${escapeHtml(t.name || '工具')} <span class="tool-badge ${ok ? 'ok' : 'err'}">${ok ? '成功' : '失败'}</span></div>`;
  body += `<div class="tool-args">${escapeHtml(JSON.stringify(t.args || {}))}</div>`;
  if (ok && t.shot) {
    body += `<div class="tool-result ok"><img class="tool-shot" src="${t.shot}" alt="截图"/></div>`;
  }
  if (ok && t.summary) {
    body += `<div class="tool-result ok">${escapeHtml(t.summary)}</div>`;
  }
  if (!ok && t.error) {
    body += `<div class="tool-result err">${escapeHtml(t.error)}</div>`;
  }
  el.innerHTML = body;
  chatScroll.appendChild(el);
  scrollBottom();
  return el;
}

/** 网页操作主循环 */
async function runAutomation(userText) {
  if (streaming) return;
  const content = (userText || '').trim();
  if (!content) return;

  pushUser(content);
  messages.push({ role: 'user', content });

  // A. 发起自动化前，先取“当前网页”快照（标题/网址/首屏正文）注入系统提示，
  // 让模型开局就知道自己正在操作哪个页面，避免弱模型凭空假设页面结构（如乱点不存在的按钮、擅自新开标签）。
  let pageCtx = '';
  try {
    const page = await getActivePage();
    if (page && page.url) {
      const snippet = (page.text || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
      pageCtx = '\n\n【当前网页上下文（请基于它操作，不要新开/跳转其他页面）】\n' +
        '标题：' + (page.title || '') + '\n' +
        '网址：' + page.url + '\n' +
        '首屏正文摘要：' + (snippet || '（无正文）');
    }
  } catch (_) { /* 取不到也不阻断主流程，仅缺少页面上下文 */ }

  const sysMsg = { role: 'system', content: buildToolSystemPrompt() + pageCtx };
  // 后台循环上下文（仅用于把工具返回结果回灌给 AI 续跑），不写入用户可见历史
  const loop = [];
  // E. 记录最近一次工具执行是否失败：若模型在上一步失败的情况下仍输出 DONE，需纠正其继续
  let lastToolFailed = false;

  // 模型可用性检查（与 send() 一致）
  const mode = chatModelId === '__collab__' ? 'collab' : 'single';
  if (mode === 'collab') {
    if (!models.filter(m => m.enabled !== false).some(m => m.isPrimary)) {
      alert('请在模型配置页面选择主模型后再进行网页操作');
      return;
    }
  } else if (!models.some(m => m.id === chatModelId)) {
    alert('请先在设置中添加并启用模型');
    return;
  }
  const ref = currentRefModel();
  const ts = (ref && ref.supportsThinking) ? thinkingStrength : undefined;
  // 是否存在支持看图的模型：决定是否在工具执行后回灌截图（用于读取图表/图片中的目标数据）
  const visionOk = models.some(m => m.supportsVision);

  let a = null;
  let acc = '';
  streaming = true; sendBtn.disabled = true; setStatus('思考中…');
  try {
    let iter = 0;
    while (iter < MAX_TOOL_ITERS) {
      iter++;
      a = a || newAssistant();
      acc = '';
      a.setText('');
      let started = false;
      setStatus('思考中…');
      const apiMessages = [sysMsg, ...messages, ...loop];
      for await (const chunk of chatStream({ models, backupModels }, apiMessages, {
        mode,
        selectedId: mode === 'single' ? chatModelId : undefined,
        thinkingStrength: ts,
        onFallback: (i, cfg, reason) => setStatus(`已切换到备用模型 #${i + 1}：${cfg.name}（${reason}）`),
      })) {
        if (chunk.error === 'NO_PRIMARY') {
          a.stopTyping();
          a.setText('请在模型配置页面选择主模型后再进行聊天');
          setStatus('未选择主模型', 'err');
          return;
        }
        if (!started) { started = true; a.stopTyping(); setStatus('正在回复…'); }
        else a.stopTyping();
        acc += chunk.delta;
        a.setText(acc);
        scrollBottom();
      }

      const calls = parseToolCalls(acc);
      if (calls.length) {
        const display = stripToolCall(acc).trim();
        if (display) a.setText(display);
        // 顺序执行本轮解析到的所有工具调用（支持一次回复包含多个连续动作）
        for (const call of calls) {
          setStatus('正在执行操作…');
          const result = await execToolCall(call.name, call.args);
          // E. 记录本步工具是否失败，供后续 DONE 校验（上一步失败时不允许判任务完成）
          lastToolFailed = !(result && result.ok);
          // 视觉回灌：工具结果若已含截图则用之；否则当任一模型支持看图时主动截图，
          // 便于模型读取图表 / 图片中的目标数据（解决“数据在图表中读不到”的问题）。
          let shotUrl = (result && result.ok && result.result && result.result.dataUrl) || null;
          if (!shotUrl && visionOk) {
            try {
              const s = await execToolCall('screenshot', {});
              if (s && s.ok && s.result && s.result.dataUrl) shotUrl = s.result.dataUrl;
            } catch (_) { /* 截图失败不影响主流程 */ }
          }
          // 把截图并入结果（工具卡片展示用；持久化时 buildToolResult 会剔除 base64 以免撑爆存储）
          if (shotUrl) { result.result = result.result || {}; result.result.dataUrl = shotUrl; }
          // 结构化工具消息（归属 AI）：界面展示 + 历史持久化，仅保留“AI 使用了什么工具”的简洁提示。
          // 注意：content 必须是中性确认语，绝不能写成“调用工具：name”这类会被模型原样复读的指令式
          // 中文——否则会作为历史回灌给下一个模型，被它误读为一次新的工具调用，进而在 T1 分支被误判为
          // “已完成”而提前结束（曾导致 SenseNova 第二次截图时输出“调用工具：screenshot”即收尾）。
          const toolMsg = {
            role: 'assistant',
            content: display || (`已对网页执行 ${call.name} 操作`),
            tool: buildToolResult(call.name, call.args, result),
          };
          // 移除本轮流式气泡，改用工具卡片展示，避免重复呈现
          if (a && a.el) a.el.remove();
          pushToolMessage(toolMsg);
          messages.push(toolMsg);
          // 后台循环上下文：把工具返回结果回灌给 AI 续跑（仅用于模型上下文，不写入用户可见历史）。
          // 回灌文本剔除截图 base64（图片已作为附件单独传递），避免上下文臃肿。
          const resForText = (result && result.ok && result.result) ? { ...result.result } : null;
          if (resForText && resForText.dataUrl) delete resForText.dataUrl;
          const loopMsg = {
            role: 'user',
            content: `[工具执行结果]\n工具: ${call.name}\n参数: ${JSON.stringify(call.args || {})}\n` +
              (result && result.ok
                ? '成功: ' + JSON.stringify(resForText)
                : '失败: ' + (result && result.error || '未知错误')) +
              '\n请基于以上结果继续操作，或直接给出最终回答。' +
              (shotUrl ? '\n（已附上当前页面截图，若目标数据以图表/图片形式呈现，请直接读取截图内容提取。）' : ''),
          };
          if (shotUrl) loopMsg.attachments = [{ type: 'image', data: shotUrl }];
          loop.push(loopMsg);
        }
        a = null; // 下一轮新建气泡（继续让 AI 决定后续动作，直到给出最终回答）
        continue;
      }

      // 兜底防误终止：若本轮未解析到规范工具调用，但回复文本疑似仍含工具调用意图
      // （如模型用中文“调用工具：name”、或残留 tool_call/toolcall 等关键字），且尚未达到最大步数，
      // 则不要立即判定为“已完成最终回答”（否则会像 SenseNova 那样把“调用工具：screenshot”当答案提前结束）。
      // 改为作为一次观察回灌并继续循环，引导模型改用规范格式，由 MAX_TOOL_ITERS 兜住任何潜在的死循环。
      const hasToolIntent = /(?:调用|使用|执行)\s*工具|tool_?call|function_?call|toolcall/i.test(acc);
      if (!calls.length && hasToolIntent && iter < MAX_TOOL_ITERS) {
        loop.push({ role: 'user', content: '[系统提示] 你刚才的回复疑似包含工具调用，但格式未被正确识别（例如中文“调用工具：name”缺少 JSON 参数，或拼写不规范）。请改用规范的 toolcall 代码块重新发起工具调用：\n```toolcall\n{"name":"工具名","args":{}}\n```\n若任务确实已全部完成，请直接给出最终的自然语言回答，并在末尾单独一行输出 DONE 标记。' });
        a = null;
        continue;
      }

      // 结束判定：DONE 标记（独占一行）视为任务彻底完成；否则视为“中途汇报/思考”，继续循环。
      // 这样即便弱模型提前用自然语言总结，也不会被误判为结束（除非它真的输出 DONE）。
      const doneMark = /^\s*DONE\s*$/m.test(acc);
      if (!calls.length && !doneMark && iter < MAX_TOOL_ITERS) {
        loop.push({
          role: 'user',
          content: '[系统提示] 你刚才的回复没有包含 DONE 结束标记，系统据此认为任务尚未完成（可能还有步骤未执行）。' +
            '请继续完成用户的全部要求：若还需操作网页就用 toolcall 块调用工具；若确实已全部完成，' +
            '请在最终回答的末尾单独一行输出 DONE 标记后再结束。不要仅用自然语言“汇报”就停止。',
        });
        a = null;
        continue;
      }

      // E. 防作弊：模型输出 DONE，但上一步工具执行其实是失败的（ok:false），不算完成。
      // 回灌纠正并继续循环，避免模型“跳过失败”直接宣布完成（如 agnes 在新开禁自动化页失败后仍返回 DONE）。
      if (!calls.length && doneMark && lastToolFailed && iter < MAX_TOOL_ITERS) {
        loop.push({
          role: 'user',
          content: '[系统提示] 你输出了 DONE，但上一步工具调用实际上是失败的（未成功执行）。' +
            '失败的任务不能视为完成。请检查上一步的错误原因，调整选择器 / 方式重试，或换一条可行路径继续完成任务；' +
            '只有在某一步工具真正成功（ok:true）且已取得用户所需数据后，才输出 DONE。',
        });
        a = null;
        lastToolFailed = false; // 重置，避免同一失败反复触发（下一轮会重新据实设置）
        continue;
      }

      // 无工具调用、且已输出 DONE（或已达上限）→ 任务结束
      messages.push({ role: 'assistant', content: acc });
      if (iter >= MAX_TOOL_ITERS && !/^\s*DONE\s*$/m.test(acc)) {
        // 已达轮次上限仍未给出 DONE 标记：明确告知用户任务可能未完整完成，避免被误当结论
        const note = '\n\n[提示] 已达到最大操作轮次（' + MAX_TOOL_ITERS + '）仍未收到完成标记，任务可能尚未全部完成。可继续补充指令或重新发起。';
        messages[messages.length - 1].content += note;
        if (a && a.el) a.setText(messages[messages.length - 1].content);
      }
      setStatus('');
      break;
    }
  } catch (e) {
    if (a) {
      a.stopTyping();
      a.setText(acc ? acc + '\n\n[中断] ' + e.message : '错误：' + e.message);
    }
    setStatus('错误：' + e.message, 'err');
  } finally {
    streaming = false; updateSendState(); scrollBottom();
    clearFuncMode();
    persistActiveConversation();
  }
}

// ============================================================
// 加号：功能入口菜单（添加文件 / 总结网页 / 翻译 / 解释 / OCR 识别 / 网页操作）
// ============================================================
const plusWrap = document.querySelector('.plus-wrap');
const funcMenu = $('#funcMenu');

function openFuncMenu() {
  funcMenu.hidden = false;
  plusWrap.classList.add('open');
  $('#plusBtn').setAttribute('aria-expanded', 'true');
}
function closeFuncMenu() {
  funcMenu.hidden = true;
  plusWrap.classList.remove('open');
  $('#plusBtn').setAttribute('aria-expanded', 'false');
}
$('#plusBtn').onclick = (e) => {
  e.stopPropagation();
  if (funcMenu.hidden) openFuncMenu(); else closeFuncMenu();
};
// 点击菜单项：执行对应功能并关闭菜单
funcMenu.querySelectorAll('.func-item').forEach(b => {
  b.onclick = (e) => {
    e.stopPropagation();
    closeFuncMenu();
    activateFunc(b.dataset.act);
  };
});
// 点击菜单外部 / 按 Esc 关闭
document.addEventListener('click', (e) => {
  if (!funcMenu.hidden && !plusWrap.contains(e.target)) closeFuncMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !funcMenu.hidden) closeFuncMenu(); });

/** 激活某个功能：设置模式、显示高亮标签、必要时立即执行 */
function activateFunc(act) {
  if (act === 'file') {
    $('#fileInput').click();
    return;
  }
  if (act === 'summarize') {
    setMode({ type: 'summarize', label: '📄 总结网页' });
    // 预填总结指令到输入框，等待用户手动编辑并点击发送（不再自动发送）
    input.value = '请总结当前网页';
    input.placeholder = '可编辑总结指令，点击发送后总结当前网页…';
    autosize();
    input.focus();
    updateSendState();
    return;
  }
  if (act === 'automate') {
    setMode({ type: 'automate', label: '🤖 网页操作' });
    input.value = '';
    input.placeholder = '描述要对当前网页执行的操作，例如：点击登录按钮 / 在搜索框输入“AI”并回车…';
    autosize();
    input.focus();
    updateSendState();
    return;
  }
  if (act === 'translate' || act === 'explain') {
    translateTarget = '';   // 切换功能时重置目标语言
    setMode({
      type: act,
      label: act === 'translate' ? '🌐 翻译' : '💡 解释',
    });
    input.placeholder = act === 'translate'
      ? '输入要翻译的文字，选择目标语言后发送…'
      : '输入要解释的文字，发送后解释…';
    input.focus();
  }
  if (act === 'ocr') {
    setMode({ type: 'ocr', label: '🔍 OCR 识别' });
    input.value = '';
    input.placeholder = '添加图片后直接发送即可识别其中文字（无需输入文本）…';
    autosize();
    input.focus();
    updateSendState();
    return;
  }
}

/** 设置功能模式并渲染标签 */
function setMode(mode) {
  activeMode = mode;
  renderFuncTag();
}
/** 清除功能模式（发送消息或手动关闭后调用） */
function clearFuncMode() {
  activeMode = null;
  translateTarget = '';
  input.placeholder = '给 AI 助手发消息…  (Enter 发送，Shift+Enter 换行)';
  renderFuncTag();
}
/** 渲染聊天框上方的高亮标签 */
function renderFuncTag() {
  const box = $('#funcTag');
  if (!activeMode) { box.hidden = true; box.innerHTML = ''; return; }
  const label = activeMode.label || activeMode.type;
  box.hidden = false;
  box.innerHTML = '';

  // 翻译模式：目标语言下拉置于标签（胶囊）右侧；关闭按钮位于胶囊右边缘，与下拉框解耦
  if (activeMode.type === 'translate') {
    const pill = document.createElement('span');
    pill.className = 'func-tag-pill';
    pill.textContent = label;

    // 关闭按钮：放入胶囊内部右边缘，定位只取决于标签本身，不受下拉框宽度/布局影响
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'func-tag-x';
    close.id = 'funcTagClose'; close.title = '关闭'; close.setAttribute('aria-label', '关闭');
    close.textContent = '×';
    close.onclick = () => clearFuncMode();
    pill.appendChild(close);

    // 目标语言下拉：作为胶囊的兄弟节点，排在标签右侧
    const sel = document.createElement('select');
    sel.id = 'translateLang';
    sel.className = 'func-tag-select';
    sel.title = '选择目标语言';
    const def = document.createElement('option');
    def.value = ''; def.textContent = '选择语言';
    sel.appendChild(def);
    for (const l of TARGET_LANGS) {
      const o = document.createElement('option');
      o.value = l; o.textContent = l;
      sel.appendChild(o);
    }
    sel.value = translateTarget;
    sel.onchange = () => { translateTarget = sel.value; updateSendState(); };

    box.appendChild(pill);
    box.appendChild(sel);
    return;
  }

  box.innerHTML =
    `<span class="func-tag-pill">${escapeHtml(label)}` +
    `<button type="button" class="func-tag-x" id="funcTagClose" title="关闭" aria-label="关闭">×</button></span>`;
  $('#funcTagClose').onclick = () => clearFuncMode();
}
/** 文件添加后，若处于 file 模式则刷新标签上的数量 */
function syncFileTag() {
  if (activeMode && activeMode.type === 'file') {
    activeMode.label = `📎 已添加文件 (${attachments.length})`;
    renderFuncTag();
  }
}

$('#fileInput').addEventListener('change', async (e) => {
  for (const file of e.target.files) {
    const isImage = file.type.startsWith('image/');
    if (isImage) {
      const dataUrl = await readFileAsDataURL(file);
      attachments.push({ name: file.name, type: file.type || 'image/png', content: '', dataUrl });
    } else {
      const content = await file.text().catch(() => '');
      attachments.push({ name: file.name, type: file.type || 'application/octet-stream', content, dataUrl: '' });
    }
  }
  e.target.value = '';
  renderAttachments(); updateSendState();
  // 图片相关功能模式（如 OCR）下添加图片应保持原模式，不要被“文件”模式覆盖
  if (attachments.length && (!activeMode || activeMode.type !== 'ocr')) {
    setMode({ type: 'file', label: `📎 已添加文件 (${attachments.length})` }); syncFileTag();
  }
});

/** 把图片文件读取为 data URL（供多模态消息使用） */
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

// ============================================================
// 聊天输入框粘贴图片：检测剪贴板图片 → 上传（或 data URL 兜底）→ 以 Markdown 插入光标处
// ============================================================

/** 解析上传响应里的图片 URL（支持 <code>data.url</code> 形式的取值路径） */
function resolveUrlPath(obj, path) {
  if (!obj) return null;
  if (!path || !path.trim()) return obj.url || obj.data || null;
  const val = path.trim().split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  return typeof val === 'string' ? val : null;
}

/** 上传图片：配置了上传地址则真实 POST，否则降级为内嵌 data URL */
async function uploadImage(file) {
  const endpoint = (imgUploadCfg.url || '').trim();
  if (!endpoint) return await readFileAsDataURL(file);   // 兜底：data URL
  const fd = new FormData();
  fd.append('file', file, file.name || 'image.png');
  const headers = {};
  const auth = (imgUploadCfg.auth || '').trim();
  if (auth) headers['Authorization'] = auth;
  const res = await fetch(endpoint, { method: 'POST', body: fd, headers });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json().catch(() => null);
  const url = resolveUrlPath(json, imgUploadCfg.path);
  if (!url) throw new Error('响应中未找到图片 URL');
  return url;
}

/** 在输入框光标处插入文本并移动光标 */
function insertAtCursor(text) {
  const v = input.value;
  const start = input.selectionStart == null ? v.length : input.selectionStart;
  const end = input.selectionEnd == null ? v.length : input.selectionEnd;
  input.value = v.slice(0, start) + text + v.slice(end);
  const pos = start + text.length;
  input.setSelectionRange(pos, pos);
  autosize();
  updateSendState();
}

/** 轻量 toast 通知 */
function toast(msg, kind = '') {
  let host = document.getElementById('toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, 3200);
}

/** 监听聊天输入框粘贴：图片 → 以缩略图进入附件区（渲染为图片，非文本）；纯文本 → 保持原生粘贴 */
input.addEventListener('paste', (e) => {
  const cd = e.clipboardData;
  if (!cd) return;                       // 无剪贴板数据：保持默认
  // 收集图片：系统截图（items，kind=file）或文件管理器复制（files）
  const images = [];
  if (cd.items && cd.items.length) {
    for (const it of cd.items) {
      if (it.kind === 'file' && /^image\//.test(it.type)) {
        const f = it.getAsFile();
        if (f) images.push(f);
      }
    }
  }
  if (!images.length && cd.files && cd.files.length) {
    for (const f of cd.files) if (/^image\//.test(f.type)) images.push(f);
  }
  if (!images.length) return;           // 仅文本：不拦截，保持原生粘贴

  e.preventDefault();                    // 有图片：拦截，避免混入原始字节 / 文件路径
  // 若剪贴板同时带文本，仍保留文本到输入框
  const text = cd.getData ? cd.getData('text/plain') : '';
  if (text) insertAtCursor(text);

  const endpoint = (imgUploadCfg.url || '').trim();
  for (const file of images) {
    // 同步入列占位对象，严格保持粘贴顺序；随后异步填充 data URL
    const att = {
      name: file.name || `粘贴图片-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`,
      type: file.type || 'image/png',
      content: '', dataUrl: '', url: '', uploading: true,
    };
    attachments.push(att);
    renderAttachments(); updateSendState();

    readFileAsDataURL(file)
      .then(dataUrl => {
        att.dataUrl = dataUrl;           // 立即以原图 data URL 渲染缩略图（保清晰度、可作多模态发送）
        if (!endpoint) att.uploading = false;
        renderAttachments();
        if (endpoint) {
          // 配置了上传端点：后台上传记录 URL（显示与发送始终用本地 data URL，保清晰）
          uploadImage(file)
            .then(url => { att.url = url; })
            .catch(err => toast('图片上传失败（仍以本地图片发送）：' + (err && err.message ? err.message : err), 'err'))
            .finally(() => { att.uploading = false; renderAttachments(); });
        }
      })
      .catch(err => {
        const i = attachments.indexOf(att);
        if (i >= 0) attachments.splice(i, 1);
        renderAttachments(); updateSendState();
        toast('读取图片失败：' + (err && err.message ? err.message : err), 'err');
      });
  }
});

// ============================================================
// 当前网页正文获取：真实扩展走 background，预览走父页面 postMessage，兜底抽取当前文档
// ============================================================
function extractText(doc) {
  const root = doc.querySelector('article') || doc.querySelector('main') || doc.body;
  if (!root) return '';
  const clone = root.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,nav,header,footer,aside').forEach(el => el.remove());
  return (clone.innerText || clone.textContent || '')
    .replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 向宿主页（host.html）请求当前页正文 */
function requestPageFromParent(timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    if (window.parent === window) { reject(new Error('无父页面')); return; }
    const ch = '__pg_' + Math.random().toString(36).slice(2);
    const onMsg = (e) => {
      if (e.data && e.data.type === 'PAGE_RESULT' && e.data._ch === ch) {
        window.removeEventListener('message', onMsg);
        resolve({ title: e.data.title || '', text: e.data.text || '', url: e.data.url || '' });
      }
    };
    window.addEventListener('message', onMsg);
    window.parent.postMessage({ type: 'GET_PAGE', _ch: ch }, '*');
    setTimeout(() => { window.removeEventListener('message', onMsg); reject(new Error('等待宿主页响应超时')); }, timeoutMs);
  });
}

/** 获取“当前所在网页”的实际正文 */
async function getActivePage() {
  // 1) 真实扩展环境：让 background 去向当前标签页内容脚本取正文
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
    try {
      const page = await chrome.runtime.sendMessage({ type: 'GET_PAGE' });
      if (page) {
        if (page.error) throw new Error(page.error);
        if (page.text && page.text.trim()) {
          return { title: page.title || '', text: page.text, url: page.url || '' };
        }
      }
    } catch (e) {
      throw e;
    }
  }
  // 2) 预览宿主页（host.html iframe）：向父页面要正文
  try {
    const page = await requestPageFromParent();
    if (page && page.text && page.text.trim()) return page;
  } catch (_) { /* 退回兜底 */ }
  // 3) 兜底：直接抽取当前文档（通常是预览页自身）
  return { title: document.title, text: extractText(document), url: location.href };
}

/** 在聊天中内联总结当前网页（点击“总结网页”后立即执行） */
async function runSummarizeInChat(instruction) {
  if (streaming) return;
  setStatus('正在获取当前网页…');
  let page;
  try { page = await getActivePage(); }
  catch (e) { setStatus('获取网页失败：' + e.message, 'err'); clearFuncMode(); return; }
  if (!page.text || !page.text.trim()) {
    setStatus('未能从当前网页提取到正文', 'err'); clearFuncMode(); return;
  }

  const welcome = $('#welcome');
  if (welcome) welcome.remove();
  const prompt = (instruction && instruction.trim())
    ? instruction.trim()
    : ('总结网页' + (page.title ? `：${page.title}` : ''));
  pushUser(prompt);
  const a = newAssistant();
  streaming = true; sendBtn.disabled = true; setStatus('正在总结…');

  let acc = ''; let started = false;
  try {
    for await (const chunk of summarizeStream({ models: prepareModels() }, page, {
      kb: makeKb(),
      instruction: prompt,
      onFallback: (i, cfg, reason) => setStatus(`已切换到备用模型 #${i + 1}：${cfg.name}（${reason}）`),
    })) {
      if (!started) { started = true; a.stopTyping(); setStatus('正在回复…'); }
      else a.stopTyping();
      acc += chunk.delta;
      a.setText(acc);
      scrollBottom();
    }
    messages.push({ role: 'user', content: prompt });
    messages.push({ role: 'assistant', content: acc });
    setStatus('');
  } catch (e) {
    a.stopTyping();
    a.setText(acc ? acc + '\n\n[中断] ' + e.message : '错误：' + e.message);
    setStatus('错误：' + e.message, 'err');
  } finally {
    streaming = false; updateSendState(); scrollBottom();
    // 发送消息（或手动关闭）后功能标签消失；总结现已改为“手动发送”，故发送后清除标签
    clearFuncMode();
    persistActiveConversation();   // 总结网页会话同样自动保存
  }
}

// ============================================================
// ============================================================
// 设置视图
// ============================================================
/**
 * 将模型别名同步为所选/输入的模型名，仅在用户未手动编辑别名时生效。
 * @param {HTMLElement} card 模型卡片元素
 * @param {number} i 模型下标
 * @param {string} modelVal 当前模型名
 */
// 图标（内联 SVG，便于在按钮中直接渲染并随状态切换）
const ICON_SAVE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const ICON_UP = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
const ICON_DOWN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>';

function syncAlias(card, arr, i, modelVal) {
  if (arr[i].nameEdited) return;  // 用户已自定义别名，不覆盖
  arr[i].name = modelVal;
  const alias = card.querySelector('input[data-f="name"]');
  if (alias) alias.value = modelVal;
}

function renderModels() {
  const wrap = $('#modelList');
  wrap.innerHTML = models.map((m, i) => {
    const vlabel = (v) => (v === 'openai' || v === 'anthropic') ? `${v}（兼容）` : v;
    const modelOpts = (fetchedModels[m.id] || [])
      .map(id => `<option value="${escapeHtml(id)}"></option>`)
      .join('');
    return `
    <div class="model-card${m.collapsed ? ' collapsed' : ''}" data-i="${i}">
      <div class="mc-head">
        <input data-f="name" class="mc-alias" value="${escapeHtml(m.name || '')}"
               placeholder="模型别名（选填，默认同模型名）"${m.collapsed ? ' readonly' : ''} />
        <button class="icon-btn mc-save" data-save="${i}"
                title="${m.collapsed ? '展开编辑' : '保存并收起'}">
          ${m.collapsed ? ICON_EDIT : ICON_SAVE}
        </button>
        <button class="icon-btn del" data-del="${i}" title="删除">${ICON_TRASH}</button>
      </div>
      <div class="mc-grid">
        <label class="full">厂商
          <select data-f="vendor">
            ${['openai', 'anthropic', 'gemini', 'ollama'].map(v =>
              `<option value="${v}" ${m.vendor === v ? 'selected' : ''}>${vlabel(v)}</option>`).join('')}
          </select>
        </label>
        <label class="full">模型
          <input data-f="model" class="model-input" list="dl-${m.id}"
                 value="${escapeHtml(m.model || '')}"
                 placeholder="填 API Base / Key 后自动获取，或手动输入模型名" />
          <datalist id="dl-${m.id}">${modelOpts}</datalist>
          <span class="model-status"></span>
        </label>
        <label>超时 ms <input data-f="timeoutMs" type="number" value="${m.timeoutMs || 60000}" /></label>
        <label class="full">API Base <input data-f="apiBase" value="${escapeHtml(m.apiBase || '')}" /></label>
        <label class="full">API Key <input data-f="apiKey" type="password" value="${escapeHtml(m.apiKey || '')}" /></label>
      </div>
      <div class="mc-grid">
        <label class="full range-row">Temperature
          <span class="range-wrap">
            <input type="range" data-f="temperature" min="0" max="2" step="0.1"
                   value="${typeof m.temperature === 'number' ? m.temperature : 1}" />
            <span class="range-val" data-val="temperature">${typeof m.temperature === 'number' ? m.temperature : 1}</span>
          </span>
        </label>
        <label class="full range-row">Top P
          <span class="range-wrap">
            <input type="range" data-f="top_p" min="0" max="1" step="0.05"
                   value="${typeof m.top_p === 'number' ? m.top_p : 1}" />
            <span class="range-val" data-val="top_p">${typeof m.top_p === 'number' ? m.top_p : 1}</span>
          </span>
        </label>
      </div>
      <div class="mc-checks">
        <label><input type="checkbox" data-f="enabled" ${m.enabled !== false ? 'checked' : ''}/> 启用</label>
        <label><input type="checkbox" data-f="supportsVision" ${m.supportsVision ? 'checked' : ''}/> 视觉</label>
        <label><input type="checkbox" data-f="supportsStream" ${m.supportsStream !== false ? 'checked' : ''}/> 流式</label>
        <label><input type="checkbox" data-f="isPrimary" ${m.isPrimary ? 'checked' : ''}/> 主模型</label>
        <label><input type="checkbox" data-f="supportsThinking" ${m.supportsThinking ? 'checked' : ''}/> 思考</label>
      </div>
    </div>`;
  }).join('');

  wrap.querySelectorAll('[data-f]').forEach(inp => {
    inp.addEventListener('change', () => {
      const card = inp.closest('.model-card');
      const i = +card.dataset.i;
      const f = inp.dataset.f;
      const val = inp.type === 'checkbox' ? inp.checked : inp.value;
      models[i][f] = (f === 'timeoutMs' || f === 'temperature' || f === 'top_p') ? Number(val) : val;

      // ---- 复选框联动规则 ----
      if (f === 'supportsVision' && val) {
        // 视觉全局互斥：清除其他模型的视觉标记，并禁用本卡其余框
        models.forEach((m, j) => { if (j !== i) m.supportsVision = false; });
        models[i].isPrimary = false; // 视觉模型不再兼作主模型
      }
      if (f === 'enabled' && !val) {
        models[i].isPrimary = false; // 停用模型不能作主模型
      }
      if (f === 'isPrimary' && val) {
        // 主模型单选：清空其他已启用模型的主模型标记
        models.forEach((m, j) => { if (j !== i) m.isPrimary = false; });
      }

      if (f === 'name') {
        models[i].nameEdited = !!String(val).trim();
      }
      if (f === 'model') syncAlias(card, models, i, val);
      if (f === 'vendor') {
        models[i].model = '';
        const mi = card.querySelector('input[data-f="model"]');
        if (mi) mi.value = '';
        syncAlias(card, models, i, '');
      }
      persistModelsToStorage(models);
      refreshCheckboxUI();              // 重算各复选框的禁用/选中态
      if (f === 'apiBase' || f === 'apiKey' || f === 'vendor') refreshModelList(models, i, wrap);
      if (f === 'name' || f === 'model' || f === 'vendor' || f === 'enabled' || f === 'isPrimary' || f === 'supportsVision') renderModelSelect();
    });
  });
  // 滑块（temperature / top_p）：拖动时实时显示数值并同步存储；range 原生约束越界
  wrap.querySelectorAll('input[type="range"]').forEach(r => {
    r.addEventListener('input', () => {
      const card = r.closest('.model-card');
      const i = +card.dataset.i;
      const f = r.dataset.f;
      const v = Math.round(Number(r.value) * 100) / 100;  // 限两位小数，避免浮点精度异常
      models[i][f] = v;
      persistModelsToStorage(models);
      const vspan = card.querySelector(`.range-val[data-val="${f}"]`);
      if (vspan) vspan.textContent = v;
    });
  });
  // 模型组合框：点击/聚焦时清空筛选条件，展示完整候选列表；
  // 若失焦时用户未重新选择（仍为空），则还原原模型名，避免误清空。
  wrap.querySelectorAll('input[data-f="model"]').forEach(inp => {
    const showAll = () => {
      if (inp.value) { inp.dataset.prev = inp.value; inp.value = ''; }
    };
    // focus 覆盖 Tab 聚焦；mousedown 覆盖“已聚焦再次点击”场景
    inp.addEventListener('focus', showAll);
    inp.addEventListener('mousedown', () => { if (document.activeElement === inp) showAll(); });
    inp.addEventListener('blur', () => {
      if (!inp.value && inp.dataset.prev) inp.value = inp.dataset.prev;
      delete inp.dataset.prev;
      // 以最终显示值为准，保持存储一致
      const card = inp.closest('.model-card');
      const i = +card.dataset.i;
      models[i].model = inp.value;
      syncAlias(card, models, i, inp.value);
      persistModelsToStorage(models);
    });
  });

  wrap.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    delete fetchedModels[models[+b.dataset.del]?.id];
    models.splice(+b.dataset.del, 1);
    persistModelsToStorage(models); renderModels();
  });

  // 保存/编辑图标：点击保存 → 写入当前配置并折叠收起；点击编辑 → 重新展开
  wrap.querySelectorAll('[data-save]').forEach(b => b.onclick = () => {
    const i = +b.dataset.save;
    const card = b.closest('.model-card');
    if (!models[i].collapsed) {
      // 保存：先把别名输入值同步进模型配置（避免只改了别名未失焦）
      const alias = card.querySelector('input[data-f="name"]');
      if (alias) { models[i].name = alias.value; models[i].nameEdited = !!alias.value.trim(); }
      models[i].collapsed = true;
    } else {
      models[i].collapsed = false;
    }
    persistModelsToStorage(models);
    renderModels();
  });

  // 已填好 API Base / Key 的卡片，加载时即自动拉取模型列表
  models.forEach((m, i) => {
    if ((m.apiBase || '').trim() && (m.apiKey || '').trim()) refreshModelList(models, i, wrap);
  });
  // 配置变更后实时同步聊天框的模型下拉，避免选项不同步/缺失
  refreshCheckboxUI();
  renderModelSelect();
}

/**
 * 自动获取并填充某卡片的模型候选列表（datalist）；含加载与失败提示。
 * 不覆盖用户在输入框里已填/手动输入的模型名，仅提供可选候选项。
 * @param {Array} arr 模型数组（models 或 backupModels）
 * @param {number} i 模型在 arr 中的下标
 * @param {HTMLElement} wrap 卡片所在容器（用于作用域查询，避免与另一列表的 data-i 冲突）
 */
async function refreshModelList(arr, i, wrap) {
  const m = arr[i];
  if (!m) return;
  const card = wrap.querySelector(`.model-card[data-i="${i}"]`);
  if (!card) return;
  const dl = card.querySelector('datalist');
  const status = card.querySelector('.model-status');
  const base = (m.apiBase || '').trim();
  const key = (m.apiKey || '').trim();

  if (!base || !key) {
    delete fetchedModels[m.id];
    if (dl) dl.innerHTML = '';
    if (status) { status.textContent = '可手动输入模型名，或填写 API Base / Key 后自动获取候选'; status.className = 'model-status'; }
    return;
  }

  if (status) { status.textContent = '正在获取模型列表…'; status.className = 'model-status loading'; }
  try {
    const list = await listModels({ vendor: m.vendor, apiBase: base, apiKey: key, timeoutMs: m.timeoutMs });
    fetchedModels[m.id] = list;
    if (dl) dl.innerHTML = list.map(id => `<option value="${escapeHtml(id)}"></option>`).join('');
    if (status) { status.textContent = `已获取 ${list.length} 个模型，可下拉选择或手动输入`; status.className = 'model-status ok'; }
  } catch (e) {
    delete fetchedModels[m.id];
    if (dl) dl.innerHTML = '';
    if (status) { status.textContent = '获取失败（可手动输入模型名）：' + e.message; status.className = 'model-status err'; }
  }
}
$('#addModel').onclick = () => { models.push(defaultModel()); persistModelsToStorage(models); renderModels(); };

// ============================================================
// 备用模型配置（自动降级）：布局与模型配置一致，但无 temperature/top_p 与 5 个复选框；
// 折叠态在删除/编辑图标左侧显示上/下箭头，用于调整优先级顺序。
// ============================================================
function renderBackupModels() {
  const wrap = $('#backupModelList');
  if (!wrap) return;
  wrap.innerHTML = backupModels.map((m, i) => {
    const vlabel = (v) => (v === 'openai' || v === 'anthropic') ? `${v}（兼容）` : v;
    const modelOpts = (fetchedModels[m.id] || [])
      .map(id => `<option value="${escapeHtml(id)}"></option>`)
      .join('');
    return `
    <div class="model-card${m.collapsed ? ' collapsed' : ''}" data-i="${i}">
      <div class="mc-head">
        <input data-f="name" class="mc-alias" value="${escapeHtml(m.name || '')}"
               placeholder="备用模型别名（选填）"${m.collapsed ? ' readonly' : ''} />
        ${m.collapsed ? `
        <button class="icon-btn" data-up="${i}" title="上移（提高优先级）">${ICON_UP}</button>
        <button class="icon-btn" data-down="${i}" title="下移（降低优先级）">${ICON_DOWN}</button>` : ''}
        <button class="icon-btn mc-save" data-save="${i}"
                title="${m.collapsed ? '展开编辑' : '保存并收起'}">
          ${m.collapsed ? ICON_EDIT : ICON_SAVE}
        </button>
        <button class="icon-btn del" data-del="${i}" title="删除">${ICON_TRASH}</button>
      </div>
      <div class="mc-grid">
        <label class="full">厂商
          <select data-f="vendor">
            ${['openai', 'anthropic', 'gemini', 'ollama'].map(v =>
              `<option value="${v}" ${m.vendor === v ? 'selected' : ''}>${vlabel(v)}</option>`).join('')}
          </select>
        </label>
        <label class="full">模型
          <input data-f="model" class="model-input" list="dl-${m.id}"
                 value="${escapeHtml(m.model || '')}"
                 placeholder="填 API Base / Key 后自动获取，或手动输入模型名" />
          <datalist id="dl-${m.id}">${modelOpts}</datalist>
          <span class="model-status"></span>
        </label>
        <label>超时 ms <input data-f="timeoutMs" type="number" value="${m.timeoutMs || 60000}" /></label>
        <label class="full">API Base <input data-f="apiBase" value="${escapeHtml(m.apiBase || '')}" /></label>
        <label class="full">API Key <input data-f="apiKey" type="password" value="${escapeHtml(m.apiKey || '')}" /></label>
      </div>
    </div>`;
  }).join('');

  // 字段变更：仅更新对应模型，无复选框联动
  wrap.querySelectorAll('[data-f]').forEach(inp => {
    inp.addEventListener('change', () => {
      const card = inp.closest('.model-card');
      const i = +card.dataset.i;
      const f = inp.dataset.f;
      const val = inp.value;
      backupModels[i][f] = (f === 'timeoutMs') ? Number(val) : val;
      if (f === 'name') backupModels[i].nameEdited = !!String(val).trim();
      if (f === 'model') syncAlias(card, backupModels, i, val);
      if (f === 'vendor') {
        backupModels[i].model = '';
        const mi = card.querySelector('input[data-f="model"]');
        if (mi) mi.value = '';
        syncAlias(card, backupModels, i, '');
      }
      LS.set('preview.backupModels', backupModels);
      if (f === 'apiBase' || f === 'apiKey' || f === 'vendor') refreshModelList(backupModels, i, wrap);
    });
  });
  // 模型组合框：聚焦清空、失焦还原、同步别名（与模型配置一致）
  wrap.querySelectorAll('input[data-f="model"]').forEach(inp => {
    const showAll = () => { if (inp.value) { inp.dataset.prev = inp.value; inp.value = ''; } };
    inp.addEventListener('focus', showAll);
    inp.addEventListener('mousedown', () => { if (document.activeElement === inp) showAll(); });
    inp.addEventListener('blur', () => {
      if (!inp.value && inp.dataset.prev) inp.value = inp.dataset.prev;
      delete inp.dataset.prev;
      const card = inp.closest('.model-card');
      const i = +card.dataset.i;
      backupModels[i].model = inp.value;
      syncAlias(card, backupModels, i, inp.value);
      LS.set('preview.backupModels', backupModels);
    });
  });
  // 删除
  wrap.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    delete fetchedModels[backupModels[+b.dataset.del]?.id];
    backupModels.splice(+b.dataset.del, 1);
    LS.set('preview.backupModels', backupModels); renderBackupModels();
  });
  // 保存/编辑：保存 → 写入并折叠；编辑 → 展开
  wrap.querySelectorAll('[data-save]').forEach(b => b.onclick = () => {
    const i = +b.dataset.save;
    const card = b.closest('.model-card');
    if (!backupModels[i].collapsed) {
      const alias = card.querySelector('input[data-f="name"]');
      if (alias) { backupModels[i].name = alias.value; backupModels[i].nameEdited = !!alias.value.trim(); }
      backupModels[i].collapsed = true;
    } else {
      backupModels[i].collapsed = false;
    }
    LS.set('preview.backupModels', backupModels);
    renderBackupModels();
  });
  // 优先级上移 / 下移（仅折叠态显示）
  wrap.querySelectorAll('[data-up]').forEach(b => b.onclick = () => {
    const i = +b.dataset.up;
    if (i <= 0) return;
    [backupModels[i - 1], backupModels[i]] = [backupModels[i], backupModels[i - 1]];
    LS.set('preview.backupModels', backupModels); renderBackupModels();
  });
  wrap.querySelectorAll('[data-down]').forEach(b => b.onclick = () => {
    const i = +b.dataset.down;
    if (i >= backupModels.length - 1) return;
    [backupModels[i + 1], backupModels[i]] = [backupModels[i], backupModels[i + 1]];
    LS.set('preview.backupModels', backupModels); renderBackupModels();
  });
  // 自动拉取候选模型列表
  backupModels.forEach((m, i) => {
    if ((m.apiBase || '').trim() && (m.apiKey || '').trim()) refreshModelList(backupModels, i, wrap);
  });
}
$('#addBackupModel').onclick = () => { backupModels.push(defaultBackupModel()); LS.set('preview.backupModels', backupModels); renderBackupModels(); };

// ============================================================
// Whisper 模型配置（实时字幕的语音转写源，可配置多个做负载均衡/降级）
// 简化卡片：仅需 别名 / API Base / API Key / 模型名 / 超时。
// ============================================================
function defaultWhisperModel() {
  return {
    id: 'w' + Date.now().toString(36),
    name: 'Whisper',
    apiBase: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'whisper-1',
    timeoutMs: 60000,
  };
}

/**
 * 构建 Whisper 模型下拉选项：已获取的 Whisper 模型 + 当前自定义值 + “手动输入”项。
 * 用原生 <select>，任何选择操作后均保持可交互，避免 datalist 选中后状态锁定的问题。
 * @param {object} m 单个 Whisper 模型配置
 */
function whisperModelOptions(m) {
  const list = fetchedModels[m.id] || [];
  const sel = m.model || '';
  const inList = list.includes(sel);
  let opts = '';
  if (sel && !inList) {
    // 已保存但不在候选列表中的自定义模型：保留为可选项，避免被清空
    opts += `<option value="${escapeHtml(sel)}" selected>${escapeHtml(sel)}（当前自定义）</option>`;
  }
  opts += list.map(id => `<option value="${escapeHtml(id)}" ${id === sel ? 'selected' : ''}>${escapeHtml(id)}</option>`).join('');
  opts += `<option value="__manual__">（手动输入自定义模型）</option>`;
  return opts;
}

function renderWhisperModels() {
  const wrap = $('#whisperModelList');
  if (!wrap) return;
  if (!whisperModels.length) {
    wrap.innerHTML = '<div class="empty" style="color:#6b7280;font-size:12px;padding:6px 0;">尚未添加 Whisper 模型。点击右上角“+ 添加 Whisper 模型”。</div>';
  } else {
    wrap.innerHTML = whisperModels.map((m, i) => {
      return `
      <div class="model-card${m.collapsed ? ' collapsed' : ''}" data-i="${i}">
        <div class="mc-head">
          <input data-f="name" class="mc-alias" value="${escapeHtml(m.name || '')}"
                 placeholder="模型别名（选填）"${m.collapsed ? ' readonly' : ''} />
          <button class="icon-btn mc-save" data-save="${i}"
                  title="${m.collapsed ? '展开编辑' : '保存并收起'}">
            ${m.collapsed ? ICON_EDIT : ICON_SAVE}
          </button>
          <button class="icon-btn del" data-del="${i}" title="删除">${ICON_TRASH}</button>
        </div>
        <div class="mc-grid">
          <label class="full">API Base
            <input data-f="apiBase" value="${escapeHtml(m.apiBase || '')}" placeholder="https://api.openai.com/v1" />
          </label>
          <label class="full">API Key
            <input data-f="apiKey" type="password" value="${escapeHtml(m.apiKey || '')}" placeholder="sk-…（Whisper 接口密钥）" />
          </label>
          <label class="full">模型
            <select data-f="model" class="model-select">${whisperModelOptions(m)}</select>
            <input data-f="model-manual" class="model-manual" type="text"
                   value="${escapeHtml(m.model || '')}"
                   placeholder="手动输入模型名（如 whisper-large-v3）"
                   style="display:${(fetchedModels[m.id] || []).includes(m.model) || !m.model ? 'none' : ''}" />
            <span class="model-status"></span>
          </label>
          <label>超时 ms <input data-f="timeoutMs" type="number" value="${m.timeoutMs || 60000}" /></label>
        </div>
      </div>`;
    }).join('');

    wrap.querySelectorAll('[data-f]').forEach(inp => {
      inp.addEventListener('change', () => {
        const card = inp.closest('.model-card');
        const i = +card.dataset.i;
        const f = inp.dataset.f;
        const val = inp.value;
        if (f === 'model') {
          // 原生 <select>：选中“（手动输入自定义模型）”则切换为手动输入框；否则直接采用选中值
          if (val === '__manual__') {
            const mi = card.querySelector('input[data-f="model-manual"]');
            whisperModels[i].model = mi ? (mi.value || '') : '';
            if (mi) { mi.value = whisperModels[i].model || ''; mi.style.display = ''; mi.focus(); }
          } else {
            whisperModels[i].model = val;
            const mi = card.querySelector('input[data-f="model-manual"]');
            if (mi) mi.style.display = 'none';
            syncAlias(card, whisperModels, i, val); // 选中模型后自动同步到“模型别名”
          }
        } else if (f === 'model-manual') {
          // 手动输入：实时写入并回写别名
          whisperModels[i].model = val;
          syncAlias(card, whisperModels, i, val);
        } else {
          whisperModels[i][f] = (f === 'timeoutMs') ? Number(val) : val;
          if (f === 'name') whisperModels[i].nameEdited = !!String(val).trim();
        }
        persistWhisperToStorage(whisperModels);
        if (ccWhisperRefresh) ccWhisperRefresh();
        if (f === 'apiBase' || f === 'apiKey') refreshWhisperModelList(whisperModels, i, wrap);
      });
    });
    wrap.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      delete fetchedModels[whisperModels[+b.dataset.del]?.id];
      whisperModels.splice(+b.dataset.del, 1);
      persistWhisperToStorage(whisperModels);
      renderWhisperModels();
      if (ccWhisperRefresh) ccWhisperRefresh();
    });
    wrap.querySelectorAll('[data-save]').forEach(b => b.onclick = () => {
      const i = +b.dataset.save;
      const card = b.closest('.model-card');
      if (!whisperModels[i].collapsed) {
        const alias = card.querySelector('input[data-f="name"]');
        if (alias) { whisperModels[i].name = alias.value; whisperModels[i].nameEdited = !!alias.value.trim(); }
        whisperModels[i].collapsed = true;
      } else {
        whisperModels[i].collapsed = false;
      }
      persistWhisperToStorage(whisperModels);
      renderWhisperModels();
      if (ccWhisperRefresh) ccWhisperRefresh();
    });

    // 已填好 API Base / Key 的卡片，加载时即自动拉取 Whisper 模型列表
    whisperModels.forEach((m, i) => {
      if ((m.apiBase || '').trim() && (m.apiKey || '').trim()) refreshWhisperModelList(whisperModels, i, wrap);
    });
  }
  if (ccWhisperRefresh) ccWhisperRefresh();   // 实时字幕卡复选列表随配置同步
}

/**
 * 自动获取并填充某 Whisper 卡片的模型候选列表（仅保留 whisper 相关模型，供下拉选择）。
 * 走 OpenAI 兼容接口 GET {base}/models；未筛出 whisper 模型时回退展示全部，避免无选项可选。
 * 用户从下拉选定模型后，由 [data-f] 的 change 处理调用 syncAlias 把模型名同步进“模型别名”。
 * @param {Array} arr whisperModels
 * @param {number} i 模型在 arr 中的下标
 * @param {HTMLElement} wrap 卡片容器
 */
// Whisper 模型列表缓存（避免每次渲染都重复请求 API）
const whisperModelCache = new Map(); // m.id -> { list, timestamp }
const WHISPER_CACHE_TTL = 30000;    // 30 秒缓存有效期

async function refreshWhisperModelList(arr, i, wrap) {
  const m = arr[i];
  if (!m) return;
  const card = wrap.querySelector(`.model-card[data-i="${i}"]`);
  if (!card) return;
  const sel = card.querySelector('select[data-f="model"]');
  const manual = card.querySelector('input[data-f="model-manual"]');
  const status = card.querySelector('.model-status');
  const base = (m.apiBase || '').trim();
  const key = (m.apiKey || '').trim();

  if (!base || !key) {
    delete fetchedModels[m.id];
    if (sel) sel.innerHTML = whisperModelOptions(m);
    if (manual) manual.style.display = 'none';
    if (status) { status.textContent = '填写 API Base / Key 后自动获取 Whisper 模型'; status.className = 'model-status'; }
    return;
  }

  // 缓存命中：直接复用已获取的模型列表
  const cached = whisperModelCache.get(m.id);
  if (cached && Date.now() - cached.timestamp < WHISPER_CACHE_TTL) {
    if (sel) sel.innerHTML = whisperModelOptions(m);
    if (manual) manual.style.display = cached.list.includes(m.model) ? 'none' : '';
    if (status) { status.textContent = `缓存：${cached.list.filter(id => /whisper/i.test(id)).length} 个 Whisper 模型`; status.className = 'model-status ok'; }
    return;
  }

  if (status) { status.textContent = '正在获取 Whisper 模型列表…'; status.className = 'model-status loading'; }
  try {
    const all = await listModels({ apiBase: base, apiKey: key, timeoutMs: m.timeoutMs });
    const list = all.filter(id => /whisper/i.test(id));
    const finalList = list.length ? list : all;
    fetchedModels[m.id] = finalList;
    whisperModelCache.set(m.id, { list: finalList, timestamp: Date.now() });
    if (sel) sel.innerHTML = whisperModelOptions(m);
    if (manual) manual.style.display = finalList.includes(m.model) ? 'none' : '';
    if (status) {
      if (list.length) status.textContent = `已获取 ${list.length} 个 Whisper 模型，可下拉选择`;
      else status.textContent = `未筛出 Whisper 模型，已展示全部 ${all.length} 个，请手动确认`;
      status.className = 'model-status ok';
    }
  } catch (e) {
    delete fetchedModels[m.id];
    whisperModelCache.delete(m.id);
    if (sel) sel.innerHTML = whisperModelOptions(m);
    if (manual) manual.style.display = 'none';
    if (status) { status.textContent = '获取失败（可手动输入模型名）：' + e.message; status.className = 'model-status err'; }
  }
}
$('#addWhisperModel').onclick = () => { whisperModels.push(defaultWhisperModel()); persistWhisperToStorage(whisperModels); renderWhisperModels(); if (ccWhisperRefresh) ccWhisperRefresh(); };

$('#kbBase').value = kbCfg.baseUrl || '';
$('#kbBase').addEventListener('change', () => { kbCfg.baseUrl = $('#kbBase').value; persistKbToStorage(kbCfg); });

// ============================================================
// 模型配置复选框联动（视觉全局互斥 / 主模型单选受启用约束）
// ============================================================
/** 根据 models 当前状态，重算所有卡片复选框的禁用与选中态（不改动配置，仅同步 UI 与互斥） */
function refreshCheckboxUI() {
  const wrap = document.getElementById('modelList');
  if (!wrap) return;
  const visionOn = models.some(m => m.supportsVision);
  // 主模型为“已启用”模型中的单选；找出当前有效主模型下标
  const primaryIdx = models.findIndex(m => m.isPrimary && m.enabled !== false);

  models.forEach((m, i) => {
    const card = wrap.querySelector(`.model-card[data-i="${i}"]`);
    if (!card) return;
    const enabledCb = card.querySelector('input[data-f="enabled"]');
    const visionCb = card.querySelector('input[data-f="supportsVision"]');
    const streamCb = card.querySelector('input[data-f="supportsStream"]');
    const primaryCb = card.querySelector('input[data-f="isPrimary"]');
    const thinkCb = card.querySelector('input[data-f="supportsThinking"]');
    const isVision = !!m.supportsVision;

    // 视觉全局互斥：其他卡视觉禁用；本卡为视觉模型时，其余框全部禁用
    visionCb.disabled = visionOn && !isVision;
    enabledCb.disabled = isVision;
    streamCb.disabled = isVision;
    thinkCb.disabled = isVision;

    // 主模型：仅“已启用且非视觉”的模型可选；且全局单选（已有主模型时其余禁用并取消勾选）
    const primaryDisabled = isVision || m.enabled === false || (primaryIdx >= 0 && i !== primaryIdx);
    primaryCb.disabled = primaryDisabled;
    if (primaryIdx >= 0 && i !== primaryIdx) {
      primaryCb.checked = false;
      models[i].isPrimary = false; // 同步取消其它模型的主模型标记
    }
  });
}

/** 思考强度下拉的“参考模型”：协作模式取主模型，单模型模式取当前所选模型 */
function currentRefModel() {
  if (chatModelId === '__collab__') {
    return models.find(m => m.isPrimary && m.enabled !== false) || null;
  }
  return models.find(m => m.id === chatModelId) || null;
}

/** 渲染聊天界面“思考强度”下拉：仅当参考模型开启“思考”时显示，选项按厂商动态生成 */
function renderThinkingSelect() {
  const sel = document.getElementById('thinkingSelect');
  if (!sel) return;
  const ref = currentRefModel();
  if (!ref || !ref.supportsThinking) { sel.hidden = true; sel.innerHTML = ''; return; }
  const levels = thinkingLevels(ref.vendor);
  const cur = thinkingStrength || ref.thinkingStrength || 'off';
  sel.hidden = false;
  sel.innerHTML = levels.map(l => `<option value="${l.value}" ${l.value === cur ? 'selected' : ''}>${l.label}</option>`).join('');
  sel.value = cur;
}


function prepareModels() {
  return models.filter(m => m.enabled !== false).map(m => ({
    ...m,
    name: m.name || m.model || m.vendor,
  }));
}

// 渲染聊天框中的模型选择下拉（动态绑定当前所有已配置模型，实时同步）
function renderModelSelect() {
  const sel = $('#modelSelect');
  if (!sel) return;
  // 归一化，防止 LS 中存储异常导致下拉缺失
  if (!Array.isArray(models)) models = [defaultModel()];
  // 选中项失效、或当前选中的是“仅后台视觉模型”时，回退到首个非视觉聊天模型，
  // 保证视觉模型只作后台辅助、不会被当作聊天主模型。
  if (chatModelId !== '__collab__') {
    const cur = models.find(m => m.id === chatModelId);
    const nonVision = models.find(m => !m.supportsVision);
    if (!cur || cur.supportsVision) chatModelId = (nonVision || models[0])?.id || null;
  }
  // 未配置主模型时，不应停留在“多模型协作”
  if (chatModelId === '__collab__' && !models.some(m => m.isPrimary && m.enabled !== false)) {
    chatModelId = models[0]?.id || null;
  }

  if (models.length === 0) {
    sel.innerHTML = '<option value="">（暂无已配置模型，请到设置添加）</option>';
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  const collab = models.some(m => m.isPrimary && m.enabled !== false)
    ? '<option value="__collab__" ' + (chatModelId === '__collab__' ? 'selected' : '') + '>多模型协作</option>'
    : '';
  // 视觉模型仅作为后台辅助识别模型，不出现在聊天框的下拉选择列表中
  const modelOpts = models
    .filter(m => !m.supportsVision)
    .map(m => {
      const label = m.name || m.model || m.vendor || '未命名模型';
      const disabled = m.enabled === false ? ' （已停用）' : '';
      return `<option value="${escapeHtml(m.id)}" ${m.id === chatModelId ? 'selected' : ''}>${escapeHtml(label + disabled)}</option>`;
    }).join('');
  sel.innerHTML = collab + modelOpts;
  sel.value = chatModelId || '';
  sel.onchange = () => {
    chatModelId = sel.value;
    // 切换模型时，思考强度重置为该模型的配置值
    const ref = currentRefModel();
    thinkingStrength = ref?.thinkingStrength || 'off';
    renderThinkingSelect();
  };
  renderThinkingSelect();
}
function makeKb() {
  return kbCfg.baseUrl ? new LocalKbConnector({ baseUrl: kbCfg.baseUrl }) : null;
}

// ============================================================
// 网页翻译（侧边栏控制）
// ============================================================
const PAGE_TRANSLATE_LANGS = [
  '中文（简体）', '中文（繁体）', 'English', '日本語', '한국어',
  'Français', 'Deutsch', 'Español', 'Русский', 'العربية', 'ภาษาไทย', 'Tiếng Việt',
];

/** 获取当前窗口的活动标签页 ID（用于与 content script 通信） */
async function getActiveTabId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return (tab && tab.id) ? tab.id : null;
  } catch (_) { return null; }
}

/** 保存网页翻译偏好 */
function savePtPrefs(prefs) {
  chrome.storage.local.set({ translatePrefs: prefs }).catch(() => {});
}

/** 初始化网页翻译卡片 */
function initPageTranslate() {
  const modelSel = $('#pt-model');
  const langSel = $('#pt-lang');
  const statusEl = $('#pt-status');
  if (!modelSel) return;  // 卡片尚未挂载

  // 语言下拉
  langSel.innerHTML = PAGE_TRANSLATE_LANGS.map(l => `<option value="${l}">${l}</option>`).join('');

  // 模型下拉（禁用/启用过滤同 settings 逻辑，且隐藏辅助视觉模型——与主聊天框保持一致）
  function popModelSelect() {
    const enabled = (models || []).filter(m => m.enabled !== false && !m.supportsVision);
    if (!enabled.length) {
      modelSel.innerHTML = '<option value="">（请先在设置添加模型）</option>';
      return;
    }
    const primary = enabled.find(m => m.isPrimary) || enabled[0];
    modelSel.innerHTML = enabled.map(m =>
      `<option value="${m.id}">${escapeHtml(m.name || m.model || m.vendor)}</option>`
    ).join('');
    // 保持上次选中的模型；若已失效或不占位，回退到首个可用模型
    chrome.storage.local.get('translatePrefs').then(r => {
      const p = r.translatePrefs || {};
      if (p.modelId && enabled.some(m => m.id === p.modelId)) modelSel.value = p.modelId;
      else modelSel.value = primary.id;
    });
  }
  popModelSelect();

  // 加载历史偏好
  chrome.storage.local.get('translatePrefs').then(r => {
    const p = r.translatePrefs || {};
    if (p.targetLang) langSel.value = p.targetLang;
    if (p.mode) {
      $('#pt-mode-auto').classList.toggle('active', p.mode === 'auto');
      $('#pt-mode-manual').classList.toggle('active', p.mode === 'manual');
    }
    // 刷新状态
    updatePtStatus();
  });

  // 模型下拉随模型变化刷新
  const origRender = renderModels;
  renderModels = function () {
    origRender();
    popModelSelect();
  };

  // 模式切换
  $('#pt-mode-auto').onclick = () => {
    const p = { mode: 'auto', targetLang: langSel.value, modelId: modelSel.value, active: false, activeHost: null };
    savePtPrefs(p);
    $('#pt-mode-auto').classList.add('active');
    $('#pt-mode-manual').classList.remove('active');
    updatePtStatus();
  };
  $('#pt-mode-manual').onclick = () => {
    const p = { mode: 'manual', targetLang: langSel.value, modelId: modelSel.value, active: false, activeHost: null };
    savePtPrefs(p);
    $('#pt-mode-manual').classList.add('active');
    $('#pt-mode-auto').classList.remove('active');
    updatePtStatus();
  };

  // 语言/模型变更时持久化
  langSel.onchange = () => {
    chrome.storage.local.get('translatePrefs').then(r => {
      const p = r.translatePrefs || {};
      p.targetLang = langSel.value; p.modelId = modelSel.value;
      savePtPrefs(p);
    });
  };
  modelSel.onchange = () => {
    chrome.storage.local.get('translatePrefs').then(r => {
      const p = r.translatePrefs || {};
      p.modelId = modelSel.value;
      savePtPrefs(p);
    });
  };

  // 翻译本页
  $('#pt-translate').onclick = async () => {
    const modelId = modelSel.value;
    if (!modelId || !(models || []).some(m => m.id === modelId && m.enabled !== false)) {
      statusEl.textContent = '请先在设置中添加并启用模型';
      return;
    }
    statusEl.textContent = '正在连接页面 Worker…';
    const tabId = await getActiveTabId();
    if (!tabId) { statusEl.textContent = '未找到活动标签页'; return; }
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'WEB_TRANSLATE_STATUS' });
    } catch (_) {
      statusEl.textContent = '网页翻译 Worker 未就绪，请刷新目标网页后重试';
      return;
    }
    const targetLang = langSel.value;
    statusEl.textContent = '正在翻译…';
    try {
      const resp = await chrome.tabs.sendMessage(tabId, {
        type: 'WEB_TRANSLATE_EXECUTE',
        modelId,
        targetLang,
      });
      if (resp && resp.ok) {
        const detail = resp.translated != null ? `（翻译 ${resp.translated} 段）` : resp.cached != null ? `（全部命中缓存）` : '';
        statusEl.textContent = `已翻译本页（${targetLang}）${detail}`;
        // 保存偏好，包括当前激活状态供自动模式使用
        savePtPrefs({ modelId, targetLang, mode: $('#pt-mode-auto').classList.contains('active') ? 'auto' : 'manual', active: true, activeHost: location.hostname });
      } else {
        statusEl.textContent = '翻译失败：' + ((resp && resp.error) || '未知错误');
      }
    } catch (e) {
      statusEl.textContent = '通信失败：' + (e && e.message ? e.message : e);
    }
  };

  // 还原
  $('#pt-restore').onclick = async () => {
    const tabId = await getActiveTabId();
    if (!tabId) { statusEl.textContent = '未找到活动标签页'; return; }
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'WEB_TRANSLATE_RESTORE' });
      statusEl.textContent = '已还原原文' + (r && r.restored ? `（${r.restored} 组）` : '');
    } catch (e) {
      statusEl.textContent = '通信失败：' + (e && e.message ? e.message : e);
    }
  };

  // 查询当前页面翻译状态
  async function updatePtStatus() {
    const tabId = await getActiveTabId();
    if (!tabId) { statusEl.textContent = ''; return; }
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: 'WEB_TRANSLATE_STATUS' });
      if (resp && resp.active) statusEl.textContent = `已翻译（${resp.count} 组文本）`;
      else statusEl.textContent = '';
    } catch (_) { statusEl.textContent = ''; }
  }

  // 当切换到「功能」视图时刷新状态
  const origShow = showView;
  showView = function (name) {
    origShow(name);
    if (name === 'features') updatePtStatus();
  };
}

// ============================================================
// 实时字幕（功能页卡片）
// 说明：优先读取平台内嵌字幕，无字幕视频可回退 Whisper 语音识别；
// 非直播视频可对“已缓存但未观看”的片段做预翻译，掩盖自定义模型的延迟。
// 本次仅接入 UI 与偏好持久化，字幕采集/翻译引擎由 content 脚本后续实现。
// ============================================================
const CC_SOURCE_LANGS = [
  '自动识别', '英语', '日语', '韩语', '法语', '德语', '西班牙语',
  '俄语', '葡萄牙语', '意大利语', '泰语', '越南语',
];

function initLiveCaption() {
  const modelSel = $('#cc-model');
  const langSel = $('#cc-lang');
  const srcSel = $('#cc-source');
  const srcModeSel = $('#cc-source-mode');
  const whisperListEl = $('#cc-whisper-list');
  const whisperHintEl = $('#cc-whisper-hint');
  const prefetchCb = $('#cc-prefetch');
  const bilingualCb = $('#cc-bilingual');
  const statusEl = $('#cc-status');
  if (!modelSel) return;  // 卡片尚未挂载

  // 目标语言（复用网页翻译的语言集）/ 源语言
  langSel.innerHTML = PAGE_TRANSLATE_LANGS.map(l => `<option value="${l}">${l}</option>`).join('');
  srcSel.innerHTML = CC_SOURCE_LANGS.map(l => `<option value="${l}">${l}</option>`).join('');

  // 模型下拉：与网页翻译一致，仅列出已启用且非视觉模型
  function popModelSelect() {
    const enabled = (models || []).filter(m => m.enabled !== false && !m.supportsVision);
    if (!enabled.length) {
      modelSel.innerHTML = '<option value="">（请先在设置添加模型）</option>';
      return;
    }
    const primary = enabled.find(m => m.isPrimary) || enabled[0];
    modelSel.innerHTML = enabled.map(m =>
      `<option value="${m.id}">${escapeHtml(m.name || m.model || m.vendor)}</option>`
    ).join('');
    const p = LS.get('preview.captionPrefs', {});
    if (p.modelId && enabled.some(m => m.id === p.modelId)) modelSel.value = p.modelId;
    else modelSel.value = primary.id;
  }
  popModelSelect();

  // ---- Whisper 模型多选列表（从已配置的 Whisper 模型里勾选）----
  // 选中状态存入 captionPrefs.whisperModelIds；若未选则回退为“全部已配置模型”。
  function populateWhisperList() {
    if (!whisperListEl) return;
    const p = LS.get('preview.captionPrefs', {});
    const selected = Array.isArray(p.whisperModelIds) ? p.whisperModelIds : [];
    if (!whisperModels.length) {
      whisperListEl.innerHTML = '<span class="empty">尚未配置 Whisper 模型（去“设置 → Whisper 模型配置”添加）</span>';
      return;
    }
    whisperListEl.innerHTML = whisperModels.map(m => {
      const checked = selected.includes(m.id) ? 'checked' : '';
      const label = escapeHtml(m.name || m.model || 'Whisper');
      return `<label><input type="checkbox" data-wid="${escapeHtml(m.id)}" ${checked}/> ${label}</label>`;
    }).join('');
    whisperListEl.querySelectorAll('input[data-wid]').forEach(cb => {
      cb.addEventListener('change', savePrefs);
    });
  }
  ccWhisperRefresh = populateWhisperList;   // 供设置页增删 Whisper 模型时同步刷新
  populateWhisperList();

  // 载入历史偏好
  const p0 = LS.get('preview.captionPrefs', {});
  if (p0.targetLang) langSel.value = p0.targetLang;
  if (p0.sourceLang) srcSel.value = p0.sourceLang;
  if (p0.sourceMode) srcModeSel.value = p0.sourceMode;
  prefetchCb.checked = p0.prefetch !== false;
  bilingualCb.checked = p0.bilingual !== false;

  function savePrefs() {
    const selectedW = whisperListEl
      ? Array.from(whisperListEl.querySelectorAll('input[data-wid]:checked')).map(cb => cb.dataset.wid)
      : [];
    LS.set('preview.captionPrefs', {
      modelId: modelSel.value,
      targetLang: langSel.value,
      sourceLang: srcSel.value,
      sourceMode: srcModeSel.value,
      whisperModelIds: selectedW,
      prefetch: prefetchCb.checked,
      bilingual: bilingualCb.checked,
    });
    if (hasChromeStorage()) {
      try { chrome.storage.local.set({ captionPrefs: LS.get('preview.captionPrefs', {}) }); } catch (_) {}
    }
  }
  [modelSel, langSel, srcSel, srcModeSel, prefetchCb, bilingualCb]
    .forEach(el => el.addEventListener('change', savePrefs));

  // 模型列表随配置变化刷新（叠加到已被网页翻译包装过的 renderModels）
  const origRender = renderModels;
  renderModels = function () {
    origRender();
    popModelSelect();
  };

  // Whisper 多选列表仅在需要语音识别时才有意义：切换来源时给出提示
  function reflectSourceMode() {
    const mode = srcModeSel.value;
    const needWhisper = mode !== 'platform';
    if (whisperListEl) {
      whisperListEl.classList.toggle('disabled', !needWhisper);
      whisperListEl.style.display = needWhisper ? '' : 'none';
    }
    if (whisperHintEl) {
      whisperHintEl.textContent = needWhisper
        ? '勾选用作语音转写的 Whisper 模型；未勾选则使用“设置”中配置的全部 Whisper 模型（按顺序负载均衡）。'
        : '当前为“仅平台字幕”模式，无需 Whisper 语音识别。';
    }
  }
  srcModeSel.addEventListener('change', reflectSourceMode);
  reflectSourceMode();

  $('#cc-start').onclick = async () => {
    const modelId = modelSel.value;
    if (!modelId || !(models || []).some(m => m.id === modelId && m.enabled !== false)) {
      statusEl.textContent = '请先在设置中添加并启用模型';
      return;
    }
    savePrefs();
    // 收集已勾选的 Whisper 模型 id（空 = 使用全部已配置模型）
    const whisperModelIds = whisperListEl
      ? Array.from(whisperListEl.querySelectorAll('input[data-wid]:checked')).map(cb => cb.dataset.wid)
      : [];
    const sourceMode = srcModeSel.value;
    if (sourceMode !== 'platform' && !whisperModels.length) {
      statusEl.textContent = '未配置 Whisper 模型：请先在“设置 → Whisper 模型配置”添加，或改用“仅平台字幕”';
      return;
    }
    const tabId = await getActiveTabId();
    if (!tabId) { statusEl.textContent = '未找到活动标签页'; return; }
    // 拦截浏览器内部页面（chrome://、edge:// 等无法捕获音频），避免无意义请求与报错
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const t = tabs && tabs[0];
      const u = (t && (t.url || t.pendingUrl)) || '';
      if (/^(chrome|chrome-extension|chrome-search|edge|about|file|devtools|view-source):/i.test(u)) {
        statusEl.textContent = '当前页面为浏览器内部页面，无法捕获音频，请在普通视频网页（如 bilibili、YouTube）上重试';
        return;
      }
    } catch (_) { /* 查询失败则继续，交给后台进一步校验 */ }
    try {
      const resp = await chrome.tabs.sendMessage(tabId, {
        type: 'LIVE_CAPTION_START',
        modelId,
        targetLang: langSel.value,
        sourceLang: srcSel.value,
        sourceMode,
        whisperModelIds,
        prefetch: prefetchCb.checked,
        bilingual: bilingualCb.checked,
      });
      if (resp && resp.ok) {
        statusEl.textContent = `已开启实时字幕（${langSel.value}）`;
      } else {
        statusEl.textContent = '开启失败：' + ((resp && resp.error) || '字幕 Worker 未就绪，请刷新目标视频页后重试');
      }
    } catch (_) {
      statusEl.textContent = '字幕 Worker 未就绪，请刷新目标视频页后重试';
    }
  };

  $('#cc-stop').onclick = async () => {
    const tabId = await getActiveTabId();
    if (!tabId) { statusEl.textContent = '未找到活动标签页'; return; }
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'LIVE_CAPTION_STOP' });
      statusEl.textContent = '已关闭实时字幕';
    } catch (e) {
      statusEl.textContent = '通信失败：' + (e && e.message ? e.message : e);
    }
  };
}

// ---------- 主题切换 ----------
const THEME_KEY = 'preview.theme';
function applyTheme(theme) {
  if (theme !== 'light' && theme !== 'dark' && theme !== 'system') theme = 'dark';
  document.documentElement.setAttribute('data-theme', theme);
}
function initThemeSwitch() {
  applyTheme(LS.get(THEME_KEY, 'dark'));
  const btns = $$('#themeSwitch .theme-icon');
  const mark = () => {
    const cur = document.documentElement.getAttribute('data-theme');
    btns.forEach(b => b.classList.toggle('active', b.dataset.theme === cur));
  };
  mark();
  btns.forEach(b => b.addEventListener('click', () => {
    applyTheme(b.dataset.theme);
    LS.set(THEME_KEY, b.dataset.theme);
    mark();
  }));
}

// ---------- 初始化 ----------
$('#thinkingSelect').onchange = () => { thinkingStrength = $('#thinkingSelect').value; };
initThemeSwitch();
renderModels();
renderBackupModels();
renderWhisperModels();
renderModelSelect();
initPageTranslate();
initLiveCaption();
showView('chat');
updateSendState();
input.focus();

// 配置同步：从 chrome.storage（与选项页同源）加载模型/知识库；
// 并监听选项页变更，使其保存后侧边栏立即生效，无需刷新。
if (hasChromeStorage()) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.models && Array.isArray(changes.models.newValue)) {
      models = changes.models.newValue;
      LS.set('preview.models', models);
      renderModels();
      renderModelSelect();
    }
    if (changes.whisperModels && Array.isArray(changes.whisperModels.newValue)) {
      whisperModels = changes.whisperModels.newValue;
      LS.set('preview.whisperModels', whisperModels);
      renderWhisperModels();
    }
    if (changes.kb) { kbCfg = changes.kb.newValue || kbCfg; LS.set('preview.kb', kbCfg); }
    if (changes.conversations) {
      // 会话数据被其他来源修改（如跨实例同步）：以存储为权威源刷新内存与界面，
      // 确保主页面会话列表准确过滤已删除项，避免缓存/未刷新导致的残留显示。
      conversations = Array.isArray(changes.conversations.newValue) ? changes.conversations.newValue : [];
      LS.set('preview.conversations', conversations);
      if (currentConvId && !conversations.some(c => c.id === currentConvId)) {
        // 当前会话已被删除：同步清理主页面聊天区
        currentConvId = null;
        messages = [];
        chatScroll.innerHTML = '';
        showWelcome();
        updateSendState();
      }
      if ($('#view-conversations').classList.contains('is-active')) renderConversationList();
    }
  });
}
syncConfigFromStorage();

// 会话：初始化时已从 localStorage 载入；真实扩展中优先以 chrome.storage（与选项页同源）为准
if (hasChromeStorage()) {
  loadConversationsFromStorage().then(arr => { conversations = arr || []; });
}
