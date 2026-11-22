/**
 * 语音识别子进程入口。
 *
 * 为什么要单独开进程：
 *   - SenseVoice 推理是同步的，会阻塞几百毫秒。放在主进程里会卡住
 *     悬浮条动画与快捷键轮询。
 *   - 原生模块崩溃不会带走整个软件。
 *
 * 这个文件会被 esbuild 打包成 dist/main/asr-worker.cjs，
 * 由主进程用 utilityProcess.fork 启动（Electron 以 ELECTRON_RUN_AS_NODE 运行）。
 */

import { createRequire } from 'node:module';

import type { WorkerConfig, WorkerRequest, WorkerResponse } from './protocol.js';

const require_ = createRequire(__filename);
const sherpa = require_('sherpa-onnx-node') as typeof import('sherpa-onnx-node');

const TARGET_RATE = 16_000;

/* ------------------------------------------------------------------ */
/* 识别器状态                                                           */
/* ------------------------------------------------------------------ */

type Recognizer = InstanceType<(typeof sherpa)['OfflineRecognizer']>;
type Detector = InstanceType<(typeof sherpa)['Vad']>;

let recognizer: Recognizer | null = null;
let detector: Detector | null = null;
let resampler: InstanceType<(typeof sherpa)['LinearResampler']> | null = null;
let resamplerRate = 0;
let currentConfig: WorkerConfig | null = null;

function build(config: WorkerConfig): void {
  const nativeConfig = {
    featConfig: { sampleRate: TARGET_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: config.model,
        language: config.language,
        useInverseTextNormalization: config.itn ? 1 : 0,
      },
      tokens: config.tokens,
      numThreads: config.threads,
      provider: 'cpu',
      debug: 0,
    },
  };

  recognizer = new sherpa.OfflineRecognizer(nativeConfig);
  detector = new sherpa.Vad(
    {
      sileroVad: {
        model: config.vad,
        threshold: config.vadThreshold,
        minSilenceDuration: config.minSilenceSeconds,
        minSpeechDuration: config.minSpeechSeconds,
        maxSpeechDuration: config.maxSpeechSeconds,
        windowSize: 512,
      },
      sampleRate: TARGET_RATE,
      numThreads: config.threads,
      provider: 'cpu',
      debug: 0,
    },
    config.maxSpeechSeconds + config.minSilenceSeconds + 1,
  );
  resampler = null;
  resamplerRate = 0;
  currentConfig = config;
}

/* ------------------------------------------------------------------ */
/* 音频处理                                                             */
/* ------------------------------------------------------------------ */

/** 把任意采样率的单声道 float 音频重采样到 16k。 */
function toTargetRate(samples: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === TARGET_RATE) return samples;
  if (!resampler || resamplerRate !== sampleRate) {
    resampler = new sherpa.LinearResampler(sampleRate, TARGET_RATE);
    resamplerRate = sampleRate;
  }
  return resampler.resample(samples);
}

/**
 * SenseVoice 偶尔会带上 <|zh|> <|NEUTRAL|> 这类标记，统一切掉。
 */
function cleanText(text: string): string {
  return text.replace(/<\|[^|]*\|>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * 拼接多个语音段。中文段之间不加空格，英文段之间加空格。
 */
function joinSegments(parts: string[]): string {
  let out = '';
  for (const part of parts) {
    if (!part) continue;
    if (!out) {
      out = part;
      continue;
    }
    const prev = out.at(-1) ?? '';
    const next = part[0] ?? '';
    const cjk = /[\u3000-\u9fff\uff00-\uffef]/;
    const needsSpace = !cjk.test(prev) && !cjk.test(next) && !/\s/.test(prev);
    out += (needsSpace ? ' ' : '') + part;
  }
  return out;
}

/** 跑一遍 VAD + 离线识别，返回最终文本。 */
function transcribe(pcm: Float32Array, sampleRate: number): { text: string; segments: number; ms: number } {
  if (!recognizer || !detector) throw new Error('识别器尚未初始化');
  const started = performance.now();

  const samples = toTargetRate(pcm, sampleRate);
  detector.reset();
  const parts: string[] = [];

  const drain = (): void => {
    while (!detector!.isEmpty()) {
      // enableExternalBuffer=false：Electron 里不要用外部缓冲区
      const segment = detector!.front(false);
      if (!segment || segment.samples.length === 0) {
        detector!.pop();
        continue;
      }
      const stream = recognizer!.createStream();
      stream.acceptWaveform({ sampleRate: TARGET_RATE, samples: segment.samples });
      recognizer!.decode(stream);
      parts.push(cleanText(recognizer!.getResult(stream).text));
      detector!.pop();
    }
  };

  for (let offset = 0; offset < samples.length; offset += 512) {
    detector.acceptWaveform(samples.subarray(offset, offset + 512));
    drain();
  }
  detector.flush();
  drain();

  return {
    text: joinSegments(parts),
    segments: parts.length,
    ms: performance.now() - started,
  };
}

/* ------------------------------------------------------------------ */
/* 消息循环                                                             */
/* ------------------------------------------------------------------ */

/**
 * 子进程与主进程之间的通道。
 *
 * Electron 的 utilityProcess 用 `process.parentPort`；
 * 普通 `child_process.fork` 用 `process.send` / `process.on('message')`。
 * 两种都支持，运行时按存在的那个走。
 */
interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

function post(message: WorkerResponse): void {
  if (parentPort) {
    parentPort.postMessage(message);
    return;
  }
  process.send?.(message);
}

function handle(request: WorkerRequest): void {
  if (request.type === 'config') {
    try {
      build(request.config);
      post({ type: 'ready', config: request.config });
    } catch (error) {
      post({ type: 'fatal', message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (request.type === 'transcribe') {
    try {
      const pcm = new Float32Array(request.pcm);
      const result = transcribe(pcm, request.sampleRate);
      post({ type: 'result', id: request.id, ...result });
    } catch (error) {
      post({
        type: 'error',
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

if (parentPort) {
  parentPort.on('message', (event) => {
    try {
      handle(event.data as WorkerRequest);
    } catch (error) {
      post({ type: 'fatal', message: error instanceof Error ? error.message : String(error) });
    }
  });
} else {
  process.on('message', (message: WorkerRequest) => {
    try {
      handle(message);
    } catch (error) {
      post({ type: 'fatal', message: error instanceof Error ? error.message : String(error) });
    }
  });
}

// 进程被父进程拉起后立刻汇报存活，由父进程下发模型配置。
post({ type: 'alive' });

export type { WorkerConfig, WorkerRequest, WorkerResponse };
export { currentConfig };
