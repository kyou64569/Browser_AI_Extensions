// shared/code-highlight.js
// 聊天回复代码块的轻量处理：围栏代码块提取 + 轻量语法高亮。
// 零依赖、纯函数、不碰 DOM —— 可直接在 Node 下单测（test/code-highlight.test.mjs）。
//
// 设计取舍：不引入 marked / highlight.js（项目坚持零运行时依赖，且扩展体积敏感），
// 只覆盖 AI 回复里最高频的诉求：
//   1) extractCodeBlocks(text) —— 从回复文本里按 ``` 围栏切出「文本段 / 代码段」；
//      流式输出未写完的未闭合围栏也按代码段处理。
//   2) highlightCode(code, lang) —— 把代码转成带 token class 的 HTML。
//      仅五类 token：注释 / 字符串 / 数字 / 关键字 / 函数调用，配色交给 CSS 变量。
//
// 安全：所有代码内容先 HTML 转义再包 span，杜绝注入；调用方不要再对返回值二次转义。

/** HTML 转义（高亮器自用版本，不依赖 DOM） */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 语言别名 -> 内部语言标识 */
const ALIASES = {
  js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
  ts: 'js', typescript: 'js', tsx: 'js',
  py: 'python', python: 'python',
  sh: 'bash', shell: 'bash', bash: 'bash', zsh: 'bash', console: 'bash', terminal: 'bash',
  json: 'json',
  html: 'html', xml: 'html', svg: 'html', vue: 'html',
  css: 'css', scss: 'css', less: 'css',
  sql: 'sql',
  java: 'clike', c: 'clike', cpp: 'clike', 'c++': 'clike', cs: 'clike', 'c#': 'clike',
  go: 'clike', rust: 'clike', swift: 'clike', kotlin: 'clike', dart: 'clike', php: 'clike',
  yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml',
};

/**
 * 归一化语言标识。未知语言返回 'plain'（仍做字符串/注释/数字的通用高亮）。
 * @param {string} lang
 * @returns {string}
 */
export function normalizeLang(lang) {
  return ALIASES[String(lang || '').toLowerCase().trim()] || 'plain';
}

const KEYWORDS = {
  js: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
    'class', 'extends', 'super', 'new', 'this', 'import', 'export', 'from', 'default', 'async', 'await', 'yield',
    'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'delete', 'void', 'static', 'get', 'set',
    'null', 'undefined', 'true', 'false'],
  python: ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'import', 'from', 'as',
    'with', 'try', 'except', 'finally', 'raise', 'lambda', 'yield', 'global', 'nonlocal', 'pass', 'del', 'assert',
    'in', 'is', 'not', 'and', 'or', 'async', 'await', 'self', 'None', 'True', 'False'],
  bash: ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'return', 'exit',
    'export', 'local', 'source', 'alias', 'set', 'unset', 'in', 'echo', 'cd', 'sudo', 'git', 'npm', 'curl'],
  json: ['true', 'false', 'null'],
  css: ['media', 'import', 'keyframes', 'supports', 'from', 'to', 'and', 'or', 'not', 'only', 'screen', 'important'],
  sql: ['select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table', 'drop',
    'alter', 'add', 'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'by', 'order', 'having', 'limit', 'offset',
    'as', 'and', 'or', 'not', 'null', 'primary', 'key', 'foreign', 'references', 'index', 'distinct', 'union', 'all',
    'case', 'when', 'then', 'else', 'end'],
  clike: ['public', 'private', 'protected', 'class', 'void', 'int', 'char', 'bool', 'boolean', 'float', 'double', 'long',
    'short', 'new', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'struct', 'enum',
    'namespace', 'using', 'template', 'typename', 'this', 'null', 'nullptr', 'true', 'false', 'const', 'static', 'final',
    'import', 'package', 'func', 'var', 'let', 'go', 'defer', 'type', 'map', 'string', 'interface', 'impl', 'fn', 'match'],
  yaml: ['true', 'false', 'null', 'yes', 'no', 'on', 'off'],
  plain: ['function', 'return', 'if', 'else', 'for', 'while', 'import', 'export', 'class', 'new', 'const', 'let', 'var',
    'def', 'print', 'echo', 'public', 'private', 'static', 'void', 'int', 'string', 'true', 'false', 'null'],
};

/**
 * 按语言构造主匹配正则。
 * 每个分组在加入时即登记自己的 token 类别（分组数量随语言不同：
 * js 有块/行两种注释 + 模板串共 7 组，python 只有 5 组），
 * 这样匹配结果的下标与类别一一对应，不会因分组顺序调整而错位。
 * @param {string} L 内部语言标识
 * @returns {{re: RegExp, classes: string[]}} classes[i] 对应第 i+1 个分组
 */
function buildMatcher(L) {
  const parts = [];
  const classes = [];
  const add = (pattern, cls) => { parts.push('(' + pattern + ')'); classes.push(cls); };

  // 1) 注释
  if (L === 'html') add('<!--[\\s\\S]*?-->', 'tok-com');
  else if (L === 'js' || L === 'clike' || L === 'css') add('/\\*[\\s\\S]*?\\*/', 'tok-com');
  if (L === 'js' || L === 'clike' || L === 'css') add('//[^\\n]*', 'tok-com');
  if (L === 'python' || L === 'bash' || L === 'yaml') add('#[^\\n]*', 'tok-com');
  if (L === 'sql') add('--[^\\n]*', 'tok-com');
  if (L === 'plain') { add('//[^\\n]*', 'tok-com'); add('#[^\\n]*', 'tok-com'); }

  // 2) 字符串：单/双引号（不跨行）；js/bash 另支持可跨行的反引号模板串
  add('\'(?:\\\\.|[^\'\\\\\\n])*\'|"(?:\\\\.|[^"\\\\\\n])*"', 'tok-str');
  if (L === 'js' || L === 'bash') add('`(?:\\\\.|[^\\\\`])*`', 'tok-str');

  // 3) 数字
  add('\\b\\d+(?:\\.\\d+)?\\b', 'tok-num');

  // 4) 关键字 / 5) 函数调用（html 用标签名替代这两类）。
  // 关键字必须排在函数调用之前：同一位置两者都能命中时（如 if( ），关键字优先。
  if (L === 'html') {
    add('</?[A-Za-z][\\w.-]*', 'tok-kw');
  } else {
    const kws = KEYWORDS[L] || KEYWORDS.plain;
    add('\\b(?:' + kws.join('|') + ')\\b', 'tok-kw');
    add('(?<![\\w$])[A-Za-z_$][\\w$]*(?=\\s*\\()', 'tok-fn');
  }

  return { re: new RegExp(parts.join('|'), 'g'), classes };
}

/**
 * 对一段代码做轻量高亮，返回 HTML 片段（内容已转义）。
 * 未识别的语言按 plain 处理（字符串/注释/数字仍可高亮）。
 * @param {string} code
 * @param {string} [lang] 围栏标注的语言，如 ```python
 * @returns {string}
 */
export function highlightCode(code, lang = '') {
  if (typeof code !== 'string' || !code) return '';
  const { re, classes } = buildMatcher(normalizeLang(lang));
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(code))) {
    if (m[0].length === 0) { re.lastIndex++; continue; } // 防御空匹配死循环
    if (m.index > last) out += esc(code.slice(last, m.index));
    let cls = null;
    for (let i = 0; i < classes.length; i++) {
      if (m[i + 1] !== undefined) { cls = classes[i]; break; }
    }
    out += cls ? `<span class="${cls}">${esc(m[0])}</span>` : esc(m[0]);
    last = m.index + m[0].length;
  }
  out += esc(code.slice(last));
  return out;
}

/**
 * 把 markdown 文本按 ``` 围栏切分为段。
 * @param {string} text
 * @returns {Array<{type:'text', content:string} | {type:'code', content:string, lang:string}>}
 *   未闭合围栏的剩余内容按代码段返回（流式输出中途常见）。
 */
export function extractCodeBlocks(text) {
  if (typeof text !== 'string' || !text) {
    return [{ type: 'text', content: typeof text === 'string' ? text : '' }];
  }
  const segs = [];
  let buf = [];
  let inCode = false;
  let fenceChar = '`';
  let fenceLen = 3;
  let lang = '';
  for (const line of text.split('\n')) {
    if (!inCode) {
      const m = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/);
      if (m) {
        if (buf.length) segs.push({ type: 'text', content: buf.join('\n') });
        buf = [];
        inCode = true;
        fenceChar = m[1][0];
        fenceLen = m[1].length;
        lang = (m[2] || '').trim().split(/\s+/)[0] || '';
        continue;
      }
      buf.push(line);
    } else {
      const t = line.trim();
      // 闭合围栏：必须是「同一字符重复 fenceLen 次以上」的纯围栏行。
      // 旧正则 /^[`~]{3,}$/ 允许 ` 和 ~ 混用（如 ```~~~），会被 CommonJS 规范外的
      // 畸形围栏意外闭合；用反向引用锁定单一字符。
      if (t.length >= fenceLen && new RegExp(`^\\${fenceChar}{${fenceLen},}$`).test(t)) {
        segs.push({ type: 'code', content: buf.join('\n'), lang });
        buf = [];
        inCode = false;
        lang = '';
        continue;
      }
      buf.push(line);
    }
  }
  if (inCode) segs.push({ type: 'code', content: buf.join('\n'), lang });
  else if (buf.length) segs.push({ type: 'text', content: buf.join('\n') });
  return segs;
}
