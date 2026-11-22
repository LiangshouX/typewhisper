/** 主进程 <-> 语音识别子进程之间的消息协议。 */

export interface WorkerConfig {
  /** SenseVoice onnx 路径 */
  model: string;
  /** tokens.txt 路径 */
  tokens: string;
  /** Silero VAD onnx 路径 */
  vad: string;
  /** 推理线程数 */
  threads: number;
  /** 语种提示 */
  language: string;
  /** 是否开启逆文本正则化 */
  itn: boolean;
  vadThreshold: number;
  minSpeechSeconds: number;
  minSilenceSeconds: number;
  maxSpeechSeconds: number;
}

export type WorkerRequest =
  | { type: 'config'; config: WorkerConfig }
  | { type: 'transcribe'; id: number; pcm: ArrayBuffer; sampleRate: number };

export type WorkerResponse =
  | { type: 'alive' }
  | { type: 'ready'; config: WorkerConfig }
  | { type: 'result'; id: number; text: string; segments: number; ms: number }
  | { type: 'error'; id: number; message: string }
  | { type: 'fatal'; message: string };
