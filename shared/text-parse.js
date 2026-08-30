// shared/text-parse.js
// 模型输出解析的纯函数集合。
//
// 原先这些函数定义在 service-worker.js 内部，导致两个问题：
// 1) service-worker.js 在模块顶层注册 chrome.* 监听器，Node 下无法 import，纯函数无法单测；
// 2) 它们是弱模型容错逻辑最容易回归的地方（格式一变就漏翻/漏解析），没有测试兜底很危险。
// 抽到这里后既可被后台复用，也可在 test/ 下直接 import 做回归测试。

// ── 翻译结果解析 ──────────────────────────────────────────────────────────

/**
 * 解析模型返回的 [N]…[/N] 分段译文。
 *
 * 兜底策略：弱模型常完全不遵守标记格式 → 正则一个都匹配不到，整批报废。
 * 此时若输出行数与段数大致相当，按行顺序对齐回填，至少把整批救回来
 * （宁可偶尔错位，也不整批丢失）。仅当标记几乎完全缺失（filled===0）时启用，
 * 避免干扰正常遵守格式的强模型。
 *
 * @param {string} text 模型原始输出
 * @param {number} count 输入段数
 * @returns {(string|undefined)[]} 长度 count 的数组；未解析到的位置为 undefined
 */
export function parseTranslateResponse(text, count) {
  const map = new Array(count).fill(undefined);
  const re = /\[(\d+)\]([\s\S]*?)\[\/\1\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const idx = Number(m[1]);
    if (idx >= 0 && idx < count && !map[idx]) { // 防止重复覆盖
      map[idx] = m[2];
    }
  }
  const filled = map.filter(v => v !== undefined).length;
  if (filled === 0 && count > 1) {
    const lines = (text || '').split(/\r?\n/).map(l => l.trim());
    const real = [];
    for (const l of lines) {
      const cleaned = l.replace(/^\[\d+\]\s*/, '').replace(/\[\/\d+\]\s*$/, '').trim();
      if (cleaned) real.push(cleaned);
    }
    if (real.length >= Math.ceil(count * 0.8) && real.length <= Math.ceil(count * 1.5)) {
      for (let i = 0; i < count && i < real.length; i++) map[i] = real[i];
      return map;
    }
  }
  if (filled < count) {
    console.warn(`Translation parsing: only ${filled}/${count} segments parsed`);
  }
  return map;
}

/**
 * 统计流式输出里已完整闭合的 [N]…[/N] 单元数。
 *
 * 提示词要求模型按 0,1,2… 顺序输出带标记分段，故从 0 起顺序统计"已闭合"的单元数，
 * 即可在流式翻译过程中做"句子单元级"进度插值（慢模型在整批返回前也能持续推进），
 * 而不是长时间卡在 0%。
 *
 * @param {string} raw 已累积的输出
 * @param {number} [fromIdx=0] 从哪个序号开始统计（配合增量调用，避免每次从头搜）
 * @returns {number}
 */
export function countClosedUnits(raw, fromIdx = 0) {
  if (!raw) return 0;
  let count = fromIdx, idx = fromIdx, pos = 0;
  while (true) {
    const open = raw.indexOf('[' + idx + ']', pos);
    if (open === -1) break;
    const close = raw.indexOf('[/' + idx + ']', open);
    if (close === -1) break;
    count++;
    idx++;
    pos = close + 1; // 从上一处闭合之后继续搜索，避免每次都从 0 扫
  }
  return count;
}

// ── 字幕整理（refine）解析 ────────────────────────────────────────────────

/**
 * 容错解析 refine 输出：兼容 <o>/<t> 标签、"原文：/译文："、以及"两行"兜底。
 * 解析不出译文时 translation 留空（内容脚本回退显示原文），
 * 绝不放原语言文本冒充译文。
 *
 * @param {string} out 模型输出
 * @param {string} raw 原始 ASR 碎片（完全解析失败时作为 original 兜底）
 * @returns {{original: string, translation: string}}
 */
export function parseRefine(out, raw) {
  let s = (out || '').trim();
  // 去掉可能的 markdown 代码围栏
  s = s.replace(/^```[\s\S]*?\n?/i, '').replace(/```\s*$/i, '').trim();
  const om = s.match(/<o>([\s\S]*?)<\/o>/i);
  const tm = s.match(/<t>([\s\S]*?)<\/t>/i);
  let original = om && om[1].trim() ? om[1].trim() : '';
  let translation = tm && tm[1].trim() ? tm[1].trim() : '';
  if (!original || !translation) {
    const o2 = s.match(/原文[:：]\s*([\s\S]*?)(?=\s*译文[:：])/i);
    const t2 = s.match(/译文[:：]\s*([\s\S]*)$/i);
    if (!original && o2 && o2[1].trim()) original = o2[1].trim();
    if (!translation && t2 && t2[1].trim()) translation = t2[1].trim();
  }
  // 有 <o> 但漏写 <t>：把 </o> 之后的内容（去掉可能夹带的 <t> 标签）当作译文
  if (original && !translation && om) {
    const after = s.slice(om.index + om[0].length).replace(/^<\/?t>/i, '').trim();
    if (after) translation = after;
  }
  // 两行兜底：必须先定 original，再挑译文。
  // 顺序反了会踩坑——original 还是空串时 `lines.find(l => l !== original)` 命中首行，
  // 于是译文被填成原文，正是"绝不用原文冒充译文"要防的情况。
  const lines = s.split(/\n+/).map(l => l.trim()).filter(Boolean);
  if (!original && lines.length >= 2) original = lines[0];
  if (!translation && lines.length >= 2) {
    const cand = lines.find(l => l !== original);
    if (cand) translation = cand;
  }
  if (!original) original = raw;   // 完全解析失败：保留原始识别文本，至少能显示
  return { original, translation };
}

// ── Whisper 幻觉剔除 ──────────────────────────────────────────────────────

// Whisper 在静音 / 纯背景音 / 音乐片段上的常见"幻觉"固定语（多语种）。
// 这些短语在无实质语音时被模型凭空吐出（如日语视频里出现"ご視聴ありがとうございました"、
// 中文"感谢观看"等）。归一化后（去空白/标点、转小写）用于整片匹配剔除。
export const HALLUCINATION_NORM = [
  // 日语
  'ご視聴ありがとうございました', 'ご視聴ありがとうございます', 'ご清聴ありがとうございました',
  '最後までご視聴いただきありがとうございます', 'チャンネル登録お願いします',
  'チャンネル登録高評価よろしくお願いします', 'おやすみなさい',
  // 中文
  '感谢观看', '谢谢观看', '谢谢大家观看', '感謝觀看', '謝謝觀看', '請不吝點贊訂閱轉發打賞',
  '请不吝点赞订阅转发打赏支持明镜与点点栏目', '请点赞订阅', '字幕由amaraorg社区提供',
  '明镜与点点栏目', '字幕志愿者', '下集见', '未完待续',
  // 英语
  'thankyouforwatching', 'thanksforwatching', 'pleasesubscribe',
  'subscribetomychannel', 'seeyounexttime', 'thanksforwatchingdontforgettosubscribe',
];

/**
 * 归一化字幕文本：去除空白与常见标点、转小写（保留中日文字符）。
 * @param {string} text
 * @returns {string}
 */
export function normalizeCaption(text) {
  return (text || '').toLowerCase()
    .replace(/[\s。、，,\.!！?？…・~〜「」『』"'“”‘’()（）\-—:：;；]/g, '');
}

/**
 * 若整片转写内容"基本只是"一条幻觉固定语，则判为幻觉并剔除（返回空串）。
 * 只在整片高度匹配时剔除，避免误伤正常语音中偶含这些词。
 *
 * @param {string} text
 * @returns {string} 原文或 ''
 */
export function stripHallucination(text) {
  const t = (text || '').trim();
  if (!t) return '';
  const norm = normalizeCaption(t);
  if (!norm) return '';
  for (const p of HALLUCINATION_NORM) {
    if (norm === p) return '';
    // 整片长度与短语相当（片段几乎只有这句话）→ 视为幻觉
    if (norm.length <= p.length + 4 && norm.includes(p)) return '';
  }
  return t;
}
