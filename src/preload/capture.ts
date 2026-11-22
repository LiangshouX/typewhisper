import { contextBridge, ipcRenderer } from 'electron';

import type { CaptureCommand, CaptureEvent } from '../shared/capture-protocol.js';

/**
 * 录音采集窗口的 preload。
 *
 * 这个页面是我们自己的隐藏窗口，暴露面可以小一点：
 * 只允许接收主进程指令、只允许上报采集事件。
 */
contextBridge.exposeInMainWorld('capture', {
  onCommand(callback: (command: CaptureCommand) => void): void {
    ipcRenderer.on('capture:cmd', (_event, command: CaptureCommand) => callback(command));
  },
  send(event: CaptureEvent): void {
    ipcRenderer.send('capture:evt', event);
  },
});
