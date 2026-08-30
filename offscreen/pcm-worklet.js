// offscreen/pcm-worklet.js
// AudioWorklet 处理器：在 worklet 线程（独立于主线程的音频渲染线程）里抓取 PCM。
//
// 替代对象：offscreen/subtitle-offscreen.js 里已废弃的 ScriptProcessorNode。
// 为什么值得换：
//   1) ScriptProcessorNode 在主线程跑音频回调，长任务（编码/传输）会卡音频 → 掉音；
//      AudioWorklet 的 process() 在专用线程执行，主线程被阻塞也不影响采集。
//   2) ScriptProcessorNode 已被 Web Audio 规范废弃，浏览器未来可能移除。
//
// 数据流：process() 每 128 帧被调用一次 → 降采样到 TARGET_RATE(16kHz，Whisper 原生采样率)
// → 在 worklet 内累积到 CHUNK 大小后经 node.port.postMessage 一次性回传主线程
// （约每 128ms 一条消息，不会高频刷主线程）。

// AudioWorkletGlobalScope 自带 sampleRate（当前 AudioContext 的采样率）
const TARGET_RATE = 16000;              // 与 subtitle-offscreen.js 保持一致
const DECIMATE = Math.max(1, Math.floor(sampleRate / TARGET_RATE));
const CHUNK = 2048;                     // 回传块大小（16kHz 下 ≈128ms）

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** 降采样后的累积缓冲 */
    this._buf = new Float32Array(CHUNK);
    this._len = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true; // 无输入：保持存活等待下一帧
    // 降采样：与原实现一致，每 DECIMATE 个样本取 1 个（ch[0], ch[DECIMATE], ...）
    for (let i = 0; i < ch.length; i += DECIMATE) {
      this._buf[this._len++] = ch[i];
      if (this._len >= CHUNK) {
        this.port.postMessage(this._buf.slice(0, CHUNK)); // 拷贝发送，避免引用同一缓冲
        this._len = 0;
      }
    }
    return true; // 保持处理器活跃
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
