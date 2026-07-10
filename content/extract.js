// content/extract.js
// 内容脚本：提取网页正文 + 监听划词。
// 通过 chrome.runtime.sendMessage 与 background 通信，不直接持有密钥。

(function () {
  /** 简单正文提取：优先 article/main，否则 body 文本 */
  function extractMainText() {
    const root =
      document.querySelector('article') ||
      document.querySelector('main') ||
      document.body;
    const clone = root.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,nav,header,footer,aside').forEach(e => e.remove());
    const text = (clone.innerText || clone.textContent || '')
      .replace(/\s+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text;
  }

  // 暴露给 background 调用
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'EXTRACT_PAGE') {
      try {
        sendResponse({ title: document.title, text: extractMainText(), url: location.href });
      } catch (e) {
        sendResponse({ title: document.title, text: '', url: location.href, error: e.message });
      }
      return true;
    }
    if (msg.type === 'GET_SELECTION') {
      try {
        sendResponse({ text: window.getSelection().toString() });
      } catch (e) {
        sendResponse({ text: '', error: e.message });
      }
      return true;
    }
    return false;
  });

  // TODO: 划词快捷操作浮层（翻译/解释/追问），后续在此挂载 UI，调用 features/selection。
})();
