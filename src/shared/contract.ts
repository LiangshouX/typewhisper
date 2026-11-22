/**
 * 轻语 QingYu — 主进程与渲染进程之间的共享契约。
 *
 * 这个文件是唯一的「真源」：主进程实现它，渲染进程（设置页）消费它。
 * 任何一方改动接口时，请同步改这里。
 */

/* ------------------------------------------------------------------ */
/* 设置结构                                                             */
/* ------------------------------------------------------------------ */

/** 触发方式：按住说话 / 按一次开始再按一次结束 */
export type TriggerMode = 'hold' | 'toggle';

/** 文本插入方式：直接敲键盘 / 走剪贴板粘贴 */
export type InsertMode = 'type' | 'clipboard';

/**
 * 识别语种。
 *
 * 只保留实际会用到的：自动 / 中文 / 英文。
 * （SenseVoice 本身还支持粤语、日语、韩语，但用不上就不摆出来。）
 */
export type LlmLanguage = 'auto' | 'zh' | 'en';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * 用户自定义术语（个性化常用词），用于纠偏时给大模型做参考。
 * - `term`：目标词，例如「飞书」
 * - `replacement`：可选的规范写法，例如「大模型」。留空表示只作为「可能出现该词」的提示。
 * - `note`：可选备注，给用户自己看的说明。
 */
export interface TermEntry {
  term: string;
  replacement?: string;
  note?: string;
}

export interface HotkeySettings {
  /** Electron accelerator，例如 "Control+Alt+V" */
  accelerator: string;
  /** 按住说话 / 切换 */
  mode: TriggerMode;
  /** 录音中用于放弃本次识别的按键，例如 "Escape" */
  cancelKey: string;
  /** 触发后是否先清空剪贴板（避免误粘贴旧内容） */
  clearClipboardOnTrigger: boolean;
}

export interface AsrSettings {
  /** 模型根目录，默认指向 DSH 已下载的 models 目录 */
  modelRoot: string;
  /** 可选：单独指定 SenseVoice onnx 文件（留空则自动在 modelRoot 下探测） */
  senseVoiceModel?: string;
  /** 可选：单独指定 tokens.txt */
  tokens?: string;
  /** 可选：单独指定 silero VAD onnx 文件 */
  vadModel?: string;
  /** 推理线程数 */
  threads: number;
  /** 识别语种提示 */
  language: LlmLanguage;
  /** VAD 语音判定阈值，越小越灵敏 */
  vadThreshold: number;
  /** 最短有效语音段（秒） */
  minSpeechSeconds: number;
  /** 静音多久算一句结束（秒） */
  minSilenceSeconds: number;
  /** 单段最长语音（秒） */
  maxSpeechSeconds: number;
  /** 是否开启逆文本正则化（数字/符号规范化） */
  itn: boolean;
}

export interface LlmSettings {
  /** 是否启用大模型纠偏 */
  enabled: boolean;
  /** OpenAI 兼容协议地址，例如 https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  /** 模型名，例如 deepseek-chat */
  model: string;
  temperature: number;
  /** 纠偏时间阈值（毫秒）。超过就放弃纠偏，直接录入原始识别文本。 */
  timeoutMs: number;
  /** 从松开热键到文本落地的总延迟上限（毫秒）。超过就直接录入原始文本。 */
  maxTotalLatencyMs: number;
  /** 纠偏超时后是否使用「已经流式收到的不完整结果」 */
  usePartialOnTimeout: boolean;
  /** 是否流式请求（首字更快） */
  streaming: boolean;
  /**
   * 强制关闭模型的「深度思考」。
   *
   * 会附带 `enable_thinking: false` 与 `thinking: {type:'disabled'}` 两个约定俗成的参数；
   * 如果对端不认这些参数（严格校验会报 400），会自动去掉它们重试一次。
   */
  disableThinking: boolean;
  /** 追加的自定义 system 提示词 */
  extraSystemPrompt: string;
  /** 个性化常用词表 */
  terms: TermEntry[];
}

/**
 * 一次大模型调用的完整记录（可观测性用）。
 *
 * 即便纠偏因为超过阈值没赶上、最终没写进正文，
 * 这条请求本身也已经发出去了，响应也会在后台补齐 —— 不留下「黑箱」。
 */
export interface LlmTrace {
  /** 发出的时间戳 */
  at: number;
  /** 请求地址 */
  url: string;
  /** 请求头（API Key 已打码） */
  headers: Record<string, string>;
  /** 请求体 */
  requestBody: unknown;
  /** 主流程实际等了多久（毫秒） */
  waitedMs: number;
  /** 是否因为超过阈值而放弃等待 */
  timedOut: boolean;
  /** 响应状态码（还没拿到时为 undefined） */
  status?: number;
  /** 响应体原文 */
  responseBody?: string;
  /** 响应真正到达的时间戳 */
  respondedAt?: number;
  /** 纠偏后的文本 */
  correctedText?: string;
  /** 出错信息 */
  error?: string;
}

export interface InputSettings {
  /** 插入方式 */
  mode: InsertMode;
  /** 剪贴板模式下，粘贴完是否还原用户原来的剪贴板 */
  restoreClipboard: boolean;
  /** 插入后是否补一个空格 */
  trailingSpace: boolean;
}

export interface AdvancedSettings {
  logLevel: LogLevel;
  /** 开机自启 */
  autoLaunch: boolean;
  /** 启动时最小化到托盘 */
  startMinimized: boolean;
  /** 录音时显示悬浮 HUD */
  showHud: boolean;
}

export interface UiSettings {
  /** 主题：跟随系统 / 亮色 / 暗色 */
  theme: 'system' | 'light' | 'dark';
}

export interface AppSettings {
  version: number;
  hotkey: HotkeySettings;
  asr: AsrSettings;
  llm: LlmSettings;
  input: InputSettings;
  advanced: AdvancedSettings;
  ui: UiSettings;
}

/* ------------------------------------------------------------------ */
/* 运行时状态                                                           */
/* ------------------------------------------------------------------ */

export type PipelineStage =
  | 'idle'
  | 'recording'
  | 'decoding'
  | 'correcting'
  | 'injecting'
  | 'done'
  | 'error';

export interface AppStatus {
  /** 当前阶段 */
  stage: PipelineStage;
  /** 是否正在录音 */
  recording: boolean;
  /** 模型是否就绪 */
  modelReady: boolean;
  /** 模型错误信息 */
  modelError?: string;
  /** 纠偏是否可用（已启用且配置完整） */
  llmReady: boolean;
  /** 纠偏不可用原因 */
  llmError?: string;
  /** 当前快捷键 */
  accelerator: string;
  /** 快捷键是否成功注册（被别的程序或系统占用时会失败） */
  hotkeyReady: boolean;
  /** 快捷键注册失败的原因 */
  hotkeyError?: string;
  /** 麦克风不可用的原因 */
  captureError?: string;
  /** 麦克风是否已经打开（按需打开时，从按键到设备就绪有几百毫秒） */
  micReady?: boolean;
  /** 最近一次结果摘要 */
  lastResult?: LastResult;
}

/** 一次识别的完整结果与耗时拆解 */
export interface LastResult {
  /** 原始识别文本 */
  raw: string;
  /** 最终写入的文本 */
  final: string;
  /** 是否用上了纠偏结果 */
  corrected: boolean;
  /** 没有纠偏的原因，例如 "timeout" / "disabled" / "error" */
  reason?: string;
  /** 识别耗时 ms */
  asrMs: number;
  /** 纠偏耗时 ms（未走纠偏为 0） */
  llmMs: number;
  /** 总耗时 ms（从松开热键到写入） */
  totalMs: number;
  /** 识别到的语音秒数 */
  audioSeconds: number;
  /** 时间戳 */
  at: number;
}

/* ------------------------------------------------------------------ */
/* 模型探测结果                                                         */
/* ------------------------------------------------------------------ */

export interface ModelProbeResult {
  ok: boolean;
  /** 解析到的模型根目录 */
  modelRoot: string;
  /** 解析到的 SenseVoice onnx */
  senseVoiceModel?: string;
  /** 解析到的 tokens.txt */
  tokens?: string;
  /** 解析到的 VAD onnx */
  vadModel?: string;
  /** 人类可读的错误 */
  error?: string;
}

/* ------------------------------------------------------------------ */
/* IPC 通道                                                             */
/* ------------------------------------------------------------------ */

export const IPC = {
  /* invoke: 渲染 -> 主 */
  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  settingsReset: 'settings:reset',
  settingsPickModelDir: 'settings:pick-model-dir',
  settingsDetectModelDir: 'settings:detect-model-dir',
  settingsOpenLogDir: 'settings:open-log-dir',
  appGetStatus: 'app:get-status',
  asrCheckModels: 'asr:check-models',
  asrTest: 'asr:test',
  llmTest: 'llm:test',
  hotkeySimulate: 'hotkey:simulate',
  llmGetTrace: 'llm:get-trace',
  llmClearTrace: 'llm:clear-trace',
  windowClose: 'window:close',
  windowMinimize: 'window:minimize',

  /* send: 主 -> 渲染 */
  eventStatus: 'event:status',
  eventResult: 'event:result',
  eventLevel: 'event:level',
} as const;

/** 渲染进程可以调用的主进程 API（由 preload 挂到 window.qingyu） */
export interface QingYuApi {
  getSettings(): Promise<AppSettings>;
  patchSettings(patch: DeepPartial<AppSettings>): Promise<AppSettings>;
  resetSettings(): Promise<AppSettings>;
  pickModelDir(): Promise<string | null>;
  detectModelDir(): Promise<string | null>;
  openLogDir(): Promise<void>;
  getStatus(): Promise<AppStatus>;
  checkModels(): Promise<ModelProbeResult>;
  testAsr(): Promise<{ ok: boolean; text: string; ms: number; error?: string }>;
  testLlm(): Promise<{ ok: boolean; text: string; ms: number; error?: string }>;
  simulateHotkey(): Promise<void>;
  closeWindow(): Promise<void>;
  minimizeWindow(): Promise<void>;
  onStatus(cb: (s: AppStatus) => void): () => void;
  onResult(cb: (r: LastResult) => void): () => void;
  /** 录音时的实时音量（0~1 的峰值），用于画电平表 */
  onLevel(cb: (level: number) => void): () => void;
  /** 取上一次大模型调用的完整记录 */
  getLlmTrace(): Promise<LlmTrace | null>;
  /** 清掉记录 */
  clearLlmTrace(): Promise<void>;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[]
    ? U[]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};
