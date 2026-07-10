// ui/options/options.js
// 设置页：模型列表 + 本地知识库地址。全部存 chrome.storage.local。

import { getModels, saveModels, getKbConfig, saveKbConfig } from '../../shared/storage.js';
import { createModelConfig } from '../../core/model-config.js';

const listEl = document.getElementById('modelList');

function cardHtml(cfg, idx) {
  return `
  <div class="model-card" data-idx="${idx}">
    <label>名称 <input data-f="name" value="${cfg.name || ''}"></label>
    <label>厂商
      <select data-f="vendor">
        ${['openai','anthropic','gemini','ollama'].map(v =>
          `<option value="${v}" ${cfg.vendor===v?'selected':''}>${v}</option>`).join('')}
      </select>
    </label>
    <label>API Base <input data-f="apiBase" value="${cfg.apiBase||''}"></label>
    <label>API Key <input data-f="apiKey" type="password" value="${cfg.apiKey||''}"></label>
    <label>Model <input data-f="model" value="${cfg.model||''}"></label>
    <label>超时(ms) <input data-f="timeoutMs" type="number" value="${cfg.timeoutMs||60000}"></label>
    <label><input type="checkbox" data-f="supportsVision" ${cfg.supportsVision?'checked':''}> 支持视觉</label>
    <label><input type="checkbox" data-f="supportsStream" ${cfg.supportsStream?'checked':''}> 支持流式</label>
    <label><input type="checkbox" data-f="enabled" ${cfg.enabled!==false?'checked':''}> 启用</label>
    <button class="del">删除</button>
  </div>`;
}

async function render() {
  const models = await getModels();
  listEl.innerHTML = models.map((m, i) => cardHtml(m, i)).join('') ||
    '<p>还没有模型，点击“添加模型”。</p>';
  listEl.querySelectorAll('.del').forEach(b => b.onclick = async () => {
    models.splice(+b.closest('.model-card').dataset.idx, 1);
    await saveModels(models); render();
  });
  const kb = await getKbConfig();
  document.getElementById('kbBase').value = kb.cfg?.baseUrl || '';
  document.getElementById('kbKey').value = kb.cfg?.apiKey || '';
}

document.getElementById('addModel').onclick = async () => {
  const models = await getModels();
  models.push(createModelConfig({ name: '新模型', vendor: 'openai', apiBase: '', model: '' }));
  await saveModels(models); render();
};

document.getElementById('save').onclick = async () => {
  const models = await getModels();
  listEl.querySelectorAll('.model-card').forEach(card => {
    const i = +card.dataset.idx;
    card.querySelectorAll('[data-f]').forEach(inp => {
      const f = inp.dataset.f;
      const val = inp.type === 'checkbox' ? inp.checked : inp.value;
      models[i][f] = (f === 'timeoutMs') ? Number(val) : val;
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
