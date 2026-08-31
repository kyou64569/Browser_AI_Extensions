// shared/extract.js
// 网页正文提取。此前同一段逻辑在 4 处各写一遍（content/extract.js 一份，
// background/service-worker.js 的三处 chrome.scripting.executeScript 兜底各一份），
// 改一处漏三处。这里抽成唯一实现。
//
// 关键约束：extractMainTextInPage 会被 chrome.scripting.executeScript 序列化后
// 注入到页面主世界执行，因此函数体必须"完全自包含"——不能引用本模块的任何
// 外部变量或 import。修改时请务必保持这一点，否则注入后会抛 ReferenceError。

/**
 * 在页面上下文中提取正文（自包含，可直接作为 executeScript 的 func 传入）。
 * 优先 article / main，回退 body；剔除脚本样式与导航类噪声节点。
 * @returns {string} 清洗后的正文
 */
export function extractMainTextInPage() {
  const root =
    document.querySelector('article') ||
    document.querySelector('main') ||
    document.body;
  if (!root) return '';
  const clone = /** @type {HTMLElement} */ (root.cloneNode(true));
  clone.querySelectorAll('script,style,noscript,nav,header,footer,aside').forEach(e => e.remove());
  return (clone.innerText || clone.textContent || '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 在页面上下文中提取正文 + 标题 + URL（自包含，供 executeScript 的 func 传入）。
 * 与 extractMainTextInPage 逻辑一致，只多返回页面元信息。
 * @returns {{title: string, text: string, url: string}}
 */
export function extractMainPageInPage() {
  const root =
    document.querySelector('article') ||
    document.querySelector('main') ||
    document.body;
  let text = '';
  if (root) {
    const clone = /** @type {HTMLElement} */ (root.cloneNode(true));
    clone.querySelectorAll('script,style,noscript,nav,header,footer,aside').forEach(e => e.remove());
    text = (clone.innerText || clone.textContent || '')
      .replace(/\s+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return { title: document.title || '', text, url: location.href || '' };
}
