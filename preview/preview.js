// preview/preview.js
// 侧边栏应用入口：复用同一套核心模块（core / connectors / features）。
// 三个视图：chat（主） / features / settings，单页切换，无整页刷新。

import { chatStream } from '../features/chat.js';
import { summarizePage } from '../features/summarize.js';
import { processSelection } from '../features/selection.js';
import { LocalKbConnector } from '../connectors/local-kb.js';
import { listModels } from '../core/list-models.js';
import { thinkingLevels } from '../shared/utils.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ---------- 本地存储（模拟 chrome.storage.local）----------
const LS = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
};

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

let models = LS.get('preview.models', [defaultModel()]);
let backupModels = LS.get('preview.backupModels', []);
let kbCfg = LS.get('preview.kb', { baseUrl: '' });
let messages = [];          // 聊天历史 {role, content}
let attachments = [];       // 待发送附件 {name, type, content}
let chatModelId = models[0]?.id || null;  // 当前聊天所选模型（'__collab__' 表示多模型协作）
let thinkingStrength = 'off';             // 聊天界面“思考强度”下拉的当前选择
let streaming = false;
const fetchedModels = {};   // 各配置的已获取模型列表（按 model.id 缓存，不持久化）

// ============================================================
// 视图导航
// ============================================================
const VIEWS = ['chat', 'features', 'settings'];
const TITLES = { chat: 'AI 助手', features: '功能', settings: '设置' };

function showView(name) {
  VIEWS.forEach(v => $('#view-' + v).classList.toggle('is-active', v === name));
  $('#navFeatures').classList.toggle('active', name === 'features');
  $('#navSettings').classList.toggle('active', name === 'settings');
  $('#barTitle').textContent = TITLES[name];
  if (name === 'chat') { renderModelSelect(); updateSendState(); }
}

$('#navFeatures').onclick = () => showView($('#view-features').classList.contains('is-active') ? 'chat' : 'features');
$('#navSettings').onclick = () => showView($('#view-settings').classList.contains('is-active') ? 'chat' : 'settings');
$('#barTitle').parentElement.onclick = () => showView('chat'); // 点标题返回聊天

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

function pushUser(text) {
  const welcome = $('#welcome');
  if (welcome) welcome.remove();
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `<div class="avatar">你</div><div class="bubble"></div>`;
  el.querySelector('.bubble').textContent = text;
  chatScroll.appendChild(el);
  scrollBottom();
}

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
  const empty = !input.value.trim() && attachments.length === 0;
  sendBtn.disabled = empty || streaming;
}

// 渲染当前附件 chips
function renderAttachments() {
  const box = $('#attachments');
  box.innerHTML = attachments.map((a, idx) =>
    `<span class="attachment-chip">${escapeHtml(a.name)}<button type="button" class="x" data-idx="${idx}" title="移除">×</button></span>`
  ).join('');
  box.querySelectorAll('.x').forEach(b => b.onclick = () => {
    attachments.splice(+b.dataset.idx, 1);
    renderAttachments(); updateSendState();
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
  if ((!text && attachments.length === 0) || streaming) return;
  const content = buildContent(text, attachments);
  // 图片转为多模态附件（data URL），文本文件保留正文
  const imageAttachments = attachments
    .filter(a => a.type.startsWith('image/') && a.dataUrl)
    .map(a => ({ type: 'image', data: a.dataUrl }));
  const userMsg = { role: 'user', content, ...(imageAttachments.length ? { attachments: imageAttachments } : {}) };

  input.value = ''; autosize();
  attachments = []; renderAttachments();
  pushUser(content + (imageAttachments.length ? ` [图片×${imageAttachments.length}]` : ''));
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
  streaming = true; sendBtn.disabled = true; setStatus('思考中…');

  let acc = '';
  let usedModel = '';
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
      if (!started) { started = true; a.stopTyping(); setStatus('正在回复…'); }
      else a.stopTyping();
      acc += chunk.delta;
      usedModel = chunk.model;
      a.setText(acc);
      scrollBottom();
    }
    messages.push({ role: 'user', content });
    messages.push({ role: 'assistant', content: acc });
    const usedCfg = [...models, ...backupModels].find(m => m.name === usedModel)
      || (mode === 'collab'
        ? models.find(m => m.isPrimary && m.enabled !== false)
        : models.find(m => m.id === chatModelId));
    const name = (mode === 'collab' ? '多模型协作 · ' : '') + (usedCfg?.name || usedModel || '完成');
    setStatus(`使用模型：${name}`, 'ok');
  } catch (e) {
    a.stopTyping();
    a.setText(acc ? acc + '\n\n[中断] ' + e.message : '错误：' + e.message);
    setStatus('错误：' + e.message, 'err');
  } finally {
    streaming = false; updateSendState(); scrollBottom();
  }
}

$('#composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

// 加号：上传文件 / 图片
$('#plusBtn').onclick = () => $('#fileInput').click();
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
// 功能视图
// ============================================================
function setStatusEl(id, msg, kind = '') {
  const el = $(id);
  el.textContent = msg;
  el.className = 'status-bar' + (kind ? ' ' + kind : '');
}

$('#loadSample').onclick = () => {
  $('#sumTitle').value = '大型语言模型简介';
  $('#sumText').value = `大型语言模型（LLM）是基于海量文本训练的深度神经网络，能够理解和生成自然语言。

常见的代表包括 GPT、Claude、Gemini 等。它们通常采用 Transformer 架构，通过自回归方式逐 token 生成文本。

在应用层面，LLM 可用于摘要、翻译、问答、代码生成等任务，是当下 AI 助手的核心能力来源。`;
};

$('#runSummarize').onclick = async () => {
  const page = { title: $('#sumTitle').value || '示例网页', text: $('#sumText').value };
  if (!page.text.trim()) { setStatusEl('#sumStatus', '请先输入网页正文', 'err'); return; }
  setStatusEl('#sumStatus', '正在总结…');
  $('#sumResult').textContent = '';
  try {
    const res = await summarizePage({ models: prepareModels() }, page, {
      kb: makeKb(), stream: false,
      onFallback: (i, cfg, reason) => setStatusEl('#sumStatus', `已切换到备用模型 #${i + 1}：${cfg.name}（${reason}）`),
    });
    $('#sumResult').textContent = res.text;
    setStatusEl('#sumStatus', `完成 · 使用模型：${res.used.name}`, 'ok');
  } catch (e) {
    setStatusEl('#sumStatus', '错误：' + e.message, 'err');
  }
};

$$('button[data-act]').forEach(b => b.onclick = async () => {
  const text = $('#selText').value;
  if (!text.trim()) { setStatusEl('#selStatus', '请先输入选中文本', 'err'); return; }
  setStatusEl('#selStatus', '处理中…');
  $('#selResult').textContent = '';
  try {
    const res = await processSelection({ models: prepareModels() }, text, b.dataset.act, {
      stream: false,
      onFallback: (i, cfg, reason) => setStatusEl('#selStatus', `已切换到备用模型 #${i + 1}：${cfg.name}（${reason}）`),
    });
    $('#selResult').textContent = res.text;
    setStatusEl('#selStatus', `完成 · 使用模型：${res.used.name}`, 'ok');
  } catch (e) {
    setStatusEl('#selStatus', '错误：' + e.message, 'err');
  }
});

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
      LS.set('preview.models', models);
      refreshCheckboxUI();              // 重算各复选框的禁用/选中态
      if (f === 'apiBase' || f === 'apiKey' || f === 'vendor') refreshModelList(models, i, wrap);
      if (f === 'name' || f === 'model' || f === 'vendor' || f === 'enabled' || f === 'isPrimary') renderModelSelect();
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
      LS.set('preview.models', models);
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
      LS.set('preview.models', models);
    });
  });

  wrap.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    delete fetchedModels[models[+b.dataset.del]?.id];
    models.splice(+b.dataset.del, 1);
    LS.set('preview.models', models); renderModels();
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
    LS.set('preview.models', models);
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
$('#addModel').onclick = () => { models.push(defaultModel()); LS.set('preview.models', models); renderModels(); };

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

$('#kbBase').value = kbCfg.baseUrl || '';
$('#kbBase').addEventListener('change', () => { kbCfg.baseUrl = $('#kbBase').value; LS.set('preview.kb', kbCfg); });

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
  // 选中项失效时回退到首个模型，保证始终有有效选择
  if (chatModelId !== '__collab__' && !models.some(m => m.id === chatModelId)) {
    chatModelId = models[0]?.id || null;
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
  const modelOpts = models.map(m => {
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
renderModelSelect();
showView('chat');
updateSendState();
input.focus();
