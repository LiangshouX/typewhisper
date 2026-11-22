import fs from 'node:fs';
import path from 'node:path';

import type { ModelProbeResult } from '../shared/contract.js';
import { modelRootCandidates } from './defaults.js';
import { log } from './logger.js';

/**
 * 解析模型文件位置。
 *
 * 支持两种目录布局：
 *   1) DSH 那种分层布局： <root>/sensevoice-onnx/model.int8.onnx + tokens.txt，
 *      <root>/silero/silero_vad.onnx
 *   2) 扁平布局：       <root>/model.onnx + tokens.txt，<root>/silero_vad.onnx
 *
 * 用户也可以在设置里逐个指定具体文件路径。
 */

/** SenseVoice 模型文件的优先顺序：int8 体积最小、速度最快，放最前。 */
const MODEL_FILENAMES = ['model.int8.onnx', 'model.onnx', 'model.fp32.onnx', 'model.int8.quant.onnx'];

function exists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** 在若干目录里按文件名优先级找第一个存在的文件。 */
function findFile(dirs: string[], names: string[]): string | undefined {
  for (const dir of dirs) {
    if (!isDir(dir)) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

export function resolveModels(
  modelRoot: string,
  overrides: { senseVoiceModel?: string; tokens?: string; vadModel?: string } = {},
): ModelProbeResult {
  const root = (modelRoot ?? '').trim();
  const result: ModelProbeResult = { ok: false, modelRoot: root };

  if (!root) {
    result.error = '未设置模型目录';
    return result;
  }
  if (!isDir(root)) {
    result.error = `模型目录不存在：${root}`;
    return result;
  }

  const senseDir = path.join(root, 'sensevoice-onnx');
  const dirs = [senseDir, root];

  // SenseVoice onnx
  if (overrides.senseVoiceModel && exists(overrides.senseVoiceModel)) {
    result.senseVoiceModel = overrides.senseVoiceModel;
  } else {
    result.senseVoiceModel = findFile(dirs, MODEL_FILENAMES);
  }

  // tokens.txt
  if (overrides.tokens && exists(overrides.tokens)) {
    result.tokens = overrides.tokens;
  } else {
    result.tokens = findFile(dirs, ['tokens.txt']);
  }

  // Silero VAD
  if (overrides.vadModel && exists(overrides.vadModel)) {
    result.vadModel = overrides.vadModel;
  } else {
    result.vadModel = findFile([path.join(root, 'silero'), root], ['silero_vad.onnx']);
  }

  const problems: string[] = [];
  if (!result.senseVoiceModel) problems.push('找不到 SenseVoice 模型（model*.onnx）');
  if (!result.tokens) problems.push('找不到 tokens.txt');
  if (!result.vadModel) problems.push('找不到 Silero VAD 模型（silero_vad.onnx）');

  if (problems.length > 0) {
    result.error = problems.join('；');
    return result;
  }

  result.ok = true;
  return result;
}

/** 自动探测一个可用的模型目录：按候选列表逐个试。 */
export function detectModelRoot(): string | null {
  for (const candidate of modelRootCandidates()) {
    if (!isDir(candidate)) continue;
    const probe = resolveModels(candidate);
    if (probe.ok) {
      log.info('models', `自动探测到模型目录：${candidate}`);
      return candidate;
    }
  }
  return null;
}
