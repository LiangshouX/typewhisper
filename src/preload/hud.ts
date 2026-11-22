import { contextBridge, ipcRenderer } from 'electron';

export interface HudState {
  stage: string;
  detail?: string;
  label?: string;
}

/** 悬浮条 preload：只接收状态推送。 */
contextBridge.exposeInMainWorld('hud', {
  onState(callback: (state: HudState) => void): void {
    ipcRenderer.on('hud:state', (_event, state: HudState) => callback(state));
  },
  onLevel(callback: (level: number) => void): void {
    ipcRenderer.on('hud:level', (_event, level: number) => callback(level));
  },
});
