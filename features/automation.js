// features/automation.js
// 网页自动化「工具定义 + 提示词 + 解析」：供侧边栏在「网页操作」模式下注入系统提示，
// 并解析 AI 输出的工具调用（ReAct 风格），交由 background 的 execTool 执行。
//
// 协议：AI 在其回复中以代码块（语言标记为 toolcall）输出一个 JSON：
//   ```toolcall
//   {"name":"click","args":{"selector":"#submit"}}
//   ```
// 系统在流式结束后解析该块；若存在则执行工具并把结果回灌为下一条消息，AI 可继续调用或直接作答。

/** 可用工具清单（名称 / 用途 / 参数） */
export const TOOLS = [
  {
    name: 'click',
    desc: '点击按钮 / 链接 / 任意可点击元素。',
    params: [
      { name: 'selector', desc: 'CSS 选择器（与 xpath/text 三选一）', required: false },
      { name: 'xpath', desc: 'XPath 表达式（与 selector/text 三选一）', required: false },
      { name: 'text', desc: '按可见文本匹配（a/button/input 等交互元素，包含即可）', required: false },
      { name: 'index', desc: '多个匹配时取第几个，默认 0', required: false },
    ],
  },
  {
    name: 'type',
    desc: '在输入框 / 文本域中输入文本（兼容 React/Vue 受控组件）。',
    params: [
      { name: 'value', desc: '要输入的文本', required: true },
      { name: 'selector', desc: '目标输入框的 CSS 选择器', required: false },
      { name: 'xpath', desc: '目标输入框的 XPath', required: false },
      { name: 'text', desc: '按可见文本/placeholder 匹配输入框', required: false },
      { name: 'clear', desc: '是否在输入前清空原内容（布尔）', required: false },
      { name: 'append', desc: '是否追加到原内容之后（布尔）', required: false },
    ],
  },
  {
    name: 'select_option',
    desc: '在下拉框（<select>）中选择选项。',
    params: [
      { name: 'selector', desc: '下拉框的 CSS 选择器', required: false },
      { name: 'value', desc: '按 option 的 value 选择', required: false },
      { name: 'label', desc: '按 option 的可见文本选择', required: false },
    ],
  },
  {
    name: 'check',
    desc: '勾选复选框（确保被选中；已选中则不变）。',
    params: [
      { name: 'selector', desc: '复选框的 CSS 选择器', required: false },
      { name: 'xpath', desc: '复选框的 XPath', required: false },
      { name: 'text', desc: '按关联文本匹配', required: false },
    ],
  },
  {
    name: 'uncheck',
    desc: '取消勾选复选框（确保未被选中；已取消则不变）。',
    params: [
      { name: 'selector', desc: '复选框的 CSS 选择器', required: false },
      { name: 'xpath', desc: '复选框的 XPath', required: false },
      { name: 'text', desc: '按关联文本匹配', required: false },
    ],
  },
  {
    name: 'scroll',
    desc: '滚动页面或元素。',
    params: [
      { name: 'selector', desc: '滚动该元素进入视图或在其内部滚动', required: false },
      { name: 'x', desc: '水平滚动像素（相对）', required: false },
      { name: 'y', desc: '垂直滚动像素（相对）', required: false },
      { name: 'position', desc: "滚动到 'top' / 'bottom'（页面或元素）", required: false },
    ],
  },
  {
    name: 'switch_tab',
    desc: '切换当前窗口的浏览器标签页。',
    params: [
      { name: 'index', desc: '标签序号（从 0 开始）', required: false },
      { name: 'title', desc: '标题或 URL 包含的子串', required: false },
      { name: 'tabId', desc: '标签页 id', required: false },
    ],
  },
  {
    name: 'wait_for',
    desc: '等待某个元素出现（轮询，超时返回错误）。',
    params: [
      { name: 'selector', desc: 'CSS 选择器', required: false },
      { name: 'xpath', desc: 'XPath', required: false },
      { name: 'text', desc: '按可见文本匹配', required: false },
      { name: 'timeout', desc: '超时毫秒，默认 10000，最大 30000', required: false },
    ],
  },
  {
    name: 'get_text',
    desc: '获取页面或某元素的文本内容（不传定位参数则取整页正文）。',
    params: [
      { name: 'selector', desc: 'CSS 选择器（取该元素文本）', required: false },
      { name: 'xpath', desc: 'XPath（取该元素文本）', required: false },
      { name: 'text', desc: '按可见文本匹配', required: false },
    ],
  },
  {
    name: 'screenshot',
    desc: '对当前可视区域截图（结果会显示在对话中）。',
    params: [],
  },
  {
    name: 'navigate',
    desc: '浏览器前进 / 后退 / 刷新。',
    params: [
      { name: 'direction', desc: " 'back'（后退，默认）/ 'forward'（前进）/ 'reload'（刷新）", required: false },
    ],
  },
];

const INTRO = `你是一个可以控制浏览器的网页自动化助手。当用户要求你操作“当前网页”（点击、输入、选择、勾选、滚动、切换标签、等待元素、获取文本、截图、前进/后退等）时，你可以使用下面列出的工具来完成，并在操作完成后用自然语言向用户汇报结果。

【多步任务（重要）】
- 如果用户的请求包含多个步骤（例如：先点击某个标签/按钮 → 再读取页面内容 → 再从中提取并汇报某项数据），你必须按顺序逐步调用多个工具，直到完成用户要求的全部操作，最后才给出最终回答。
- 严禁在完成所有必要步骤之前提前给出“已完成”的最终回答。每一步执行后，根据工具返回的结果决定下一步该做什么。
- 一条用户消息应当足以让你自主完成一串连续动作，无需用户再次发消息；只有在任务真正彻底完成后才输出最终自然语言回答。

【工具使用协议】
- 当你需要操作网页时，在你的回复中放入一个语言标记为 toolcall 的代码块，内容为 JSON：
  \`\`\`toolcall
  {"name": "工具名", "args": { ...参数 } }
  \`\`\`
- 你可以（也应该）在一次回复中连续输出多个 toolcall 块来规划接下来的若干步骤；系统会按顺序逐一执行它们，并把每一步的结果反馈给你。
- 系统执行工具后，会把结果作为下一条消息返回给你。根据结果继续调用工具，直到任务完成，再直接给出最终的自然语言回答（不要再输出 toolcall 块）。
- 定位元素优先使用稳定且唯一的 CSS 选择器；也可用 "xpath" 或 "text"（按可见文本包含匹配）。若不确定元素，可先调用 get_text 或 screenshot 观察页面。
- 若工具返回错误（ok:false），请据此调整选择器或换一种方式重试，不要反复用完全相同的错误参数。`;

/** 生成注入到系统提示中的工具使用说明 */
export function buildToolSystemPrompt() {
  const lines = [INTRO, '', '【可用工具】'];
  for (const t of TOOLS) {
    lines.push(`- ${t.name}：${t.desc}`);
    if (t.params && t.params.length) {
      lines.push('  参数：' + t.params.map(p => `${p.name}${p.required ? '（必填）' : ''}: ${p.desc}`).join('；'));
    }
  }
  return lines.join('\n');
}

const RE_BLOCK = /```toolcall\s*\n([\s\S]*?)```|<<TOOLCALL>>\s*([\s\S]*?)\s*<<\/TOOLCALL>>|<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;

/** 从 AI 回复文本中解析全部工具调用（支持一次回复包含多个），无则空数组 */
export function parseToolCalls(text) {
  if (!text) return [];
  const out = [];
  let m;
  RE_BLOCK.lastIndex = 0;
  while ((m = RE_BLOCK.exec(text)) !== null) {
    const json = (m[1] || m[2] || m[3] || '').trim();
    if (!json) continue;
    try {
      const obj = JSON.parse(json);
      if (obj && typeof obj.name === 'string') {
        out.push({ name: obj.name, args: (obj.args && typeof obj.args === 'object') ? obj.args : {} });
      }
    } catch (_) { /* 非法 JSON 忽略该块 */ }
  }
  return out;
}

/** 兼容旧调用：解析出第一个工具调用（无则 null） */
export function parseToolCall(text) {
  const all = parseToolCalls(text);
  return all.length ? all[0] : null;
}

/** 去掉 AI 回复中的工具调用块（用于最终展示，避免向用户暴露原始 JSON） */
export function stripToolCall(text) {
  if (!text) return text;
  return text
    .replace(/```toolcall\s*\n[\s\S]*?```/gi, '')
    .replace(/<<TOOLCALL>>\s*[\s\S]*?<<\/TOOLCALL>>/gi, '')
    .replace(/<tool_call>\s*[\s\S]*?<\/tool_call>/gi, '')
    .trim();
}
