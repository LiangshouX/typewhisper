import { EventEmitter } from 'node:events';

import type { AppSettings, AppStatus, LastResult, PipelineStage } from '../shared/contract.js';
import { recognizer, type WorkerConfig } from './asr/recognizer.js';
import { capture } from './capture/capture.js';
import { resolveModels } from './models.js';
import { corrector } from './llm/corrector.js';
import { log } from './logger.js';
import { settings } from './settings.js';
import { captureTarget, injectText, type InjectionTarget } from './inject/injector.js';
import { hotkey } from './hotkey/hotkey.js';

/** 录音结束到文本落地的时间预算来源点。 */
const STAGE_LABEL: Record<PipelineStage, string> = {
  idle: '空闲',
  recording: '录音中',
  decoding: '识别中',
  correcting: '纠偏中',
  injecting: '写入中',
  done: '完成',
  error: '出错',
};

/** 识别配置解析结果。 */
export type WorkerConfigResult =
  | { ok: true; config: WorkerConfig }
  | { ok: false; error: string };

/**
 * 把设置换算成识别子进程需要的配置。
 * @returns 配置或错误信息
 */
export function buildWorkerConfig(appSettings: AppSettings): WorkerConfigResult {
  const asr = appSettings.asr;
  const probe = resolveModels(asr.modelRoot, {
    senseVoiceModel: asr.senseVoiceModel || undefined,
    tokens: asr.tokens || undefined,
    vadModel: asr.vadModel || undefined,
  });
  if (!probe.ok || !probe.senseVoiceModel || !probe.tokens || !probe.vadModel) {
    return { ok: false, error: probe.error ?? '模型配置不完整' };
  }
  return {
    ok: true,
    config: {
      model: probe.senseVoiceModel,
      tokens: probe.tokens,
      vad: probe.vadModel,
      threads: Math.max(1, Math.min(8, Math.round(asr.threads))),
      language: asr.language,
      itn: asr.itn,
      vadThreshold: asr.vadThreshold,
      minSpeechSeconds: asr.minSpeechSeconds,
      minSilenceSeconds: asr.minSilenceSeconds,
      maxSpeechSeconds: asr.maxSpeechSeconds,
    },
  };
}

/**
 * 语音输入流水线。
 *
 * 严格的时间预算：
 *   - 松开热键 → 文本落地，总共不超过 llm.maxTotalLatencyMs；
 *   - 其中给大模型纠偏的时间不超过 llm.timeoutMs。
 * 任何一处超时，都直接退回原始识别文本，绝不让用户干等。
 */
export class Pipeline extends EventEmitter {
  private stage: PipelineStage = 'idle';
  private target: InjectionTarget | null = null;
  private busy = false;
  /** 录音正在启动中（异步），用来挡住重复触发 */
  private starting = false;
  private lastResult: LastResult | undefined;

  get status(): AppStatus {
    const appSettings = settings.get();
    const modelState = buildWorkerConfig(appSettings);
    const llmReady = appSettings.llm.enabled && Boolean(appSettings.llm.baseUrl && appSettings.llm.model);
    return {
      stage: this.stage,
      recording: this.stage === 'recording',
      modelReady: modelState.ok,
      modelError: modelState.ok ? undefined : modelState.error,
      llmReady,
      llmError: appSettings.llm.enabled
        ? llmReady
          ? undefined
          : '未填写接口地址或模型名'
        : '未启用大模型纠偏',
      accelerator: appSettings.hotkey.accelerator,
      hotkeyReady: hotkey.isRegistered,
      hotkeyError: hotkey.error,
      captureError: capture.error ?? undefined,
      lastResult: this.lastResult,
    };
  }

  private setStage(stage: PipelineStage): void {
    this.stage = stage;
    this.emit('status', this.status);
  }

  /* ---------------------------------------------------------------- */
  /* 快捷键事件                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * 快捷键被按下。
   *
   * 按住模式下，Windows 会在按住不放时**反复**发同一个快捷键。
   * 这里必须把录音中的重复触发挡掉，否则会「开始 → 立刻结束 → 再开始」地抖。
   * 按住模式的结束信号来自 onRelease（检测主键松开），不是来自这里。
   */
  async onTrigger(): Promise<void> {
    const mode = settings.get().hotkey.mode;

    if (this.stage === 'recording') {
      if (mode === 'toggle') {
        await this.finishRecording(true);
      }
      // hold 模式：录音中的重复触发直接忽略
      return;
    }

    if (this.busy || this.starting) {
      if (!this.busy) log.warn('pipeline', '上一轮录音还没启动完，忽略这次触发');
      return;
    }

    this.starting = true;
    try {
      await this.startRecording();
    } finally {
      this.starting = false;
    }
  }

  /** 主键松开（按住模式）。 */
  async onRelease(): Promise<void> {
    if (this.stage !== 'recording') return;
    await this.finishRecording(true);
  }

  /**
   * 模拟一次完整输入，但**不写入任何窗口**。
   * 给设置页的「测试」按钮用，避免把测试文本打到设置窗口里。
   */
  async simulateCycle(seconds = 3): Promise<void> {
    if (this.busy || this.stage === 'recording') return;
    this.busy = true;
    this.setStage('recording');
    try {
      await capture.start();
      await sleep(seconds * 1000);
    } catch (error) {
      log.error('pipeline', '测试录音失败', error);
      this.setStage('error');
      this.busy = false;
      return;
    }
    this.busy = false;
    await this.finishRecording(false);
  }

  /** 取消本次输入。 */
  async onCancel(): Promise<void> {
    if (this.stage !== 'recording') return;
    log.info('pipeline', '用户取消了本次输入');
    // 不去动 hotkey 的 hold 状态：用户可能还按着快捷键，
    // 让轮询照常跑着，等他真的松手时自然收尾 —— 免得中途又开一轮新的。
    hotkey.unregisterCancelKey();
    capture.reset();
    await capture.stop().catch(() => undefined);
    this.setStage('idle');
  }

  /* ---------------------------------------------------------------- */
  /* 录音                                                               */
  /* ---------------------------------------------------------------- */

  private async startRecording(): Promise<void> {
    const appSettings = settings.get();
    this.target = captureTarget();

    try {
      await capture.start();
    } catch (error) {
      log.error('pipeline', '启动录音失败', error);
      this.setStage('error');
      this.emit('error', error);
      return;
    }

    hotkey.registerCancelKey();
    this.setStage('recording');
    log.info('pipeline', `开始录音（${appSettings.hotkey.mode === 'hold' ? '按住' : '切换'}模式）`);
  }

  private async finishRecording(inject: boolean): Promise<void> {
    // 注意：这里**不要**调 hotkey.endHold()。
    // 按住模式的轮询负责检测「主键松开」，提前停掉轮询就再也等不到松手信号了。
    hotkey.unregisterCancelKey();
    this.busy = true;
    this.setStage('decoding');

    const releasedAt = Date.now();
    let audioSeconds = 0;

    try {
      const { pcm, sampleRate } = await capture.stop();
      audioSeconds = sampleRate > 0 ? pcm.length / sampleRate : 0;

      if (pcm.length === 0) {
        log.warn('pipeline', '没有采集到音频');
        this.setStage('idle');
        this.busy = false;
        return;
      }

      const appSettings = settings.get();
      const built = buildWorkerConfig(appSettings);
      if (!built.ok) {
        log.error('pipeline', `模型未就绪：${built.error}`);
        this.setStage('error');
        this.emit('error', new Error(built.error));
        this.busy = false;
        return;
      }

      const recognition = await recognizer.transcribe(pcm, sampleRate, built.config);
      // 全程用 Date.now()，不要和 performance.now() 混用（两个时钟基准不同）
      const asrMs = Date.now() - releasedAt;
      const raw = recognition.text.trim();
      log.info('pipeline', `识别完成 ${asrMs}ms：${raw || '(空)'}`);

      if (!raw) {
        this.setStage('idle');
        this.busy = false;
        return;
      }

      /* ---- 纠偏：在剩余预算内做，超时就放弃 ---- */
      let finalText = raw;
      let corrected = false;
      let reason: string | undefined;
      let llmMs = 0;

      const llmSettings = appSettings.llm;
      const elapsed = Date.now() - releasedAt;
      const remaining = appSettings.llm.maxTotalLatencyMs - elapsed;

      if (llmSettings.enabled && remaining > 60) {
        const budget = Math.min(llmSettings.timeoutMs, remaining);
        this.setStage('correcting');
        const outcome = await corrector.correct({ text: raw, budgetMs: budget }, llmSettings);
        llmMs = outcome.ms;
        finalText = outcome.text;
        corrected = outcome.corrected;
        reason = outcome.corrected ? undefined : outcome.reason;
        if (outcome.error) log.warn('pipeline', `纠偏未生效：${outcome.error}`);
        if (outcome.corrected) {
          log.info(`pipeline`, `纠偏完成 ${llmMs}ms：${finalText}`);
        }
      } else if (llmSettings.enabled) {
        reason = 'timeout';
        log.info('pipeline', `识别已耗时 ${elapsed}ms，没有剩余预算做纠偏，直接录入原文`);
      } else {
        reason = 'disabled';
      }

      /* ---- 写入 ---- */
      let injectError: string | undefined;
      if (inject) {
        this.setStage('injecting');
        const injectResult = injectText(finalText, appSettings.input.mode, this.target, {
          restoreClipboard: appSettings.input.restoreClipboard,
          trailingSpace: appSettings.input.trailingSpace,
        });
        if (!injectResult.ok) injectError = injectResult.error;
      } else {
        this.setStage('injecting');
      }

      const totalMs = Date.now() - releasedAt;
      const result: LastResult = {
        raw,
        final: finalText,
        corrected,
        reason,
        asrMs,
        llmMs,
        totalMs,
        audioSeconds,
        at: Date.now(),
      };
      this.lastResult = result;
      this.emit('result', result);

      if (injectError) {
        log.error('pipeline', `写入失败：${injectError}`);
        this.setStage('error');
        this.emit('error', new Error(injectError));
      } else {
        log.info('pipeline', `${inject ? '写入' : '测试'}完成，总耗时 ${totalMs}ms（识别 ${asrMs}ms，纠偏 ${llmMs}ms）`);
        this.setStage('done');
        setTimeout(() => {
          if (this.stage === 'done') this.setStage('idle');
        }, 800);
      }
    } catch (error) {
      log.error('pipeline', '处理失败', error);
      this.setStage('error');
      this.emit('error', error);
    } finally {
      this.busy = false;
    }
  }

  /** 预热识别模型，让第一次按键不必等模型冷启动。 */
  async warmup(): Promise<void> {
    const built = buildWorkerConfig(settings.get());
    if (!built.ok) {
      log.warn('pipeline', `预热跳过：${built.error}`);
      return;
    }
    try {
      const started = Date.now();
      await recognizer.ensure(built.config);
      log.info('pipeline', `模型预热完成 ${Date.now() - started}ms`);
    } catch (error) {
      log.error('pipeline', '模型预热失败', error);
    }
  }
}

export const pipeline = new Pipeline();
export { STAGE_LABEL };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
