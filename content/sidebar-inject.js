// content/sidebar-inject.js
// 在任意网页右侧注入一个可拖拽调整宽度、可折叠的 AI 侧边栏。
// 侧边栏以 iframe 加载扩展内的聊天页（preview/index.html），与主页面完全隔离。
// 展开时通过给页面主体加 margin-right 让出空间，主页面其余区域仍可正常交互。
//
// 注意：本文件是扩展 content script，仅在已加载该扩展的浏览器中运行；
// 预览模式下请用 preview/host.html 体验同一交互。

(function () {
  const ROOT_ID = '__ai_sidebar_root';
  if (window.self !== window.top) return; // 仅在顶层框架注入，避免子 iframe 内重复注入
  if (document.getElementById(ROOT_ID)) return;

  const style = document.createElement('style');
  style.textContent = `
  #${ROOT_ID}{ position:fixed; top:0; right:0; height:100vh; z-index:2147483646;
    display:flex; align-items:stretch; font-family:system-ui,sans-serif; }
  #${ROOT_ID} .ai-sb-resizer{ width:6px; cursor:col-resize; background:#c9ced6; flex:0 0 auto; }
  #${ROOT_ID} .ai-sb-resizer:hover{ background:#6c8cff; }
  #${ROOT_ID} .ai-sb-panel{ flex:0 0 auto; height:100%; box-shadow:-8px 0 24px rgba(0,0,0,.18); }
  #${ROOT_ID} iframe{ width:100%; height:100%; border:0; display:block; background:#0f1115; }
  #${ROOT_ID}.collapsed .ai-sb-panel, #${ROOT_ID}.collapsed .ai-sb-resizer{ display:none; }
  #${ROOT_ID} .ai-sb-fab{ position:fixed; right:16px; bottom:16px; z-index:2147483647;
    width:48px; height:48px; border-radius:50%; border:0; background:#6c8cff; color:#fff;
    font-size:14px; cursor:pointer; box-shadow:0 6px 18px rgba(0,0,0,.3); }
  body.__ai_sb_open{ transition:margin-right .15s ease; }
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = ROOT_ID;

  const panel = document.createElement('div');
  panel.className = 'ai-sb-panel';
  panel.style.width = '400px';

  const iframe = document.createElement('iframe');
  iframe.src = chrome.runtime.getURL('preview/index.html');
  iframe.title = 'AI 助手';
  panel.appendChild(iframe);

  const resizer = document.createElement('div');
  resizer.className = 'ai-sb-resizer';

  const fab = document.createElement('button');
  fab.className = 'ai-sb-fab';
  fab.textContent = 'AI';

  root.appendChild(resizer);
  root.appendChild(panel);
  document.documentElement.appendChild(root);
  document.body.appendChild(fab);

  let open = false;
  function setOpen(v) {
    open = v;
    root.classList.toggle('collapsed', !open);
    fab.textContent = open ? '×' : 'AI';
    if (open) {
      document.body.classList.add('__ai_sb_open');
      document.body.style.marginRight = panel.style.width;
    } else {
      document.body.classList.remove('__ai_sb_open');
      document.body.style.marginRight = '';
    }
  }
  fab.addEventListener('click', () => setOpen(!open));
  setOpen(false); // 默认折叠，点击右下角 FAB 或工具栏图标均可展开

  // 监听来自 background（工具栏图标点击）的切换指令
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'AI_TOGGLE_SIDEBAR') setOpen(!open);
  });

  // 拖拽调整宽度
  let dragging = false;
  resizer.addEventListener('pointerdown', (e) => {
    dragging = true;
    resizer.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const w = Math.max(280, Math.min(640, window.innerWidth - e.clientX));
    panel.style.width = w + 'px';
    if (open) document.body.style.marginRight = w + 'px';
  });
  window.addEventListener('pointerup', () => {
    dragging = false;
    document.body.style.cursor = '';
  });
})();
