import path from 'node:path';
import { writeFile } from 'node:fs/promises';

import { BrowserWindow, Menu, Tray, app, nativeImage, session } from 'electron';

import { IPC, type AppStatus, type LastResult } from '../shared/contract.js';
import { applySettings } from './apply.js';
import { recognizer } from './asr/recognizer.js';
import { capture } from './capture/capture.js';
import { hud } from './hud/hud.js';
import { hotkey } from './hotkey/hotkey.js';
import { registerIpc } from './ipc.js';
import { log } from './logger.js';
import { buildWorkerConfig, pipeline } from './pipeline.js';
import { registerScheme, serveAppProtocol } from './protocol.js';
import { settings } from './settings.js';
import { getSettingsWindow, openSettingsWindow } from './windows.js';

const APP_ID = 'io.github.liangshoux.typewhisper';
const startedMinimized = process.argv.includes('--minimized');

let tray: Tray | null = null;
let recordTimer: NodeJS.Timeout | null = null;
let recordStartedAt = 0;

/* ------------------------------------------------------------------ */
/* 单实例                                                               */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    openSettingsWindow();
  });
}

/* ------------------------------------------------------------------ */
/* 悬浮条状态                                                           */
/* ------------------------------------------------------------------ */

function hudDetail(status: AppStatus): string | undefined {
  switch (status.stage) {
    case 'recording': {
      // 麦克风是按需打开的，还没就绪就如实说明，别让人对着空气说话
      if (status.micReady === false) return '准备麦克风…';
      const seconds = (Date.now() - recordStartedAt) / 1000;
      return `${seconds.toFixed(1)}s`;
    }
    case 'decoding':
      return '本地识别中';
    case 'correcting':
      return '大模型纠偏中';
    case 'injecting':
      return '写入中';
    case 'error':
      return '请查看日志';
    default:
      return undefined;
  }
}

function startRecordTimer(): void {
  recordStartedAt = Date.now();
  if (recordTimer) clearInterval(recordTimer);
  recordTimer = setInterval(() => {
    const status = pipeline.status;
    if (status.stage !== 'recording') {
      if (recordTimer) clearInterval(recordTimer);
      recordTimer = null;
      return;
    }
    hud.update({ stage: status.stage, detail: hudDetail(status) });
  }, 100);
}

function stopRecordTimer(): void {
  if (recordTimer) clearInterval(recordTimer);
  recordTimer = null;
}

/* ------------------------------------------------------------------ */
/* 托盘                                                                 */
/* ------------------------------------------------------------------ */

function buildTrayMenu(): Menu {
  const current = settings.get();
  const modelState = buildWorkerConfig(current);
  const modelText = modelState.ok ? '模型已就绪' : '模型未就绪';
  const llmText = current.llm.enabled ? '纠偏已启用' : '纠偏未启用';

  return Menu.buildFromTemplate([
    { label: `状态：${modelText} · ${llmText}`, enabled: false },
    { type: 'separator' },
    {
      label: '立即语音输入（3 秒）',
      click: () => {
        void pipeline.simulateCycle(3);
      },
    },
    {
      label: '打开设置',
      click: () => {
        openSettingsWindow();
      },
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: current.advanced.autoLaunch,
      click: (item) => {
        const next = settings.patch({ advanced: { autoLaunch: item.checked } });
        applySettings(next);
      },
    },
    {
      label: '启动时最小化',
      type: 'checkbox',
      checked: current.advanced.startMinimized,
      click: (item) => {
        const next = settings.patch({ advanced: { startMinimized: item.checked } });
        applySettings(next);
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit();
      },
    },
  ]);
}

function createTray(): void {
  const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
  const image = nativeImage.createFromPath(iconPath);
  // 托盘图标在 Windows 上要小尺寸，32 足够清晰
  const resized = image.isEmpty() ? image : image.resize({ width: 20, height: 20 });
  tray = new Tray(resized);
  tray.setToolTip('Typewhisper — 按住快捷键说话');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => {
    openSettingsWindow();
  });
}

function refreshTrayMenu(): void {
  tray?.setContextMenu(buildTrayMenu());
}

/* ------------------------------------------------------------------ */
/* 启动                                                                 */
/* ------------------------------------------------------------------ */

registerScheme();

app.setAppUserModelId(APP_ID);

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  const logDir = path.join(userData, 'logs');
  log.setDirectory(logDir);

  const appSettings = settings.load(userData);
  log.setLevel(appSettings.advanced.logLevel);
  log.info('app', `Typewhisper 启动，用户数据目录 ${userData}`);

  serveAppProtocol();

  // 麦克风权限：只放行我们自己的页面
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
      return;
    }
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => {
    return permission === 'media';
  });

  capture.init();
  registerIpc(logDir);
  applySettings(appSettings);
  createTray();

  /* ---- 实时音量：喂给设置页的电平表与悬浮条 ---- */
  capture.onLevel((level) => {
    hud.updateLevel(level);
    getSettingsWindow()?.webContents.send(IPC.eventLevel, level);
  });

  /* ---- 流水线事件 ---- */
  pipeline.on('status', (status: AppStatus) => {
    if (status.stage === 'recording') {
      startRecordTimer();
    } else {
      stopRecordTimer();
    }
    if (appSettings.advanced.showHud) {
      hud.update({ stage: status.stage, detail: hudDetail(status) });
    }
    getSettingsWindow()?.webContents.send(IPC.eventStatus, status);
  });

  pipeline.on('result', (result: LastResult) => {
    getSettingsWindow()?.webContents.send(IPC.eventResult, result);
    refreshTrayMenu();
  });

  pipeline.on('error', (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    hud.update({ stage: 'error', detail: message });
  });

  /* ---- 窗口 ---- */
  // 第一次运行一定要让用户看到设置页；之后按「启动时最小化」处理
  if (!startedMinimized && (settings.isFirstRun || !appSettings.advanced.startMinimized)) {
    openSettingsWindow();
  }

  /* ---- 预热录音窗口与悬浮指示条 ----
   * 这两个窗口第一次创建都要拉起一个渲染进程，实测几秒到十几秒。
   * 如果等到用户按快捷键才建，开头的语音就丢了、指示条也来不及出现。
   * 所以启动时就把它们建好（隐藏着），按键即刻可用。
   */
  void Promise.all([
    capture
      .ensureReady()
      .then(() => log.info('capture', '录音窗口已预热'))
      .catch((error) => log.warn('capture', '录音窗口预热失败', error)),
    hud
      .ensureReady()
      .then(() => log.info('hud', '悬浮指示条已预热'))
      .catch((error) => log.warn('hud', '悬浮指示条预热失败', error)),
  ]);

  /* ---- 预热模型 ---- */
  void pipeline.warmup();

  /* ---- 自检模式：验证麦克风→识别→纠偏整条链路，不写入任何窗口 ---- */
  if (process.argv.includes('--selftest')) {
    const { runSelfTest } = await import('./selftest.js');
    setTimeout(() => {
      void runSelfTest({ seconds: 5 }).then(() => {
        setTimeout(() => app.quit(), 800);
      });
    }, 2500);
  }

  /* ---- 注入自检：在自建窗口里验证文本插入，完全不碰用户窗口 ---- */
  if (process.argv.includes('--inject-test')) {
    const { runInjectTest } = await import('./inject-test.js');
    setTimeout(() => {
      void runInjectTest().then((ok) => {
        setTimeout(() => app.exit(ok ? 0 : 1), 600);
      });
    }, 2000);
  }

  /* ---- 快捷键自检：验证「按住说话」不会抖 ---- */
  if (process.argv.includes('--hotkey-test')) {
    const { runHotkeyTest } = await import('./hotkey-test.js');
    setTimeout(() => {
      void runHotkeyTest().then((ok) => {
        setTimeout(() => app.exit(ok ? 0 : 1), 600);
      });
    }, 2500);
  }

  /* ---- 悬浮指示条演示：在真实桌面上看效果 ---- */
  if (process.argv.includes('--hud-demo')) {
    const { runHudDemo } = await import('./hud-demo.js');
    setTimeout(() => {
      void runHudDemo(20).then(() => app.exit(0));
    }, 2000);
  }

  /* ---- 截图：把设置窗口自己抓下来（开发用） ---- */
  const shotIndex = process.argv.indexOf('--shot');
  const sectionIndex = process.argv.indexOf('--shot-section');
  if (shotIndex >= 0 && sectionIndex < 0) {
    const target = process.argv[shotIndex + 1] ?? 'typewhisper-settings.png';
    // 设置窗口可能因为「启动时最小化」而没开，这里补开一个
    const shot = async (attempt: number): Promise<void> => {
      const win = getSettingsWindow();
      if (!win) {
        log.error('shot', '设置窗口不存在');
        app.exit(1);
        return;
      }
      try {
        // capturePage 对「还没真正显示」的窗口会失败，先确保它可见
        if (!win.isVisible()) win.show();
        const image = await win.webContents.capturePage();
        if (image.isEmpty()) throw new Error('截图为空');
        await writeFile(target, image.toPNG());
        log.info('shot', `已保存截图 ${target}`);
        app.exit(0);
      } catch (error) {
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 900));
          await shot(attempt + 1);
          return;
        }
        log.error('shot', '截图失败', error);
        app.exit(1);
      }
    };
    openSettingsWindow();
    setTimeout(() => {
      void shot(1);
    }, 3200);
  }

  /* ---- 指定分区截图（开发用）：--shot-section 2 ---- */
  if (sectionIndex >= 0) {
    const index = Number(process.argv[sectionIndex + 1] ?? 0);
    const target = process.argv[shotIndex + 1] ?? 'qingyu-section.png';
    openSettingsWindow();
    setTimeout(() => {
      const win = getSettingsWindow();
      if (!win) {
        app.exit(1);
        return;
      }
      void win.webContents
        .executeJavaScript(
          `(() => {
             const pick = () => {
               const items = document.querySelectorAll('.nav__item');
               const el = items[${index}];
               if (!el) return false;
               el.click();
               return true;
             };
             if (pick()) return 'ok';
             return new Promise((resolve) => {
               let tries = 0;
               const timer = setInterval(() => { tries++; if (pick() || tries > 40) { clearInterval(timer); resolve('done'); } }, 150);
             });
           })()`,
        )
        .then(() => new Promise((resolve) => setTimeout(resolve, 2200)))
        .then(() =>
          win.webContents.executeJavaScript(
            '(() => { const c = document.querySelector(".content, .main"); if (c) c.scrollTop = c.scrollHeight; return true; })()',
          ),
        )
        .then(() => new Promise((resolve) => setTimeout(resolve, 700)))
        .then(() => win.webContents.capturePage())
        .then(async (image) => {
          await writeFile(target, image.toPNG());
          log.info('shot', `已保存分区截图 ${target}`);
          app.exit(0);
        })
        .catch((error) => {
          log.error('shot', '分区截图失败', error);
          app.exit(1);
        });
    }, 3200);
  }

  log.info('app', '启动完成');
});

app.on('window-all-closed', () => {
  // 常驻托盘，不退出
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    openSettingsWindow();
  }
});

app.on('before-quit', () => {
  hotkey.dispose();
  recognizer.stop();
  capture.destroy();
  hud.destroy();
  log.info('app', '退出中');
});
