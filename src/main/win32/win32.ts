/**
 * Win32 薄封装。
 *
 * 这里只负责「把 Windows API 调通」，不做业务判断。
 * 所有 FFI 都集中在一个文件里，便于排查与替换。
 *
 * 结构体按 koffi 官方示例声明（C 类型名 + 联合体成员），
 * 由 koffi 负责内存布局，不手写字节偏移。
 */

import koffi from 'koffi';

/* ------------------------------------------------------------------ */
/* 常量                                                                 */
/* ------------------------------------------------------------------ */

export const INPUT_KEYBOARD = 1;
export const KEYEVENTF_KEYUP = 0x0002;
export const KEYEVENTF_UNICODE = 0x0004;
export const CF_UNICODETEXT = 13;
export const GMEM_MOVEABLE = 0x0002;

/* ------------------------------------------------------------------ */
/* 结构体                                                               */
/* ------------------------------------------------------------------ */

const RECT = koffi.struct('QingYuRECT', {
  left: 'int32_t',
  top: 'int32_t',
  right: 'int32_t',
  bottom: 'int32_t',
});

export const GUITHREADINFO = koffi.struct('QingYuGUITHREADINFO', {
  cbSize: 'uint32_t',
  flags: 'uint32_t',
  hwndActive: 'void *',
  hwndFocus: 'void *',
  hwndCapture: 'void *',
  hwndMenuOwner: 'void *',
  hwndMoveSize: 'void *',
  hwndCaret: 'void *',
  rcCaret: RECT,
});

const MOUSEINPUT = koffi.struct('QingYuMOUSEINPUT', {
  dx: 'int32_t',
  dy: 'int32_t',
  mouseData: 'uint32_t',
  dwFlags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t',
});

const KEYBDINPUT = koffi.struct('QingYuKEYBDINPUT', {
  wVk: 'uint16_t',
  wScan: 'uint16_t',
  dwFlags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t',
});

const HARDWAREINPUT = koffi.struct('QingYuHARDWAREINPUT', {
  uMsg: 'uint32_t',
  wParamL: 'uint16_t',
  wParamH: 'uint16_t',
});

export const INPUT = koffi.struct('QingYuINPUT', {
  type: 'uint32_t',
  u: koffi.union('QingYuINPUTUNION', {
    mi: MOUSEINPUT,
    ki: KEYBDINPUT,
    hi: HARDWAREINPUT,
  }),
});

/** INPUT 结构体大小（x64 上是 40 字节）。 */
export const INPUT_SIZE = koffi.sizeof(INPUT);

/* ------------------------------------------------------------------ */
/* DLL 绑定                                                             */
/* ------------------------------------------------------------------ */

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

export const Win32 = {
  GetForegroundWindow: user32.func('void *GetForegroundWindow()'),
  GetWindowThreadProcessId: user32.func('uint32_t GetWindowThreadProcessId(void *hwnd, uint32_t *pid)'),
  GetGUIThreadInfo: user32.func('int GetGUIThreadInfo(uint32_t idThread, QingYuGUITHREADINFO *lpgui)'),
  AttachThreadInput: user32.func('bool AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, bool attach)'),
  GetAsyncKeyState: user32.func('int16_t GetAsyncKeyState(int vKey)'),
  GetKeyState: user32.func('int16_t GetKeyState(int vKey)'),
  SendInput: user32.func('uint32_t SendInput(uint32_t nInputs, QingYuINPUT *pInputs, int cbSize)'),
  OpenClipboard: user32.func('bool OpenClipboard(void *hwndNewOwner)'),
  CloseClipboard: user32.func('bool CloseClipboard()'),
  EmptyClipboard: user32.func('bool EmptyClipboard()'),
  SetClipboardData: user32.func('void *SetClipboardData(uint32_t uFormat, void *hMem)'),
  GetClipboardData: user32.func('void *GetClipboardData(uint32_t uFormat)'),
  IsClipboardFormatAvailable: user32.func('bool IsClipboardFormatAvailable(uint32_t format)'),
  SetForegroundWindow: user32.func('bool SetForegroundWindow(void *hWnd)'),
  SwitchToThisWindow: user32.func('void SwitchToThisWindow(void *hWnd, bool fAltTab)'),
  ShowWindow: user32.func('bool ShowWindow(void *hWnd, int nCmdShow)'),
  GetWindowRect: user32.func('bool GetWindowRect(void *hWnd, QingYuRECT *lpRect)'),
  GlobalAlloc: kernel32.func('void *GlobalAlloc(uint32_t uFlags, uintptr_t dwBytes)'),
  GlobalLock: kernel32.func('void *GlobalLock(void *hMem)'),
  GlobalUnlock: kernel32.func('bool GlobalUnlock(void *hMem)'),
  GlobalSize: kernel32.func('uintptr_t GlobalSize(void *hMem)'),
  GlobalFree: kernel32.func('void *GlobalFree(void *hMem)'),
  GetLastError: kernel32.func('uint32_t GetLastError()'),
  GetCurrentThreadId: kernel32.func('uint32_t GetCurrentThreadId()'),
};

/* ------------------------------------------------------------------ */
/* 辅助函数                                                             */
/* ------------------------------------------------------------------ */

/** 某个虚拟键当前是否按下。 */
export function isKeyDown(vk: number): boolean {
  return (Win32.GetAsyncKeyState(vk) & 0x8000) !== 0;
}

/** 读取剪贴板里的纯文本（没有则返回 null）。 */
export function readClipboardText(): string | null {
  if (!Win32.IsClipboardFormatAvailable(CF_UNICODETEXT)) return null;
  if (!Win32.OpenClipboard(null)) return null;
  try {
    const handle = Win32.GetClipboardData(CF_UNICODETEXT);
    if (!handle) return null;
    const size = Win32.GlobalSize(handle);
    if (!size) return null;
    const locked = Win32.GlobalLock(handle);
    if (!locked) return null;
    try {
      const view = koffi.view(locked, size);
      const buffer = Buffer.from(view);
      const text = buffer.toString('utf16le');
      const end = text.indexOf('\u0000');
      return (end >= 0 ? text.slice(0, end) : text).trim();
    } finally {
      Win32.GlobalUnlock(handle);
    }
  } finally {
    Win32.CloseClipboard();
  }
}

/** 把纯文本写进剪贴板。 */
export function writeClipboardText(text: string): boolean {
  if (!Win32.OpenClipboard(null)) return false;
  try {
    if (!Win32.EmptyClipboard()) return false;
    const byteLength = (text.length + 1) * 2;
    const handle = Win32.GlobalAlloc(GMEM_MOVEABLE, byteLength);
    if (!handle) return false;
    const locked = Win32.GlobalLock(handle);
    if (!locked) {
      Win32.GlobalFree(handle);
      return false;
    }
    try {
      const view = koffi.view(locked, byteLength);
      const buffer = Buffer.from(view);
      buffer.write(text, 0, 'utf16le');
      buffer.writeUInt16LE(0, text.length * 2);
    } finally {
      Win32.GlobalUnlock(handle);
    }
    if (!Win32.SetClipboardData(CF_UNICODETEXT, handle)) {
      Win32.GlobalFree(handle);
      return false;
    }
    return true;
  } finally {
    Win32.CloseClipboard();
  }
}

/**
 * 把某个窗口抢到前台。
 *
 * Windows 的前台锁只允许「当前前台窗口的拥有者」或「最近获得输入的进程」
 * 切换前台，所以后台程序直接调 SetForegroundWindow 经常失败。
 * 经典解法是 AttachThreadInput：把自己的输入队列临时挂到目标窗口的线程上，
 * 此时前台锁会认为我们就是前台进程。
 *
 * @param hwnd 目标窗口句柄
 * @returns 是否成功切到前台
 */
export function focusWindow(hwnd: number | bigint): boolean {
  if (!hwnd) return false;
  const handle = typeof hwnd === 'bigint' ? Number(hwnd) : hwnd;

  const pidPtr = koffi.alloc('uint32_t', 1);
  const targetTid = Win32.GetWindowThreadProcessId(handle, pidPtr);
  const selfTid = Win32.GetCurrentThreadId();

  // 注意：AttachThreadInput 的两个参数都是 thread id
  const attached = Win32.AttachThreadInput(selfTid, targetTid, true);
  try {
    Win32.ShowWindow(handle, 9); // SW_RESTORE
    const ok = Boolean(Win32.SetForegroundWindow(handle));
    if (!ok) {
      // 前台锁很顽固时，用这个非公开 API 硬切
      Win32.SwitchToThisWindow(handle, true);
    }
    return ok;
  } finally {
    if (attached) Win32.AttachThreadInput(selfTid, targetTid, false);
  }
}

/** 取某个窗口在屏幕上的矩形（用于判断它在哪个显示器上）。 */
export function getWindowRect(hwnd: number | bigint): { left: number; top: number; right: number; bottom: number } | null {
  if (!hwnd) return null;
  const handle = typeof hwnd === 'bigint' ? Number(hwnd) : hwnd;
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  const ok = Win32.GetWindowRect(handle, rect);
  return ok ? rect : null;
}

/** 当前前台窗口的线程信息（含焦点控件与光标控件）。 */
export interface FocusInfo {
  hwnd: unknown;
  threadId: number;
  hwndFocus: unknown;
  hwndCaret: unknown;
  hasCaret: boolean;
}

export function getFocusInfo(): FocusInfo | null {
  const hwnd = Win32.GetForegroundWindow();
  if (!hwnd) return null;
  const threadId = Win32.GetWindowThreadProcessId(hwnd, null);
  const info: Record<string, unknown> = {};
  // cbSize 必须先填，否则 API 会直接失败
  info.cbSize = GUITHREADINFO.size;
  const ok = Win32.GetGUIThreadInfo(threadId, info);
  if (!ok) {
    return { hwnd, threadId, hwndFocus: null, hwndCaret: null, hasCaret: false };
  }
  return {
    hwnd,
    threadId,
    hwndFocus: info.hwndFocus ?? null,
    hwndCaret: info.hwndCaret ?? null,
    hasCaret: Boolean(info.hwndCaret),
  };
}

/* ------------------------------------------------------------------ */
/* 键盘输入                                                             */
/* ------------------------------------------------------------------ */

/** 一条键盘事件（对应 KEYBDINPUT）。 */
interface KeyEvent {
  vk: number;
  scan: number;
  flags: number;
}

/**
 * 批量发送键盘输入。
 *
 * @param events 事件列表
 * @param guard 可选的安全闸门：在**每一批**发送前调用，返回 false 就中止。
 *              用来保证「绝不会把文字敲到不是目标窗口的地方」。
 * @returns 实际插入到输入队列里的事件数（0 表示被系统拒绝或被闸门拦下）
 */
export function sendKeyboardEvents(events: KeyEvent[], guard?: () => boolean): number {
  if (events.length === 0) return 0;
  if (guard && !guard()) return 0;
  const inputs = events.map((event) => ({
    type: INPUT_KEYBOARD,
    u: {
      ki: {
        wVk: event.vk,
        wScan: event.scan,
        dwFlags: event.flags,
        time: 0,
        dwExtraInfo: 0,
      },
    },
  }));
  return Win32.SendInput(inputs.length, inputs, INPUT_SIZE);
}

/** 用 Unicode 方式逐字输入文本（不碰剪贴板）。 */
export function typeUnicode(text: string, guard?: () => boolean): number {
  let sent = 0;
  // 分批发送，避免单次数组过大，也给目标程序喘息机会
  const CHUNK = 64;
  for (let offset = 0; offset < text.length; offset += CHUNK) {
    if (guard && !guard()) break;
    const slice = text.slice(offset, offset + CHUNK);
    const events: KeyEvent[] = [];
    for (let i = 0; i < slice.length; i++) {
      const code = slice.charCodeAt(i);
      events.push({ vk: 0, scan: code, flags: KEYEVENTF_UNICODE });
      events.push({ vk: 0, scan: code, flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP });
    }
    sent += sendKeyboardEvents(events, guard);
  }
  return sent;
}

/** 模拟按下并松开一个普通虚拟键组合（比如 Ctrl+V）。 */
export function pressShortcut(vks: number[], guard?: () => boolean): number {
  if (guard && !guard()) return 0;
  const events: KeyEvent[] = [];
  for (const vk of vks) events.push({ vk, scan: 0, flags: 0 });
  for (const vk of [...vks].reverse()) events.push({ vk, scan: 0, flags: KEYEVENTF_KEYUP });
  return sendKeyboardEvents(events, guard);
}

export const VK = {
  CONTROL: 0x11,
  SHIFT: 0x10,
  ALT: 0x12,
  V: 0x56,
  ESCAPE: 0x1b,
  SPACE: 0x20,
  ENTER: 0x0d,
};
