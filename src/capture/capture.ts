/**
 * 录音采集窗口（隐藏窗口）。
 *
 * 职责：
 *   1. 提前把 AudioContext 与 AudioWorklet 建好（**不碰麦克风**）；
 *   2. 收到「开始」时才去开麦克风，收��「停止」时立刻释放；
 *   3. 把 PCM 源源不断传给主进程。
 *
 * 为什么要这样：麦克风一开就是亮的，隐私指示灯会一直亮着。
 * 微信的做法是「按下才开、松开就关」，我们照做 ——
 * 但**音频图先建好**，所以按下到能录音之间只剩「打开设备」这一步。
 */

import type { CaptureCommand, CaptureEvent } from '../shared/capture-protocol.js';

declare global {
  interface Window {
    capture: {
      onCommand(cb: (command: CaptureCommand) => void): void;
      send(event: CaptureEvent): void;
    };
  }
}

const TARGET_RATE = 16_000;

/** 音频图（与麦克风无关，可以提前建好）。 */
let context: AudioContext | null = null;
let worklet: AudioWorkletNode | null = null;
let sink: GainNode | null = null;
/** 当前麦克风流；null 表示没开。 */
let stream: MediaStream | null = null;
let source: MediaStreamAudioSourceNode | null = null;
/** 当前是否在采集 */
let recording = false;
/** 麦克风打开失败时的原因 */
let micError: string | null = null;

const audioOptions: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  sampleRate: TARGET_RATE,
};

/** 把 AudioContext 与 worklet 建好 —— 这一步不碰麦克风。 */
async function setupGraph(): Promise<void> {
  if (context) return;

  // 先建上下文（不接麦克风）。浏览器允许在还没有用户手势时创建，
  // 只是处于 suspended 状态，按下快捷键时 resume 一下即可。
  context = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: 'interactive' });
  await context.audioWorklet.addModule('./capture-worklet.js');

  worklet = new AudioWorkletNode(context, 'pcm-processor');
  worklet.port.onmessage = (event: MessageEvent) => {
    if (!recording) return;
    const chunk = event.data as Float32Array;
    const copy = chunk.buffer.slice(0) as ArrayBuffer;
    window.capture.send({ type: 'audio', pcm: copy });
  };

  // 接到 destination 才会被拉动；用静音增益节点接收。
  sink = context.createGain();
  sink.gain.value = 0;
  worklet.connect(sink);
  sink.connect(context.destination);
}

/** 打开麦克风。设备可能刚被释放，第一次会慢一点。 */
async function acquireMic(): Promise<void> {
  if (stream) return;
  const acquired = await navigator.mediaDevices.getUserMedia({ audio: audioOptions });
  stream = acquired;
  if (!context) await setupGraph();
  source = context!.createMediaStreamSource(acquired);
  source.connect(worklet!);
}

/** 释放麦克风 —— 隐私指示灯随之熄灭。 */
function releaseMic(): void {
  if (source) {
    try {
      source.disconnect();
    } catch {
      /* 忽略 */
    }
    source = null;
  }
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
}

/** 开始采集：开麦 → 恢复音频上下文 → 收流。 */
async function startCapture(): Promise<void> {
  const startedAt = performance.now();
  try {
    await acquireMic();
    const openedAt = performance.now();
    if (context?.state === 'suspended') await context.resume();
    recording = true;
    micError = null;
    // 告诉主进程「麦克风真的开了」，主进程据此确认采集已经开始
    window.capture.send({
      type: 'capturing',
      sampleRate: context?.sampleRate ?? TARGET_RATE,
      openMs: Math.round(openedAt - startedAt),
    });
  } catch (error) {
    micError = error instanceof Error ? error.message : String(error);
    recording = false;
    window.capture.send({ type: 'error', message: `打开麦克风失败：${micError}` });
  }
}

/** 停止采集：停流 → 关麦。 */
function stopCapture(): void {
  recording = false;
  // 给最后一点缓冲留出时间，再关设备
  setTimeout(() => {
    releaseMic();
  }, 120);
  window.capture.send({ type: 'stopped' });
}

window.capture.onCommand((command) => {
  if (command.type === 'start') {
    void startCapture();
  } else if (command.type === 'stop') {
    stopCapture();
  } else if (command.type === 'ping') {
    // 只确保音频图就绪，不开麦克风
    void setupGraph().then(() => {
      window.capture.send({ type: 'ready', sampleRate: context?.sampleRate ?? TARGET_RATE });
    });
  }
});

// 页面一加载就先把音频图建好（不碰麦克风），按下快捷键时只需开设备。
void setupGraph().then(() => {
  window.capture.send({ type: 'ready', sampleRate: context?.sampleRate ?? TARGET_RATE });
});

export {};
