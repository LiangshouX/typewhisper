import path from 'node:path';

import { BrowserWindow, nativeTheme, shell } from 'electron';

import { appUrl } from './protocol.js';
import { settings } from './settings.js';

const SETTINGS_WIDTH = 980;
const SETTINGS_HEIGHT = 680;

/** 各主题的窗口底色，避免加载瞬间闪一下另一种颜色。 */
const THEME_BACKDROP: Record<string, string> = {
  light: '#eeede7',
  dark: '#05070a',
};

/** 解析当前该用哪套主题（system 时跟随系统）。 */
function resolveBackdrop(): string {
  const preference = settings.get().ui?.theme ?? 'system';
  if (preference === 'light') return THEME_BACKDROP.light;
  if (preference === 'dark') return THEME_BACKDROP.dark;
  return nativeTheme.shouldUseDarkColors ? THEME_BACKDROP.dark : THEME_BACKDROP.light;
}

let settingsWindow: BrowserWindow | null = null;

/** 打开（或聚焦）设置窗口。 */
export function openSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    width: SETTINGS_WIDTH,
    height: SETTINGS_HEIGHT,
    minWidth: 820,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: resolveBackdrop(),
    title: '轻语 QingYu 设置',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  settingsWindow.once('ready-to-show', () => {
    settingsWindow?.show();
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  // 外部链接交给系统浏览器
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  void settingsWindow.loadURL(appUrl('renderer/settings.html'));
  return settingsWindow;
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null;
}

export function closeSettingsWindow(): void {
  settingsWindow?.close();
}
