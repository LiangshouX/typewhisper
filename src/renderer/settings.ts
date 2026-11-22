/* =============================================================================
 * Typewhisper · 设置页（渲染进程）
 * -----------------------------------------------------------------------------
 * · 本文件是渲染进程的唯一入口，由 esbuild 打包为 dist/renderer/settings.js
 * · 只通过 window.qingyu（preload 暴露）访问主进程，不碰任何 Node API
 * · 不引入任何第三方依赖，不使用任何前端框架 —— 全部原生 DOM 操作
 * ============================================================================= */

import type {
  AppSettings,
  AppStatus,
  DeepPartial,
  InsertMode,
  LastResult,
  LlmLanguage,
  LlmTrace,
  LogLevel,
  ModelProbeResult,
  QingYuApi,
  TermEntry,
  TriggerMode,
  UiSettings,
} from '../shared/contract.js';

// defaults.ts 是浏览器安全的（不含 node 内置模块），可以直接打包进渲染进程
import { defaultSettings, MODEL_ROOT_PLACEHOLDER } from '../shared/defaults.js';

declare global {
  interface Window {
    qingyu: QingYuApi;
  }
}

/* =============================================================================
 * 一、模块级状态
 * ========================================================================== */

/** preload 注入的主进程 API（可能不存在，例如直接在浏览器里打开本页面） */
const api: QingYuApi | null =
  (window as unknown as { qingyu?: QingYuApi }).qingyu ?? null;

/** 上一次保存成功的设置 —— 用于计算差异 patch */
let baseline: AppSettings | null = null;

/** 当前正在编辑的草稿 —— 所有控件读写它 */
let draft: AppSettings | null = null;

/** 兜底默认值（来自 shared/defaults.ts），主进程读取失败时使用 */
const FALLBACK = defaultSettings();

/** 当前选中的分区 id */
let activeSection = 'hotkey';

/** 最近一次识别结果（来自 onResult） */
let lastResult: LastResult | null = null;

/** 最近一次模型探测结果 */
let probeResult: ModelProbeResult | null = null;

/** ASR 测试结果（重渲染后需要保留） */
let asrTestResult: { ok: boolean; text: string; ms: number; error?: string } | null = null;

/** LLM 测试结果 */
let llmTestResult: { ok: boolean; text: string; ms: number; error?: string } | null = null;

/** 探测结果面板（每次重建内容区都要重新登记） */
let probeEl: HTMLElement | null = null;

/** 事件订阅的取消函数 */
const unsubscribes: Array<() => void> = [];

/* =============================================================================
 * 二、DOM 小工具
 * ========================================================================== */

type Child = Node | string | null | undefined | false;

/** 创建一个元素 */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | null | undefined> = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** 按 id 取元素 */
function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** 生成一个线性图标（描边风格） */
function svgIcon(path: string, size = 16): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}

/** 图标路径表 */
const ICON = {
  keyboard:
    'M3 6.5h18v11H3zM7 10h.01M10.5 10h.01M14 10h.01M17 10h.01M7 13.5h10',
  mic: 'M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6',
  spark:
    'M12 3.2l1.7 4.4 4.4 1.7-4.4 1.7L12 15.4l-1.7-4.4L5.9 9.3l4.4-1.7L12 3.2zM18.6 15l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9z',
  sliders: 'M4 8h9M18 8h2M4 16h4M13 16h7M15.5 5.2v5.6M8 13.2v5.6',
  eye: 'M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12zM12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z',
  eyeOff:
    'M3 3l18 18M10.2 10.4a3.2 3.2 0 0 0 4.4 4.4M9.6 5.9A10 10 0 0 1 12 5.8c6 0 9.5 6.2 9.5 6.2a17 17 0 0 1-3 3.8M6.4 6.7A17.6 17.6 0 0 0 2.5 12S6 18.2 12 18.2c1 0 1.9-.2 2.7-.4',
  folder: 'M3 7a2 2 0 0 1 2-2h3.6l1.8 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
  search: 'M11 4.2a6.8 6.8 0 1 0 0 13.6 6.8 6.8 0 0 0 0-13.6zM15.8 15.8l4 4',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4.5V11h-6.5',
  trash: 'M4 7h16M9.5 7V4.8h5V7M6.6 7l.9 12.2h9l.9-12.2',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12.5l4.2 4.2L19 7',
  terminal: 'M5 7l4 4-4 4M12.5 16H19',
  warn: 'M12 8.5v4.2M12 16.2v.6M10.4 4 2.8 17.2A2 2 0 0 0 4.5 20.2h15a2 2 0 0 0 1.7-3L13.6 4a2 2 0 0 0-3.2 0z',
  chevron: 'M9 6l6 6-6 6',
};

/* =============================================================================
 * 三、控件工厂（全部自绘，不依赖原生外观）
 * ========================================================================== */

/** 一行字段：左侧标签，右侧控件 */
function field(spec: {
  label: string;
  /** 标签下方的小字说明 */
  hint?: string;
  /** 单独占一整行的说明（长说明用，不挤在标签列里） */
  wideHint?: string;
  /** 一个或多个控件 */
  control: HTMLElement | HTMLElement[];
  /** 控件占满右侧整列 */
  grow?: boolean;
}): HTMLElement {
  const controls = Array.isArray(spec.control) ? spec.control : [spec.control];
  const control = h(
    'div',
    { class: spec.grow ? 'field__control field__control--grow' : 'field__control' },
    controls,
  );
  const children: Child[] = [
    h('div', { class: 'field__label' }, [
      h('span', { class: 'field__name' }, [spec.label]),
      spec.hint ? h('span', { class: 'field__hint' }, [spec.hint]) : null,
    ]),
    control,
  ];
  if (spec.wideHint) {
    children.push(h('div', { class: 'field__hint field__hint--wide' }, [spec.wideHint]));
  }
  return h('div', { class: 'field' }, children);
}

/** 文本输入框 */
function textInput(opts: {
  get(): string;
  set(v: string): void;
  placeholder?: string;
  mono?: boolean;
  grow?: boolean;
  password?: boolean;
}): HTMLInputElement {
  const input = h('input', {
    class: `input${opts.mono ? ' input--mono' : ''}${opts.grow ? ' input--grow' : ''}`,
    type: opts.password ? 'password' : 'text',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  if (opts.placeholder) input.placeholder = opts.placeholder;
  input.value = opts.get();
  input.addEventListener('input', () => opts.set(input.value));
  input.addEventListener('blur', () => {
    input.value = opts.get();
  });
  return input;
}

/** 数字输入框（inputmode=numeric，带范围钳制与单位） */
function numberInput(opts: {
  get(): number;
  set(v: number): void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  placeholder?: string;
}): HTMLElement {
  const input = h('input', {
    class: 'input input--num',
    type: 'text',
    inputmode: 'numeric',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  if (opts.placeholder) input.placeholder = opts.placeholder;
  input.value = String(opts.get());

  const clamp = (v: number): number => {
    let out = v;
    if (typeof opts.min === 'number') out = Math.max(opts.min, out);
    if (typeof opts.max === 'number') out = Math.min(opts.max, out);
    return out;
  };

  input.addEventListener('input', () => {
    const raw = input.value.replace(/[^\d.\-]/g, '');
    if (input.value !== raw) input.value = raw;
    if (raw === '' || raw === '-' || raw === '.' || raw === '-.') return;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    input.classList.remove('is-invalid');
    opts.set(clamp(parsed));
  });

  input.addEventListener('blur', () => {
    const parsed = Number(input.value);
    if (!Number.isFinite(parsed)) {
      input.value = String(opts.get());
      input.classList.remove('is-invalid');
      return;
    }
    let value = clamp(parsed);
    if (typeof opts.step === 'number' && opts.step > 0) {
      value = Number((Math.round(value / opts.step) * opts.step).toFixed(4));
      value = clamp(value);
    }
    opts.set(value);
    input.value = String(value);
    input.classList.remove('is-invalid');
  });

  const wrap = h('div', { class: 'num-field' }, [input]);
  if (opts.suffix) wrap.append(h('span', { class: 'unit' }, [opts.suffix]));
  return wrap;
}

/** 下拉选择 */
function selectInput<T extends string>(opts: {
  options: { value: T; label: string }[];
  get(): T;
  set(v: T): void;
}): HTMLSelectElement {
  const sel = h('select', { class: 'input' });
  for (const option of opts.options) {
    sel.append(h('option', { value: option.value }, [option.label]));
  }
  sel.value = opts.get();
  sel.addEventListener('change', () => opts.set(sel.value as T));
  return sel;
}

/** 开关（40×22 滑块式） */
function switchInput(opts: { get(): boolean; set(v: boolean): void }): HTMLElement {
  const btn = h('button', {
    class: 'switch',
    type: 'button',
    role: 'switch',
    'aria-checked': 'false',
  });
  const paint = (): void => {
    btn.setAttribute('aria-checked', opts.get() ? 'true' : 'false');
  };
  paint();
  btn.addEventListener('click', () => {
    opts.set(!opts.get());
    paint();
  });
  return btn;
}

/** 拨档式分段控件（滑块指示器带 120ms 缓动） */
function segmented<T extends string>(opts: {
  options: { value: T; label: string; title?: string }[];
  get(): T;
  set(v: T): void;
}): HTMLElement {
  const wrap = h('div', { class: 'toggle', role: 'group' });
  const indicator = h('span', { class: 'toggle__ind' });
  wrap.append(indicator);
  const buttons: HTMLButtonElement[] = [];

  const paint = (): void => {
    const current = opts.get();
    let activeIndex = -1;
    buttons.forEach((btn, index) => {
      const on = opts.options[index].value === current;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) activeIndex = index;
    });
    // 指示器滑到激活项下面
    const active = activeIndex >= 0 ? buttons[activeIndex] : null;
    if (active) {
      indicator.style.width = `${active.offsetWidth}px`;
      indicator.style.transform = `translateX(${active.offsetLeft}px)`;
    }
  };

  for (const option of opts.options) {
    const btn = h('button', {
      class: 'toggle__opt',
      type: 'button',
      'aria-pressed': 'false',
    }, [option.label]);
    if (option.title) btn.title = option.title;
    btn.addEventListener('click', () => {
      opts.set(option.value);
      paint();
    });
    buttons.push(btn);
    wrap.append(btn);
  }
  paint();
  // 窗口尺寸变化后重新对齐
  window.addEventListener('resize', paint);
  return wrap;
}

/** 滑块（自绘轨道 + 数值显示） */
function slider(opts: {
  min: number;
  max: number;
  step: number;
  get(): number;
  set(v: number): void;
  format(v: number): string;
}): HTMLElement {
  const input = h('input', {
    class: 'slider__range',
    type: 'range',
    min: String(opts.min),
    max: String(opts.max),
    step: String(opts.step),
  });
  const value = h('span', { class: 'slider__value' });
  const paint = (v: number): void => {
    const ratio = (v - opts.min) / (opts.max - opts.min);
    input.style.setProperty('--pct', `${(ratio * 100).toFixed(2)}%`);
    value.textContent = opts.format(v);
  };
  input.value = String(opts.get());
  paint(opts.get());
  input.addEventListener('input', () => {
    const v = Number(input.value);
    paint(v);
    opts.set(v);
  });
  return h('div', { class: 'slider' }, [input, value]);
}

/* =============================================================================
 * 四、按键捕获（快捷键录制）
 * ========================================================================== */

/** e.code → Electron accelerator 的主键名 */
function keyNameFromCode(code: string): string | null {
  if (!code) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  const map: Record<string, string> = {
    Escape: 'Escape',
    Enter: 'Enter',
    NumpadEnter: 'Enter',
    Space: 'Space',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    Comma: ',',
    Period: '.',
    Slash: '/',
    NumpadAdd: 'Plus',
    NumpadSubtract: '-',
    NumpadMultiply: '*',
    NumpadDivide: '/',
    NumpadDecimal: '.',
  };
  return map[code] ?? null;
}

/** 修饰键代码表 */
const MODIFIER_CODES: Record<string, string> = {
  ControlLeft: 'Control',
  ControlRight: 'Control',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  MetaLeft: 'Super',
  MetaRight: 'Super',
};

/** 当前按下的修饰键（Electron accelerator 的规范顺序） */
function modifierOrder(e: KeyboardEvent): string[] {
  const list: string[] = [];
  if (e.ctrlKey) list.push('Control');
  if (e.altKey) list.push('Alt');
  if (e.shiftKey) list.push('Shift');
  if (e.metaKey) list.push('Super');
  return list;
}

/** 按键捕获器 */
function createKeyCapture(opts: {
  /** 组合键模式（快捷键）还是单键模式（取消键） */
  combo: boolean;
  /** 单键模式下允许把 Esc 直接录成目标键 */
  allowEscape?: boolean;
  onCommit(value: string): void;
  onState(recording: boolean, preview: string): void;
}): { start(): void; end(): void; isRecording(): boolean } {
  let recording = false;
  let detach: (() => void) | null = null;

  const previewText = (): string => {
    if (!opts.combo) return '按下按键…';
    return '按下修饰键…';
  };

  const end = (): void => {
    if (!recording) return;
    recording = false;
    detach?.();
    detach = null;
    opts.onState(false, '');
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();

    // Esc：组合键模式下取消录制；单键模式下允许把它录成目标键
    if (e.code === 'Escape' && !opts.allowEscape) {
      end();
      return;
    }

    // 只按下修饰键 —— 继续等待主键
    if (MODIFIER_CODES[e.code]) {
      const held = modifierOrder(e)
        .map((mod) => MODIFIER_LABEL[mod] ?? mod)
        .join(' + ');
      opts.onState(true, opts.combo ? `${held} + …` : previewText());
      return;
    }

    const key = keyNameFromCode(e.code);
    if (!key) return;

    if (opts.combo) {
      const mods = modifierOrder(e);
      if (mods.length === 0) {
        opts.onState(true, '至少要有一个修饰键');
        return;
      }
      opts.onCommit([...mods, key].join('+'));
    } else {
      opts.onCommit(key);
    }
    end();
  };

  return {
    isRecording: () => recording,
    end,
    start(): void {
      if (recording) return;
      recording = true;
      detach = () => document.removeEventListener('keydown', onKeyDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      opts.onState(true, previewText());
    },
  };
}

/** 组合键录制器（触发快捷键）—— 键帽造型 */
function createChordRecorder(opts: {
  get(): string;
  set(v: string): void;
  defaultValue: string;
}): HTMLElement {
  const valueEl = h('code', { class: 'keycap__face' }, [formatAccelerator(opts.get())]);
  const recBtn = h('button', { class: 'btn btn--sm', type: 'button' }, ['录制']);
  const defBtn = h('button', { class: 'btn btn--sm btn--ghost', type: 'button', title: '恢复默认' }, [
    '默认',
  ]);

  const capture = createKeyCapture({
    combo: true,
    onCommit(value) {
      opts.set(value);
      valueEl.textContent = formatAccelerator(value);
      toast(`快捷键已设为 ${formatAccelerator(value)}`, 'ok');
    },
    onState(recording, preview) {
      valueEl.classList.toggle('is-recording', recording);
      valueEl.textContent = recording ? preview : formatAccelerator(opts.get());
      recBtn.textContent = recording ? '取消' : '录制';
    },
  });

  recBtn.addEventListener('click', () => {
    if (capture.isRecording()) {
      capture.end();
    } else {
      capture.start();
    }
  });
  defBtn.addEventListener('click', () => {
    opts.set(opts.defaultValue);
    valueEl.textContent = formatAccelerator(opts.get());
  });

  return h('div', { class: 'keycap' }, [valueEl, recBtn, defBtn]);
}

/** 单键录制器（取消按键）—— 键帽式输入框，同时允许直接键入 */
function createSingleKeyRecorder(opts: {
  get(): string;
  set(v: string): void;
  defaultValue: string;
}): HTMLElement {
  const input = h('input', {
    class: 'input input--mono input--cap',
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: 'Escape',
  });
  input.value = opts.get();
  const recBtn = h('button', { class: 'btn btn--sm', type: 'button' }, ['录制']);
  const defBtn = h('button', { class: 'btn btn--sm btn--ghost', type: 'button', title: '恢复默认' }, [
    '默认',
  ]);

  input.addEventListener('input', () => opts.set(input.value.trim()));
  input.addEventListener('blur', () => {
    input.value = opts.get();
  });

  const capture = createKeyCapture({
    combo: false,
    allowEscape: true,
    onCommit(value) {
      opts.set(value);
      input.value = value;
      toast(`取消按键已设为 ${value}`, 'ok');
    },
    onState(recording, preview) {
      input.classList.toggle('is-recording', recording);
      input.readOnly = recording;
      input.value = recording ? preview : opts.get();
      recBtn.textContent = recording ? '取消' : '录制';
    },
  });

  recBtn.addEventListener('click', () => {
    if (capture.isRecording()) {
      capture.end();
    } else {
      capture.start();
    }
  });
  defBtn.addEventListener('click', () => {
    opts.set(opts.defaultValue);
    input.value = opts.get();
  });

  return h('div', { class: 'keycap' }, [input, recBtn, defBtn]);
}

/* =============================================================================
 * 五、设置差异（只提交真正改动的字段）
 * ========================================================================== */

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b) || isPlainObject(a) || isPlainObject(b)) {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

/** 计算 base → next 的深差异（只包含变化的叶子） */
function diffPatch(base: Json, next: Json): Json {
  const patch: Json = {};
  for (const key of Object.keys(next)) {
    const before = base[key];
    const after = next[key];
    if (after === undefined) continue;
    if (isPlainObject(after) && isPlainObject(before)) {
      const sub = diffPatch(before, after);
      if (Object.keys(sub).length > 0) patch[key] = sub;
    } else if (!sameValue(before, after)) {
      patch[key] = after;
    }
  }
  return patch;
}

/** 统计差异条目数 */
function countChanges(patch: Json): number {
  let total = 0;
  for (const value of Object.values(patch)) {
    if (isPlainObject(value)) total += countChanges(value);
    else total += 1;
  }
  return total;
}

/* =============================================================================
 * 六、轻提示
 * ========================================================================== */

function toast(message: string, tone: 'ok' | 'error' | 'info' = 'info'): void {
  const host = byId('toast-host');
  if (!host) return;
  const node = h('div', { class: `toast toast--${tone}` }, [message]);
  host.append(node);
  window.setTimeout(() => {
    node.style.transition = 'opacity .2s';
    node.style.opacity = '0';
    window.setTimeout(() => node.remove(), 240);
  }, 1900);
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/* =============================================================================
 * 七、主题：跟随系统明暗 —— 只换根节点上的变量值，不重渲染组件
 * ========================================================================== */

type Theme = 'light' | 'dark';

/** 主题偏好：跟随系统 / 亮 / 暗 */
type ThemePref = 'system' | 'light' | 'dark';

const THEME_ATTR = 'data-iv-theme';

/**
 * 设置里的 ui 段（主题偏好）。
 * 契约里 ui 是必填，但老配置文件可能还没有这一段 —— 读的时候兜底成「跟随系统」。
 */
function uiOf(settings: AppSettings): UiSettings {
  const theme = settings.ui?.theme;
  return {
    theme: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'system',
  };
}

function setUiOf(settings: AppSettings, ui: UiSettings): void {
  settings.ui = ui;
}

/** 用户选的主题偏好（'system' 时跟随宿主） */
let themePref: ThemePref = 'system';

/** 把主题写到根节点。属性值没变就不写，避免触发观察者自激。 */
function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (root.getAttribute('data-iv-page') !== '1') root.setAttribute('data-iv-page', '1');
  if (root.getAttribute(THEME_ATTR) !== theme) root.setAttribute(THEME_ATTR, theme);
}

/**
 * 当前生效的主题。
 * 'system' → 跟宿主；'light'/'dark' → 用户钉死。
 * 切换只改根节点上的变量值，不重渲染任何组件。
 */
function applyEffectiveTheme(): void {
  const theme: Theme =
    themePref === 'light' ? 'light' : themePref === 'dark' ? 'dark' : hostColorScheme() ?? 'light';
  applyTheme(theme);
}

/**
 * 宿主现在是亮还是暗。三层兜底：
 *  ① 宿主在根节点行内显式声明的 color-scheme（显式指令优先，行内优先级也最高）
 *  ② 系统偏好（桌面应用最可靠的一层，也是 Electron 跟随系统的那一层）
 *  ③ 按底色亮度猜（宿主只换 CSS 变量、不声明 color-scheme 时）
 */
function hostColorScheme(): Theme | undefined {
  if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;

  try {
    const inline = document.documentElement.style?.colorScheme;
    if (inline === 'light' || inline === 'dark') return inline;
  } catch {
    /* 读不到 */
  }

  try {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (media !== undefined && typeof media.matches === 'boolean') {
      return media.matches ? 'dark' : 'light';
    }
  } catch {
    /* 有的 WebView 没有 matchMedia */
  }

  try {
    const probe = document.body ?? document.documentElement;
    const background = window.getComputedStyle?.(probe)?.backgroundColor ?? '';
    const rgb = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(background);
    if (rgb !== null) {
      const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
      const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      return luminance > 0.5 ? 'light' : 'dark';
    }
  } catch {
    /* 读不到 */
  }

  return undefined;
}

/**
 * 盯着宿主主题的变化。
 * **为什么不用定时器**：每秒读一次 getComputedStyle 会逼浏览器做样式重算，
 * 而「空闲时不重渲染」是桌面应用的硬要求。宿主换主题只有两种方式
 * （改根节点行内样式 / 换 <head> 样式表），MutationObserver 都能抓到。
 */
function watchHostScheme(onChange: (theme: Theme) => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  let frame = 0;
  let last: Theme | undefined;

  const read = (): void => {
    const next = hostColorScheme();
    if (next === undefined || next === last) return;
    last = next;
    onChange(next);
  };
  read();

  const schedule = (): void => {
    if (frame !== 0) return;
    if (typeof window.requestAnimationFrame === 'function') {
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        read();
      });
    } else {
      frame = window.setTimeout(() => {
        frame = 0;
        read();
      }, 120);
    }
  };
  const disposers: Array<() => void> = [];
  try {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (media !== undefined && typeof media.addEventListener === 'function') {
      media.addEventListener('change', schedule);
      disposers.push(() => media.removeEventListener('change', schedule));
    }
  } catch {
    /* 有的 WebView 没有 matchMedia */
  }
  try {
    const Observer = window.MutationObserver;
    if (typeof Observer === 'function') {
      const observer = new Observer(schedule);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style', 'class', 'data-theme', THEME_ATTR],
      });
      if (document.head !== null && document.head !== undefined) {
        observer.observe(document.head, { childList: true, subtree: true, characterData: true });
      }
      disposers.push(() => observer.disconnect());
    }
  } catch {
    /* 观察不了就只在挂载时读一次 */
  }

  return () => {
    if (frame !== 0) {
      if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame);
      else window.clearTimeout(frame);
      frame = 0;
    }
    for (const dispose of disposers) dispose();
  };
}

/* =============================================================================
 * 八、快捷键的友好写法
 * ========================================================================== */

/** Electron accelerator 里的修饰键 → 友好写法 */
const MODIFIER_LABEL: Record<string, string> = {
  Control: 'Ctrl',
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl',
  Alt: 'Alt',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  Shift: 'Shift',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  Super: 'Win',
  SuperLeft: 'Win',
  SuperRight: 'Win',
  Meta: 'Win',
  MetaLeft: 'Win',
  MetaRight: 'Win',
  CommandOrControl: 'Ctrl',
  CmdOrCtrl: 'Ctrl',
  Command: 'Win',
};

/** 修饰键的归一顺序 */
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Win'];

/** Control+Super+K → Ctrl + Win + K（主键大写，修饰键按 Ctrl/Alt/Shift/Win 归一） */
function formatAccelerator(accelerator: string): string {
  const parts = accelerator
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const mods: string[] = [];
  let main = '';
  for (const part of parts) {
    const label = MODIFIER_LABEL[part];
    if (label !== undefined) {
      if (!mods.includes(label)) mods.push(label);
    } else {
      main = part;
    }
  }
  mods.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  const key = main.length === 1 ? main.toUpperCase() : main;
  return [...mods, key].filter((part) => part !== '').join(' + ');
}

/* =============================================================================
 * 九、状态条与结果面板
 * ========================================================================== */

const STAGE_LABEL: Record<AppStatus['stage'], string> = {
  idle: '空闲',
  recording: '录音中',
  decoding: '识别中',
  correcting: '纠偏中',
  injecting: '写入中',
  done: '完成',
  error: '出错',
};

/** 未纠偏的原因 → 中文说明 */
const REASON_LABEL: Record<string, string> = {
  timeout: '超时',
  disabled: '未启用',
  error: '出错',
  skipped: '已跳过',
  off: '未启用',
};

/** 当前音量（0~1）与峰值保持 */
let currentLevel = 0;
let peakLevel = 0;

/** 收到实时音量 */
function applyLevel(level: number): void {
  if (!Number.isFinite(level)) return;
  // 不在录音状态就忽略（主进程偶尔还会补发最后一帧）
  const box = byId('level');
  if (box && !box.classList.contains('is-on')) return;
  currentLevel = Math.max(0, Math.min(1, level));
  if (currentLevel > peakLevel) peakLevel = currentLevel;
  paintLevel();
}

/** 刷新电平表 */
function paintLevel(): void {
  const box = byId('level');
  const fill = byId('level-fill');
  const peak = byId('level-peak');
  const value = byId('level-value');
  if (!box || !fill || !peak || !value) return;

  box.classList.toggle('is-high', currentLevel >= 0.8 && currentLevel < 0.98);
  box.classList.toggle('is-max', currentLevel >= 0.98);
  fill.style.width = `${(currentLevel * 100).toFixed(1)}%`;
  peak.style.left = `${Math.min(100, peakLevel * 100).toFixed(1)}%`;
  value.textContent = currentLevel.toFixed(2);
}

function applyStatus(status: AppStatus): void {
  const stage = byId('stage');
  if (stage) {
    stage.setAttribute('data-stage', status.stage);
    const text = stage.querySelector('.stage__text');
    if (text) text.textContent = STAGE_LABEL[status.stage] ?? status.stage;
  }

  const modelChip = byId('chip-model');
  if (modelChip) {
    if (status.modelReady) {
      modelChip.setAttribute('data-tone', 'ok');
      modelChip.textContent = '模型 就绪';
    } else {
      modelChip.setAttribute('data-tone', 'error');
      modelChip.textContent = `模型 未就绪${status.modelError ? `：${status.modelError}` : ''}`;
    }
  }

  const llmChip = byId('chip-llm');
  if (llmChip) {
    if (status.llmReady) {
      llmChip.setAttribute('data-tone', 'ok');
      llmChip.textContent = '纠偏 可用';
    } else {
      llmChip.setAttribute('data-tone', 'warn');
      llmChip.textContent = `纠偏 不可用${status.llmError ? `：${status.llmError}` : ''}`;
    }
  }

  const accel = byId('current-accel');
  if (accel) accel.textContent = formatAccelerator(status.accelerator || '');

  // 快捷键注册失败（被系统或别的程序占用）—— 给一行「出路」
  const hotkeyBlock = byId('hotkey-block');
  const hotkeyError = byId('hotkey-error');
  const ready = status.hotkeyReady !== false;
  if (hotkeyBlock) hotkeyBlock.classList.toggle('is-error', !ready);
  if (hotkeyError) {
    if (ready) {
      hotkeyError.hidden = true;
      hotkeyError.textContent = '';
    } else {
      hotkeyError.hidden = false;
      hotkeyError.textContent = `${status.hotkeyError ?? '快捷键注册失败'} · 到「快捷键」换一个组合`;
    }
  }

  // 电平表只在录音时出现
  const recording = status.stage === 'recording' || status.recording;
  const levelBox = byId('level');
  if (levelBox) {
    levelBox.classList.toggle('is-on', recording);
    if (!recording) {
      currentLevel = 0;
      peakLevel = 0;
    }
  }
  paintLevel();
}

function applyResult(result: LastResult): void {
  lastResult = result;
  const panel = document.querySelector<HTMLElement>('.result');
  if (panel) renderResultInto(panel);
}

/** 结果面板骨架 —— 延迟预算仪表 + 文本对比 */
const RESULT_SKELETON = `
  <div class="result__head">
    <span class="micro">LAST RESULT · 最近一次识别</span>
    <span class="result__time" data-role="time"></span>
  </div>

  <div class="gauge" data-role="gauge">
    <div class="gauge__head">
      <span class="micro">LATENCY BUDGET · 延迟预算</span>
      <span class="gauge__state micro" data-role="gauge-state">—</span>
    </div>
    <div class="gauge__track">
      <span class="gauge__seg gauge__seg--asr" data-role="seg-asr"></span>
      <span class="gauge__seg gauge__seg--llm" data-role="seg-llm"></span>
      <span class="gauge__seg gauge__seg--rest" data-role="seg-rest"></span>
      <span class="gauge__marker" data-role="marker"><b data-role="marker-label"></b></span>
    </div>
    <div class="gauge__scale">
      <span class="micro">0 ms</span>
      <span class="micro" data-role="scale-max"></span>
    </div>
    <div class="gauge__legend">
      <span class="lgd"><i class="lgd__dot" style="background: var(--iv-jade)"></i>识别 ASR</span>
      <span class="lgd"><i class="lgd__dot" style="background: var(--iv-amber)"></i>纠偏 CORRECT</span>
      <span class="lgd"><i class="lgd__dot" style="background: var(--iv-ink700)"></i>其它余量 REST</span>
    </div>
    <div class="gauge__readout">
      <div class="readout__cell readout__cell--total">
        <span class="micro">总耗时 TOTAL</span>
        <span class="readout__value" data-role="total">—<em>ms</em></span>
      </div>
      <div class="readout__cell">
        <span class="micro">识别 ASR</span>
        <span class="readout__value" data-role="asr">—<em>ms</em></span>
      </div>
      <div class="readout__cell">
        <span class="micro">纠偏 CORRECT</span>
        <span class="readout__value" data-role="llm">—<em>ms</em></span>
      </div>
    </div>
  </div>

  <div class="result__grid" data-role="grid">
    <div>
      <div class="result__k"><span class="micro">原始识别 RAW</span></div>
      <p class="result__text" data-role="raw">—</p>
    </div>
    <div>
      <div class="result__k">
        <span class="micro">最终写入 FINAL</span>
        <span data-role="badge"></span>
      </div>
      <p class="result__text result__text--final" data-role="final">—</p>
    </div>
  </div>
`;

function buildResultPanel(): HTMLElement {
  const panel = h('div', { class: 'result' });
  panel.innerHTML = RESULT_SKELETON;
  renderResultInto(panel);
  return panel;
}

/** 渲染耗时预算仪表与文本对比 */
function renderResultInto(panel: HTMLElement): void {
  const role = (name: string): HTMLElement | null =>
    panel.querySelector<HTMLElement>(`[data-role="${name}"]`);

  const grid = role('grid');
  const gauge = role('gauge');
  const time = role('time');
  const raw = role('raw');
  const final = role('final');
  const badge = role('badge');

  const result = lastResult;

  if (!result) {
    if (grid) grid.style.display = 'none';
    if (gauge) gauge.style.display = 'none';
    if (time) time.textContent = '';
    panel.querySelector('.result__empty')?.remove();
    panel.append(
      h('p', { class: 'result__empty' }, [
        '还没有识别记录。按住上面那个快捷键说一句话，这里会显示识别结果与延迟预算。',
      ]),
    );
    return;
  }

  if (grid) grid.style.display = '';
  if (gauge) gauge.style.display = '';
  panel.querySelector('.result__empty')?.remove();

  if (time) {
    const date = new Date(result.at);
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    time.textContent = `${hh}:${mm}:${ss} · 语音 ${result.audioSeconds.toFixed(1)}s`;
  }

  if (raw) raw.textContent = result.raw || '（空）';
  if (final) final.textContent = result.final || '（空）';

  if (badge) {
    badge.textContent = '';
    if (result.corrected) {
      badge.className = 'badge badge--ok';
      badge.textContent = '已纠偏';
    } else {
      badge.className = 'badge badge--muted';
      const reason = result.reason ? REASON_LABEL[result.reason] ?? result.reason : '';
      badge.textContent = reason ? `未纠偏 · ${reason}` : '未纠偏';
    }
  }

  renderGauge(result);
}

/** 渲染延迟预算仪表 */
function renderGauge(result: LastResult): void {
  const gauge = document.querySelector<HTMLElement>('[data-role="gauge"]');
  if (!gauge) return;

  // 刻度基准：总延迟上限
  const budget = Math.max(
    draft?.llm.maxTotalLatencyMs ?? 2500,
    1,
  );
  const timeoutMs = Math.max(draft?.llm.timeoutMs ?? 1200, 0);
  const over = result.totalMs > budget;

  gauge.classList.toggle('is-over', over);
  gauge.classList.toggle('is-ok', !over);

  const pct = (value: number): number => Math.min(100, (value / budget) * 100);

  const segAsr = gauge.querySelector<HTMLElement>('[data-role="seg-asr"]');
  const segLlm = gauge.querySelector<HTMLElement>('[data-role="seg-llm"]');
  const segRest = gauge.querySelector<HTMLElement>('[data-role="seg-rest"]');

  // 累计位置一律夹在 [0, 100]：超预算时整条填满而不是溢出轨道
  const asrEnd = Math.min(100, (result.asrMs / budget) * 100);
  const llmEnd = Math.min(100, ((result.asrMs + result.llmMs) / budget) * 100);
  const totalEnd = Math.min(100, (result.totalMs / budget) * 100);

  if (segAsr) {
    segAsr.style.left = '0%';
    segAsr.style.width = `${asrEnd}%`;
  }
  if (segLlm) {
    segLlm.style.left = `${asrEnd}%`;
    segLlm.style.width = `${Math.max(0, llmEnd - asrEnd)}%`;
  }
  if (segRest) {
    segRest.style.left = `${llmEnd}%`;
    segRest.style.width = `${Math.max(0, totalEnd - llmEnd)}%`;
  }

  // 阈值标记：纠偏超时点（超出刻度范围时不画）
  const marker = gauge.querySelector<HTMLElement>('[data-role="marker"]');
  const markerLabel = gauge.querySelector<HTMLElement>('[data-role="marker-label"]');
  if (marker) {
    const inScale = timeoutMs > 0 && timeoutMs <= budget;
    const pos = pct(timeoutMs);
    marker.style.display = inScale ? '' : 'none';
    marker.style.left = `${pos}%`;
    marker.classList.toggle('gauge__marker--flip', inScale && pos > 80);
  }
  if (markerLabel) markerLabel.textContent = `上限 ${timeoutMs}ms`;

  const scaleMax = gauge.querySelector<HTMLElement>('[data-role="scale-max"]');
  if (scaleMax) scaleMax.textContent = `总预算 ${budget} ms`;

  const state = gauge.querySelector<HTMLElement>('[data-role="gauge-state"]');
  if (state) {
    state.textContent = over
      ? `超预算 ${result.totalMs - budget} ms`
      : `预算内 · 余量 ${budget - result.totalMs} ms`;
  }

  const setReadout = (name: string, value: number): void => {
    const node = gauge.querySelector<HTMLElement>(`[data-role="${name}"]`);
    if (!node) return;
    node.textContent = '';
    node.append(document.createTextNode(String(value)));
    node.append(h('em', {}, ['ms']));
  };
  setReadout('total', result.totalMs);
  setReadout('asr', result.asrMs);
  setReadout('llm', result.llmMs);
}

/* =============================================================================
 * 十、分区一：快捷键
 * ========================================================================== */

function buildHotkeySection(): HTMLElement {
  const s = draft!;
  const children: HTMLElement[] = [];

  children.push(
    field({
      label: '触发快捷键',
      hint: '全局生效，任意软件里都能唤起录音。点「录制」后按下组合键，Esc 取消',
      control: createChordRecorder({
        get: () => s.hotkey.accelerator,
        set: (v) => {
          s.hotkey.accelerator = v;
          markDirty();
        },
        defaultValue: FALLBACK.hotkey.accelerator,
      }),
    }),
  );

  children.push(
    field({
      label: '触发方式',
      hint: '按住说话，还是按一次开始、再按一次结束',
      control: segmented<TriggerMode>({
        options: [
          { value: 'hold', label: '按住说话', title: '按住快捷键开始录音，松开立即识别' },
          { value: 'toggle', label: '切换开关', title: '按一次开始录音，再按一次结束' },
        ],
        get: () => s.hotkey.mode,
        set: (v) => {
          s.hotkey.mode = v;
          markDirty();
        },
      }),
    }),
  );

  children.push(
    field({
      label: '取消按键',
      hint: '录音过程中按下此键放弃本次识别。也可以直接键入键名',
      control: createSingleKeyRecorder({
        get: () => s.hotkey.cancelKey,
        set: (v) => {
          s.hotkey.cancelKey = v;
          markDirty();
        },
        defaultValue: FALLBACK.hotkey.cancelKey,
      }),
    }),
  );

  children.push(
    field({
      label: '触发时清空剪贴板',
      hint: '剪贴板插入模式下先清空剪贴板，避免误贴到旧内容',
      control: switchInput({
        get: () => s.hotkey.clearClipboardOnTrigger,
        set: (v) => {
          s.hotkey.clearClipboardOnTrigger = v;
          markDirty();
        },
      }),
    }),
  );

  children.push(
    h('div', { class: 'note' }, [
      h('div', {}, [
        h('strong', {}, ['按住说话（推荐）']),
        '：按住快捷键即开始录音，松开就结束识别 —— 延迟最低，适合边想边说。',
      ]),
      h('div', {}, [
        h('strong', {}, ['切换开关']),
        '：第一次按下开始录音，再按一次停止 —— 适合长段落输入，或不方便一直按住快捷键的场景。',
      ]),
    ]),
  );

  return section('01 / HOTKEY & TRIGGER', '快捷键', '设置唤起录音的组合键与触发方式。', children);
}

/* =============================================================================
 * 十一、分区二：语音识别
 * ========================================================================== */

/** 语种只保留三种；旧配置里的其它值一律当「自动」 */
type AsrLanguage = 'auto' | 'zh' | 'en';

function languageOf(settings: AppSettings): AsrLanguage {
  const lang = String(settings.asr.language);
  return lang === 'zh' || lang === 'en' ? lang : 'auto';
}

/** 执行一次模型探测并刷新结果区 */
async function runProbe(): Promise<void> {
  if (!api) return;
  try {
    probeResult = await api.checkModels();
  } catch (err) {
    probeResult = { ok: false, modelRoot: '', error: errorText(err) };
  }
  if (probeEl) renderProbeInto(probeEl);
}

/** 渲染模型探测结果 */
function renderProbeInto(panel: HTMLElement): void {
  panel.textContent = '';
  panel.classList.remove('probe--ok', 'probe--error');

  const result = probeResult;
  if (!result) {
    panel.append(
      h('div', { class: 'probe__title' }, ['尚未检测']),
      h('div', { class: 'probe__text' }, [
        '点击「自动检测」或选择目录后会立即探测模型文件。页面加载时也会自动检测一次。',
      ]),
    );
    return;
  }

  if (!result.ok) {
    panel.classList.add('probe--error');
    panel.append(
      h('div', { class: 'probe__title' }, ['检测失败']),
      h('div', { class: 'probe__text probe__text--err' }, [result.error ?? '未知错误']),
    );
    return;
  }

  panel.classList.add('probe--ok');
  panel.append(h('div', { class: 'probe__title' }, ['检测通过']));

  const rows: [string, string | undefined][] = [
    ['MODEL ROOT', result.modelRoot],
    ['SENSEVOICE', result.senseVoiceModel],
    ['TOKENS', result.tokens],
    ['VAD', result.vadModel],
  ];
  const list = h('div', { class: 'probe__list' });
  for (const [key, value] of rows) {
    if (!value) continue;
    list.append(h('span', { class: 'probe__k' }, [key]));
    list.append(h('span', { class: 'probe__v' }, [value]));
  }
  panel.append(list);
}

function buildAsrSection(): HTMLElement {
  const s = draft!;
  const children: HTMLElement[] = [];

  const modelInput = h('input', {
    class: 'input input--mono input--grow',
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  modelInput.value = s.asr.modelRoot;

  /** 模型目录为空时，用占位文案说明「用的是 DSH 内置目录」 */
  const syncModelPlaceholder = (): void => {
    modelInput.placeholder = s.asr.modelRoot.trim()
      ? '模型根目录'
      : MODEL_ROOT_PLACEHOLDER;
  };
  syncModelPlaceholder();

  modelInput.addEventListener('input', () => {
    s.asr.modelRoot = modelInput.value.trim();
    syncModelPlaceholder();
    markDirty();
  });
  modelInput.addEventListener('blur', () => {
    modelInput.value = s.asr.modelRoot;
    syncModelPlaceholder();
  });

  const browseBtn = h('button', { class: 'btn', type: 'button' }, ['浏览…']);
  const detectBtn = h('button', { class: 'btn', type: 'button' }, ['自动检测']);
  const probeBox = h('div', { class: 'probe' });
  probeEl = probeBox;
  renderProbeInto(probeBox);

  browseBtn.addEventListener('click', async () => {
    if (!api) return;
    browseBtn.disabled = true;
    try {
      const dir = await api.pickModelDir();
      if (!dir) return;
      s.asr.modelRoot = dir;
      modelInput.value = dir;
      syncModelPlaceholder();
      markDirty();
      await runProbe();
    } catch (err) {
      toast(`选择目录失败：${errorText(err)}`, 'error');
    } finally {
      browseBtn.disabled = false;
    }
  });

  detectBtn.addEventListener('click', async () => {
    if (!api) return;
    detectBtn.disabled = true;
    try {
      const dir = await api.detectModelDir();
      if (dir) {
        s.asr.modelRoot = dir;
        modelInput.value = dir;
        syncModelPlaceholder();
        markDirty();
      } else {
        toast('没有找到可用的模型目录', 'error');
      }
      await runProbe();
    } catch (err) {
      toast(`自动检测失败：${errorText(err)}`, 'error');
    } finally {
      detectBtn.disabled = false;
    }
  });

  children.push(
    field({
      label: '模型目录',
      hint: 'SenseVoice / tokens / VAD 模型所在的根目录。留空则使用 DSH 内置目录',
      grow: true,
      control: [modelInput, browseBtn, detectBtn],
    }),
  );
  children.push(probeBox);

  children.push(
    field({
      label: '识别语种',
      hint: 'auto 表示让模型自动判断',
      control: selectInput<AsrLanguage>({
        options: [
          { value: 'auto', label: '自动（推荐）' },
          { value: 'zh', label: '中文' },
          { value: 'en', label: 'English' },
        ],
        get: () => languageOf(s),
        set: (v) => {
          s.asr.language = v;
          markDirty();
        },
      }),
    }),
  );

  children.push(
    field({
      label: '推理线程数',
      hint: '线程越多越快，但占用更多 CPU',
      control: numberInput({
        get: () => s.asr.threads,
        set: (v) => {
          s.asr.threads = v;
          markDirty();
        },
        min: 1,
        max: 8,
        step: 1,
        suffix: 'T',
      }),
    }),
  );

  children.push(
    field({
      label: 'VAD 灵敏度',
      hint: '数值越低越灵敏，越容易把轻声音也当成语音',
      control: slider({
        min: 0,
        max: 1,
        step: 0.05,
        get: () => s.asr.vadThreshold,
        set: (v) => {
          s.asr.vadThreshold = v;
          markDirty();
        },
        format: (v) => v.toFixed(2),
      }),
    }),
  );

  children.push(
    field({
      label: '静音断句',
      hint: '静音多久算一句话结束',
      control: numberInput({
        get: () => s.asr.minSilenceSeconds,
        set: (v) => {
          s.asr.minSilenceSeconds = v;
          markDirty();
        },
        min: 0.1,
        max: 10,
        step: 0.05,
        suffix: 's',
      }),
    }),
  );

  children.push(
    field({
      label: '最短语音',
      hint: '短于这个长度的片段会被丢弃',
      control: numberInput({
        get: () => s.asr.minSpeechSeconds,
        set: (v) => {
          s.asr.minSpeechSeconds = v;
          markDirty();
        },
        min: 0,
        max: 5,
        step: 0.05,
        suffix: 's',
      }),
    }),
  );

  children.push(
    field({
      label: '单段最长语音',
      hint: '超过这个长度会被强制切段',
      control: numberInput({
        get: () => s.asr.maxSpeechSeconds,
        set: (v) => {
          s.asr.maxSpeechSeconds = v;
          markDirty();
        },
        min: 5,
        max: 120,
        step: 1,
        suffix: 's',
      }),
    }),
  );

  children.push(
    field({
      label: '逆文本正则化',
      hint: '把「二零二四」这类写法规范成「2024」，并补齐常用符号',
      control: switchInput({
        get: () => s.asr.itn,
        set: (v) => {
          s.asr.itn = v;
          markDirty();
        },
      }),
    }),
  );

  return section(
    '02 / SPEECH RECOGNITION',
    '语音识别',
    '配置本地 SenseVoice 识别引擎与断句参数。',
    children,
  );
}

/* =============================================================================
 * 十二、分区三：AI 纠偏
 * ========================================================================== */

function buildLlmSection(): HTMLElement {
  const s = draft!;
  const children: HTMLElement[] = [];

  children.push(
    field({
      label: '启用大模型纠偏',
      hint: '关闭后直接录入原始识别文本，速度最快',
      control: switchInput({
        get: () => s.llm.enabled,
        set: (v) => {
          s.llm.enabled = v;
          markDirty();
        },
      }),
    }),
  );

  children.push(
    field({
      label: '接口地址',
      hint: 'OpenAI 兼容协议地址，例如 https://api.deepseek.com/v1',
      grow: true,
      control: textInput({
        get: () => s.llm.baseUrl,
        set: (v) => {
          s.llm.baseUrl = v.trim();
          markDirty();
        },
        mono: true,
        grow: true,
        placeholder: 'https://api.deepseek.com/v1',
      }),
    }),
  );

  // API Key —— 密码框 + 显示/隐藏
  const keyInput = h('input', {
    class: 'input input--mono input--grow',
    type: 'password',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: 'sk-…',
  });
  keyInput.value = s.llm.apiKey;
  keyInput.addEventListener('input', () => {
    s.llm.apiKey = keyInput.value.trim();
    markDirty();
  });
  keyInput.addEventListener('blur', () => {
    keyInput.value = s.llm.apiKey;
  });

  const eyeBtn = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: '显示 API Key',
    'aria-label': '显示 API Key',
  });
  let keyVisible = false;
  const paintEye = (): void => {
    eyeBtn.textContent = '';
    eyeBtn.append(svgIcon(keyVisible ? ICON.eyeOff : ICON.eye, 15));
    eyeBtn.title = keyVisible ? '隐藏 API Key' : '显示 API Key';
  };
  paintEye();
  eyeBtn.addEventListener('click', () => {
    keyVisible = !keyVisible;
    keyInput.type = keyVisible ? 'text' : 'password';
    paintEye();
  });

  children.push(
    field({
      label: 'API Key',
      hint: '只保存在本机设置文件里，不会随识别内容上传',
      grow: true,
      control: [keyInput, eyeBtn],
    }),
  );

  // 模型名 —— 输入框 + 候选下拉
  const modelInput = h('input', {
    class: 'input input--mono input--grow',
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    list: 'llm-model-options',
    placeholder: 'deepseek-chat',
  });
  modelInput.value = s.llm.model;
  modelInput.addEventListener('input', () => {
    s.llm.model = modelInput.value.trim();
    markDirty();
  });
  modelInput.addEventListener('blur', () => {
    modelInput.value = s.llm.model;
  });

  const datalist = h('datalist', { id: 'llm-model-options' });
  for (const name of [
    'deepseek-chat',
    'deepseek-reasoner',
    'gpt-4o-mini',
    'gpt-4o',
    'qwen-plus',
    'glm-4-flash',
    'moonshot-v1-8k',
  ]) {
    datalist.append(h('option', { value: name }));
  }

  children.push(
    field({
      label: '模型名',
      hint: '任意 OpenAI 兼容的模型名都可以',
      grow: true,
      control: [modelInput, datalist],
    }),
  );

  children.push(
    field({
      label: '关闭深度思考',
      wideHint:
        '部分模型会先「深度思考」再回答，首字会很慢；开启后会带上关闭思考的参数，对端不认时自动去掉重试一次。',
      control: switchInput({
        get: () => s.llm.disableThinking !== false,
        set: (v) => {
          s.llm.disableThinking = v;
          markDirty();
        },
      }),
    }),
  );

  children.push(
    field({
      label: '纠偏时间阈值',
      hint: '超过这个时间就放弃纠偏，直接录入原始识别文本。大模型首次响应通常要 1–3 秒，不够就调大。',
      control: numberInput({
        get: () => s.llm.timeoutMs,
        set: (v) => {
          s.llm.timeoutMs = v;
          markDirty();
        },
        min: 500,
        max: 30000,
        step: 100,
        suffix: 'ms',
      }),
    }),
  );

  children.push(
    field({
      label: '总延迟上限',
      hint: '从松开热键到文字落地的总预算',
      control: numberInput({
        get: () => s.llm.maxTotalLatencyMs,
        set: (v) => {
          s.llm.maxTotalLatencyMs = v;
          markDirty();
        },
        min: 500,
        max: 30000,
        step: 100,
        suffix: 'ms',
      }),
    }),
  );

  children.push(
    h('div', { class: 'quiet' }, [
      '实测：本地识别约 200–400ms，大模型纠偏通常 600–2000ms。阈值建议 ≥ 3000ms。',
    ]),
  );

  children.push(
    field({
      label: '温度',
      hint: '纠偏要稳定，温度越低越保守',
      control: slider({
        min: 0,
        max: 1,
        step: 0.05,
        get: () => s.llm.temperature,
        set: (v) => {
          s.llm.temperature = v;
          markDirty();
        },
        format: (v) => v.toFixed(2),
      }),
    }),
  );

  children.push(
    field({
      label: '超时后使用部分结果',
      hint: '纠偏超时但已经流式收到内容时，采用不完整的结果',
      control: switchInput({
        get: () => s.llm.usePartialOnTimeout,
        set: (v) => {
          s.llm.usePartialOnTimeout = v;
          markDirty();
        },
      }),
    }),
  );

  children.push(
    field({
      label: '流式请求',
      hint: '边生成边返回，首字更快；关闭则等待完整结果',
      control: switchInput({
        get: () => s.llm.streaming,
        set: (v) => {
          s.llm.streaming = v;
          markDirty();
        },
      }),
    }),
  );

  // 追加提示词
  const promptArea = h('textarea', {
    class: 'input',
    spellcheck: 'false',
    placeholder: '例如：保持中文标点；不要添加解释性文字；保留原句语气。',
  });
  promptArea.value = s.llm.extraSystemPrompt;
  promptArea.addEventListener('input', () => {
    s.llm.extraSystemPrompt = promptArea.value;
    markDirty();
  });

  children.push(
    field({
      label: '追加提示词',
      hint: '追加到大模型纠偏指令后面',
      grow: true,
      control: promptArea,
    }),
  );

  // 个性化常用词
  children.push(buildTermsBlock());

  // 测试纠偏
  const testBtn = h('button', { class: 'btn', type: 'button' }, ['测试纠偏']);
  const testOut = h('div', { class: 'test-out' });
  renderTestOut(testOut, llmTestResult, '还没有测试过纠偏');

  const runLlmTest = async (): Promise<void> => {
    if (!api) return;
    testBtn.disabled = true;
    testBtn.classList.add('is-busy');
    testBtn.textContent = '测试中…';
    renderTestOut(testOut, null, '正在请求大模型…', true);
    try {
      llmTestResult = await api.testLlm();
    } catch (err) {
      llmTestResult = { ok: false, text: '', ms: 0, error: errorText(err) };
    } finally {
      testBtn.disabled = false;
      testBtn.classList.remove('is-busy');
      testBtn.textContent = '测试纠偏';
      renderTestOut(testOut, llmTestResult);
    }
  };

  testBtn.addEventListener('click', () => {
    void runLlmTest();
  });

  children.push(
    field({
      label: '测试纠偏',
      hint: '用当前配置发一次请求，确认接口、密钥和模型都可用',
      control: testBtn,
    }),
  );
  children.push(testOut);

  // 请求详情（可观测性）：即使超时没赶上，这里也能看到请求到底发出去了没有
  children.push(buildTracePanel(() => void runLlmTest()));

  return section(
    '03 / AI CORRECTION',
    'AI 纠偏',
    '用大模型修正识别结果里的错别字、口语化表达与标点。',
    children,
  );
}

/** 个性化常用词编辑器 */
function buildTermsBlock(): HTMLElement {
  const s = draft!;
  const list = h('div', { class: 'terms__list' });
  const addBtn = h('button', { class: 'btn btn--sm', type: 'button' }, ['+ 添加']);

  const render = (): void => {
    list.textContent = '';
    const terms = s.llm.terms;
    if (terms.length === 0) {
      list.append(
        h('div', { class: 'terms__empty' }, [
          '还没有添加常用词。纠偏时这些词会作为参考提示给大模型，例如把「达莫德尔」纠正成「大模型」。',
        ]),
      );
      return;
    }
    terms.forEach((term, index) => {
      list.append(buildTermRow(term, index, render));
    });
  };

  addBtn.addEventListener('click', () => {
    s.llm.terms.push({ term: '' });
    markDirty();
    render();
    const inputs = list.querySelectorAll<HTMLInputElement>('.terms__row .input');
    inputs[inputs.length - 3]?.focus();
  });

  render();

  return h('div', { class: 'block' }, [
    h('div', { class: 'block__head' }, [
      h('div', { class: 'block__titles' }, [
        h('span', { class: 'block__title' }, ['个性化常用词']),
        h('span', { class: 'block__hint' }, ['纠偏时作为参考提示给大模型']),
      ]),
      addBtn,
    ]),
    h('div', { class: 'terms__head' }, [
      h('span', {}, ['常用词']),
      h('span', {}, ['规范写法（选填）']),
      h('span', {}, ['备注（选填）']),
      h('span', {}, []),
    ]),
    list,
  ]);
}

/** 常用词的一行 */
function buildTermRow(
  term: TermEntry,
  index: number,
  rerender: () => void,
): HTMLElement {
  const s = draft!;

  const termInput = h('input', {
    class: 'input',
    type: 'text',
    spellcheck: 'false',
    placeholder: '例如：飞书',
  });
  termInput.value = term.term ?? '';
  // 常用词必填 —— 空的一行标红提示
  const syncTermState = (): void => {
    termInput.classList.toggle('is-invalid', term.term.trim() === '');
  };
  syncTermState();
  termInput.addEventListener('input', () => {
    term.term = termInput.value;
    syncTermState();
    markDirty();
  });

  const replacementInput = h('input', {
    class: 'input',
    type: 'text',
    spellcheck: 'false',
    placeholder: '留空则只作提示',
  });
  replacementInput.value = term.replacement ?? '';
  replacementInput.addEventListener('input', () => {
    const value = replacementInput.value.trim();
    term.replacement = value === '' ? undefined : value;
    markDirty();
  });

  const noteInput = h('input', {
    class: 'input',
    type: 'text',
    spellcheck: 'false',
    placeholder: '可选',
  });
  noteInput.value = term.note ?? '';
  noteInput.addEventListener('input', () => {
    const value = noteInput.value.trim();
    term.note = value === '' ? undefined : value;
    markDirty();
  });

  const removeBtn = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: '删除',
    'aria-label': '删除该常用词',
  });
  removeBtn.append(svgIcon(ICON.trash, 15));
  removeBtn.addEventListener('click', () => {
    s.llm.terms.splice(index, 1);
    markDirty();
    rerender();
  });

  return h('div', { class: 'terms__row' }, [
    termInput,
    replacementInput,
    noteInput,
    removeBtn,
  ]);
}

/** 渲染测试输出 */
function renderTestOut(
  box: HTMLElement,
  result: { ok: boolean; text: string; ms: number; error?: string } | null,
  placeholder = '',
  pending = false,
): void {
  box.textContent = '';
  box.classList.remove('test-out--ok', 'test-out--error');

  if (pending) {
    box.append(h('div', { class: 'test-out__text' }, [placeholder]));
    return;
  }

  if (!result) {
    if (placeholder) box.append(h('div', { class: 'test-out__text' }, [placeholder]));
    return;
  }

  box.classList.add(result.ok ? 'test-out--ok' : 'test-out--error');
  box.append(
    h('div', { class: 'test-out__meta' }, [
      h('span', {}, [result.ok ? '成功' : '失败']),
      h('span', {}, [`耗时 ${result.ms} ms`]),
    ]),
  );
  box.append(
    h('div', { class: 'test-out__text' }, [
      result.ok ? result.text || '（空结果）' : result.error ?? '未知错误',
    ]),
  );
}

/* =============================================================================
 * 十三、AI 纠偏的可观测性面板（请求详情）
 * ========================================================================== */

/** 折叠状态记在哪 */
const TRACE_OPEN_KEY = 'typewhisper:llm-trace-open';

/** 面板轮询间隔（响应可能晚于阈值才到） */
const TRACE_POLL_MS = 1500;

/** 把 JSON 美化输出；不是 JSON 就原样返回 */
function prettyJson(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return value;
      }
    }
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** trace 的指纹：变了才重绘，避免每 1.5s 闪一次 */
function traceSignature(trace: LlmTrace | null): string {
  if (trace === null) return '';
  return [
    trace.at,
    trace.waitedMs,
    trace.timedOut ? '1' : '0',
    trace.status ?? '',
    trace.respondedAt ?? '',
    trace.error ?? '',
    trace.correctedText ?? '',
    (trace.responseBody ?? '').length,
  ].join('|');
}

/** 面板的当前记录（供外部读） */
let lastTrace: LlmTrace | null = null;

/** 重建内容区时要把上一块面板的轮询停掉 */
let tracePanelCleanup: (() => void) | null = null;

/**
 * 时序一句话：这次请求实际往返多久、比阈值晚多少。
 * 超时与非超时各一句，不展开成说明书。
 */
function timingSentence(trace: LlmTrace): string {
  const threshold = draft?.llm.timeoutMs ?? 3000;
  const elapsed = trace.respondedAt !== undefined ? trace.respondedAt - trace.at : undefined;

  if (!trace.timedOut) {
    return elapsed === undefined
      ? '未超时，响应尚未到达'
      : `未超时，响应在 ${elapsed}ms 到达`;
  }
  if (elapsed === undefined) {
    return `超过阈值 ${threshold}ms，已放弃等待；响应尚未到达`;
  }
  const late = elapsed - threshold;
  return `超过阈值 ${threshold}ms，已放弃等待；响应在 ${elapsed}ms 后到达（比阈值晚 ${late}ms）`;
}

/**
 * 「请求详情 · 上次调用」可折叠面板。
 * 展开时按 1.5s 轮询一次 IPC —— 响应可能在超过阈值之后才回来。
 */
function buildTracePanel(onTest: () => void): HTMLElement {
  const badge = h('span', { class: 'badge badge--muted' }, ['无记录']);
  const caret = svgIcon(ICON.chevron, 14);
  caret.classList.add('trace__caret');

  const head = h('button', { class: 'trace__head', type: 'button', 'aria-expanded': 'false' });
  head.append(caret);
  head.append(h('span', { class: 'trace__title' }, ['请求详情 · 上次调用']));
  head.append(badge);

  const body = h('div', { class: 'trace__body' });
  const panel = h('div', { class: 'trace' }, [head, body]);

  let open = false;
  try {
    open = window.localStorage.getItem(TRACE_OPEN_KEY) === '1';
  } catch {
    /* localStorage 不可用就默认折叠 */
  }

  let timer: number | null = null;

  const paint = (): void => {
    const trace = lastTrace;
    body.textContent = '';

    if (!trace) {
      // 空状态：一句话 + 一个动作
      body.append(
        h('div', { class: 'trace__empty' }, [
          h('span', { class: 'trace__empty-text' }, ['还没有调用记录']),
          h('button', { class: 'btn btn--sm', type: 'button' }, ['测试纠偏']),
        ]),
      );
      const action = body.querySelector<HTMLButtonElement>('.btn');
      action?.addEventListener('click', onTest);
      badge.className = 'badge badge--muted';
      badge.textContent = '无记录';
      return;
    }

    // 状态徽标
    if (trace.error) {
      badge.className = 'badge badge--error';
      badge.textContent = '失败';
    } else if (trace.timedOut) {
      badge.className = 'badge badge--warn';
      badge.textContent = '已超时';
    } else {
      badge.className = 'badge badge--ok';
      badge.textContent = '已生效';
    }

    const row = (key: string, value: string, cls = ''): HTMLElement =>
      h('div', { class: 'trace__row' }, [
        h('span', { class: 'trace__k' }, [key]),
        h('span', { class: `trace__v${cls === '' ? '' : ` ${cls}`}` }, [value]),
      ]);

    const block = (key: string, text: string): HTMLElement =>
      h('div', { class: 'trace__row trace__row--block' }, [
        h('span', { class: 'trace__k' }, [key]),
        h('pre', { class: 'trace__pre' }, [text]),
      ]);

    body.append(row('请求地址', trace.url || '—'));

    const headers = prettyJson(trace.headers ?? {});
    if (headers !== '') body.append(block('请求头', headers));

    const request = prettyJson(trace.requestBody);
    if (request !== '') body.append(block('请求体', request));

    const waited = trace.timedOut
      ? `${trace.waitedMs} ms · 超时（请求仍发给了大模型，响应在后台继续等）`
      : `${trace.waitedMs} ms`;
    body.append(row('等待', waited));

    // 时序：这次请求到底慢在哪、超了多少 —— 一句话说完
    body.append(row('本次请求', timingSentence(trace)));

    if (trace.status !== undefined) {
      const arrived = trace.respondedAt !== undefined ? ` · 到达于 ${new Date(trace.respondedAt).toLocaleTimeString()}` : '';
      body.append(row('响应', `${trace.status}${arrived}`));
    } else if (!trace.error) {
      body.append(row('响应', '尚未到达'));
    }

    const response = prettyJson(trace.responseBody);
    if (response !== '') body.append(block('响应体', response));

    if (trace.correctedText !== undefined && trace.correctedText !== '') {
      body.append(row('纠偏结果', trace.correctedText));
    }

    if (trace.error) {
      body.append(row('错误', trace.error, 'trace__v--error'));
    }

    // 底部：清空记录
    const clearBtn = h('button', { class: 'btn btn--sm btn--ghost', type: 'button' }, ['清空记录']);
    clearBtn.addEventListener('click', async () => {
      if (!api) return;
      try {
        await api.clearLlmTrace();
        lastTrace = null;
        paint();
      } catch (err) {
        toast(`清空记录失败：${errorText(err)}`, 'error');
      }
    });
    body.append(h('div', { class: 'trace__foot' }, [clearBtn]));
  };

  const pull = async (): Promise<void> => {
    if (!api) return;
    try {
      const trace = await api.getLlmTrace();
      if (traceSignature(trace) === traceSignature(lastTrace)) return;
      lastTrace = trace;
      paint();
    } catch {
      /* 取不到就保持上一次的样子 */
    }
  };

  const setOpen = (next: boolean): void => {
    open = next;
    panel.classList.toggle('is-open', open);
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    body.hidden = !open;
    try {
      window.localStorage.setItem(TRACE_OPEN_KEY, open ? '1' : '0');
    } catch {
      /* 记不住也无所谓 */
    }
    if (open) {
      void pull();
      if (timer === null) {
        timer = window.setInterval(() => void pull(), TRACE_POLL_MS);
      }
    } else if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };

  head.addEventListener('click', () => setOpen(!open));

  paint();
  setOpen(open);
  // 收起时也取一次：徽标要能显示「上次调用」的状态
  void pull();

  tracePanelCleanup = (): void => {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
    tracePanelCleanup = null;
  };

  return panel;
}

/* =============================================================================
 * 十四、分区四：输入与高级
 * ========================================================================== */

function buildAdvancedSection(): HTMLElement {
  const s = draft!;
  const children: HTMLElement[] = [];

  children.push(
    field({
      label: '主题',
      hint: '跟随系统，或钉死成亮 / 暗',
      control: segmented<ThemePref>({
        options: [
          { value: 'system', label: '跟随系统', title: '随 Windows 的明暗设置自动切换' },
          { value: 'light', label: '亮', title: '始终使用纸白亮色' },
          { value: 'dark', label: '暗', title: '始终使用深色' },
        ],
        get: () => uiOf(s).theme,
        set: (v) => {
          setUiOf(s, { theme: v });
          themePref = v;
          applyEffectiveTheme();
          markDirty();
        },
      }),
    }),
  );

  children.push(
    field({
      label: '插入方式',
      hint: '把识别结果写进光标处的方式',
      control: segmented<InsertMode>({
        options: [
          { value: 'type', label: '直接敲键盘', title: '模拟键盘输入，不碰剪贴板（推荐）' },
          { value: 'clipboard', label: '剪贴板粘贴', title: '写入剪贴板后模拟 Ctrl+V' },
        ],
        get: () => s.input.mode,
        set: (v) => {
          s.input.mode = v;
          markDirty();
        },
      }),
    }),
  );

  children.push(
    h('div', { class: 'note' }, [
      h('div', {}, [
        h('strong', {}, ['直接敲键盘（推荐）']),
        '：逐字符模拟输入，不占用剪贴板 —— 最干净，也最不容易和别的软件抢剪贴板。',
      ]),
      h('div', {}, [
        h('strong', {}, ['剪贴板粘贴']),
        '：把文本写进剪贴板再模拟 Ctrl+V —— 对少数不接受模拟按键的输入框更可靠，但会短暂占用剪贴板。',
      ]),
    ]),
  );

  children.push(
    field({
      label: '粘贴后还原剪贴板',
      hint: '剪贴板模式下，粘贴完把用户原来的剪贴板还回去',
      control: switchInput({
        get: () => s.input.restoreClipboard,
        set: (v) => {
          s.input.restoreClipboard = v;
          markDirty();
        },
      }),
    }),
  );

  children.push(
    field({
      label: '插入后补空格',
      hint: '写入文本后再敲一个空格，方便接着打字',
      control: switchInput({
        get: () => s.input.trailingSpace,
        set: (v) => {
          s.input.trailingSpace = v;
          markDirty();
        },
      }),
    }),
  );

  children.push(
    field({
      label: '开机自启',
      hint: '登录 Windows 后自动在后台运行',
      control: switchInput({
        get: () => s.advanced.autoLaunch,
        set: (v) => {
          s.advanced.autoLaunch = v;
          markDirty();
        },
      }),
    }),
  );

  children.push(
    field({
      label: '启动时最小化',
      hint: '开机自启时不显示窗口，只留在托盘',
      control: switchInput({
        get: () => s.advanced.startMinimized,
        set: (v) => {
          s.advanced.startMinimized = v;
          markDirty();
        },
      }),
    }),
  );

  children.push(
    field({
      label: '录音时显示悬浮条',
      hint: '录音过程中在屏幕上显示一个小的状态条',
      control: switchInput({
        get: () => s.advanced.showHud,
        set: (v) => {
          s.advanced.showHud = v;
          markDirty();
        },
      }),
    }),
  );

  children.push(
    field({
      label: '日志级别',
      hint: 'debug 会记录很多细节，排错时再打开',
      control: selectInput<LogLevel>({
        options: [
          { value: 'error', label: 'error（只记错误）' },
          { value: 'warn', label: 'warn（错误 + 警告）' },
          { value: 'info', label: 'info（默认）' },
          { value: 'debug', label: 'debug（详细）' },
        ],
        get: () => s.advanced.logLevel,
        set: (v) => {
          s.advanced.logLevel = v;
          markDirty();
        },
      }),
    }),
  );

  const logBtn = h('button', { class: 'btn', type: 'button' }, ['打开日志目录']);
  logBtn.addEventListener('click', async () => {
    if (!api) return;
    try {
      await api.openLogDir();
    } catch (err) {
      toast(`打开日志目录失败：${errorText(err)}`, 'error');
    }
  });
  children.push(field({ label: '日志', hint: '排查问题时用得上', control: logBtn }));

  // 测试语音识别
  const testBtn = h('button', { class: 'btn', type: 'button' }, ['测试语音识别']);
  const testOut = h('div', { class: 'test-out' });
  renderTestOut(testOut, asrTestResult, '点击上面的按钮开始一次测试录音');

  testBtn.addEventListener('click', async () => {
    if (!api) return;
    testBtn.disabled = true;
    testBtn.classList.add('is-busy');
    testBtn.textContent = '正在录音…';
    renderTestOut(testOut, null, '正在录音…请对着麦克风说话（约 3 秒）', true);
    try {
      asrTestResult = await api.testAsr();
    } catch (err) {
      asrTestResult = { ok: false, text: '', ms: 0, error: errorText(err) };
    } finally {
      testBtn.disabled = false;
      testBtn.classList.remove('is-busy');
      testBtn.textContent = '测试语音识别';
      renderTestOut(testOut, asrTestResult);
    }
  });

  children.push(
    field({
      label: '测试语音识别',
      hint: '点击后请说话（约 3 秒），会真的开始录音',
      control: testBtn,
    }),
  );
  children.push(testOut);

  return section(
    '04 / INPUT & ADVANCED',
    '输入与高级',
    '文本写入方式、开机行为与日志设置。',
    children,
  );
}

/* =============================================================================
 * 十五、页面骨架
 * ========================================================================== */

/** 分区外壳 */
function section(
  eyebrow: string,
  title: string,
  desc: string,
  children: HTMLElement[],
): HTMLElement {
  return h('section', { class: 'section' }, [
    h('div', { class: 'section__head' }, [
      h('span', { class: 'micro section__eyebrow' }, [eyebrow]),
      h('h2', { class: 'section__title' }, [title]),
      h('p', { class: 'section__desc' }, [desc]),
    ]),
    h('div', { class: 'section__body' }, children),
  ]);
}

interface SectionDef {
  id: string;
  /** 手册式章节序号 */
  num: string;
  /** 英文微标签 */
  eyebrow: string;
  title: string;
  icon: string;
  build(): HTMLElement;
}

const SECTIONS: SectionDef[] = [
  {
    id: 'hotkey',
    num: '01',
    eyebrow: 'HOTKEY & TRIGGER',
    title: '快捷键',
    icon: ICON.keyboard,
    build: buildHotkeySection,
  },
  {
    id: 'asr',
    num: '02',
    eyebrow: 'SPEECH RECOGNITION',
    title: '语音识别',
    icon: ICON.mic,
    build: buildAsrSection,
  },
  {
    id: 'llm',
    num: '03',
    eyebrow: 'AI CORRECTION',
    title: 'AI 纠偏',
    icon: ICON.spark,
    build: buildLlmSection,
  },
  {
    id: 'advanced',
    num: '04',
    eyebrow: 'INPUT & ADVANCED',
    title: '输入与高级',
    icon: ICON.sliders,
    build: buildAdvancedSection,
  },
];

/** 渲染左侧导航 */
function renderNav(): void {
  const nav = byId('nav');
  if (!nav) return;
  nav.textContent = '';
  for (const def of SECTIONS) {
    const item = h('button', {
      class: `nav__item${def.id === activeSection ? ' is-active' : ''}`,
      type: 'button',
    });
    item.append(h('span', { class: 'nav__num' }, [def.num]));
    item.append(svgIcon(def.icon, 16));
    item.append(h('span', { class: 'nav__label' }, [def.title]));
    item.addEventListener('click', () => {
      activeSection = def.id;
      renderNav();
      showSection();
    });
    nav.append(item);
  }
}

/** 切换分区显示 */
function showSection(): void {
  const sections = document.querySelectorAll<HTMLElement>('.section');
  sections.forEach((el, index) => {
    el.classList.toggle('is-active', SECTIONS[index]?.id === activeSection);
  });
}

/** 渲染右侧内容 */
function renderContent(): void {
  const content = byId('content');
  if (!content || !draft) return;
  const scrollTop = content.scrollTop;

  // 上一块请求详情面板的轮询要停掉
  tracePanelCleanup?.();

  content.textContent = '';
  const inner = h('div', { class: 'content__inner' });
  inner.append(buildResultPanel());
  for (const def of SECTIONS) {
    const el = def.build();
    el.id = `section-${def.id}`;
    inner.append(el);
  }
  content.append(inner);
  showSection();
  content.scrollTop = scrollTop;
}

/** 标记有未保存的改动 */
function markDirty(): void {
  const state = byId('dirty-state');
  if (!state || !draft || !baseline) return;
  const changes = countChanges(
    diffPatch(baseline as unknown as Json, draft as unknown as Json),
  );
  state.textContent = changes === 0 ? '所有更改已保存' : `${changes} 项未保存的更改`;

  // 阈值改了，延迟预算仪表要跟着变
  if (lastResult) renderGauge(lastResult);
}

/* =============================================================================
 * 十六、保存
 * ========================================================================== */

async function save(closeAfter: boolean): Promise<void> {
  if (!api || !draft || !baseline) return;
  const saveBtn = byId<HTMLButtonElement>('btn-save');
  const saveCloseBtn = byId<HTMLButtonElement>('btn-save-close');
  if (saveBtn) saveBtn.disabled = true;
  if (saveCloseBtn) saveCloseBtn.disabled = true;

  try {
    const patch = diffPatch(
      baseline as unknown as Json,
      draft as unknown as Json,
    ) as unknown as DeepPartial<AppSettings>;
    const next = await api.patchSettings(patch);
    baseline = structuredClone(next);
    draft = structuredClone(next);
    // 主进程还没回传 ui 段时，主题偏好以本地为准，别被回写冲掉
    setUiOf(baseline, { theme: themePref });
    setUiOf(draft, { theme: themePref });
    renderContent();
    markDirty();
    const accel = byId('current-accel');
    if (accel) accel.textContent = formatAccelerator(next.hotkey.accelerator);
    if (saveBtn) {
      saveBtn.textContent = '已保存 ✓';
      window.setTimeout(() => {
        saveBtn.textContent = '保存';
      }, 1600);
    }
    toast('设置已保存', 'ok');
    if (closeAfter) await api.closeWindow();
  } catch (err) {
    toast(`保存失败：${errorText(err)}`, 'error');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    if (saveCloseBtn) saveCloseBtn.disabled = false;
  }
}

/* =============================================================================
 * 十七、启动
 * ========================================================================== */

function applySettings(settings: AppSettings): void {
  baseline = structuredClone(settings);
  draft = structuredClone(settings);
  // 旧配置里的语种（粤语 / 日语 / 韩语）当「自动」处理，且不产生虚假 diff
  const lang = languageOf(settings);
  baseline.asr.language = lang;
  draft.asr.language = lang;
  // 主题偏好：契约字段还没落地时也按「跟随系统」处理
  themePref = uiOf(settings).theme;
  setUiOf(baseline, { theme: themePref });
  setUiOf(draft, { theme: themePref });
  applyEffectiveTheme();
  renderNav();
  renderContent();
  markDirty();
  const accel = byId('current-accel');
  if (accel) accel.textContent = formatAccelerator(settings.hotkey.accelerator);
}

function wireStaticButtons(): void {
  byId('btn-save')?.addEventListener('click', () => {
    void save(false);
  });
  byId('btn-save-close')?.addEventListener('click', () => {
    void save(true);
  });
  byId('btn-minimize')?.addEventListener('click', () => {
    void api?.minimizeWindow();
  });
  byId('btn-close')?.addEventListener('click', () => {
    void api?.closeWindow();
  });
  // 快捷键注册失败提示 → 直接跳到「快捷键」分区去换组合
  byId('hotkey-error')?.addEventListener('click', () => {
    activeSection = 'hotkey';
    renderNav();
    showSection();
    byId('content')?.scrollTo({ top: 0 });
  });
}

async function boot(): Promise<void> {
  const content = byId('content');

  // 主题：只换根节点上的变量值，不重渲染组件
  themePref = 'system';
  applyEffectiveTheme();
  unsubscribes.push(watchHostScheme(() => applyEffectiveTheme()));

  if (!api) {
    content?.append(
      h('div', { class: 'fatal' }, [
        '未检测到 window.qingyu（preload 没有注入）。请从 Electron 主进程打开这个设置页，而不是直接在浏览器里打开 settings.html。',
      ]),
    );
    return;
  }

  // 先订阅再拉数据，避免漏掉状态事件
  unsubscribes.push(api.onStatus(applyStatus));
  unsubscribes.push(api.onResult(applyResult));
  if (typeof api.onLevel === 'function') {
    unsubscribes.push(api.onLevel(applyLevel));
  }

  wireStaticButtons();

  try {
    const settings = await api.getSettings();
    applySettings(settings);
  } catch (err) {
    toast(`载入设置失败：${errorText(err)}`, 'error');
    // 主进程读不到设置时，至少用默认值把界面渲染出来
    applySettings(FALLBACK);
  }

  try {
    applyStatus(await api.getStatus());
  } catch (err) {
    toast(`读取状态失败：${errorText(err)}`, 'error');
  }

  // 页面加载时自动检测一次模型
  await runProbe();
}

void boot();
