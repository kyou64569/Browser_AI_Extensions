// preview/host.js
// 宿主页逻辑：拖拽分隔条调整侧边栏宽度（夹紧 280–560px），折叠/展开切换。
// 主页面始终保持可交互（侧边栏是文档流兄弟节点，不遮挡）。

const layout = document.getElementById('layout');
const sidebar = document.getElementById('sidebar');
const resizer = document.getElementById('resizer');
const toggle = document.getElementById('sbToggle');

const MIN = 280, MAX = 560;
let sbWidth = 400;

function setWidth(w) {
  sbWidth = Math.max(MIN, Math.min(MAX, w));
  sidebar.style.width = sbWidth + 'px';
}

// 拖拽调整宽度
let dragging = false;
resizer.addEventListener('pointerdown', (e) => {
  dragging = true;
  resizer.classList.add('active');
  resizer.setPointerCapture(e.pointerId);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
});
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const rect = layout.getBoundingClientRect();
  setWidth(rect.right - e.clientX);
});
window.addEventListener('pointerup', () => {
  if (!dragging) return;
  dragging = false;
  resizer.classList.remove('active');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

// 折叠 / 展开
toggle.addEventListener('click', () => {
  const collapsed = layout.classList.toggle('collapsed');
  toggle.textContent = collapsed ? '展开侧边栏' : '收起侧边栏';
});

setWidth(sbWidth);

// 侧边栏（index.html，作为 iframe 嵌入）请求当前宿主页正文时，抽取并回传，使其可“总结当前网页”
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.type !== 'GET_PAGE') return;
  const page = extractHostPage();
  // 回传给来源窗口（即侧边栏 iframe），而非 window.parent（父页自身）
  if (e.source) {
    e.source.postMessage(
      { type: 'PAGE_RESULT', _ch: d._ch, title: document.title, text: page, url: location.href },
      '*'
    );
  }
});

/** 抽取宿主页正文（与 content/extract.js 逻辑对齐） */
function extractHostPage() {
  const root = document.querySelector('article') || document.querySelector('main') || document.body;
  if (!root) return '';
  const clone = root.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,nav,header,footer,aside').forEach(el => el.remove());
  return (clone.innerText || clone.textContent || '')
    .replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
