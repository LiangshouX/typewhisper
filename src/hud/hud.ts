/** 悬浮指示条：状态文字 + 实时声波。 */

interface HudState {
  stage: string;
  detail?: string;
  label?: string;
  text?: string;
}

declare global {
  interface Window {
    hud: {
      onState(cb: (state: HudState) => void): void;
      onLevel(cb: (level: number) => void): void;
    };
  }
}

const root = document.getElementById('hud') as HTMLDivElement;
const label = document.getElementById('label') as HTMLSpanElement;
const detail = document.getElementById('detail') as HTMLSpanElement;
const wave = document.getElementById('wave') as HTMLDivElement;

/** 声波条数。 */
const BARS = 22;
/** 每一根柱子的历史音量。 */
const history: number[] = new Array<number>(BARS).fill(0);

const LABELS: Record<string, string> = {
  idle: '轻语',
  recording: '正在录音',
  decoding: '识别中',
  correcting: '纠偏中',
  injecting: '写入中',
  done: '已写入',
  error: '出错了',
};

for (let i = 0; i < BARS; i++) {
  const bar = document.createElement('i');
  wave.appendChild(bar);
}
const bars = Array.from(wave.children) as HTMLElement[];

function render(state: HudState): void {
  const stage = state.stage ?? 'idle';
  root.dataset.stage = stage;
  label.textContent = state.label ?? LABELS[stage] ?? '轻语';
  detail.textContent = state.detail ?? '';

  if (stage === 'idle') {
    root.classList.remove('show');
    history.fill(0);
    paint();
    return;
  }
  root.classList.add('show');
}

/** 把历史音量画成声波。 */
function paint(): void {
  for (let i = 0; i < bars.length; i++) {
    const value = history[i] ?? 0;
    const height = Math.round(3 + value * 23);
    bars[i].style.height = `${height}px`;
    bars[i].className = value > 0.98 ? 'clip' : value > 0.8 ? 'hot' : '';
  }
}

window.hud.onState(render);

window.hud.onLevel((level) => {
  const value = Math.max(0, Math.min(1, level));
  history.shift();
  history.push(value);
  paint();
});

// 注意：**不要**在这里再 render({ stage: 'idle' })。
// 主进程的状态消息可能比这段脚本更早到达（preload 先注册好了监听），
// 末尾再刷一次 idle 会把真实状态冲掉。

export {};
