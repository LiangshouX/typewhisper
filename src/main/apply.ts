import { app } from 'electron';

import type { AppSettings } from '../shared/contract.js';
import { hotkey } from './hotkey/hotkey.js';
import { log } from './logger.js';
import { pipeline } from './pipeline.js';

/**
 * 把设置里那些「有副作用」的部分应用到运行时。
 * 改完设置后必须调用一次。
 */
export function applySettings(appSettings: AppSettings): void {
  log.setLevel(appSettings.advanced.logLevel);

  // 快捷键
  hotkey.apply(
    appSettings.hotkey.accelerator,
    appSettings.hotkey.mode,
    appSettings.hotkey.cancelKey,
    {
      onDown: () => {
        void pipeline.onTrigger();
      },
      onUp: () => {
        void pipeline.onRelease();
      },
      onCancel: () => {
        void pipeline.onCancel();
      },
    },
  );

  // 开机自启
  try {
    app.setLoginItemSettings({
      openAtLogin: appSettings.advanced.autoLaunch,
      path: process.execPath,
      args: appSettings.advanced.startMinimized ? ['--minimized'] : [],
    });
  } catch (error) {
    log.warn('settings', '设置开机自启失败', error);
  }
}
