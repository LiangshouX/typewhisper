import fs from 'node:fs';
import path from 'node:path';

import type { AppSettings, DeepPartial } from '../shared/contract.js';
import { defaultSettings, SETTINGS_VERSION } from '../shared/defaults.js';
import { defaultModelRoot } from './defaults.js';
import { log } from './logger.js';

/**
 * 设置存储：单个 JSON 文件，写入是「先写临时文件再 rename」的原子替换，
 * 避免软件被强杀时留下半截 JSON。
 */
class SettingsStore {
  private settings: AppSettings = defaultSettings();
  private filePath: string | null = null;
  /** 首次运行时为 true（此前没有设置文件）。 */
  isFirstRun = true;

  load(dir: string): AppSettings {
    this.filePath = path.join(dir, 'settings.json');
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<AppSettings>;
        this.settings = mergeSettings(defaultSettings(), parsed);
        this.isFirstRun = false;
        log.info('settings', `已载入设置 ${this.filePath}`);
      } else {
        this.settings = defaultSettings();
        log.info('settings', `未找到设置文件，使用默认设置 ${this.filePath}`);
      }
    } catch (error) {
      log.error('settings', '设置文件损坏，回退到默认设置', error);
      this.settings = defaultSettings();
    }
    this.settings.version = SETTINGS_VERSION;
    // 模型目录留空表示「用 DSH 那个」，首次运行时补上真实路径
    if (!this.settings.asr.modelRoot) {
      this.settings.asr.modelRoot = defaultModelRoot();
    }
    return this.settings;
  }

  get(): AppSettings {
    return this.settings;
  }

  /** 深合并部分设置并落盘。 */
  patch(patch: DeepPartial<AppSettings>): AppSettings {
    this.settings = mergeSettings(this.settings, patch);
    this.save();
    return this.settings;
  }

  reset(): AppSettings {
    this.settings = defaultSettings();
    this.save();
    return this.settings;
  }

  private save(): void {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.settings, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      log.error('settings', '保存设置失败', error);
    }
  }
}

/** 把 patch 深合并进 base；数组整体替换，不做逐项合并。 */
export function mergeSettings<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = result[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      result[key] = mergeSettings(current, value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const settings = new SettingsStore();
