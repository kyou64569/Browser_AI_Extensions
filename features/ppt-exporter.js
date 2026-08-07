// features/ppt-exporter.js
// PPT 导出：结构化大纲 JSON → .pptx 文件
//
// 零依赖实现：内嵌最小 ZIP 写入器 + OOXML 生成。
// outline 格式：
//   {
//     title: "报告标题",
//     slides: [
//       { heading: "页标题", bullets: ["要点1", "要点2"] }
//     ]
//   }

// 媒体扩展名 → Content-Type（解析上传模板时，为其 media 补 Default 声明）
const MEDIA_CONTENT_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', emf: 'image/x-emf', wmf: 'image/x-wmf',
  tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp', webp: 'image/webp',
};

// ── 最小 ZIP 读取器（用于解析上传的 .pptx 模板） ────────────────────────────
// 仅支持 store(0) 与 deflate(8)，无 ZIP64。读取使用浏览器/Node 原生 DecompressionStream。
class ZipReader {
  constructor(buf) {
    this.buf = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.dv = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
  }
  findEocd() {
    const n = this.buf.length;
    const maxBack = Math.min(n, 22 + 65535);
    const start = Math.max(0, n - maxBack);
    for (let i = n - 22; i >= start; i--) {
      if (this.dv.getUint32(i, true) === 0x06054b50) return i;
    }
    throw new Error('无法定位 ZIP 结尾记录（EOCD）');
  }
  list() {
    const eocd = this.findEocd();
    const cdOffset = this.dv.getUint32(eocd + 16, true);
    const cdCount = this.dv.getUint16(eocd + 10, true);
    const files = [];
    let p = cdOffset;
    for (let i = 0; i < cdCount; i++) {
      if (this.dv.getUint32(p, true) !== 0x02014b50) break;
      const method = this.dv.getUint16(p + 10, true);
      const compSize = this.dv.getUint32(p + 20, true);
      const uncompSize = this.dv.getUint32(p + 24, true);
      const nameLen = this.dv.getUint16(p + 28, true);
      const extraLen = this.dv.getUint16(p + 30, true);
      const commentLen = this.dv.getUint16(p + 32, true);
      const localOffset = this.dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(new Uint8Array(this.buf.slice(p + 46, p + 46 + nameLen)));
      files.push({ name, method, compSize, uncompSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }
  async read(file) {
    const p = file.localOffset;
    const nameLen = this.dv.getUint16(p + 26, true);
    const extraLen = this.dv.getUint16(p + 28, true);
    const dataStart = p + 30 + nameLen + extraLen;
    const comp = new Uint8Array(this.buf.slice(dataStart, dataStart + file.compSize));
    if (file.method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      writer.write(comp);
      writer.close();
      const ab = await new Response(ds.readable).arrayBuffer();
      return new Uint8Array(ab);
    }
    return comp;
  }
}

function normalizePath(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function parseRels(relsXml) {
  const rels = [];
  const re = /<Relationship\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(relsXml))) {
    const a = m[1];
    const idM = /Id="([^"]+)"/.exec(a);
    const typeM = /Type="([^"]+)"/.exec(a);
    const targetM = /Target="([^"]+)"/.exec(a);
    if (idM && typeM && targetM) rels.push({ id: idM[1], type: typeM[1], target: targetM[1] });
  }
  return rels;
}

function parseLayoutPhs(layoutXml) {
  const phs = [];
  const re = /<p:ph\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(layoutXml))) {
    const a = m[1];
    const typeM = /type="([^"]+)"/.exec(a);
    const idxM = /idx="([^"]+)"/.exec(a);
    phs.push({ type: typeM ? typeM[1] : null, idx: idxM ? idxM[1] : null });
  }
  // 同时解析 title/body 占位符的几何（位置与尺寸），用于判断正文框是否过小
  const boxOf = (phType) => {
    const spRe = /<p:sp>([\s\S]*?)<\/p:sp>/g;
    let s;
    while ((s = spRe.exec(layoutXml))) {
      const blk = s[1];
      const ph = /<p:ph\b([^>]*)\/?>/.exec(blk);
      if (!ph) continue;
      const t = /type="([^"]+)"/.exec(ph[1]);
      if (t && t[1] === phType) {
        const xf = /<a:xfrm>([\s\S]*?)<\/a:xfrm>/.exec(blk);
        if (!xf) return null;
        const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(xf[1]);
        const ext = /<a:ext cx="(-?\d+)" cy="(-?\d+)"\/>/.exec(xf[1]);
        return {
          x: off ? +off[1] : 0, y: off ? +off[2] : 0,
          cx: ext ? +ext[1] : 0, cy: ext ? +ext[2] : 0,
        };
      }
    }
    return null;
  };
  const title = phs.find(p => p.type === 'title' || p.type === 'ctrTitle') || phs[0] || { type: 'title', idx: null };
  // 正文占位符：优先明确的 body/subTitle；否则取第一个"非标题/非页眉页脚"的文本占位符。
  // 注意：很多模板的内容版式其正文 <p:ph> 不带 type 属性（仅含 idx），此时不能回退到
  // phs[1]（那往往是 dt/ftr 页眉页脚），而应识别"除标题外的文本占位符"。
  const textPhs = phs.filter(p => !/^(title|ctrTitle|dt|ftr|sldNum|sldImg|chart|pic|clipArt|media|tbl|web|grpSp|graph)$/.test(p.type || ''));
  const body = phs.find(p => p.type === 'body') || phs.find(p => p.type === 'subTitle') || textPhs.find(p => p !== title) || { type: 'body', idx: '1' };
  title.box = boxOf(title.type);
  body.box = boxOf(body.type);
  return { title, body };
}

/**
 * 给模板【全部版式】做语义角色分类——这是「对任意模板都稳健复用」的核心。
 *
 * 分类依据：版式的 type 属性 + 中文 layoutName + 占位符集合(标题/正文)。
 * 关键约束：
 *  - 内容版式(content) 必须是「同时具备标题 + 正文文本(body)占位符」且
 *    【不是】节/分区/封底/仅标题/空白/图片独占 的版式。这彻底避免旧逻辑把
 *    「节标题(secHead)」误当成内容版式，进而被替换成带封面背景的合成版式。
 *  - 封面/章节/目录/封底各自独立成桶，路由时按桶精确匹配。
 */
/**
 * 判断某个占位符是否为「可承载正文文本」的占位符。
 * 排除：标题/页眉页脚/副标题/图表/图片/表格等。
 * 关键：很多模板的内容版式其 <p:ph> 不带 type 属性（仅含 idx，type=null），
 * 它【仍是正文占位符】，必须算作可承载正文。只有 type=subTitle（封面副标题）等才算非正文。
 */
function isTextBodyPh(ph) {
  if (!ph) return false;
  const t = ph.type || '';
  return !/^(title|ctrTitle|dt|ftr|sldNum|sldImg|chart|pic|clipArt|media|tbl|web|graph|subTitle)$/.test(t);
}

// 与 isTextBodyPh 类似，但【包含 subTitle / 无 type 的占位符】——即「任何可承载文本」的占位符。
// 用于安全网：只要版式存在「标题之外、能放文字」的占位符（含封面副标题 subTitle），就足以承载正文/标语，不必回退。
function isTextHolderPh(ph) {
  if (!ph) return false;
  const t = ph.type || '';
  return !/^(dt|ftr|sldNum|sldImg|chart|pic|clipArt|media|tbl|web|graph)$/.test(t);
}

function classifyLayouts(layouts) {
  const lower = (s) => (s || '').toLowerCase();
  const hasTitle = (l) => { const t = l.phs && l.phs.title; return !!t && (t.type === 'title' || t.type === 'ctrTitle'); };
  // 正文版式的关键：存在「可承载正文」的占位符（标题/副标题/页眉页脚均不算）。
  const hasRealBody = (l) => isTextBodyPh(l.phs && l.phs.body);
  const isType = (l, re) => re.test(lower(l.type));
  const isName = (l, re) => re.test(lower(l.layoutName || ''));

  // 封面：优先 type=title；否则「有标题但无真实正文」（通常只有标题+副标题）；否则首个有标题的版式。
  const cover = layouts.find(l => isType(l, /^title$/))
    || layouts.find(l => hasTitle(l) && !hasRealBody(l))
    || layouts.find(l => hasTitle(l))
    || layouts[0] || null;

  const closing = layouts.filter(l =>
    isType(l, /titleonly|blank/) || isName(l, /封底|感谢|致谢|结尾|联系|thank|closing|end/));
  const section = layouts.filter(l =>
    isType(l, /sechead|section|divider|chapter|part/) || isName(l, /节|章节|分区|部分/));
  const toc = layouts.filter(l =>
    isType(l, /table|toc|contents|agenda/) || isName(l, /目录|议程|大纲/));
  // 内容版式：标题 + 真实正文占位符，且【不是】分区/节/封底/仅标题/空白/图片独占/封面。
  // 排除封面（即使封面恰好有标题+副标题，也会被 hasRealBody 过滤；再加显式 l!==cover 双保险）。
  const content = layouts.filter(l =>
    l !== cover
    && hasTitle(l) && hasRealBody(l)
    && !isType(l, /sechead|section|divider|titleonly|blank|pic|chart|table|media|sldimg|clipart/)
    && !isName(l, /节|章节|分区|部分|封底|感谢|致谢|封面/));

  return {
    cover,
    closing, section, toc, content,
    all: layouts,
    // 内容兜底：第一个真·内容版式；否则第一个「标题+正文」版式（排除封面）；都没有则 null（由导出分支合成中性版式）。
    defaultContent: content[0] || layouts.find(l => hasTitle(l) && hasRealBody(l) && l !== cover) || null,
  };
}

/** 向后兼容：返回 { cover, content }（content 退化为 defaultContent） */
function pickLayouts(layouts) {
  const r = classifyLayouts(layouts || []);
  return { cover: r.cover, content: r.defaultContent };
}

function parsePalette(themeXml) {
  const scheme = /<a:clrScheme[^>]*>([\s\S]*?)<\/a:clrScheme>/.exec(themeXml);
  if (!scheme) return null;
  const pick = (tag) => {
    const m = new RegExp(`<a:${tag}>\\s*<a:(?:srgbClr|sysClr)[^>]*?(?:val|lastClr)="([^"]+)"`).exec(scheme[1]);
    return m ? m[1] : null;
  };
  return { dk1: pick('dk1'), lt1: pick('lt1'), accent1: pick('accent1') };
}

function parseSldSz(presentationXml) {
  const m = /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"[^>]*?(?:type="([^"]+)")?/.exec(presentationXml);
  if (m) return { cx: +m[1], cy: +m[2], type: m[3] || 'screen4x3' };
  return null;
}

/**
 * 解析上传的 .pptx 模板，提取可复用的母版部件与占位符定义。
 * @param {Uint8Array|ArrayBuffer} buffer 整个 pptx 文件字节
 * @returns {Promise<{theme,master,layout,masterRels,layoutRels,media,mediaExts,layoutPhs,palette,sldSz}>}
 */
export async function parseTemplate(buffer) {
  const reader = new ZipReader(buffer);
  const files = reader.list();
  const findFile = (name) =>
    files.find(f => f.name === name) ||
    files.find(f => f.name === 'ppt/' + name.replace(/^\/?ppt\//, ''));
  const readStr = async (name) => {
    const f = findFile(name);
    return f ? new TextDecoder().decode(await reader.read(f)) : null;
  };

  const themeFile = files.find(f => /^ppt\/theme\/theme\d+\.xml$/.test(f.name));
  const masterFile = files.find(f => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(f.name));
  const presFile = files.find(f => f.name === 'ppt/presentation.xml');
  if (!themeFile || !masterFile) {
    throw new Error('模板缺少必要的 theme/master 部件，无法套用');
  }

  const theme = await readStr(themeFile.name);
  const master = await readStr(masterFile.name);
  const presentation = presFile ? await readStr(presFile.name) : null;

  const masterRelsName = masterFile.name.replace(/\.xml$/, '.xml.rels').replace('ppt/slideMasters/', 'ppt/slideMasters/_rels/');
  const themeRelsName = themeFile.name.replace(/\.xml$/, '.xml.rels').replace('ppt/theme/', 'ppt/theme/_rels/');
  const masterRels = await readStr(masterRelsName);
  const themeRels = await readStr(themeRelsName);

  // 解析模板里【全部】 slideLayout（封面 / 内容 / 节 等），而非只取第一个。
  // 每个版式记录：编号 num、类型 type、名称 layoutName、占位符 phs、XML 与 .rels。
  const layoutFiles = files
    .filter(f => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(f.name))
    .map(f => {
      const m = /slideLayout(\d+)\.xml$/.exec(f.name);
      return { num: m ? +m[1] : 0, name: f.name };
    })
    .sort((a, b) => a.num - b.num);
  if (!layoutFiles.length) {
    throw new Error('模板缺少 slideLayout 版式，无法套用');
  }

  const layouts = [];
  for (const lf of layoutFiles) {
    const xml = await readStr(lf.name);
    const relsName = lf.name.replace(/\.xml$/, '.xml.rels').replace('ppt/slideLayouts/', 'ppt/slideLayouts/_rels/');
    const rels = await readStr(relsName);
    const typeM = /<p:sldLayout\b([^>]*)>/.exec(xml);
    const typeAttr = typeM ? (/\btype="([^"]+)"/.exec(typeM[1]) || [])[1] || null : null;
    const nameM = /<p:cSld\b([^>]*?)\s+name="([^"]+)"/.exec(xml);
    layouts.push({
      num: lf.num, name: lf.name, type: typeAttr, layoutName: nameM ? nameM[2] : null,
      phs: parseLayoutPhs(xml), xml, rels,
    });
  }

  const { cover, content } = pickLayouts(layouts);

  const media = {};
  const mediaExts = new Set();
  // relationship target 是相对于 source part 所在目录，而不是 .rels 文件所在目录
  const collectMedia = async (relsXml, sourcePartDir) => {
    if (!relsXml) return;
    for (const rel of parseRels(relsXml)) {
      if (!/\.(png|jpe?g|gif|svg|emf|wmf|tiff?|bmp|webp)$/i.test(rel.target) && !/image/i.test(rel.type)) continue;
      const resolved = normalizePath(sourcePartDir + rel.target);
      const f = findFile(resolved);
      if (f && !media[f.name]) {
        media[f.name] = await reader.read(f);
        const ext = (f.name.split('.').pop() || '').toLowerCase();
        if (ext) mediaExts.add(ext);
      }
    }
  };
  await collectMedia(masterRels, masterFile.name.replace(/[^/]+$/, ''));
  for (const l of layouts) {
    if (l.rels) await collectMedia(l.rels, l.name.replace(/[^/]+$/, ''));
  }
  await collectMedia(themeRels, themeFile.name.replace(/[^/]+$/, ''));

  // 兜底：扫描归档内所有部件，凡 media 类扩展名一律纳入，避免关系解析遗漏
  for (const f of files) {
    if (!/\.(png|jpe?g|gif|svg|emf|wmf|tiff?|bmp|webp)$/i.test(f.name)) continue;
    if (!media[f.name]) media[f.name] = await reader.read(f);
  }

  return {
    theme, master, masterRels, themeRels,
    media, mediaExts: [...mediaExts],
    layouts, cover, content,
    // 向后兼容：仍暴露封面版式作为默认 layout
    layout: cover ? cover.xml : null,
    layoutRels: cover ? cover.rels : null,
    layoutPhs: cover ? cover.phs : { title: { type: 'title', idx: null }, body: { type: 'body', idx: '1' } },
    palette: parsePalette(theme),
    sldSz: presentation ? parseSldSz(presentation) : null,
  };
}

class Crc32 {
  static table = null;
  static init() {
    if (this.table) return;
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    this.table = t;
  }
  static compute(buf) {
    this.init();
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      crc = this.table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
}

class ZipWriter {
  constructor() {
    this.files = [];
    this.chunks = [];
    this.offset = 0;
  }

  addFile(name, data) {
    if (typeof data === 'string') data = new TextEncoder().encode(data);
    const crc = Crc32.compute(data);
    const nameBytes = new TextEncoder().encode(name);
    const localHeader = new Uint8Array(30);
    const dv = new DataView(localHeader.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);

    const localOffset = this.offset;
    this.chunks.push(localHeader, nameBytes, data);
    this.offset += 30 + nameBytes.length + data.length;

    this.files.push({ name, nameBytes, data, crc, localOffset });
  }

  finish() {
    const centralDirOffset = this.offset;
    let centralDirSize = 0;
    const centralParts = [];

    for (const f of this.files) {
      const hdr = new Uint8Array(46);
      const dv = new DataView(hdr.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 20, true);
      dv.setUint16(8, 0, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0, true);
      dv.setUint16(14, 0, true);
      dv.setUint32(16, f.crc, true);
      dv.setUint32(20, f.data.length, true);
      dv.setUint32(24, f.data.length, true);
      dv.setUint16(28, f.nameBytes.length, true);
      dv.setUint16(30, 0, true);
      dv.setUint16(32, 0, true);
      dv.setUint16(34, 0, true);
      dv.setUint16(36, 0, true);
      dv.setUint32(38, 0, true);
      dv.setUint32(42, f.localOffset, true);

      const entry = new Uint8Array(46 + f.nameBytes.length);
      entry.set(hdr, 0);
      entry.set(f.nameBytes, 46);
      centralParts.push(entry);
      centralDirSize += entry.length;
    }

    const endRecord = new Uint8Array(22);
    const ev = new DataView(endRecord.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, this.files.length, true);
    ev.setUint16(10, this.files.length, true);
    ev.setUint32(12, centralDirSize, true);
    ev.setUint32(16, centralDirOffset, true);
    ev.setUint16(20, 0, true);

    const allParts = [...this.chunks, ...centralParts, endRecord];
    let totalSize = 0;
    for (const p of allParts) totalSize += p.length;

    const result = new Uint8Array(totalSize);
    let off = 0;
    for (const p of allParts) {
      result.set(p, off);
      off += p.length;
    }
    return result;
  }
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function escXml(s) {
  return String(s ?? '').replace(/[<>&"']/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c])
  );
}

/**
 * PPT 模板主题表
 * 每个主题定义：背景（纯色/渐变）、标题色、正文色、强调色、顶部装饰条。
 * id 同时作为 export(outline, { template }) 的参数值，以及 UI 选择器的 key。
 */
export const THEMES = {
  'classic-blue': {
    label: '商务蓝',
    bg: { kind: 'gradient', from: '1F3864', to: '2E5496' },
    titleColor: 'FFFFFF', bodyColor: 'EDF2FB', accentColor: '9DC3E6',
    bar: true, barColor: '9DC3E6',
  },
  'dark-night': {
    label: '暗夜黑',
    bg: { kind: 'solid', color: '16161F' },
    titleColor: 'FF5C7A', bodyColor: 'E8E8F0', accentColor: 'FF5C7A',
    bar: true, barColor: 'FF5C7A',
  },
  'vibrant-orange': {
    label: '活力橙',
    bg: { kind: 'gradient', from: 'FF7E5F', to: 'FEB47B' },
    titleColor: 'FFFFFF', bodyColor: 'FFF3E6', accentColor: 'FF6B35',
    bar: true, barColor: 'FF6B35',
  },
  'fresh-green': {
    label: '清新绿',
    bg: { kind: 'solid', color: 'F3FBF6' },
    titleColor: '1E7B4F', bodyColor: '2C3A33', accentColor: '27AE60',
    bar: true, barColor: '27AE60',
  },
  'minimal-white': {
    label: '极简白',
    bg: { kind: 'solid', color: 'FFFFFF' },
    titleColor: '1A1A1A', bodyColor: '444444', accentColor: '1A1A1A',
    bar: false,
  },
  'dream-purple': {
    label: '梦幻紫',
    bg: { kind: 'gradient', from: '6A11CB', to: '2575FC' },
    titleColor: 'FFFFFF', bodyColor: 'EFEAFF', accentColor: 'C9A8FF',
    bar: true, barColor: 'C9A8FF',
  },
};

/** 供 UI 使用的主题精简列表 */
export const PPT_THEMES = Object.entries(THEMES).map(([id, t]) => ({ id, label: t.label }));

/** 解析模板 id → 主题对象（缺省回退商务蓝） */
function resolveTheme(template) {
  return THEMES[template] || THEMES['classic-blue'];
}

/** 幻灯片背景 XML（纯色或渐变） */
function buildBgXml(theme) {
  if (theme.bg.kind === 'gradient') {
    return `<p:bg><p:bgPr><a:gradFill><a:gsLst>` +
      `<a:gs pos="0"><a:srgbClr val="${theme.bg.from}"/></a:gs>` +
      `<a:gs pos="100000"><a:srgbClr val="${theme.bg.to}"/></a:gs>` +
      `</a:gsLst><a:lin ang="5400000" scaled="1"/></a:gradFill><a:effectLst/></p:bgPr></p:bg>`;
  }
  return `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${theme.bg.color}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
}

/** 顶部装饰条形状（位于标题上方，不遮挡正文） */
function buildAccentShape(theme) {
  const color = theme.barColor || theme.accentColor;
  return `<p:sp>
    <p:nvSpPr><p:cNvPr id="10" name="装饰条"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
    <p:spPr>
      <a:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="158400"/></a:xfrm>
      <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      <a:solidFill><a:srgbClr val="${color}"/></a:solidFill>
    </p:spPr>
    <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody>
  </p:sp>`;
}

function buildContentTypes(slideCount) {
  const overrides = [
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`,
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>`,
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`,
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
  ];
  for (let i = 1; i <= slideCount; i++) {
    overrides.push(`<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
  }
  return `${XML_DECL}\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${overrides.join('\n  ')}
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

/**
 * 自定义模板模式：根据【实际使用的版式集合】重写母版，避免出现悬空版式引用。
 * - 母版 .rels：保留 theme / image 关系，并为每个使用到的版式补一条 layout 关系（指向其原始 target）。
 * - 母版 XML 的 sldLayoutIdLst：重写为仅引用这些版式（新 rId）。
 * @param {string} masterXml 模板母版 XML
 * @param {string} masterRelsXml 模板母版 .rels
 * @param {Array<{num:number,name:string}>} usedLayouts 实际使用的版式（含 num）
 * @returns {{master:string, masterRels:string}}
 */
function rebuildMasterForLayouts(masterXml, masterRelsXml, usedLayouts) {
  const originalRels = masterRelsXml ? parseRels(masterRelsXml) : [];
  // 非版式关系（theme / image 等）原样保留
  const kept = originalRels.filter(r => !/slideLayout$/i.test(r.type));

  // 为每个使用的版式定位原始 rel；找不到则按命名推断 target
  const layoutRels = usedLayouts.map(u => {
    const found = originalRels.find(r =>
      /slideLayout$/i.test(r.type) &&
      normalizePath(r.target.startsWith('/') ? r.target : 'ppt/slideLayouts/' + r.target).endsWith('slideLayout' + u.num + '.xml')
    );
    return found
      ? { ...found }
      : { id: null, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout', target: `../slideLayouts/slideLayout${u.num}.xml` };
  });

  // 计算不冲突的新 rId：在现有最大数字 id 之上递增
  const nums = kept.map(r => { const m = /(\d+)/.exec(r.id || ''); return m ? +m[1] : 0; });
  let next = (nums.length ? Math.max(...nums) : 0) + 1;
  layoutRels.forEach(r => { r.id = 'rId' + (next++); });

  const allRels = [...kept, ...layoutRels];
  const relsXml = `${XML_DECL}\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n` +
    allRels.map(r => `  <Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join('\n') +
    `\n</Relationships>`;

  const layoutIdEntries = usedLayouts.map((u, k) =>
    `<p:sldLayoutId id="${2147483649 + k}" r:id="${layoutRels[k].id}"/>`).join('');
  const newLst = `<p:sldLayoutIdLst>${layoutIdEntries}</p:sldLayoutIdLst>`;

  let newMaster = masterXml;
  if (/<p:sldLayoutIdLst[\s\S]*?<\/p:sldLayoutIdLst>/.test(masterXml)) {
    newMaster = masterXml.replace(/<p:sldLayoutIdLst[\s\S]*?<\/p:sldLayoutIdLst>/, newLst);
  } else {
    newMaster = masterXml.replace(/<\/p:sldMaster>/, newLst + '</p:sldMaster>');
  }
  return { master: newMaster, masterRels: relsXml };
}

/** 幻灯片 .rels：指向所使用的具体版式 */
function buildSlideRelsFor(layoutNum) {
  return `${XML_DECL}\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout${layoutNum}.xml"/>
</Relationships>`;
}

/** 自定义模板模式下生成 [Content_Types]，为模板引用的 media 与各所用版式补声明 */
function buildContentTypesForCustom(slideCount, mediaExts, layoutNums) {
  const usedLayouts = (layoutNums && layoutNums.length) ? layoutNums : [1];
  const overrides = [
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`,
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>`,
    ...usedLayouts.map(n => `<Override PartName="/ppt/slideLayouts/slideLayout${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`),
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
  ];
  for (let i = 1; i <= slideCount; i++) {
    overrides.push(`<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
  }
  const defaults = [
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
    `<Default Extension="xml" ContentType="application/xml"/>`,
  ];
  for (const ext of (mediaExts || [])) {
    const ct = MEDIA_CONTENT_TYPES[ext] || 'application/octet-stream';
    defaults.push(`<Default Extension="${ext}" ContentType="${ct}"/>`);
  }
  return `${XML_DECL}\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  ${defaults.join('\n  ')}
  ${overrides.join('\n  ')}
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

function buildRels() {
  return `${XML_DECL}\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function buildPresentationRels(slideCount) {
  const items = [];
  items.push(`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>`);
  items.push(`<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`);
  for (let i = 1; i <= slideCount; i++) {
    items.push(`<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i}.xml"/>`);
  }
  return `${XML_DECL}\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${items.join('\n  ')}
</Relationships>`;
}

function buildPresentation(slideCount, sldSz) {
  const sz = sldSz && sldSz.cx ? sldSz : { cx: 9144000, cy: 6858000, type: 'screen4x3' };
  const sldIds = [];
  for (let i = 1; i <= slideCount; i++) {
    sldIds.push(`<p:sldId id="${255 + i + 1}" r:id="rId${i + 2}"/>`);
  }
  return `${XML_DECL}
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>${sldIds.join('')}</p:sldIdLst>
  <p:sldSz cx="${sz.cx}" cy="${sz.cy}" type="${sz.type}"/>
  <p:notesSz cx="6858000" cy="9144000"/>
  <p:defaultTextStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr></p:defaultTextStyle>
</p:presentation>`;
}

function buildSlideRels() {
  return `${XML_DECL}\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`;
}

function buildSlide(slide, theme, opts = {}) {
  const heading = escXml(slide.heading || '');
  const bullets = slide.bullets || [];
  const t = theme || THEMES['classic-blue'];

  // 自定义模板模式：slide 仅放占位符内容，视觉（背景/配色/字体/位置）全部继承母版，
  // 不写 spPr 几何与显式颜色，让 PowerPoint 按 layout 的占位符渲染。
  if (opts.useMaster) {
    const titlePh = opts.titlePh || { type: 'title', idx: null };
    const bodyPh = opts.bodyPh || { type: 'body', idx: '1' };
    const titlePhAttr = (titlePh.type ? ` type="${titlePh.type}"` : '') + (titlePh.idx != null ? ` idx="${titlePh.idx}"` : '');
    const bodyPhAttr = (bodyPh.type ? ` type="${bodyPh.type}"` : '') + (bodyPh.idx != null ? ` idx="${bodyPh.idx}"` : '');

    const bulletParaXml = bullets.length
      ? bullets.map(b => `<a:p>
      <a:pPr><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/></a:pPr>
      <a:r><a:rPr lang="zh-CN"/><a:t>${escXml(b)}</a:t></a:r>
      <a:endParaRPr lang="zh-CN"/>
    </a:p>`).join('\n')
      : '<a:p><a:endParaRPr lang="zh-CN"/></a:p>';

    return `${XML_DECL}
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm>
      </p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="标题"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph${titlePhAttr}/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          <a:p><a:r><a:rPr lang="zh-CN"/><a:t>${heading}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="内容"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph${bodyPhAttr}/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          ${bulletParaXml}
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
  }

  const bulletParaXml = bullets.length
    ? bullets.map(b => {
        const text = escXml(b);
        return `<a:p>
      <a:pPr marL="360000" indent="-360000"><a:buFont typeface="Arial" panose="020B0604020202020204" pitchFamily="34" charset="0"/><a:buChar char="&#8226;"/><a:buClr><a:srgbClr val="${t.accentColor}"/></a:buClr></a:pPr>
      <a:r><a:rPr lang="zh-CN" sz="1800" dirty="0"><a:solidFill><a:srgbClr val="${t.bodyColor}"/></a:solidFill></a:rPr><a:t>${text}</a:t></a:r>
      <a:endParaRPr lang="zh-CN"/>
    </a:p>`;
      }).join('\n')
    : '<a:p><a:endParaRPr lang="zh-CN"/></a:p>';

  const bgXml = buildBgXml(t);
  const accentXml = t.bar ? buildAccentShape(t) : '';

  return `${XML_DECL}
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    ${bgXml}
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm>
      </p:grpSpPr>
      ${accentXml}
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="标题 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1600200"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          <a:p>
            <a:r><a:rPr lang="zh-CN" sz="3200" b="1"><a:solidFill><a:srgbClr val="${t.titleColor}"/></a:solidFill></a:rPr><a:t>${heading}</a:t></a:r>
          </a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="内容 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="457200" y="2286000"/><a:ext cx="8229600" cy="3810000"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          ${bulletParaXml}
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function buildSlideMaster() {
  return `${XML_DECL}
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm>
      </p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`;
}

function buildSlideMasterRels() {
  return `${XML_DECL}\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;
}

function buildTheme() {
  return `${XML_DECL}
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">
  <a:themeElements>
    <a:clrScheme name="Office">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="1F497D"/></a:dk2>
      <a:lt2><a:srgbClr val="EEECE1"/></a:lt2>
      <a:accent1><a:srgbClr val="4F81BD"/></a:accent1>
      <a:accent2><a:srgbClr val="C0504D"/></a:accent2>
      <a:accent3><a:srgbClr val="9BBB59"/></a:accent3>
      <a:accent4><a:srgbClr val="8064A2"/></a:accent4>
      <a:accent5><a:srgbClr val="4BACC6"/></a:accent5>
      <a:accent6><a:srgbClr val="F79646"/></a:accent6>
      <a:hlink><a:srgbClr val="0000FF"/></a:hlink>
      <a:folHlink><a:srgbClr val="800080"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Office">
      <a:majorFont>
        <a:latin typeface="Calibri Light" panose="020F0302020204030204"/>
        <a:ea typeface="Microsoft YaHei"/>
        <a:cs typeface=""/>
      </a:majorFont>
      <a:minorFont>
        <a:latin typeface="Calibri" panose="020F0502020204030204"/>
        <a:ea typeface="Microsoft YaHei"/>
        <a:cs typeface=""/>
      </a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Office">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:gradFill rotWithShape="1">
          <a:gsLst>
            <a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/><a:satMod val="300000"/></a:schemeClr></a:gs>
            <a:gs pos="35000"><a:schemeClr val="phClr"><a:tint val="37000"/><a:satMod val="300000"/></a:schemeClr></a:gs>
            <a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="15000"/><a:satMod val="350000"/></a:schemeClr></a:gs>
          </a:gsLst>
          <a:lin ang="16200000" scaled="1"/>
        </a:gradFill>
        <a:noFill/>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"><a:shade val="95000"/><a:satMod val="105000"/></a:schemeClr></a:solidFill><a:prstDash val="solid"/></a:ln>
        <a:ln w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
        <a:ln w="38100" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst><a:outerShd blurRad="40000" dist="20000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="38000"/></a:srgbClr></a:outerShd></a:effectLst></a:effectStyle>
      </a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill>
        <a:gradFill rotWithShape="1">
          <a:gsLst>
            <a:gs pos="0"><a:schemeClr val="phClr"><a:shade val="94000"/><a:satMod val="205000"/></a:schemeClr></a:gs>
            <a:gs pos="50000"><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="205000"/></a:schemeClr></a:gs>
            <a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="25000"/><a:satMod val="205000"/></a:schemeClr></a:gs>
          </a:gsLst>
          <a:path path="circle"><a:fillToRect l="50000" t="-80000" r="50000" b="180000"/></a:path>
        </a:gradFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`;
}

function buildSlideLayout() {
  return `${XML_DECL}
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="title" preserve="1">
  <p:cSld name="标题和内容">
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm>
      </p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="标题占位符 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1600200"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/>
        </p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="内容占位符 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="457200" y="2286000"/><a:ext cx="8229600" cy="3810000"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/>
        </p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;
}

function buildSlideLayoutRels() {
  return `${XML_DECL}\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;
}

/**
 * 干净的"标题 + 内容"版式（无背景图，使用主题 bg1 纯色背景）。
 * 当自定义模板缺乏真正的正文版式（只有封面/分区版式，或正文框过小）时，
 * 内容页改用此版式，从而与封面（含背景图）在视觉上区分开。
 */
function buildCleanContentLayout() {
  return `${XML_DECL}
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="titleAndContent" preserve="1">
  <p:cSld>
    <p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm>
      </p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="标题占位符 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="457200" y="365125"/><a:ext cx="8229600" cy="1454052"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/>
        </p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="内容占位符 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="457200" y="2032000"/><a:ext cx="8229600" cy="3835375"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/>
        </p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;
}

/** 判断版式是否不适合作为正文版式（分区/节标题，或正文框过小） */
function isUnsuitableContentLayout(layout) {
  if (!layout) return true;
  const type = (layout.type || '').toLowerCase();
  if (/sechead|section|divider|blank/.test(type)) return true;
  // 正文占位符框高小于 ~1.5 英寸（~1371600 EMU）视为过小
  const phs = layout.phs || {};
  const body = phs.body;
  if (body && body.box && body.box.cy && body.box.cy < 1371600) return true;
  return false;
}

/** 从封面版式 XML 取出背景图片形状（含 <a:blip> 的 <p:pic>），用于在内容版式里复用同一背景 */
function extractBgPics(coverXml) {
  if (!coverXml) return '';
  const spTree = /<p:spTree>([\s\S]*?)<\/p:spTree>/.exec(coverXml);
  if (!spTree) return '';
  const out = [];
  const re = /<p:pic>[\s\S]*?<\/p:pic>/g;
  let m;
  while ((m = re.exec(spTree[1]))) {
    if (/<a:blip\b/.test(m[0])) out.push(m[0]);
  }
  // 避免与内容版式内 title(id=2)/body(id=3) 占位符的 cNvPr id 冲突
  return out.map(p => p.replace(/<p:cNvPr id="\d+"/, '<p:cNvPr id="100"')).join('\n');
}

/**
 * 构建「套用模板外观」的干净内容版式：沿用封面背景图 + 干净标题/正文占位符几何。
 * 这样内容页视觉上属于同一模板家族，而不是纯白（且不触发修复弹窗，只要 [Content_Types] 声明了图片扩展名）。
 */
function buildSkinnedContentLayout(bgPics, palette) {
  const titleColor = (palette && palette.lt1) ? palette.lt1 : 'FFFFFF';
  return `${XML_DECL}
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="titleAndContent" preserve="1">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm>
      </p:grpSpPr>
      ${bgPics}
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="标题占位符 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="457200" y="365125"/><a:ext cx="8229600" cy="1454052"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/>
        </p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:rPr><a:t>占位标题</a:t></a:r><a:endParaRPr lang="zh-CN"/></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="内容占位符 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="457200" y="2032000"/><a:ext cx="8229600" cy="3835375"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/>
        </p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;
}

/** 内容版式 .rels：母版(rId1) + 背景图（沿用封面 pic 的 r:embed id，从封面 rels 取 target） */
function buildSkinnedContentLayoutRels(coverRelsXml, embeds) {
  const items = [`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>`];
  if (coverRelsXml && embeds && embeds.length) {
    const rels = parseRels(coverRelsXml);
    for (const e of embeds) {
      const r = rels.find(x => x.id === e);
      if (r) items.push(`<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`);
    }
  }
  return `${XML_DECL}\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n  ${items.join('\n  ')}\n</Relationships>`;
}

/**
 * 为某一页选择使用的版式。
 * 优先尊重 slide.layout 显式指定（'cover'/'content'/版式索引/版式名），
 * 否则默认：第一页用封面版式，其余用内容版式。
 */
// 把语义标签精确映射到模板里最匹配的版式（agent 规划路径）
// idx 为 classifyLayouts() 的分类结果；不足时回退到内容/封面版式。
function matchLayoutBySemantic(want, idx, layouts) {
  const w = String(want).toLowerCase().trim();
  const { cover, closing, section, toc, content, defaultContent } = idx;
  if (w === 'cover' || w === 'title') return cover;
  if (w === 'content' || w === 'body' || w === 'object') return content[0] || defaultContent;
  if (w === 'section' || w === 'divider' || w === 'chapter' || w === 'part')
    return section[0] || (content[0] || defaultContent);
  if (w === 'toc' || w === 'contents' || w === 'agenda')
    return toc[0] || (content[0] || defaultContent);
  if (w === 'closing' || w === 'thank' || w === 'end' || w === 'contact')
    return closing[0] || (content[0] || defaultContent);
  // 数字：既支持 0-based 数组下标，也支持 1-based 版式编号
  if (/^\d+$/.test(w)) {
    const n = +w;
    if (layouts[n - 1]) return layouts[n - 1];
    if (layouts[n]) return layouts[n];
  }
  const byName = layouts.find(l => (l.layoutName || '').toLowerCase() === w || (l.type || '').toLowerCase() === w);
  if (byName) return byName;
  return null;
}

// 无显式 layout 时，按页面内容语义从分类版式中自动选最合适的（规划大脑 / 兜底）
function autoPickLayout(slide, index, idx, layouts) {
  const { cover, closing, section, toc, content, defaultContent } = idx;
  if (index === 0) return cover;
  const heading = (slide.heading || '').toLowerCase();
  const bullets = slide.bullets || [];
  // 结尾 / 致谢页
  if (/谢谢|感谢|thank|联系我们|contact|q\s*&?\s*a|封底|结尾/.test(heading)) {
    if (closing[0]) return closing[0];
  }
  // 章节 / 分区页（仅当标题显含章节语义时才路由到节版式；
  // 不再用「要点极少」兜底，否则普通内容页(仅 1 个要点)会被误判成节标题版式）
  if (/第\s*[\d一二三四五六七八九十百千零]+\s*章|章节|section\s*\d*|part\s*\d*|模块\s*\d*|^part\b|^chapter\b/i.test(heading)) {
    if (section[0]) return section[0];
  }
  // 目录 / 议程页
  if (/目录|contents|content\s*list|agenda|大纲|议程/.test(heading)) {
    if (toc[0]) return toc[0];
  }
  // 默认：内容版式
  return content[0] || defaultContent;
}

function chooseLayout(slide, index, idx, layouts) {
  const want = slide && slide.layout;
  if (want != null) {
    const m = matchLayoutBySemantic(want, idx, layouts);
    if (m) return m;
  }
  return autoPickLayout(slide, index, idx, layouts);
}

function buildCoreProps(title) {
  const now = new Date().toISOString();
  return `${XML_DECL}
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escXml(title || '演示文稿')}</dc:title>
  <dc:creator>AI 助手</dc:creator>
  <cp:lastModifiedBy>AI 助手</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function buildAppProps(slideCount) {
  return `${XML_DECL}
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>AI 助手</Application>
  <PresentationFormat>宽屏</PresentationFormat>
  <Slides>${slideCount}</Slides>
  <ScaleCrop>false</ScaleCrop>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
  <AppVersion>16.0000</AppVersion>
</Properties>`;
}

/**
 * PPT 导出器
 */
export class PptExporter {
  /**
   * @param {object} outline { title: string, slides: [{ heading, bullets: string[] }] }
   * @returns {Promise<Blob>} pptx 文件 Blob
   */
  async export(outline, opts = {}) {
    const slides = outline.slides?.length ? outline.slides : [{ heading: outline.title || '演示文稿', bullets: [] }];
    const slideCount = slides.length;
    const zip = new ZipWriter();

    // 自定义模板模式：完整复用上传模板的母版/版式/主题，并按内容自动匹配版式
    if (opts.custom) {
      const c = opts.custom;
      const layouts = (c.layouts && c.layouts.length) ? c.layouts : (c.cover ? [c.cover] : []);
      // 核心：对模板全部版式做角色分类（封面/章节/目录/内容/封底），
      // 内容页只从"同时具备标题+正文占位符、且非分区/节"的真实版式中选取，
      // 杜绝旧逻辑把"节标题"误当内容版式、再被替换成带封面背景的合成版式。
      const idx = classifyLayouts(layouts);
      const cover = idx.cover;

      // 仅当模板【完全没有任何内容版式】时，才合成一个中性"标题+内容"兜底版式
      // （不强行刷封面背景，避免内容页看起来像封面）；其余一律复用模板真实版式。
      let synthesized = null;
      if (!idx.content.length) {
        synthesized = {
          num: 9001, name: 'ppt/slideLayouts/slideLayout9001.xml',
          type: 'titleAndContent', layoutName: '标题和内容',
          phs: parseLayoutPhs(buildCleanContentLayout()),
          xml: buildCleanContentLayout(),
          rels: buildSlideLayoutRels(),
        };
      }
      const contentFallback = idx.content[0] || synthesized || layouts.find(l => isTextBodyPh(l.phs && l.phs.body)) || cover;

      // 为每页选定版式（按语义角色路由，缺失则回退），并收集实际用到的版式（去重）
      const perSlide = [];
      const usedMap = new Map();
      for (let i = 0; i < slideCount; i++) {
        let L = chooseLayout(slides[i], i, idx, layouts) || contentFallback;
        // 安全网：内容页若选中的版式缺少正文文本占位符，回退到内容/合成版式，避免正文丢失
        if (slides[i].bullets && slides[i].bullets.length && (!L.phs || !isTextHolderPh(L.phs.body))) {
          L = contentFallback;
        }
        perSlide.push(L);
        if (L && !usedMap.has(L.num)) usedMap.set(L.num, L);
      }
      if (synthesized) usedMap.set(synthesized.num, synthesized);
      const used = [...usedMap.values()].sort((a, b) => a.num - b.num);
      const usedNums = used.map(u => u.num);

      // 始终按【实际写入的媒体】推导扩展名，避免依赖可能过期的存储元数据
      // （历史上曾因 c.mediaExts 落后导致 [Content_Types] 漏声明 png/jpg，触发 PowerPoint 修复弹窗）。
      const mediaExts = c.media && Object.keys(c.media).length
        ? [...new Set(Object.keys(c.media).map(n => (n.split('.').pop() || '').toLowerCase()).filter(Boolean))]
        : (c.mediaExts && c.mediaExts.length ? c.mediaExts : []);
      zip.addFile('[Content_Types].xml', buildContentTypesForCustom(slideCount, mediaExts, usedNums));
      zip.addFile('_rels/.rels', buildRels());
      zip.addFile('ppt/_rels/presentation.xml.rels', buildPresentationRels(slideCount));
      zip.addFile('ppt/presentation.xml', buildPresentation(slideCount, c.sldSz));

      // 母版：仅引用实际用到的版式，重写 sldLayoutIdLst 与 masterRels，避免悬空引用
      const masterOut = rebuildMasterForLayouts(c.master, c.masterRels, used);
      zip.addFile('ppt/slideMasters/slideMaster1.xml', masterOut.master);
      if (masterOut.masterRels) zip.addFile('ppt/slideMasters/_rels/slideMaster1.xml.rels', masterOut.masterRels);

      // 主题与媒体原样写入
      zip.addFile('ppt/theme/theme1.xml', c.theme);
      if (c.themeRels) zip.addFile('ppt/theme/_rels/theme1.xml.rels', c.themeRels);
      if (c.media) {
        for (const [name, bytes] of Object.entries(c.media)) {
          zip.addFile(name, bytes);
        }
      }

      // 写入实际用到的版式及其 .rels
      for (const u of used) {
        zip.addFile(`ppt/slideLayouts/slideLayout${u.num}.xml`, u.xml);
        if (u.rels) zip.addFile(`ppt/slideLayouts/_rels/slideLayout${u.num}.xml.rels`, u.rels);
      }

      // 每页指向各自版式，并使用该版式的占位符定义
      for (let i = 0; i < slideCount; i++) {
        const L = perSlide[i];
        const titlePh = (L && L.phs && L.phs.title) || { type: 'title', idx: null };
        const bodyPh = (L && L.phs && L.phs.body) || { type: 'body', idx: '1' };
        zip.addFile(`ppt/slides/slide${i + 1}.xml`, buildSlide(slides[i], null, { useMaster: true, titlePh, bodyPh }));
        zip.addFile(`ppt/slides/_rels/slide${i + 1}.xml.rels`, buildSlideRelsFor(L ? L.num : 1));
      }
      zip.addFile('docProps/core.xml', buildCoreProps(outline.title));
      zip.addFile('docProps/app.xml', buildAppProps(slideCount));
      const data = zip.finish();
      return new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
    }

    const theme = resolveTheme(opts.template);
    zip.addFile('[Content_Types].xml', buildContentTypes(slideCount));
    zip.addFile('_rels/.rels', buildRels());
    zip.addFile('ppt/_rels/presentation.xml.rels', buildPresentationRels(slideCount));
    zip.addFile('ppt/presentation.xml', buildPresentation(slideCount));
    zip.addFile('ppt/slideMasters/slideMaster1.xml', buildSlideMaster());
    zip.addFile('ppt/slideMasters/_rels/slideMaster1.xml.rels', buildSlideMasterRels());
    zip.addFile('ppt/slideLayouts/slideLayout1.xml', buildSlideLayout());
    zip.addFile('ppt/slideLayouts/_rels/slideLayout1.xml.rels', buildSlideLayoutRels());
    zip.addFile('ppt/theme/theme1.xml', buildTheme());

    for (let i = 0; i < slideCount; i++) {
      zip.addFile(`ppt/slides/slide${i + 1}.xml`, buildSlide(slides[i], theme));
      zip.addFile(`ppt/slides/_rels/slide${i + 1}.xml.rels`, buildSlideRels());
    }

    zip.addFile('docProps/core.xml', buildCoreProps(outline.title));
    zip.addFile('docProps/app.xml', buildAppProps(slideCount));

    const data = zip.finish();
    return new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
  }
}

/**
 * 便捷函数：文本/Markdown 大纲 → PPT
 * 解析简单 Markdown 结构为 outline JSON
 * @param {string} markdown
 * @returns {Promise<Blob>}
 */
export async function exportMarkdownToPpt(markdown) {
  const outline = parseMarkdownOutline(markdown);
  const exporter = new PptExporter();
  return exporter.export(outline);
}

/**
 * 解析简单 Markdown 为 outline JSON
 * 支持：# 标题 → 新幻灯片，- 或 * → 要点
 */
export function parseMarkdownOutline(markdown) {
  const lines = (markdown || '').split('\n');
  const slides = [];
  let current = null;
  const orphans = []; // 无 # 标题上下文时的普通文本行，用于兜底聚合成页

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('#')) {
      if (current) slides.push(current);
      let text = trimmed.replace(/^#+\s*/, '');
      let layout = null;
      const lm = /\s*@layout=([\w-]+)\s*$/.exec(text);
      if (lm) { layout = lm[1]; text = text.slice(0, lm.index); }
      current = { heading: text.trim(), bullets: [], layout };
      orphans.length = 0; // 出现新标题，丢弃前面游离的普通文本
    } else if ((trimmed.startsWith('- ') || trimmed.startsWith('* ')) && current) {
      current.bullets.push(trimmed.replace(/^[-*]\s*/, ''));
    } else if (current) {
      current.bullets.push(trimmed);
    } else {
      orphans.push(trimmed);
    }
  }
  if (current) slides.push(current);

  // 兜底：完全没有 # 标题（如普通总结/要点散文）时，按段落聚合成多页幻灯片
  if (!slides.length && orphans.length) {
    const CHUNK = 5; // 每页约 5 行
    for (let i = 0; i < orphans.length; i += CHUNK) {
      const chunk = orphans.slice(i, i + CHUNK);
      const heading = chunk[0].length <= 24 ? chunk[0] : chunk[0].slice(0, 24) + '…';
      slides.push({ heading, bullets: chunk.slice(1) });
    }
  }

  if (!slides.length) {
    slides.push({ heading: '演示文稿', bullets: ['无内容'] });
  }

  return { title: slides[0]?.heading || '演示文稿', slides };
}
