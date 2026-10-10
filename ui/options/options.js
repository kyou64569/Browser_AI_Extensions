// ui/options/options.js
// 设置页：模型列表 + 本地知识库地址。全部存 chrome.storage.local。
// 复选框与侧边栏设置页保持一致：启用 / 视觉 / 流式 / 主模型 / 思考，
// 并实现同样的联动（视觉全局互斥、主模型单选受启用约束）。

import { getModels, saveModels, getKbState, saveKbState } from '../../shared/storage.js';
import { createModelConfig } from '../../core/model-config.js';
import { KB_PROVIDERS } from '../../connectors/kb-registry.js';
import { aggregateUsage } from '../../shared/usage.js';
import { THINKING_STYLES, maxTokensHint } from '../../shared/thinking.js';
import { thinkingLevels } from '../../shared/utils.js';

const kFmt = (n) => n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n);

/** 渲染用量统计（近 7 天）：总计 + 按模型列表 + 按天迷你条形图 */
async function renderUsage() {
  const box = document.getElementById('usageSummary');
  if (!box) return;
  let log = [];
  try {
    const r = await chrome.storage.local.get('usageLog');
    log = Array.isArray(r.usageLog) ? r.usageLog : [];
  } catch (_) { box.textContent = '无法读取用量数据'; return; }
  const agg = aggregateUsage(log, { days: 7 });
  if (!agg.total.calls) { box.textContent = '暂无调用记录（使用聊天 / 翻译后自动累计）'; return; }

  const t = agg.total;
  const maxTok = Math.max(1, ...agg.byDay.map(d => d.inTok + d.outTok));
  const bars = agg.byDay.map(d => {
    const h = Math.round(((d.inTok + d.outTok) / maxTok) * 100);
    return `<div class="usage-bar-col" title="${d.day}：${d.calls} 次，${kFmt(d.inTok + d.outTok)} tokens">`
      + `<div class="usage-bar" style="height:${Math.max(h, 2)}%"></div></div>`;
  }).join('');

  const rows = agg.byModel.map(m =>
    `<tr><td>${escapeHtml(m.model)}</td><td>${m.calls}</td>`
    + `<td>${kFmt(m.inTok)}</td><td>${kFmt(m.outTok)}</td></tr>`).join('');

  box.innerHTML =
    `<div class="usage-total">调用 <b>${t.calls}</b> 次（失败 ${t.calls - t.ok}）· 输入 ≈<b>${kFmt(t.inTok)}</b> · 输出 ≈<b>${kFmt(t.outTok)}</b> tokens</div>`
    + `<div class="usage-bars">${bars}</div>`
    + `<table class="usage-table"><thead><tr><th>模型</th><th>调用</th><th>输入 tok</th><th>输出 tok</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const listEl = document.getElementById('modelList');

// 内存中的模型列表，便于复选框联动即时生效（点“保存”时写回 storage）
let models = [];

// 知识库多 provider 状态的草稿（随表单输入实时更新，点“保存”时写回 storage）
let kbStateDraft = null;

/** 渲染知识库 provider 切换标签 + 当前 provider 的凭证表单 */
async function renderKbProviders() {
  kbStateDraft = await getKbState();
  const tabs = document.getElementById('kbProviderTabs');
  tabs.innerHTML = '';
  KB_PROVIDERS.forEach((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'kb-provider-tab' + (p.id === kbStateDraft.active ? ' active' : '') + (p.placeholder ? ' placeholder' : '');
    b.textContent = p.label;
    b.disabled = !!p.placeholder;
    b.onclick = () => { kbStateDraft.active = p.id; renderKbProviders(); };
    tabs.appendChild(b);
  });
  const wrap = document.getElementById('kbProviderForms');
  const id = kbStateDraft.active;
  const def = KB_PROVIDERS.find((p) => p.id === id);
  if (!def) { wrap.innerHTML = ''; return; }
  if (def.placeholder) { wrap.innerHTML = '<p class="card-note">该知识库来源即将推出，敬请期待。</p>'; return; }
  const cfg = (kbStateDraft.providers[id] && kbStateDraft.providers[id].cfg) || {};
  wrap.innerHTML = def.fields.map((f, i) => `<label>${f.label} <input id="kbF_${i}" type="${f.type}" placeholder="${f.placeholder || ''}" /></label>`).join('');
  def.fields.forEach((f, i) => {
    const el = document.getElementById('kbF_' + i);
    el.value = cfg[f.key] || '';
    el.oninput = () => {
      kbStateDraft.providers[id] = kbStateDraft.providers[id] || { type: def.id, cfg: {} };
      kbStateDraft.providers[id].type = def.id;
      kbStateDraft.providers[id].cfg = kbStateDraft.providers[id].cfg || {};
      kbStateDraft.providers[id].cfg[f.key] = el.value.trim();
    };
  });
}

/** 思考参数（风格）下拉：仅 OpenAI 兼容厂商（openai）且已开启思考时展示 */
function showThinkStyle(cfg) {
  return cfg.supportsThinking && cfg.vendor === 'openai';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cardHtml(cfg, idx) {
  const mtHint = maxTokensHint(cfg);
  return `
  <div class="model-card" data-idx="${idx}">
    <label>名称 <input data-f="name" value="${escapeHtml(cfg.name)}"></label>
    <label>厂商
      <select data-f="vendor">
        ${['openai', 'anthropic', 'gemini', 'ollama'].map(v =>
          `<option value="${v}" ${cfg.vendor === v ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
    </label>
    <label>API Base <input data-f="apiBase" value="${escapeHtml(cfg.apiBase)}"></label>
    <label>API Key <input data-f="apiKey" type="password" value="${escapeHtml(cfg.apiKey)}"></label>
    <label>Model <input data-f="model" value="${escapeHtml(cfg.model)}"></label>
    <label>超时(ms) <input data-f="timeoutMs" type="number" value="${cfg.timeoutMs || 60000}"></label>
    <label>TPM上限 <input data-f="tpm" type="number" min="0" step="1000" placeholder="留空=自适应" value="${cfg.tpm != null ? cfg.tpm : ''}"></label>
    <label>RPM上限 <input data-f="rpm" type="number" min="0" step="1" placeholder="留空=自适应" value="${cfg.rpm != null ? cfg.rpm : ''}"></label>
    <label>Temperature <input data-f="temperature" type="number" min="0" max="2" step="0.1" placeholder="留空=厂商默认" value="${cfg.temperature != null ? cfg.temperature : ''}"></label>
    <label>Top P <input data-f="top_p" type="number" min="0" max="1" step="0.05" placeholder="留空=厂商默认" value="${cfg.top_p != null ? cfg.top_p : ''}"></label>
    <label data-tip="单次回复的最大输出 token 上限：思考与正文共用这一份额度，过小会让正文被 max_tokens 截断；留空=厂商默认">最大输出 tokens <input data-f="maxTokens" type="number" min="1" step="1" placeholder="留空=厂商默认" value="${cfg.maxTokens != null ? cfg.maxTokens : ''}">${mtHint ? `<span class="field-hint">${mtHint}</span>` : ''}</label>
    <label class="think-strength" style="display:${cfg.supportsThinking ? '' : 'none'}">思考强度
      <select data-f="thinkingStrength">
        ${thinkingLevels(cfg.vendor).map(v =>
          `<option value="${v.value}" ${cfg.thinkingStrength === v.value ? 'selected' : ''}>${v.label}</option>`).join('')}
      </select>
    </label>
    <label class="think-style" data-tip="各网关「让模型思考」的参数不同：默认按模型名自动识别；识别不准时手动指定。仅 OpenAI 兼容厂商需要，Anthropic / Gemini / Ollama 用各自原生参数" style="display:${showThinkStyle(cfg) ? '' : 'none'}">思考参数
      <select data-f="thinkingStyle">
        ${THINKING_STYLES.map(s =>
          `<option value="${s.value}" ${(cfg.thinkingStyle || 'auto') === s.value ? 'selected' : ''}>${s.label}</option>`).join('')}
      </select>
    </label>
    <label data-tip="勾选后此模型参与多模型协作；单模型处理时此复选框无作用"><input type="checkbox" data-f="enabled" ${cfg.enabled !== false ? 'checked' : ''}> 启用</label>
    <label data-tip="辅助视觉模型：勾选后，当聊天模型不支持视觉处理时自动调用此模型；只能勾选一个视觉模型"><input type="checkbox" data-f="supportsVision" ${cfg.supportsVision ? 'checked' : ''}> 视觉</label>
    <label data-tip="逐字流式输出；关闭则等待完整结果后一次性返回"><input type="checkbox" data-f="supportsStream" ${cfg.supportsStream !== false ? 'checked' : ''}> 流式</label>
    <label data-tip="多模型协作时由它整合各子模型结果；只能勾选一个主模型"><input type="checkbox" data-f="isPrimary" ${cfg.isPrimary ? 'checked' : ''}> 主模型</label>
    <label data-tip="开启推理/思考能力，推理模型会先思考再作答（Anthropic 走 thinking budget）"><input type="checkbox" data-f="supportsThinking" ${cfg.supportsThinking ? 'checked' : ''}> 思考</label>
    <button class="del">删除</button>
  </div>`;
}

/** 根据 models 当前状态重算各复选框禁用/选中态（视觉全局互斥、主模型单选受启用约束） */
function refreshChecks() {
  const visionOn = models.some(m => m.supportsVision);
  const primaryIdx = models.findIndex(m => m.isPrimary && m.enabled !== false);
  listEl.querySelectorAll('.model-card').forEach(card => {
    const i = +card.dataset.idx;
    const m = models[i];
    const enabledCb = card.querySelector('input[data-f="enabled"]');
    const visionCb = card.querySelector('input[data-f="supportsVision"]');
    const streamCb = card.querySelector('input[data-f="supportsStream"]');
    const primaryCb = card.querySelector('input[data-f="isPrimary"]');
    const thinkCb = card.querySelector('input[data-f="supportsThinking"]');
    const isVision = !!m.supportsVision;

    visionCb.disabled = visionOn && !isVision;
    enabledCb.disabled = isVision;
    streamCb.disabled = isVision;
    thinkCb.disabled = isVision;

    // 思考相关选择器：仅开启“思考”且非视觉模型时显示。
    // 思考参数（风格）下拉仅 OpenAI 兼容（openai）厂商有意义；
    // 强度下拉按厂商刷新选项（anthropic 展示预算档位），避免切换厂商后残留旧选项
    const showThink = m.supportsThinking && !isVision;
    const thinkStrengthLabel = card.querySelector('.think-strength');
    if (thinkStrengthLabel) {
      thinkStrengthLabel.style.display = showThink ? '' : 'none';
      const sel = thinkStrengthLabel.querySelector('select[data-f="thinkingStrength"]');
      if (sel) {
        const cur = m.thinkingStrength || 'off';
        sel.innerHTML = thinkingLevels(m.vendor)
          .map(l => `<option value="${l.value}" ${l.value === cur ? 'selected' : ''}>${l.label}</option>`).join('');
        sel.value = cur;
      }
    }
    const thinkStyleLabel = card.querySelector('.think-style');
    if (thinkStyleLabel) thinkStyleLabel.style.display = (showThink && m.vendor === 'openai') ? '' : 'none';

    const primaryDisabled = isVision || m.enabled === false || (primaryIdx >= 0 && i !== primaryIdx);
    primaryCb.disabled = primaryDisabled;
    if (primaryIdx >= 0 && i !== primaryIdx) {
      primaryCb.checked = false;
      models[i].isPrimary = false;
    }
  });
}

async function render() {
  models = await getModels();
  listEl.innerHTML = models.map((m, i) => cardHtml(m, i)).join('') ||
    '<p>还没有模型，点击“添加模型”。</p>';

  listEl.querySelectorAll('.del').forEach(b => b.onclick = async () => {
    models.splice(+b.closest('.model-card').dataset.idx, 1);
    await saveModels(models); render();
renderUsage();
  });

  // 复选框联动：改变即同步内存态并刷新禁用/选中态
  listEl.querySelectorAll('.model-card').forEach(card => {
    const i = +card.dataset.idx;
    card.querySelectorAll('input[type="checkbox"][data-f]').forEach(cb => {
      cb.addEventListener('change', () => {
        const f = cb.dataset.f;
        const val = cb.checked;
        models[i][f] = val;
        if (f === 'supportsVision' && val) {
          models.forEach((m, j) => { if (j !== i) m.supportsVision = false; });
          models[i].isPrimary = false;
        }
        if (f === 'enabled' && !val) models[i].isPrimary = false;
        if (f === 'isPrimary' && val) models.forEach((m, j) => { if (j !== i) m.isPrimary = false; });
        refreshChecks();
      });
    });
  });
  refreshChecks();

  await renderKbProviders();
}

document.getElementById('addModel').onclick = async () => {
  models.push(createModelConfig({ name: '新模型', vendor: 'openai', apiBase: '', model: '' }));
  await saveModels(models); render();
renderUsage();
};

document.getElementById('save').onclick = async () => {
  listEl.querySelectorAll('.model-card').forEach(card => {
    const i = +card.dataset.idx;
    card.querySelectorAll('[data-f]').forEach(inp => {
      const f = inp.dataset.f;
      const val = inp.type === 'checkbox' ? inp.checked : inp.value;
      // 数值型字段转为 Number；空字符串视为未配置（undefined），让适配器走厂商默认。
      // Number('abc') 是 NaN，NaN 进 storage 会破坏限速/超时逻辑，非法输入直接弃用
      if (f === 'timeoutMs' || f === 'tpm' || f === 'rpm' || f === 'temperature' || f === 'top_p' || f === 'maxTokens') {
        const n = Number(val);
        models[i][f] = (val === '' || val == null || !Number.isFinite(n) || (f === 'maxTokens' && n <= 0)) ? undefined : n;
      } else {
        models[i][f] = val;
      }
    });
  });
  await saveModels(models);
  // 知识库：保存当前 provider 草稿（随表单输入实时更新，不覆盖其他 provider）。
  // 草稿未加载完成（初始 getKbState 竞态失败）时不能保存：saveKbState(null) 会把
  // 用户已配置的 KB 凭证整体清空
  if (kbStateDraft) {
    await saveKbState(kbStateDraft);
  }
  document.getElementById('msg').textContent = '已保存';
  setTimeout(() => (document.getElementById('msg').textContent = ''), 2000);
};

render();
renderUsage();

// ---------- 复选框悬停提示：浮动提示框，自动夹在视口内避免溢出屏幕外 ----------
(function initTips() {
  const tip = document.createElement('div');
  tip.className = 'tip-pop';
  document.body.appendChild(tip);
  let current = null;
  function place(el) {
    const r = el.getBoundingClientRect();
    tip.style.visibility = 'hidden';
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.visibility = 'visible';
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    let top = r.top - th - 8;
    if (top < 8) top = r.bottom + 8;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el && el !== current) {
      current = el;
      tip.textContent = el.getAttribute('data-tip');
      tip.style.display = 'block';
      place(el);
    }
  });
  document.addEventListener('mouseout', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el && !el.contains(e.relatedTarget)) {
      tip.style.display = 'none';
      current = null;
    }
  });
})();
