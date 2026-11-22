import { capture } from './capture/capture.js';
import { log } from './logger.js';
import { buildWorkerConfig } from './pipeline.js';
import { settings } from './settings.js';

/**
 * 自检模式（`--selftest`）。
 *
 * 用来在没有用户输入的情况下验证整条链路：
 *   麦克风 → PCM → 识别 → 纠偏 → （可选）写入
 *
 * **不写入任何窗口**，只报告各环节耗时与结果。
 */
export async function runSelfTest(options: { seconds?: number } = {}): Promise<void> {
  const seconds = options.seconds ?? 5;
  const appSettings = settings.get();

  log.info('selftest', `开始自检：录音 ${seconds} 秒`);

  const built = buildWorkerConfig(appSettings);
  if (!built.ok) {
    log.error('selftest', `模型不可用：${built.error}`);
    return;
  }

  let peak = 0;
  const offLevel = capture.onLevel((level) => {
    if (level > peak) peak = level;
  });

  const started = Date.now();
  await capture.start();
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const { pcm, sampleRate } = await capture.stop();
  offLevel();

  const audioSeconds = sampleRate > 0 ? pcm.length / sampleRate : 0;
  log.info(
    'selftest',
    `录音完成：${audioSeconds.toFixed(2)}s 音频 / ${pcm.length} 采样 / 峰值音量 ${peak.toFixed(3)}`,
  );

  if (pcm.length === 0) {
    log.error('selftest', '没有采集到任何音频 —— 麦克风可能不可用');
    return;
  }

  const decodeStart = Date.now();
  const { recognizer } = await import('./asr/recognizer.js');
  const result = await recognizer.transcribe(pcm, sampleRate, built.config);
  const asrMs = Date.now() - decodeStart;

  log.info('selftest', `识别完成 ${asrMs}ms：${result.text || '(没有识别到语音)'}`);
  log.info(
    'selftest',
    `时间拆解：录音 ${((Date.now() - started) / 1000).toFixed(2)}s / 识别 ${asrMs}ms`,
  );

  if (appSettings.llm.enabled) {
    const correctorStart = Date.now();
    const { corrector } = await import('./llm/corrector.js');
    const outcome = await corrector.correct(
      { text: result.text || '今天用清语工具说了一句话。', budgetMs: appSettings.llm.timeoutMs },
      appSettings.llm,
    );
    log.info(
      'selftest',
      `纠偏完成 ${Date.now() - correctorStart}ms：${outcome.text}（${outcome.reason}）`,
    );
  }

  log.info('selftest', '自检结束');
}
