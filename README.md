# 个人 AI 助手浏览器扩展（核心框架 / MV3）

> 在分层 + 优先级架构上已实现并可运行：网页总结、通用聊天（单模型 / 多模型协作 / 视觉转发）、
> 多模态生成（图片 / 音频 / 视频）、网页自动化（ReAct 工具调用）、网页翻译、实时双语字幕。
> 复杂逻辑按模块解耦，预留清晰扩展点（`registerAdapter`、连接器抽象、`placeholders.js`）。

## 目录结构与职责

```
manifest.json                  MV3 清单（service worker / sidePanel / options / content script）
background/
  service-worker.js           后台中枢：消息分发，装配 router + fallback + kb + 多模态 + 自动化
  web-tools.js                网页自动化工具执行层（DOM 工具 + 浏览器级工具，被 AUTOMATE 调用）
core/
  message.js                  统一内部消息格式（角色/内容/多模态附件）+ 类型定义（不绑定厂商）
  http.js                     通用 fetch 封装（超时、错误分类 HttpError）
  model-config.js             ModelConfig 数据结构 + 校验
  model-client.js             ModelClient 工厂（registerAdapter 扩展点）
  model-base.js               ModelClient 抽象基类（避免与 adapter 注册表循环依赖）
  adapters/
    openai.js                 OpenAI 兼容（OpenRouter/国产兼容），支持图片+流式
    anthropic.js              Anthropic Messages API，system 单独字段 + 图片
    gemini.js                 Gemini generateContent / streamGenerateContent
    ollama.js                 本地 Ollama（OpenAI 兼容 /api/chat）
  list-models.js              按厂商拉取可用模型列表（配置界面自动填充下拉框）
  fallback.js                 备用/降级：排序候选 -> 失败自动切下一个 -> 失败冷却
  router.js                   任务路由：规则表 + selectModel（条件筛选，策略可替换）
  translate-rate.js           网页翻译优化：token 估算 / 句边界切分 / 分块 / TPM-RPM 限流
connectors/
  knowledge-base.js           KnowledgeBaseConnector 抽象接口（search/add）
  local-kb.js                 本地知识库连接器（HTTP 实现，字段待你提供）
  online-kb.js                在线知识库（NotebookLM/ima 等）占位，TODO 留空
features/
  summarize.js                网页总结（最小闭环，依赖 router+fallback+kb）
  chat.js                     通用聊天：单模型 / 多模型协作 / 视觉转发，复用 adapter+fallback
  selection.js                划词处理（翻译/解释/追问）接口骨架，TODO 接 UI
  automation.js               网页自动化：工具定义 + 提示词 + ReAct 式工具调用解析
  placeholders.js             未实现模块占位：工作流/Agent/Skill/PPT/网页自动化
content/
  extract.js                  content script：提取正文 + 监听划词（GET_SELECTION）
  sidebar-inject.js           在任意网页右侧注入可拖拽/折叠的 iframe 侧边栏（加载 preview）
  translate.js                网页翻译页面 Worker：收集文本→后台翻译→替换/还原
  subtitle.js                 实时字幕页面 Worker：平台字幕/Whisper 转写→大模型翻译→叠加双语层
offscreen/
  subtitle-offscreen.html     扩展 Offscreen 文档（承载字幕音频捕获，不受视频页 autoplay 限制）
  subtitle-offscreen.js       捕获标签页音频、Web Audio 恢复声音、VAD 分片转 WAV 回传 SW
shared/
  storage.js                  chrome.storage.local 读写封装（密钥不写死）
  utils.js                    共享工具：凭证判断、采样参数提取等
ui/
  sidepanel/                  原生侧边栏（chrome.sidePanel）：触发总结、展示结果、备用模型提示
  popup/                      工具栏弹窗：打开原生侧边栏 / 设置
  options/                    原生设置页（chrome.runtime.openOptionsPage）：聊天/总结模型列表 + 本地知识库地址。
                              （多模态模型在预览/注入侧边栏的「设置」preview.js 中配置）
preview/
  index.html                  侧边栏式预览应用（聊天为主页；顶部左=功能、右=设置）
  preview.js                  预览逻辑（import 核心模块，localStorage 替代 storage，多模态生成）
  preview.css                 现代化紧凑侧边栏样式
  host.html / host.js / host.css   宿主页：预览模式下可拖拽/折叠侧边栏（等价于 content/sidebar-inject）
  secrets.example.json        代理模式密钥模板（复制为 secrets.json）
```

## 分层依赖（上层不感知下层厂商）

`features` → 依赖 `core/router` + `core/fallback`(包裹 `core/model-client`) + `connectors`
`core/adapters` → 仅被 `core/model-client` 工厂使用
所有配置来自 `shared/storage`（chrome.storage.local）

## 核心能力概览

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 网页总结 | `features/summarize.js` | 提取正文 → 路由选模型 → 流式/聚合返回，失败自动降级 |
| 通用聊天 | `features/chat.js` | 单模型 / 多模型协作 / 视觉转发（图片自动转交视觉模型） |
| 多模态生成 | `preview/preview.js` `callMultimodalModel` | 图片 / 音频 / 视频（视频为异步轮询，支持第三方网关 `metadata.url`） |
| 网页自动化 | `features/automation.js` + `background/web-tools.js` | ReAct 式工具调用（click/type/scroll/screenshot…）操作当前页面 |
| 网页翻译 | `content/translate.js` + `core/translate-rate.js` | 收集页面文本 → 后台翻译 → 替换/还原，带 TPM-RPM 限流 |
| 实时字幕 | `content/subtitle.js` + `offscreen/subtitle-offscreen.js` | 平台字幕或 Whisper 转写 → 大模型翻译 → 页面叠加双语层 |

## 验证最小闭环（网页总结 / 聊天）

1. Chrome 打开 `chrome://extensions`，开启「开发者模式」。
2. 「加载已解压的扩展程序」，选择本目录。
3. 点击扩展图标 -> 「设置」：
   - 添加至少一个模型（vendor/apiBase/apiKey/model），勾选「启用」。
   - 若你有本地知识库，填服务地址（字段映射见 `connectors/local-kb.js` 的 TODO）。
4. 打开任意网页 -> 点击扩展图标 -> 「打开侧边栏」-> 点「总结本页」或直接在聊天框输入。
5. 侧边栏显示结果；若主模型失败会自动切到备用模型并提示（状态栏显示第几个）。

## 在真实网页上运行（注入式扩展侧边栏）

除了「浏览器内预览」，本项目也内置了**真正的扩展侧边栏**：在任意网页右侧注入一个
可拖拽调宽、可折叠的 iframe 侧边栏，加载聊天应用（`preview/index.html`），主页面不被遮挡、可正常交互。

### 加载为解压的扩展程序
1. Chrome / Edge 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本仓库根目录 `Browser_AI_Extensions`。
3. 扩展安装成功，**不填任何密钥也能直接用**（见下方「演示模式」）。

### 在真实页面上使用
1. 打开任意普通网页（如 `https://example.com`，注意 `chrome://` 页面不支持侧边栏）。
2. **点击工具栏上的扩展图标** → 浏览器原生侧边栏（右侧槽位）直接打开聊天应用。
   这是最可靠的触发方式，由浏览器自身处理，无需刷新页面。原生侧边栏可拖动左缘调整宽度，
   且完全不遮挡主页面。
3. 若想要「覆盖在网页之上、可拖宽」的版本：在扩展加载后**刷新一次当前网页**，
   右下角会出现蓝色 `AI` 悬浮按钮，点击即在页面右侧注入可拖拽（280–640px）的 iframe 侧边栏
   （主页面让出 `margin-right`，其余区域照常可交互）。
4. 在聊天框输入消息 → 流式逐字回复；点左上「功能」可做网页总结 / 翻译 / 解释 / OCR / 网页操作（自动化），
   点右上「设置」配置模型（含多模态模型，多模态模型在预览/注入侧边栏的「设置」中维护）。

### 演示模式（开箱即用）
- 默认模型是 OpenRouter 但未填 Key。此时聊天 / 总结 / 划词会**本地生成示例回复并流式展示**，
  用于验证侧边栏布局与交互，不会报错、不会白屏。
- 想接入真实模型：点右上「设置」添加模型（推荐 **OpenRouter** 或本地 **Ollama**，
  二者都支持浏览器直连，无需代理），填入 Key/地址后即为真实调用；多个模型会按
  `core/router` + `core/fallback` 自动降级。

### 兼容性
- 内容脚本与侧边栏均为标准 ES Module + MV3 API，**Chrome 与 Edge（同为 Chromium 内核）**
  渲染与运行一致；侧边栏注入逻辑已加 `top` 框架判断，不会在子 iframe 内重复注入。

## 多模态生成（图片 / 音频 / 视频）

在「设置」中添加**多模态模型**卡片（与聊天模型共用 vendor/apiBase/apiKey，但额外指定 `model`、
可选 `size` 与 `modalities`：image/audio/video）。由 `preview/preview.js` 的 `callMultimodalModel` 调度：

- **图片**：`POST {base}/images/generations`，兼容多种返回格式（url / b64_json / image_url）。
- **音频**：`POST {base}/audio/speech`，直接返回可播放的 blob。
- **视频**：OpenAI 兼容异步流程 ——
  `POST {base}/videos` 创建任务 → `GET {base}/videos/{id}` 轮询状态 → 完成后用可下载 URL 播放。
  - 轮询为「容错多义词」完成判定：`status ∈ {completed,succeeded,success,finished,done}`、
    `completed_at` 存在、`progress≥100`、或存在可下载 URL 任一即视为完成。
  - 可下载地址依次尝试 `url / video_url / download_url / content_url / output_url /
    metadata.url / output.url`；命中 `metadata.url` 等直链时直接播放，否则回退到 `/content` 端点。
  - 轮询 `GET` 使用 `cache:'no-store'`，避免浏览器缓存导致一直读到生成中的旧进度。
  - 总超时由 `taskTimeoutMs`（默认 600000ms = 10 分钟）控制，单次请求超时由 `timeoutMs` 控制。

## 待你提供 / 待补项

- `connectors/local-kb.js`：真实接口路径、请求/响应字段（当前按 `/retrieve`、`/add` 占位）。
- `connectors/online-kb.js`：在线知识库接入方式需调研（官方 API/浏览器自动化）。
- `features/selection.js`：划词浮层 UI（已预留接口）。
- `features/placeholders.js`：工作流、自主 Agent、Skill 系统、PPT 导出、网页自动化（仅接口占位）。
- 原生侧边栏（`ui/sidepanel`）的流式展示当前由 service-worker 聚合后一次性返回；
  `preview` 路径的聊天已支持逐 chunk 打字机效果，原生侧边栏路径后续可对齐。

---

## 浏览器内预览（开发模式）

扩展本体依赖 `chrome.*` API，无法在普通标签页直接加载。为此提供 `preview/` 预览应用，
**复用同一套核心模块**（`core/`、`connectors/`、`features/`），用 `localStorage` 替代
`chrome.storage.local`，通过本地开发服务器在浏览器里直接交互验证架构。

### 目录
```
preview/
  index.html        侧边栏式预览应用（聊天为主页；顶部左=功能、右=设置）
  preview.js        预览逻辑（import 核心模块，localStorage 替代 storage，单页视图切换，含多模态生成）
  preview.css       现代化紧凑侧边栏样式
  host.html         宿主页（预览模式下可拖拽/折叠侧边栏入口，等价于 content/sidebar-inject）
  host.js           宿主页逻辑：拖拽分隔条调整侧边栏宽度、折叠/展开
  host.css          宿主页样式
  secrets.example.json   代理模式密钥模板（复制为 secrets.json）
dev-server.mjs      Node 零依赖服务器（静态 + 流式代理）
dev-server.py       Python 零依赖服务器（静态 + 整块代理）
package.json        start 脚本
```

### 依赖与前置
- 运行模式一（推荐）：**Node.js ≥ 18**（仅用内置模块，无需 `npm install`）。
- 运行模式二：**Python ≥ 3.8**（仅用标准库，无需 `pip install`）。
- 浏览器：Chrome / Edge / 任意支持 ES Module 的现代浏览器。

### 启动流程

**方式 A：Node（推荐，代理支持流式）**
```bash
cd Browser_AI_Extensions
npm start            # 等价于 node dev-server.mjs
# 如需代理模式（规避官方 API 的 CORS）：
cp preview/secrets.example.json preview/secrets.json
# 编辑 preview/secrets.json 填入你的密钥
```
访问：**http://localhost:5173**

**方式 B：Python（无 Node 时）**
```bash
cd Browser_AI_Extensions
python dev-server.py        # 或 python3 dev-server.py
# 代理模式同样需要 preview/secrets.json
```
访问：**http://localhost:5173**

> 端口可用环境变量覆盖：`PORT=8080 npm start`

### 两种调用模式（页面内切换）
1. **直连模式**（默认，勾选框关闭）：使用页面里填的 API Base/Key 直接请求。
   适合 **OpenRouter、Ollama 等支持浏览器 CORS** 的服务。OpenAI/Anthropic/Gemini 官方
   端点通常会被浏览器 CORS 拦截（控制台会报 CORS 错误，属正常现象，非代码缺陷）。
2. **代理模式**（勾选“通过本地代理调用”）：请求发往同源的 `/proxy/<vendor>/*`，
   由 `dev-server` 注入服务端密钥并转发真实接口，**规避 CORS 且密钥不进前端**。
   需先在 `preview/secrets.json` 配置对应密钥。

### 最小验证（无密钥也能验证架构）
- 打开页面 → 点「加载示例」→「总结本页」：
  - 若用 OpenRouter 且填了 Key：直接得到总结，验证 适配器→路由→降级→展示 全链路。
  - 若无网络/Key：控制台/状态栏会显示错误信息，但**页面不崩溃、无脚本报错**。
- 配置两个模型（如 OpenRouter 主用 + Ollama 备用），主用故意填错 Key → 触发降级，
  状态栏会提示「已切换到备用模型 #2」，验证 fallback 机制。
- 在「设置」中添加多模态模型（图片/视频），触发多模态生成，验证 `callMultimodalModel` 全链路。
- 划词区选「翻译/解释/追问」验证 `features/selection.js` 同链路。

### 控制台无报错的保证范围
- 页面脚本、核心模块均为标准 ES2020+，import 路径已逐一核对，加载期无报错。
- 预览页不 import 任何 `chrome.*` 相关模块，无扩展 API 缺失报错。
- 唯一可能的控制台报错来自浏览器 CORS（仅在“直连模式”调用官方端点时），属预期，
  按上面切换到“代理模式”即可消除。
