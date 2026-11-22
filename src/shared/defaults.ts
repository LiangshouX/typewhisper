import type { AppSettings } from './contract.js';

/**
 * 默认设置。
 *
 * 这个文件会被渲染进程打包，所以**不能**引入任何 node 内置模块。
 * 模型目录这类与运行环境相关的默认值由主进程在首次加载时补齐
 * （见 src/main/defaults.ts）。
 */

export const SETTINGS_VERSION = 1;

/** 渲染进程用这个占位符展示「未设置」。 */
export const MODEL_ROOT_PLACEHOLDER = '（使用 DSH 内置模型目录）';

export function defaultSettings(): AppSettings {
  return {
    version: SETTINGS_VERSION,
    hotkey: {
      // 默认走 Ctrl+Win 这一组：公司内网的机器不装微信，不会撞车。
      // 注意 **不能用 Ctrl+Win+V / Ctrl+Win+Space / Ctrl+Win+D** ——
      // 这三个被 Windows 11 自己占了（语音输入 / 语言切换 / 显示桌面），
      // 实测注册会直接失败。字母用 K，任意但好按。
      accelerator: 'Control+Super+K',
      mode: 'hold',
      cancelKey: 'Escape',
      clearClipboardOnTrigger: false,
    },
    asr: {
      modelRoot: '',
      senseVoiceModel: '',
      tokens: '',
      vadModel: '',
      threads: 2,
      language: 'auto',
      vadThreshold: 0.5,
      minSpeechSeconds: 0.25,
      minSilenceSeconds: 0.5,
      maxSpeechSeconds: 30,
      itn: true,
    },
    llm: {
      enabled: false,
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
      apiKey: '',
      model: 'mimo-v2.6-flash',
      temperature: 0,
      // 纠偏时间阈值：超过就放弃纠偏，直接录入原始识别文本。
      // 大模型首字通常要 1–3 秒，阈值给到 3000ms 比较稳。
      timeoutMs: 3000,
      // 从松开热键到文本落地的总上限。
      maxTotalLatencyMs: 6000,
      usePartialOnTimeout: false,
      streaming: true,
      // 强制关闭模型的「深度思考」，否则首字会很慢。
      disableThinking: true,
      extraSystemPrompt: '',
      terms: [],
    },
    input: {
      mode: 'type',
      restoreClipboard: true,
      trailingSpace: false,
    },
    advanced: {
      logLevel: 'info',
      autoLaunch: false,
      startMinimized: true,
      showHud: true,
    },
    ui: {
      theme: 'system',
    },
  };
}
