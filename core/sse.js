// core/sse.js
// 共享的流式响应行读取器：TextDecoder 增量解码 + 按行切分 + SSE 数据行归一化。
// 四个 adapter 的流式读取循环原先是四份逐行复制粘贴，这里收敛为单一实现：
// - reader 在 finally 中 cancel：消费方提前退出（用户点停止/上层生成器 return）时
//   立刻断开 HTTP 连接，不再让模型把剩余 token 全部生成完（省 token、让 MV3 SW 尽早空闲）。
// - 服务端末帧不带换行时残帧不再被丢弃（旧实现 lines.pop() 后 buf 直接丢弃）。
// - 跳过 SSE 的注释行与 event:/id:/retry: 字段行，只让数据行到达 adapter。

/**
 * 逐行产出流式响应的原始行（不含行尾换行符）。
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<string, void, undefined>}
 */
export async function* streamLines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) yield line;
    }
    buf += decoder.decode();
    if (buf) yield buf;
  } finally {
    // 生成器被提前 return/throw 时 finally 仍会执行，此处必须 cancel 才能断开底层连接
    try { await reader.cancel(); } catch (_) { /* 流已结束或连接已断，忽略 */ }
  }
}

/**
 * 把一行 SSE 文本归一化为数据载荷：
 * - 空行 / 注释（`:...`）/ event: / id: / retry: 字段行 → null
 * - `data: xxx` → xxx
 * - 无前缀的裸 JSON 行（Ollama 的 NDJSON 风格）→ 原样返回
 * @param {string} line
 * @returns {string|null}
 */
export function sseData(line) {
  const t = line.trim();
  if (!t) return null;
  if (t.startsWith(':') || /^(event|id|retry):/i.test(t)) return null;
  if (t.startsWith('data:')) {
    const d = t.slice(5).trim();
    return d || null;
  }
  return t;
}
