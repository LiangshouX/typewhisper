import { BrowserWindow, dialog, ipcMain, shell } from 'electron';

import { IPC, type DeepPartial, type ModelProbeResult } from '../shared/contract.js';
import { applySettings } from './apply.js';
import { recognizer, type WorkerConfig } from './asr/recognizer.js';
import { capture } from './capture/capture.js';
import { corrector } from './llm/corrector.js';
import { log } from './logger.js';
import { detectModelRoot, resolveModels } from './models.js';
import { buildWorkerConfig, pipeline } from './pipeline.js';
import { settings } from './settings.js';
import { closeSettingsWindow, getSettingsWindow } from './windows.js';

/** 纠偏测试用的样例：故意把「轻语」写成同音的「清雨」。 */
const LLM_TEST_TEXT = '今天用清雨工具说了一句话，看看纠偏能不能把清雨改回轻语。';

/** 注册所有 IPC 处理器。 */
export function registerIpc(logDir: string): void {
  ipcMain.handle(IPC.settingsGet, () => settings.get());

  ipcMain.handle(IPC.settingsPatch, (_event, patch: DeepPartial<unknown>) => {
    const next = settings.patch(patch as DeepPartial<ReturnType<typeof settings.get>>);
    applySettings(next);
    return next;
  });

  ipcMain.handle(IPC.settingsReset, () => {
    const next = settings.reset();
    applySettings(next);
    return next;
  });

  ipcMain.handle(IPC.settingsPickModelDir, async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: '选择语音模型目录',
      properties: ['openDirectory' as const],
      defaultPath: settings.get().asr.modelRoot || undefined,
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(IPC.settingsDetectModelDir, () => detectModelRoot());

  ipcMain.handle(IPC.settingsOpenLogDir, async () => {
    await shell.openPath(logDir);
  });

  ipcMain.handle(IPC.appGetStatus, () => pipeline.status);

  ipcMain.handle(IPC.asrCheckModels, (): ModelProbeResult => {
    const asr = settings.get().asr;
    return resolveModels(asr.modelRoot, {
      senseVoiceModel: asr.senseVoiceModel || undefined,
      tokens: asr.tokens || undefined,
      vadModel: asr.vadModel || undefined,
    });
  });

  ipcMain.handle(IPC.asrTest, async () => {
    const started = Date.now();
    try {
      const built = buildWorkerConfig(settings.get());
      if (!built.ok) {
        return { ok: false, text: '', ms: 0, error: built.error };
      }
      await capture.start();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const { pcm, sampleRate } = await capture.stop();
      if (pcm.length === 0) {
        return { ok: false, text: '', ms: Date.now() - started, error: '没有采集到音频' };
      }
      const result = await recognizer.transcribe(pcm, sampleRate, built.config);
      return {
        ok: Boolean(result.text),
        text: result.text,
        ms: Date.now() - started,
        error: result.text ? undefined : '没有识别到语音内容',
      };
    } catch (error) {
      return {
        ok: false,
        text: '',
        ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle(IPC.llmTest, async () => {
    const llmSettings = settings.get().llm;
    const started = Date.now();
    if (!llmSettings.enabled) {
      return { ok: false, text: '', ms: 0, error: '尚未启用大模型纠偏' };
    }
    const outcome = await corrector.correct(
      { text: LLM_TEST_TEXT, budgetMs: Math.max(1000, llmSettings.timeoutMs) },
      llmSettings,
    );
    return {
      ok: outcome.corrected || outcome.reason === 'unchanged',
      text: outcome.text,
      ms: outcome.ms || Date.now() - started,
      error: outcome.error,
    };
  });

  ipcMain.handle(IPC.hotkeySimulate, async () => {
    await pipeline.simulateCycle(3);
  });

  ipcMain.handle(IPC.llmGetTrace, () => corrector.getLastTrace());

  ipcMain.handle(IPC.llmClearTrace, () => {
    corrector.clearTrace();
  });

  ipcMain.handle(IPC.windowClose, () => {
    closeSettingsWindow();
  });

  ipcMain.handle(IPC.windowMinimize, () => {
    getSettingsWindow()?.minimize();
  });
}

export type { WorkerConfig };
