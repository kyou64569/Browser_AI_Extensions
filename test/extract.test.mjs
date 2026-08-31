// test/extract.test.mjs
// 正文提取函数的测试。
//
// 最关键的是「自包含性」：这两个函数会被 chrome.scripting.executeScript 序列化后
// 注入页面主世界执行，函数体内一旦引用了模块作用域的任何变量/import，
// 浏览器端就会抛 ReferenceError，而本地开发完全看不出来（SW 里跑得好好的）。
// 这里用 new Function 只注入 document/location 来复现该执行环境，
// 任何隐式外部依赖都会在测试阶段暴露。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMainTextInPage, extractMainPageInPage } from '../shared/extract.js';

/**
 * 极简 DOM 替身。
 * @param {{root?: 'article'|'main'|'body'|null, nodes?: {tag:string, text:string}[], title?: string}} [cfg]
 */
function makeDoc({ root = 'article', nodes = [], title = '测试页面标题' } = {}) {
  const mkClone = () => {
    const list = nodes.map(n => ({ ...n }));
    return {
      _nodes: list,
      // 返回值需支持 .forEach(e => e.remove())，且 remove 要真的把节点摘掉
      querySelectorAll(sel) {
        const tags = sel.split(',').map(s => s.trim());
        return list
          .filter(n => tags.includes(n.tag))
          .map(n => ({
            ...n,
            remove: () => {
              const i = list.indexOf(n);
              if (i >= 0) list.splice(i, 1);
            },
          }));
      },
      get innerText() { return list.map(n => n.text).join('\n'); },
      get textContent() { return this.innerText; },
    };
  };
  const rootEl = { cloneNode: () => mkClone() };
  return {
    title,
    body: rootEl,
    querySelector: (sel) => {
      if (root === null) return null;
      if (sel === root) return rootEl;
      if (sel === 'body' && root === 'body') return rootEl;
      return null;
    },
  };
}

/** 在"只有 document/location 的裸环境"里执行，验证函数自包含 */
function runInPageContext(fn, doc, location = { href: 'https://example.com/page' }) {
  const rebuilt = new Function('document', 'location', `return (${fn.toString()})();`);
  return rebuilt(doc, location);
}

test('extractMainTextInPage: 自包含（不引用模块作用域的任何变量）', () => {
  // 只要函数体引用了除 document / location 之外的标识符，这里就会 ReferenceError
  const doc = makeDoc({ nodes: [{ tag: 'p', text: '正文内容' }] });
  assert.doesNotThrow(() => runInPageContext(extractMainTextInPage, doc));
});

test('extractMainPageInPage: 自包含', () => {
  const doc = makeDoc({ nodes: [{ tag: 'p', text: '正文内容' }] });
  assert.doesNotThrow(() => runInPageContext(extractMainPageInPage, doc));
});

test('extractMainTextInPage: 提取正文并剔除 script/nav 等噪声节点', () => {
  const doc = makeDoc({
    nodes: [
      { tag: 'p', text: '这是正文' },
      { tag: 'script', text: 'alert(1)' },
      { tag: 'nav', text: '导航' },
      { tag: 'p', text: '第二段' },
    ],
  });
  const out = runInPageContext(extractMainTextInPage, doc);
  assert.ok(out.includes('这是正文'), '应保留正文：' + JSON.stringify(out));
  assert.ok(out.includes('第二段'), '应保留正文：' + JSON.stringify(out));
  assert.ok(!out.includes('alert(1)'), '应剔除 script 内容：' + JSON.stringify(out));
  assert.ok(!out.includes('导航'), '应剔除 nav 内容：' + JSON.stringify(out));
});

test('extractMainTextInPage: 压缩多余空行', () => {
  const doc = makeDoc({
    nodes: [
      { tag: 'p', text: '第一段' },
      { tag: 'p', text: '   \n   ' },
      { tag: 'p', text: '   \n   ' },
      { tag: 'p', text: '第二段' },
    ],
  });
  const out = runInPageContext(extractMainTextInPage, doc);
  assert.ok(!/\n{3,}/.test(out), '不应有连续 3 个以上换行：' + JSON.stringify(out));
});

test('extractMainTextInPage: 回退到 body', () => {
  const doc = makeDoc({ root: 'body', nodes: [{ tag: 'p', text: 'body 里的正文' }] });
  assert.ok(runInPageContext(extractMainTextInPage, doc).includes('body 里的正文'));
});

test('extractMainPageInPage: 返回 title/text/url 三元组', () => {
  const doc = makeDoc({ root: 'main', nodes: [{ tag: 'p', text: '正文' }] });
  const r = runInPageContext(extractMainPageInPage, doc, { href: 'https://example.com/abc' });
  assert.deepEqual(Object.keys(r).sort(), ['text', 'title', 'url']);
  assert.equal(r.title, '测试页面标题');
  assert.equal(r.url, 'https://example.com/abc');
  assert.ok(r.text.includes('正文'));
});

test('两个函数在无正文节点时返回空值而非抛错', () => {
  const emptyDoc = makeDoc({ root: null, nodes: [] });
  assert.equal(runInPageContext(extractMainTextInPage, emptyDoc), '');
  const r = runInPageContext(extractMainPageInPage, emptyDoc);
  assert.equal(r.text, '');
  assert.equal(r.title, '测试页面标题');
});
