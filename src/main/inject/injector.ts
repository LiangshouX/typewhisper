import type { InsertMode } from '../../shared/contract.js';
import { log } from '../logger.js';
import {
  getFocusInfo,
  isKeyDown,
  pressShortcut,
  readClipboardText,
  typeUnicode,
  VK,
  Win32,
  writeClipboardText,
} from '../win32/win32.js';

export interface InjectResult {
  ok: boolean;
  error?: string;
  mode: InsertMode;
  /** 是否因为前台窗口变化而重新激活了原窗口 */
  refocused: boolean;
}

/** 记录触发瞬间的光标位置信息。 */
export interface InjectionTarget {
  hwnd: unknown;
  threadId: number;
  hasCaret: boolean;
}

/** 在触发瞬间记录前台窗口，作为之后写入的目标。 */
export function captureTarget(): InjectionTarget | null {
  const info = getFocusInfo();
  if (!info) return null;
  return { hwnd: info.hwnd, threadId: info.threadId, hasCaret: info.hasCaret };
}

/**
 * 尝试把焦点切回记录下来的窗口。
 * Windows 的前台锁会拒绝后台进程抢焦点，所以这里用
 * AttachThreadInput + ShowWindow 的组合拳，再失败就放弃。
 */
function tryRefocus(target: InjectionTarget | null): boolean {
  if (!target?.hwnd) return false;
  const current = Win32.GetForegroundWindow();
  if (current === target.hwnd) return true;

  const currentThread = Win32.GetCurrentThreadId();
  const attached = Win32.AttachThreadInput(currentThread, target.threadId, true);
  try {
    Win32.ShowWindow(target.hwnd, 9); // SW_RESTORE
    const ok = Win32.SetForegroundWindow(target.hwnd);
    return Boolean(ok);
  } finally {
    if (attached) Win32.AttachThreadInput(currentThread, target.threadId, false);
  }
}

/** 用 Unicode 逐字输入，换行处改发回车键。 */
function typeText(text: string, guard?: () => boolean): number {
  const lines = text.split(/\r?\n/);
  let sent = 0;
  lines.forEach((line, index) => {
    if (index > 0) {
      sent += pressShortcut([VK.ENTER], guard);
    }
    if (line.length > 0) {
      sent += typeUnicode(line, guard);
    }
  });
  return sent;
}

/**
 * 把文本写入当前焦点位置。
 *
 * 安全约定：如果触发瞬间记录的窗口已经不是当前前台窗口，
 * 会先尝试切回去；切不回去就**放弃写入**，绝不把文字敲到别的窗口里。
 *
 * @param text 要写入的文本
 * @param mode 写入方式
 * @param target 触发瞬间记录的目标窗口
 */
export function injectText(
  text: string,
  mode: InsertMode,
  target: InjectionTarget | null,
  options: { restoreClipboard: boolean; trailingSpace: boolean },
): InjectResult {
  if (!text) {
    return { ok: false, error: '没有可写入的文本', mode, refocused: false };
  }

  const payload = options.trailingSpace ? `${text} ` : text;

  // 焦点跑掉时，先尝试切回原来的窗口
  let refocused = false;
  const current = Win32.GetForegroundWindow();
  if (target?.hwnd && current !== target.hwnd) {
    refocused = tryRefocus(target);
    if (!refocused) {
      log.warn('inject', '前台窗口已变化且无法切回，放弃写入（避免把文字敲到别的窗口）');
      return {
        ok: false,
        error: '焦点已切换到别的窗口，已放弃写入',
        mode,
        refocused: false,
      };
    }
  }

  if (mode === 'clipboard') {
    return injectViaClipboard(payload, options.restoreClipboard, refocused, foregroundGuard(target));
  }
  return injectViaTyping(payload, refocused, foregroundGuard(target));
}

/**
 * 安全闸门：每批按键发送前都确认前台窗口还是我们记录的那一个。
 * 防止在「判断」与「发送」之间用户切换了窗口。
 */
function foregroundGuard(target: InjectionTarget | null): () => boolean {
  return () => {
    if (!target?.hwnd) return true;
    return Win32.GetForegroundWindow() === target.hwnd;
  };
}

/** 方式一：直接把字符敲进去，不碰剪贴板。 */
function injectViaTyping(text: string, refocused: boolean, guard?: () => boolean): InjectResult {
  const sent = typeText(text, guard);
  if (sent === 0) {
    const errorCode = Win32.GetLastError();
    const blocked = guard ? !guard() : false;
    return {
      ok: false,
      error: blocked
        ? '前台窗口在写入过程中发生了变化，已中止'
        : errorCode === 5
          ? '输入被系统拒绝（目标程序可能是以管理员身份运行的）'
          : `输入失败（错误码 ${errorCode}）`,
      mode: 'type',
      refocused,
    };
  }
  return { ok: true, mode: 'type', refocused };
}

/** 方式二：走剪贴板粘贴，兼容性最好。 */
function injectViaClipboard(
  text: string,
  restore: boolean,
  refocused: boolean,
  guard?: () => boolean,
): InjectResult {
  const previous = restore ? readClipboardText() : null;

  if (!writeClipboardText(text)) {
    return { ok: false, error: '写入剪贴板失败', mode: 'clipboard', refocused };
  }

  const sent = pressShortcut([VK.CONTROL, VK.V], guard);
  if (sent === 0) {
    return {
      ok: false,
      error: '粘贴指令被系统拒绝（目标程序可能是以管理员身份运行的）',
      mode: 'clipboard',
      refocused,
    };
  }

  if (restore && previous !== null) {
    // 等目标程序把内容取走之后再还原
    setTimeout(() => {
      const current = readClipboardText();
      if (current === text) {
        writeClipboardText(previous);
      }
    }, 400);
  }

  return { ok: true, mode: 'clipboard', refocused };
}

/** 检查某个虚拟键当前是否按下（供热键轮询使用）。 */
export { isKeyDown };
