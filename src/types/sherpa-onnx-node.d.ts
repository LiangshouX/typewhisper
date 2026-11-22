/**
 * sherpa-onnx-node 的类型声明。
 *
 * 官方包只提供了 JSDoc，没有 .d.ts，这里按实际用到的 API 手写一份。
 */
declare module 'sherpa-onnx-node' {
  export interface Waveform {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface SpeechSegment {
    start: number;
    samples: Float32Array;
  }

  export interface OfflineRecognizerResult {
    lang: string;
    emotion: string;
    event: string;
    text: string;
    timestamps: number[];
    durations: number[];
    tokens: string[];
  }

  export interface SenseVoiceModelConfig {
    model: string;
    language?: string;
    useInverseTextNormalization?: number;
  }

  export interface OfflineModelConfig {
    senseVoice?: SenseVoiceModelConfig;
    tokens?: string;
    numThreads?: number;
    debug?: boolean | number;
    provider?: string;
  }

  export interface FeatureConfig {
    sampleRate?: number;
    featureDim?: number;
  }

  export interface OfflineRecognizerConfig {
    featConfig?: FeatureConfig;
    modelConfig?: OfflineModelConfig;
  }

  export interface SileroVadModelConfig {
    model: string;
    threshold?: number;
    minSilenceDuration?: number;
    minSpeechDuration?: number;
    windowSize?: number;
    maxSpeechDuration?: number;
  }

  export interface VadConfig {
    sileroVad?: SileroVadModelConfig;
    tenVad?: SileroVadModelConfig;
    sampleRate?: number;
    numThreads?: number;
    provider?: string;
    debug?: boolean | number;
  }

  export class OfflineStream {
    acceptWaveform(waveform: Waveform): void;
    setOption(key: string, value: string): void;
    getOption(key: string): string;
  }

  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig);
    setConfig(config: OfflineRecognizerConfig): void;
    createStream(hotwords?: string): OfflineStream;
    decode(stream: OfflineStream): void;
    getResult(stream: OfflineStream): OfflineRecognizerResult;
  }

  export class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    pop(): void;
    clear(): void;
    front(enableExternalBuffer?: boolean): SpeechSegment;
    reset(): void;
    flush(): void;
  }

  export class LinearResampler {
    constructor(inputSampleRate: number, outputSampleRate: number);
    resample(samples: Float32Array): Float32Array;
    flush(samples: Float32Array): Float32Array;
    reset(): void;
    getInputSampleRate(): number;
    getOutputSampleRate(): number;
  }

  export class CircularBuffer {
    constructor(capacity: number);
    push(samples: Float32Array): void;
    get(startIndex: number, n: number, enableExternalBuffer?: boolean): Float32Array;
    pop(n: number): void;
    size(): number;
    head(): number;
    reset(): void;
  }
}
