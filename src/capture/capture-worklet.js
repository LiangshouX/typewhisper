/**
 * AudioWorklet 处理器：把麦克风音频攒成 4096 采样一块往外抛。
 * 放在音频线程上跑，不受主线程卡顿影响。
 */
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(4096);
    this._offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this._buffer[this._offset++] = channel[i];
      if (this._offset === this._buffer.length) {
        // slice 复制一份，避免下一轮写入污染已发送的数据
        this.port.postMessage(this._buffer.slice(0));
        this._offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-processor', PcmProcessor);
