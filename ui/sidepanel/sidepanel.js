// ui/sidepanel/sidepanel.js
// 侧边栏逻辑：触发总结、展示结果、显示当前备用模型提示。

const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const btn = document.getElementById('summarize');

let port;
function ensurePort() {
  if (!port) {
    port = chrome.runtime.connect({ name: 'sidepanel' });
    port.onMessage.addListener(onMessage);
  }
  return port;
}

function onMessage(msg) {
  if (msg.type === 'FALLBACK') {
    statusEl.textContent = `已切换到备用模型 #${msg.index + 1}：${msg.name} (${msg.reason})`;
  } else if (msg.type === 'RESULT') {
    resultEl.textContent = msg.text;
    statusEl.textContent = `完成（使用：${msg.used}，共尝试 ${msg.tried} 个模型）`;
  } else if (msg.type === 'ERROR') {
    statusEl.textContent = '错误：' + msg.message;
  }
}

btn.addEventListener('click', () => {
  resultEl.textContent = '';
  statusEl.textContent = '正在总结…';
  ensurePort().postMessage({ type: 'SUMMARIZE' });
});
