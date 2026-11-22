import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC,
  type AppSettings,
  type AppStatus,
  type DeepPartial,
  type LastResult,
  type LlmTrace,
  type ModelProbeResult,
  type QingYuApi,
} from '../shared/contract.js';

/**
 * 设置页 preload。
 *
 * 渲染进程只能通过这里暴露的 API 与主进程通信，
 * 不给页面任何 Node 能力。
 */
const api: QingYuApi = {
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
  patchSettings: (patch: DeepPartial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.settingsPatch, patch),
  resetSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsReset),
  pickModelDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.settingsPickModelDir),
  detectModelDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.settingsDetectModelDir),
  openLogDir: (): Promise<void> => ipcRenderer.invoke(IPC.settingsOpenLogDir),
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke(IPC.appGetStatus),
  checkModels: (): Promise<ModelProbeResult> => ipcRenderer.invoke(IPC.asrCheckModels),
  testAsr: (): Promise<{ ok: boolean; text: string; ms: number; error?: string }> =>
    ipcRenderer.invoke(IPC.asrTest),
  testLlm: (): Promise<{ ok: boolean; text: string; ms: number; error?: string }> =>
    ipcRenderer.invoke(IPC.llmTest),
  simulateHotkey: (): Promise<void> => ipcRenderer.invoke(IPC.hotkeySimulate),
  closeWindow: (): Promise<void> => ipcRenderer.invoke(IPC.windowClose),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke(IPC.windowMinimize),

  onStatus(callback: (status: AppStatus) => void): () => void {
    const handler = (_event: unknown, status: AppStatus): void => callback(status);
    ipcRenderer.on(IPC.eventStatus, handler);
    return () => {
      ipcRenderer.removeListener(IPC.eventStatus, handler);
    };
  },

  onResult(callback: (result: LastResult) => void): () => void {
    const handler = (_event: unknown, result: LastResult): void => callback(result);
    ipcRenderer.on(IPC.eventResult, handler);
    return () => {
      ipcRenderer.removeListener(IPC.eventResult, handler);
    };
  },

  onLevel(callback: (level: number) => void): () => void {
    const handler = (_event: unknown, level: number): void => callback(level);
    ipcRenderer.on(IPC.eventLevel, handler);
    return () => {
      ipcRenderer.removeListener(IPC.eventLevel, handler);
    };
  },

  getLlmTrace: (): Promise<LlmTrace | null> => ipcRenderer.invoke(IPC.llmGetTrace),
  clearLlmTrace: (): Promise<void> => ipcRenderer.invoke(IPC.llmClearTrace),
};

contextBridge.exposeInMainWorld('qingyu', api);
