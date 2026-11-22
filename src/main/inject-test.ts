import { BrowserWindow, app } from 'electron';

import { captureTarget, injectText } from './inject/injector.js';
import { log } from './logger.js';
import { Win32, focusWindow } from './win32/win32.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 注入自检：在**我们自己创建的窗口**里验证文本插入。
 *
 * 为什么不拿记事本试：桌面会话里可能已经开着别的窗口，
 * 输入会落到用户自己的窗口上（曾经把宿主 DSH 搞崩溃过）。
 *
 * 安全护栏：注入前必须确认**前台窗口就是我们自己刚建的窗口**，
 * 否则直接放弃 —— 绝不往任何别的窗口里打字。
 */
export async function runInjectTest(sample = '轻语 QingYu 注入自检 12345'): Promise<boolean> {
  const win = new BrowserWindow({
    width: 520,
    height: 260,
    show: true,
    title: '轻语 · 注入自检',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>body{margin:0;padding:20px;background:#0d1017;color:#e7edf5;font:14px "Microsoft YaHei UI",sans-serif}
textarea{width:100%;height:140px;background:#171d27;color:#e7edf5;border:1px solid #35404f;border-radius:6px;padding:10px;font:14px Consolas,monospace}</style>
</head><body><div>注入自检目标（下面这个框会收到文本）</div>
<textarea id="target" autofocus></textarea>
<script>window.__ready=true;</script></body></html>`;

  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  await win.loadURL(dataUrl);
  await new Promise((resolve) => setTimeout(resolve, 600));

  // 护栏：前台窗口必须是我们自己这个窗口的原生句柄
  const nativeHandle = win.getNativeWindowHandle();
  const ourHwnd = nativeHandle.length >= 8
    ? nativeHandle.readBigUInt64LE(0)
    : BigInt(nativeHandle.readUInt32LE(0));

  // Windows 的前台锁会挡住普通的前台切换请求，这里用 Win32 的方式抢一次
  for (let attempt = 0; attempt < 10; attempt++) {
    focusWindow(ourHwnd);
    app.focus({ steal: true });
    win.focus();
    win.moveTop();
    await sleep(200);
    const current = BigInt(Win32.GetForegroundWindow() as unknown as number);
    if (current === ourHwnd) break;
  }

  const foreground = BigInt(Win32.GetForegroundWindow() as unknown as number);
  if (foreground !== ourHwnd) {
    log.error(
      'inject-test',
      `前台窗口不是自检窗口（前台 ${foreground} vs 自建 ${ourHwnd}），放弃注入，不向任何窗口输入`,
    );
    win.destroy();
    return false;
  }

  const target = captureTarget();
  log.info('inject-test', `前台窗口确认为自建窗口 ${ourHwnd}`);

  const result = injectText(sample, 'type', target, {
    restoreClipboard: false,
    trailingSpace: false,
  });
  log.info('inject-test', `注入结果：${result.ok ? '成功' : `失败 · ${result.error}`}`);

  await new Promise((resolve) => setTimeout(resolve, 500));

  // 读回文本框内容比对
  const value = (await win.webContents.executeJavaScript(
    'document.getElementById("target").value',
  )) as string;

  const ok = result.ok && value === sample;
  log.info('inject-test', `读回内容：${JSON.stringify(value)}`);
  log.info('inject-test', ok ? '✅ 注入自检通过' : '❌ 注入自检失败');

  win.destroy();
  return ok;
}
