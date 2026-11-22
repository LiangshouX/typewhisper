import path from 'node:path';

import { BrowserWindow, ipcMain } from 'electron';

import type { CaptureCommand, CaptureEvent } from '../../shared/capture-protocol.js';
import { log } from '../logger.js';
import { appUrl } from '../protocol.js';

export interface CapturedAudio {
  pcm: Float32Array;
  sampleRate: number;
}

/**
 * 录音采集管理器。
 *
 * 持有一个隐藏的 BrowserWindow，由它通过 Web Audio API 采集麦克风，
 * 把 PCM 流式送回主进程。主进程这边只负责拼装与起停。
 */
class CaptureManager {
  private window: BrowserWindow | null = null;
  private chunks: Float32Array[] = [];
  private sampleRate = 16_000;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private readyWaiters: Array<() => void> = [];
  /** 麦克风是否已打开（隐私指示灯是否亮着） */
  private micOpen = false;
  /** 等「麦克风已开」的回调 */
  private capturingWaiters: Array<() => void> = [];
  private stoppedWaiters: Array<() => void> = [];
  private lastError: string | null = null;
  private capturing = false;
  /** 实时音量回调（0~1 峰值） */
  private levelListeners: Array<(level: number) => void> = [];
  /** 自检模式：忽略真实麦克风的数据 */
  private ignoreMicAudio = false;
  /** 上次上报音量的时间，用来限流 */
  private lastLevelAt = 0;

  /** 订阅实时音量，返回取消订阅的函数。 */
  onLevel(listener: (level: number) => void): () => void {
    this.levelListeners.push(listener);
    return () => {
      this.levelListeners = this.levelListeners.filter((item) => item !== listener);
    };
  }

  /** 计算一段 PCM 的峰值音量。 */
  private static peak(pcm: Float32Array): number {
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      const value = Math.abs(pcm[i]);
      if (value > peak) peak = value;
    }
    return peak;
  }

  private emitLevel(level: number): void {
    const now = Date.now();
    // 声波要够密才好看，25ms 一次（约 40fps）
    if (now - this.lastLevelAt < 25) return;
    this.lastLevelAt = now;
    for (const listener of this.levelListeners) {
      try {
        listener(level);
      } catch {
        /* 单个订阅者出错不影响其它人 */
      }
    }
  }

  /** 注册 IPC 监听。只能调用一次。 */
  init(): void {
    ipcMain.on('capture:evt', (_event, message: CaptureEvent) => this.onEvent(message));
  }

  private onEvent(message: CaptureEvent): void {
    switch (message.type) {
      case 'ready': {
        this.sampleRate = message.sampleRate || 16_000;
        this.ready = true;
        this.lastError = null;
        log.info('capture', `音频图就绪，采样率 ${this.sampleRate}Hz（麦克风仍未打开）`);
        const waiters = this.readyWaiters;
        this.readyWaiters = [];
        waiters.forEach((fn) => fn());
        break;
      }

      case 'capturing': {
        this.sampleRate = message.sampleRate || this.sampleRate;
        this.micOpen = true;
        log.info(
          'capture',
          `麦克风已打开，开始采集（打开设备用了 ${message.openMs ?? '?'}ms）`,
        );
        const waiters = this.capturingWaiters;
        this.capturingWaiters = [];
        waiters.forEach((fn) => fn());
        break;
      }      case 'audio': {
        if (!this.capturing) break;
        // 自检模式下丢掉真实麦克风的数据，只留注入的音频，
        // 避免两种采样率混在同一个缓冲区里。
        if (this.ignoreMicAudio) break;
        const pcm = new Float32Array(message.pcm);
        this.chunks.push(pcm);
        this.emitLevel(CaptureManager.peak(pcm));
        break;
      }
      case 'stopped': {
        this.micOpen = false;
        const waiters = this.stoppedWaiters;
        this.stoppedWaiters = [];
        waiters.forEach((fn) => fn());
        break;
      }
      case 'error': {
        this.lastError = message.message;
        this.micOpen = false;
        log.error('capture', `麦克风出错：${message.message}`);
        const waiters = this.readyWaiters;
        this.readyWaiters = [];
        waiters.forEach((fn) => fn());
        const capturing = this.capturingWaiters;
        this.capturingWaiters = [];
        capturing.forEach((fn) => fn());
        break;
      }
    }
  }

  /** 确保隐藏窗口已经存在（不等待麦克风）。 */
  private async ensureWindow(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) return;
    this.window = new BrowserWindow({
      show: false,
      width: 200,
      height: 120,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'capture.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    this.window.on('closed', () => {
      this.window = null;
      this.ready = false;
      this.readyPromise = null;
      this.readyWaiters = [];
    });
    // 页面偶尔会加载失败（比如上一个实例刚退出、asar 还没释放）。
    // 重试几次，别让「录音窗口没起来」变成静默失败。
    const url = appUrl('capture/capture.html');
    const loadStarted = Date.now();
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.window.loadURL(url);
        log.info('capture', `录音窗口页面加载完成（${Date.now() - loadStarted}ms）`);
        return;
      } catch (error) {
        lastError = error;
        log.warn('capture', `录音窗口加载失败（第 ${attempt} 次）：${String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** 确保隐藏窗口存在并且音频图已就绪（**不涉及麦克风**）。 */
  async ensureReady(): Promise<void> {
    await this.ensureWindow();

    if (this.ready) return;
    // 同一个「等音频图」的 promise 只做一次，别每次都重新等
    if (!this.readyPromise) {
      this.readyPromise = new Promise<void>((resolve) => {
        this.readyWaiters.push(resolve);
        // 兜底：3 秒内没就绪也放行，避免卡死整条链路
        setTimeout(resolve, 3_000);
      });
    }
    await this.readyPromise;
  }

  get error(): string | null {
    return this.lastError;
  }

  get isCapturing(): boolean {
    return this.capturing;
  }

  /** 麦克风当前是不是开着（也就是隐私指示灯亮不亮）。 */
  get isMicOpen(): boolean {
    return this.micOpen;
  }

  /**
   * 开始采集。
   *
   * 麦克风是**这一刻才打开的**（之前只把音频图建好，隐私指示灯不亮）。
   * 所以这里要等渲染进程回报「麦克风已开」才算真正开始。
   */
  async start(): Promise<void> {
    await this.ensureWindow();
    this.chunks = [];
    this.capturing = true;
    this.micOpen = false;

    const opened = new Promise<void>((resolve) => {
      this.capturingWaiters.push(resolve);
      // 兜底：2 秒内没回报也别把整条链路卡住
      setTimeout(resolve, 2_000);
    });

    this.window?.webContents.send('capture:cmd', { type: 'start' } satisfies CaptureCommand);
    await opened;

    if (!this.micOpen) {
      log.warn('capture', '麦克风没有打开，采集会是空的');
    }
  }

  /** 停止采集并返回音频。 */
  async stop(): Promise<CapturedAudio> {
    if (!this.capturing) {
      return { pcm: new Float32Array(0), sampleRate: this.sampleRate };
    }
    this.capturing = false;
    this.emitLevel(0);
    const stopped = new Promise<void>((resolve) => this.stoppedWaiters.push(resolve));
    this.window?.webContents.send('capture:cmd', { type: 'stop' } satisfies CaptureCommand);
    // 兜底：渲染进程可能还没加载好，收不到 stop 指令。
    // 没有这个超时，流水线会永远卡在 stop() 上。
    await Promise.race([
      stopped,
      new Promise<void>((resolve) => setTimeout(resolve, 1_200)),
    ]);

    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const pcm = new Float32Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }
    log.info(
      'capture',
      `采集结束：${this.chunks.length} 块 / ${total} 采样 / ${(total / (this.sampleRate || 1)).toFixed(2)}s @ ${this.sampleRate}Hz`,
    );
    this.chunks = [];
    return { pcm, sampleRate: this.sampleRate };
  }

  /**
   * 自检用：把一段音频当作麦克风数据塞进来。
   *
   * 这样可以在没有真实人声的环境里，端到端验证
   * 「按住快捷键 → 采集 → 识别 → 出文字」整条链路。
   */
  injectTestAudio(pcm: Float32Array, sampleRate: number): void {
    if (!this.capturing) {
      log.warn('capture', '注入测试音频时不在采集状态，已忽略');
      return;
    }
    this.sampleRate = sampleRate;
    this.chunks.push(pcm);
    this.emitLevel(CaptureManager.peak(pcm));
    log.info('capture', `注入测试音频 ${pcm.length} 采样 @ ${sampleRate}Hz`);
  }

  /** 丢弃已采集但还没取走的数据。 */
  reset(): void {
    this.chunks = [];
  }

  /** 自检用：是否忽略真实麦克风的数据。 */
  setIgnoreMicAudio(ignore: boolean): void {
    this.ignoreMicAudio = ignore;
  }

  destroy(): void {
    this.window?.destroy();
    this.window = null;
  }
}

export const capture = new CaptureManager();
