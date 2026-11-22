import path from 'node:path';
import { writeFile } from 'node:fs/promises';

import { BrowserWindow, screen } from 'electron';

import { log } from '../logger.js';
import { appUrl } from '../protocol.js';

/** 悬浮指示条的尺寸。 */
const HUD_WIDTH = 340;
const HUD_HEIGHT = 60;

export interface HudState {
  stage: string;
  detail?: string;
  label?: string;
  /** 实时文本（如果将来支持增量识别，这里会显示） */
  text?: string;
}

/**
 * 悬浮指示条：录音声波 + 当前状态。
 *
 * 三个要点：
 *   1. **不能抢焦点** —— 一旦抢了，用户的插入位置就没了；
 *   2. **要出现在用户正在干活的那块屏幕上** —— 前台窗口在哪个显示器就贴哪个；
 *   3. **鼠标穿透** —— 不能挡住用户正在点的东西。
 */
export class Hud {
  private window: BrowserWindow | null = null;
  private lastDisplayId: number | null = null;
  /** 页面是否已经加载完（没加载完就 show 会出现一个空白窗口） */
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  ensure(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;

    this.window = new BrowserWindow({
      width: HUD_WIDTH,
      height: HUD_HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      focusable: false,
      fullscreen: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'hud.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });

    this.window.setAlwaysOnTop(true, 'screen-saver');
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.window.setIgnoreMouseEvents(true, { forward: true });

    const loadStarted = Date.now();
    this.window.webContents.on('console-message', (_event, level, message) => {
      log.debug('hud', `[渲染进程] ${message}`);
    });
    this.loadPromise = this.window
      .loadURL(appUrl('hud/hud.html'))
      .then(() => {
        this.loaded = true;
        log.info('hud', `悬浮条页面加载完成（${Date.now() - loadStarted}ms）`);
      })
      .catch((error) => {
        log.error('hud', '悬浮条页面加载失败', error);
      });

    this.window.on('closed', () => {
      this.window = null;
      this.loaded = false;
      this.loadPromise = null;
      this.lastDisplayId = null;
    });
    return this.window;
  }

  /**
   * 找到「用户正在干活」的那块屏幕。
   *
   * 跟着**鼠标光标所在的屏幕**走：你在哪块屏上干活，光标就在那块屏，
   * 指示条就贴那块屏的底部中央（任务栏上方）。
   */
  private targetDisplay(): Electron.Display {
    try {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    } catch (error) {
      log.debug('hud', `取光标位置失败：${String(error)}`);
      return screen.getPrimaryDisplay();
    }
  }

  /** 确保悬浮条已经就绪（窗口建好、页面加载完）。 */
  async ensureReady(): Promise<void> {
    this.ensure();
    await this.loadPromise;
  }

  /**
   * 把悬浮条放到目标屏幕的**底部中央**（任务栏上方）。
   *
   * 用的是工作区（workArea），它已经把任务栏排除在外了。
   */
  reposition(): void {
    const win = this.ensure();
    const display = this.targetDisplay();
    const area = display.workArea;

    const x = Math.round(area.x + (area.width - HUD_WIDTH) / 2);
    const y = Math.round(area.y + area.height - HUD_HEIGHT - 16);
    win.setPosition(x, y, false);
    this.lastDisplayId = display.id;
  }

  update(state: HudState): void {
    try {
      const win = this.ensure();
      if (win.isDestroyed()) return;

      // 页面还没加载完就先记着，等加载完再显示（否则是个空白窗口）
      if (!this.loaded) {
        void this.loadPromise?.then(() => this.update(state));
        return;
      }

      // 换屏幕了就重新贴一次
      const display = this.targetDisplay();
      if (display.id !== this.lastDisplayId) {
        this.reposition();
      }

      // 空闲就藏起来，其余状态亮出来。
      // 注意：窗口是 focusable:false 的，show() 不会把焦点抢走。
      const idle = state.stage === 'idle';
      if (idle) {
        if (win.isVisible()) win.hide();
      } else if (!win.isVisible()) {
        this.reposition();
        win.show();
        log.info('hud', `悬浮条已显示 bounds=${JSON.stringify(win.getBounds())}`);
      }

      win.webContents.send('hud:state', state);
    } catch (error) {
      log.warn('hud', '更新悬浮条失败', error);
    }
  }

  /** 把悬浮条自己抓成图片（开发用，不依赖它有没有被别的窗口挡住）。 */
  async capture(filePath: string): Promise<boolean> {
    const win = this.window;
    if (!win || win.isDestroyed()) {
      log.warn('hud', '悬浮条截图失败：窗口不存在');
      return false;
    }
    if (!this.loaded) {
      log.warn('hud', '悬浮条截图失败：页面还没加载完');
      return false;
    }
    try {
      const image = await win.webContents.capturePage();
      if (image.isEmpty()) {
        log.warn('hud', '悬浮条截图失败：截图为空');
        return false;
      }
      await writeFile(filePath, image.toPNG());
      return true;
    } catch (error) {
      log.warn('hud', '悬浮条截图失败', error);
      return false;
    }
  }

  /** 推送实时音量，让悬浮条能画声波。 */
  updateLevel(level: number): void {
    try {
      const win = this.window;
      if (!win || win.isDestroyed()) return;

      // 录音过程中用户把鼠标挪到另一块屏 —— 指示条跟过去
      const display = this.targetDisplay();
      if (display.id !== this.lastDisplayId) {
        this.reposition();
      }

      win.webContents.send('hud:level', level);
    } catch {
      /* 忽略 */
    }
  }

  destroy(): void {
    this.window?.destroy();
    this.window = null;
  }
}

export const hud = new Hud();
