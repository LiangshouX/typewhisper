import os from 'node:os';
import path from 'node:path';

/** DSH 已下载的 SenseVoice 模型默认位置（可在设置页里改）。 */
export function defaultModelRoot(): string {
  return path.join(os.homedir(), '.dsh', 'speech-to-text', 'sensevoice', 'models');
}

/** 候选的模型目录，「自动检测」按钮按顺序去找。 */
export function modelRootCandidates(): string[] {
  const candidates = [
    path.join(os.homedir(), '.dsh', 'speech-to-text', 'sensevoice', 'models'),
    path.join(os.homedir(), '.dsh', 'speech-to-text', 'models'),
  ];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.push(path.join(localAppData, 'typewhisper', 'models'));
  }
  return candidates;
}
