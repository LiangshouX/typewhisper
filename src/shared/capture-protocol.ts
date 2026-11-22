/** 录音窗口与主进程之间的消息协议。 */

export type CaptureCommand =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'ping' };

export type CaptureEvent =
  /** 音频图已就绪（此时**还没有**打开麦克风） */
  | { type: 'ready'; sampleRate: number }
  /** 麦克风已打开，正在采集（openMs = 从发指令到设备打开用了多久） */
  | { type: 'capturing'; sampleRate: number; openMs?: number }
  | { type: 'audio'; pcm: ArrayBuffer }
  | { type: 'stopped' }
  | { type: 'error'; message: string };
