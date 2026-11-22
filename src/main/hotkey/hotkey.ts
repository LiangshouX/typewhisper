import { globalShortcut } from 'electron';

import type { TriggerMode } from '../../shared/contract.js';
import { log } from '../logger.js';
import { isKeyDown } from '../win32/win32.js';

/** 按住说话时轮询按键状态的间隔（毫秒）。 */
const POLL_INTERVAL_MS = 25;
/** 单次录音的最长时间（毫秒）。 */
const MAX_HOLD_MS = 120_000;

export interface HotkeyHandlers {
  /** 快捷键按下 */
  onDown(): void;
  /** 主键松开（仅按住模式） */
  onUp(): void;
  /** 取消键被按下 */
  onCancel(): void;
}

/** 常见的 Electron accelerator 主键 → Windows 虚拟键码。 */
const VK_BY_NAME: Record<string, number> = {
  space: 0x20,
  enter: 0x0d,
  return: 0x0d,
  escape: 0x1b,
  esc: 0x1b,
  tab: 0x09,
  backspace: 0x08,
  delete: 0x2e,
  insert: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  capslock: 0x14,
  ';': 0xba,
  '=': 0xbb,
  ',': 0xbc,
  '-': 0xbd,
  '.': 0xbe,
  '/': 0xbf,
  '\\': 0xdc,
  '[': 0xdb,
  ']': 0xdd,
  "'": 0xde,
  '`': 0xc0,
};

/** 把 accelerator 的主键部分翻译成虚拟键码。 */
export function virtualKeyOf(key: string): number {
  if (!key) return 0;
  const lower = key.toLowerCase();
  if (/^f\d{1,2}$/.test(lower)) {
    const n = Number(lower.slice(1));
    if (n >= 1 && n <= 24) return 0x6f + n;
  }
  if (/^[0-9]$/.test(key)) return 0x30 + Number(key);
  if (/^[a-z]$/i.test(key)) return 0x41 + (key.toUpperCase().charCodeAt(0) - 0x41);
  if (lower === 'plus') return 0xbb;
  return VK_BY_NAME[lower] ?? 0;
}

/** 拆出 accelerator 里的主键（最后一段）。 */
export function mainKeyOf(accelerator: string): string {
  const parts = accelerator.split('+').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

/**
 * 全局快捷键管理器。
 *
 * 按住模式：按下即开始录音，监听主键松开即结束。
 * 切换模式：按一次开始，再按一次结束。
 */
export class HotkeyManager {
  private accelerator = '';
  private cancelKey = '';
  private mode: TriggerMode = 'hold';
  private handlers: HotkeyHandlers | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private holdTimer: NodeJS.Timeout | null = null;
  private cancelRegistered = false;
  private holding = false;
  /** 快捷键是否成功注册 */
  private registered = false;
  /** 最近一次注册失败的原因 */
  private lastError: string | undefined;
  /**
   * 主键是否按下的探测函数。
   * 默认读物理按键状态；自检时替换成可控的模拟值。
   */
  private keyStateProbe: (() => boolean) | null = null;

  /** 自检用：接管「主键是否按下」的判断。 */
  setKeyStateProbe(probe: (() => boolean) | null): void {
    this.keyStateProbe = probe;
  }

  private triggerKeyDown(): boolean {
    if (this.keyStateProbe) return this.keyStateProbe();
    const vk = virtualKeyOf(mainKeyOf(this.accelerator));
    return vk ? isKeyDown(vk) : false;
  }

  /**
   * 应用新的快捷键配置。
   * @returns 注册是否成功
   */
  apply(
    accelerator: string,
    mode: TriggerMode,
    cancelKey: string,
    handlers: HotkeyHandlers,
  ): boolean {
    this.dispose();
    this.handlers = handlers;
    this.mode = mode;
    this.cancelKey = cancelKey;
    this.registered = false;
    this.lastError = undefined;

    if (!accelerator) {
      this.lastError = '快捷键为空';
      log.error('hotkey', '快捷键为空');
      return false;
    }

    // 先记下来：即使注册失败也要知道「用户想用哪个组合」，
    // 否则后面解析主键会拿到空字符串。
    this.accelerator = accelerator;

    const ok = globalShortcut.register(accelerator, () => {
      this.handleTrigger();
    });

    if (!ok) {
      this.lastError = `快捷键 ${accelerator} 注册失败，可能已被其它程序或系统占用`;
      log.error('hotkey', this.lastError);
      return false;
    }
    this.registered = true;
    log.info('hotkey', `快捷键 ${accelerator} 注册成功（${mode === 'hold' ? '按住说话' : '切换模式'}）`);
    return true;
  }

  /** 当前快捷键是否成功注册。 */
  get isRegistered(): boolean {
    return this.registered;
  }

  /** 最近一次注册失败的原因。 */
  get error(): string | undefined {
    return this.lastError;
  }

  /** 录音开始时注册取消键。 */
  registerCancelKey(): void {
    if (this.cancelRegistered || !this.cancelKey) return;
    const ok = globalShortcut.register(this.cancelKey, () => {
      log.info('hotkey', `取消键 ${this.cancelKey} 被按下`);
      this.handlers?.onCancel();
    });
    this.cancelRegistered = ok;
    if (!ok) log.warn('hotkey', `取消键 ${this.cancelKey} 注册失败`);
  }

  unregisterCancelKey(): void {
    if (!this.cancelRegistered) return;
    globalShortcut.unregister(this.cancelKey);
    this.cancelRegistered = false;
  }

  /** 自检用：模拟快捷键被触发一次（走的是和真实快捷键完全相同的路径）。 */
  triggerForTest(): void {
    this.handleTrigger();
  }

  /**
   * 快捷键被触发。
   *
   * 注意：Windows 在按住组合键时会**自动重复**地发 WM_HOTKEY，
   * 所以按住模式下会连续收到很多次触发。必须靠 `holding` 把重复挡掉，
   * 否则会出现「开始录音 → 立刻结束 → 再开始」的抖动。
   */
  private handleTrigger(): void {
    if (this.mode === 'toggle') {
      this.handlers?.onDown();
      return;
    }

    // 按住不放时的系统自动重复：直接忽略
    if (this.holding) return;

    // 按住模式：开始录音并轮询主键状态
    this.holding = true;
    this.handlers?.onDown();

    const vk = virtualKeyOf(mainKeyOf(this.accelerator));
    if (!vk) {
      log.warn('hotkey', '无法解析主键虚拟键码，改为由再次触发来结束');
      this.holding = false;
      return;
    }

    this.pollTimer = setInterval(() => {
      if (!this.holding) return;
      if (!this.triggerKeyDown()) {
        // 先清状态再回调：回调里可能会再次触发
        this.holding = false;
        this.stopPolling();
        this.handlers?.onUp();
      }
    }, POLL_INTERVAL_MS);

    // 兜底：防止用户一直按着不放。
    // 注意这里**不清 holding**：主键还按着，就不该允许开下一轮。
    // 轮询继续跑着，等用户真的松手时再收尾。
    this.holdTimer = setTimeout(() => {
      if (!this.holding) return;
      log.warn('hotkey', '录音超过最大时长，自动结束');
      this.handlers?.onUp();
    }, MAX_HOLD_MS);
  }

  /** 当前是否处于「按住」状态。 */
  get isHolding(): boolean {
    return this.holding;
  }

  /**
   * 触发键此刻是否还被物理按着。
   *
   * 按住模式用它守住一条不变量：**必须先松手，才能开始下一次录音**。
   * 否则系统自动重复的快捷键会在上一轮处理完后又开一轮新的。
   */
  isTriggerKeyDown(): boolean {
    return this.triggerKeyDown();
  }

  /** 只停轮询，不动 holding 状态（holding 由轮询自己清）。 */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  /**
   * 强制结束「按住」状态（取消录音时用）。
   * 正常松手走的是轮询检测那条路径，不会调到这里。
   */
  endHold(): void {
    this.holding = false;
    this.stopPolling();
  }

  dispose(): void {
    this.endHold();
    this.unregisterCancelKey();
    if (this.accelerator) {
      globalShortcut.unregister(this.accelerator);
      this.accelerator = '';
    }
    this.registered = false;
  }
}

export const hotkey = new HotkeyManager();
