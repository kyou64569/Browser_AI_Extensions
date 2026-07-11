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
- 工具调用格式并不唯一：你可以用 \`\`\`toolcall 代码块，也可以直接写 toolcall{...}、toolcall[...]、tool_call{...} 等形式，只要其中是合法的 JSON（含 name 与 args）即可被系统识别执行。你也可以用中文“调用工具：name”的形式（name 须为上方列出的工具名），同样会被系统识别。
- 系统会在每次工具执行后，把当前页面的截图作为图片一并反馈给你。若目标数据以图表、示意图、图片等形式呈现（而非纯文本），请直接读取截图内容来提取数据。
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

/** 从 openIdx（s[openIdx] === '{'）开始做括号匹配，返回匹配的右花括号下标；失败返回 -1 */
function matchBrace(s, openIdx) {
  let depth = 0, inStr = false, esc = false;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** 尝试把 JSON 字符串解析为 {name, args}；非法或缺少 name 则返回 null */
function tryParseCall(jsonStr) {
  if (!jsonStr) return null;
  try {
    const obj = JSON.parse(jsonStr);
    if (obj && typeof obj.name === 'string') {
      return { name: obj.name, args: (obj.args && typeof obj.args === 'object') ? obj.args : {} };
    }
  } catch (_) { /* 非法 JSON 忽略 */ }
  return null;
}

/**
 * 从 AI 回复文本中解析全部工具调用（含起止下标），无则空数组。
 * 识别格式：```toolcall 代码块 / <<TOOLCALL>> / <tool_call> / 裸 toolcall{...} / toolcall[...] /
 * tool_call{...} / function_call{...} / 中文「调用/使用/执行 工具：name」(name 须为已知工具) /
 * 以及兜底的任何含 name 的 JSON 对象。
 */
function extractCalls(text) {
  const calls = [];
  const seen = new Set();
  const push = (c, start, end) => {
    const norm = JSON.stringify({ name: c.name, args: c.args });
    if (seen.has(norm)) return;
    seen.add(norm);
    calls.push({ name: c.name, args: c.args, _start: start, _end: end });
  };
  if (!text) return calls;

  // 1) 代码块 / 标签 / XML 形式
  let m;
  RE_BLOCK.lastIndex = 0;
  while ((m = RE_BLOCK.exec(text)) !== null) {
    const json = (m[1] || m[2] || m[3] || '').trim();
    const c = tryParseCall(json);
    if (c) push(c, m.index, RE_BLOCK.lastIndex);
  }

  // 2) 关键字形式：toolcall / tool_call / function_call（后可跟可选的 : = 或 [ 再接 {）
  const KW = /(tool_?call|function_?call)\b\s*(\[)?/gi;
  let km;
  KW.lastIndex = 0;
  while ((km = KW.exec(text)) !== null) {
    let i = km.index + km[0].length;
    while (i < text.length && (/\s/.test(text[i]) || text[i] === ':' || text[i] === '=')) i++;
    if (text[i] !== '{') continue;
    const end = matchBrace(text, i);
    if (end === -1) continue;
    const c = tryParseCall(text.slice(i, end + 1));
    if (c) {
      let close = end + 1;
      while (close < text.length && /\s/.test(text[close])) close++;
      if (text[close] === ']') close++; // 吃掉 toolcall[ ... ] 外层的右括号
      push(c, km.index, close);
    }
  }

  // 2.5) 中文「调用/使用/执行 工具」格式（防御性兜底）：模型偶尔用中文工具调用
  // （如“调用工具：screenshot”或“使用工具 click”），若不被识别会在终止分支被误判为最终回答、
  // 导致像 SenseNova 那样提前结束。仅当名称命中已知工具清单才视为有效调用，以降低普通中文
  // 说明文字误触发的概率。
  const CN = /(?:调用|使用|执行)\s*工具\s*[:：]?\s*([A-Za-z_][\w-]*)/gi;
  let cn;
  CN.lastIndex = 0;
  while ((cn = CN.exec(text)) !== null) {
    const name = cn[1];
    let scan = cn.index + cn[0].length;
    while (scan < text.length && /\s/.test(text[scan])) scan++;
    let args = {};
    // 默认结束点：名称之后（不吞掉后续空格/文字，保证 stripToolCall 不会误删正文）。
    // 注意：中文格式的名称在 JSON 外部，故参数 JSON 不含 name 字段，不能复用 tryParseCall
    // （它要求 JSON 内必须有 name），而应当把整段 JSON 直接当作 args 解析。
    let end = cn.index + cn[0].length;
    if (text[scan] === '{') {
      const e = matchBrace(text, scan);
      if (e !== -1) {
        try {
          const o = JSON.parse(text.slice(scan, e + 1));
          if (o && typeof o === 'object' && !Array.isArray(o)) args = o;
        } catch (_) { /* 非法 JSON 忽略，按无参数处理 */ }
        end = e + 1;
      }
    }
    if (TOOLS.some(t => t.name === name)) push({ name, args }, cn.index, end);
  }

  // 3) 兜底：整段中任何含 name 的 JSON 对象（仅在前两步无果时启用，避免误伤普通文本）
  if (calls.length === 0) {
    let i = 0;
    while (i < text.length) {
      if (text[i] === '{') {
        const end = matchBrace(text, i);
        if (end === -1) { i++; continue; }
        const c = tryParseCall(text.slice(i, end + 1));
        if (c) push(c, i, end + 1);
        i = end + 1;
      } else i++;
    }
  }
  return calls;
}

/** 从 AI 回复文本中解析全部工具调用（支持一次回复包含多个），无则空数组 */
export function parseToolCalls(text) {
  return extractCalls(text).map(c => ({ name: c.name, args: c.args }));
}

/** 兼容旧调用：解析出第一个工具调用（无则 null） */
export function parseToolCall(text) {
  const all = parseToolCalls(text);
  return all.length ? all[0] : null;
}

/** 去掉 AI 回复中的工具调用块（用于最终展示，避免向用户暴露原始 JSON） */
export function stripToolCall(text) {
  if (!text) return text;
  const calls = extractCalls(text);
  if (!calls.length) {
    return text
      .replace(/```toolcall\s*\n[\s\S]*?```/gi, '')
      .replace(/<<TOOLCALL>>\s*[\s\S]*?<<\/TOOLCALL>>/gi, '')
      .replace(/<tool_call>\s*[\s\S]*?<\/tool_call>/gi, '')
      .replace(/<\/?toolcall>/gi, '')
      .replace(/\n{3,}/g, '\n\n').trim();
  }
  // 按 _start 降序移除每个调用区间（含其可能带的关键字 / 括号）
  const spans = calls.map(c => [c._start, c._end]).sort((a, b) => b[0] - a[0]);
  let s = text;
  for (const [a, b] of spans) s = s.slice(0, a) + s.slice(b);
  return s.replace(/<\/?toolcall>/gi, '').replace(/\n{3,}/g, '\n\n').trim();
}
