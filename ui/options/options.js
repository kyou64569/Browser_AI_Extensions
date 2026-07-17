// ui/options/options.js
// 设置页：模型列表 + 本地知识库地址。全部存 chrome.storage.local。
// 复选框与侧边栏设置页保持一致：启用 / 视觉 / 流式 / 主模型 / 思考，
// 并实现同样的联动（视觉全局互斥、主模型单选受启用约束）。

import { getModels, saveModels, getKbConfig, saveKbConfig } from '../../shared/storage.js';
import { createModelConfig } from '../../core/model-config.js';

const listEl = document.getElementById('modelList');

// 内存中的模型列表，便于复选框联动即时生效（点“保存”时写回 storage）
let models = [];

function thinkLabel(v) {
  return { off: '关闭', low: '低', medium: '中', high: '高' }[v] || v;
}

/** 是否展示“支持 reasoning_effort”开关：仅 OpenAI 兼容厂商（openai/ollama/gemini）且已开启思考时 */
function showResFlag(cfg) {
  return cfg.supportsThinking && cfg.vendor !== 'anthropic';
}

function cardHtml(cfg, idx) {
  return `
  <div class="model-card" data-idx="${idx}">
    <label>名称 <input data-f="name" value="${cfg.name || ''}"></label>
    <label>厂商
      <select data-f="vendor">
        ${['openai', 'anthropic', 'gemini', 'ollama'].map(v =>
          `<option value="${v}" ${cfg.vendor === v ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
    </label>
    <label>API Base <input data-f="apiBase" value="${cfg.apiBase || ''}"></label>
    <label>API Key <input data-f="apiKey" type="password" value="${cfg.apiKey || ''}"></label>
    <label>Model <input data-f="model" value="${cfg.model || ''}"></label>
    <label>超时(ms) <input data-f="timeoutMs" type="number" value="${cfg.timeoutMs || 60000}"></label>
    <label>TPM上限 <input data-f="tpm" type="number" min="0" step="1000" placeholder="留空=自适应" value="${cfg.tpm != null ? cfg.tpm : ''}"></label>
    <label>RPM上限 <input data-f="rpm" type="number" min="0" step="1" placeholder="留空=自适应" value="${cfg.rpm != null ? cfg.rpm : ''}"></label>
    <label>Temperature <input data-f="temperature" type="number" min="0" max="2" step="0.1" placeholder="留空=厂商默认" value="${cfg.temperature != null ? cfg.temperature : ''}"></label>
    <label>Top P <input data-f="top_p" type="number" min="0" max="1" step="0.05" placeholder="留空=厂商默认" value="${cfg.top_p != null ? cfg.top_p : ''}"></label>
    <label class="think-strength" style="display:${cfg.supportsThinking ? '' : 'none'}">思考强度
      <select data-f="thinkingStrength">
        ${['off', 'low', 'medium', 'high'].map(v =>
          `<option value="${v}" ${cfg.thinkingStrength === v ? 'selected' : ''}>${thinkLabel(v)}</option>`).join('')}
      </select>
    </label>
    <label><input type="checkbox" data-f="enabled" ${cfg.enabled !== false ? 'checked' : ''}> 启用</label>
    <label><input type="checkbox" data-f="supportsVision" ${cfg.supportsVision ? 'checked' : ''}> 视觉</label>
    <label><input type="checkbox" data-f="supportsStream" ${cfg.supportsStream !== false ? 'checked' : ''}> 流式</label>
    <label><input type="checkbox" data-f="isPrimary" ${cfg.isPrimary ? 'checked' : ''}> 主模型</label>
    <label><input type="checkbox" data-f="supportsThinking" ${cfg.supportsThinking ? 'checked' : ''}> 思考</label>
    <label class="res-flag" style="display:${showResFlag(cfg) ? '' : 'none'}"><input type="checkbox" data-f="reasoningEffortSupported" ${cfg.reasoningEffortSupported ? 'checked' : ''}> 支持 reasoning_effort（推理模型如 o1/o3）</label>
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

    // 思考强度选择器：仅开启“思考”且非视觉模型时显示
    const thinkStrengthLabel = card.querySelector('.think-strength');
    if (thinkStrengthLabel) thinkStrengthLabel.style.display = (m.supportsThinking && !isVision) ? '' : 'none';
    // reasoning_effort 开关：仅 OpenAI 兼容厂商 + 开启思考时显示并可用
    const resFlagLabel = card.querySelector('.res-flag');
    const showRes = m.supportsThinking && m.vendor !== 'anthropic' && !isVision;
    if (resFlagLabel) {
      resFlagLabel.style.display = showRes ? '' : 'none';
      const resCb = resFlagLabel.querySelector('input[data-f="reasoningEffortSupported"]');
      if (resCb) resCb.disabled = isVision;
    }

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

  const kb = await getKbConfig();
  document.getElementById('kbBase').value = kb.cfg?.baseUrl || '';
  document.getElementById('kbKey').value = kb.cfg?.apiKey || '';
}

document.getElementById('addModel').onclick = async () => {
  models.push(createModelConfig({ name: '新模型', vendor: 'openai', apiBase: '', model: '' }));
  await saveModels(models); render();
};

document.getElementById('save').onclick = async () => {
  listEl.querySelectorAll('.model-card').forEach(card => {
    const i = +card.dataset.idx;
    card.querySelectorAll('[data-f]').forEach(inp => {
      const f = inp.dataset.f;
      const val = inp.type === 'checkbox' ? inp.checked : inp.value;
      // 数值型字段转为 Number；空字符串视为未配置（undefined），让适配器走厂商默认
      if (f === 'timeoutMs' || f === 'tpm' || f === 'rpm' || f === 'temperature' || f === 'top_p') {
        models[i][f] = (val === '' || val == null) ? undefined : Number(val);
      } else {
        models[i][f] = val;
      }
    });
  });
  await saveModels(models);
  await saveKbConfig({
    type: 'local',
    cfg: {
      baseUrl: document.getElementById('kbBase').value,
      apiKey: document.getElementById('kbKey').value,
    },
  });
  document.getElementById('msg').textContent = '已保存';
  setTimeout(() => (document.getElementById('msg').textContent = ''), 2000);
};

render();
