import fs from 'node:fs';
import path from 'node:path';

import { utilityProcess, type UtilityProcess } from 'electron';

import { log } from '../logger.js';
import type { WorkerConfig, WorkerRequest, WorkerResponse } from './protocol.js';

const TRANSCRIBE_TIMEOUT_MS = 60_000;

/**
 * 找到识别子进程脚本的真实路径。
 *
 * 打包后脚本默认在 app.asar 里，而 **utilityProcess 无法执行 asar 内部的脚本**
 * （子进程是独立的 Node 运行时，不是 Electron 主进程，没有 asar 钩子）。
 * 所以打包时把这个脚本标记为 asarUnpack，这里再把路径换成
 * app.asar.unpacked 下的真实文件。
 */
function resolveWorkerScript(): string {
  const script = path.join(__dirname, 'asr-worker.cjs');
  if (script.includes('app.asar') && !script.includes('app.asar.unpacked')) {
    const unpacked = script.replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(unpacked)) {
      log.debug('asr', `子进程脚本使用 unpacked 副本：${unpacked}`);
      return unpacked;
    }
  }
  return script;
}

interface Pending {
  resolve: (value: { text: string; segments: number; ms: number }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * 语音识别门面：管理子进程的生命周期与请求/响应配对。
 *
 * 模型常驻子进程里，启动时预热一次（首次加载约 3 秒），
 * 这样第一次按快捷键时不用等模型冷启动。
 */
class AsrRecognizer {
  private child: UtilityProcess | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private currentConfigKey = '';
  private lastError: string | null = null;

  /** 启动子进程并下发模型配置。 */
  async ensure(config: WorkerConfig): Promise<void> {
    const key = configKey(config);
    if (this.readyPromise && this.currentConfigKey === key) {
      return this.readyPromise;
    }
    if (this.readyPromise && this.currentConfigKey !== key) {
      // 配置变了，重建识别器
      this.stop();
    }
    if (!this.readyPromise) {
      this.currentConfigKey = key;
      this.readyPromise = new Promise<void>((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
      });
      this.spawn(config);
    }
    return this.readyPromise;
  }

  private spawn(config: WorkerConfig): void {
    try {
      const script = resolveWorkerScript();
      log.info('asr', `启动识别子进程 ${script}`);
      const child = utilityProcess.fork(script, [], {
        serviceName: 'qingyu-asr',
        stdio: 'inherit',
      });
      this.child = child;

      child.on('message', (message: WorkerResponse) => this.onMessage(message));
      child.on('exit', (code) => this.onExit(code));

      const request: WorkerRequest = { type: 'config', config };
      child.postMessage(request);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private onMessage(message: WorkerResponse): void {
    switch (message.type) {
      case 'alive':
        break;
      case 'ready':
        this.lastError = null;
        log.info('asr', '模型加载完成');
        this.readyResolve?.();
        this.readyResolve = null;
        this.readyReject = null;
        break;
      case 'result': {
        const entry = this.pending.get(message.id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(message.id);
          entry.resolve({ text: message.text, segments: message.segments, ms: message.ms });
        }
        break;
      }
      case 'error': {
        const entry = this.pending.get(message.id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(message.id);
          entry.reject(new Error(message.message));
        }
        break;
      }
      case 'fatal':
        log.error('asr', `子进程报错：${message.message}`);
        this.lastError = message.message;
        this.fail(new Error(message.message));
        break;
    }
  }

  private onExit(code: number): void {
    log.warn('asr', `识别子进程退出，code=${code}`);
    this.child = null;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('识别子进程已退出'));
    }
    this.pending.clear();
    if (this.readyResolve) {
      this.fail(new Error(`识别子进程退出（code=${code}）`));
    }
  }

  private fail(error: Error): void {
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    this.readyPromise = null;
    this.currentConfigKey = '';
  }

  get lastErrorMessage(): string | null {
    return this.lastError;
  }

  get isReady(): boolean {
    return this.child !== null && this.readyPromise !== null;
  }

  /**
   * 识别一段音频。
   * @param pcm 单声道 float 音频，范围 [-1, 1]
   * @param sampleRate 采样率
   */
  async transcribe(
    pcm: Float32Array,
    sampleRate: number,
    config: WorkerConfig,
  ): Promise<{ text: string; segments: number; ms: number }> {
    await this.ensure(config);
    const child = this.child;
    if (!child) throw new Error('识别子进程未运行');

    const id = this.nextId++;
    const buffer = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('识别超时'));
      }, TRANSCRIBE_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const request: WorkerRequest = { type: 'transcribe', id, pcm: buffer, sampleRate };
      child.postMessage(request);
    });
  }

  /** 终止子进程（配置变更或退出时）。 */
  stop(): void {
    this.child?.kill();
    this.child = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.currentConfigKey = '';
  }
}

function configKey(config: WorkerConfig): string {
  return [
    config.model,
    config.tokens,
    config.vad,
    config.threads,
    config.language,
    config.itn,
    config.vadThreshold,
    config.minSpeechSeconds,
    config.minSilenceSeconds,
    config.maxSpeechSeconds,
  ].join('|');
}

export const recognizer = new AsrRecognizer();
export type { WorkerConfig };
