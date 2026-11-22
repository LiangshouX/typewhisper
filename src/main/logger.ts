import fs from 'node:fs';
import path from 'node:path';

import type { LogLevel } from '../shared/contract.js';

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * 极简日志器：同时写控制台与滚动日志文件。
 * 写文件是同步的，但日志量很小，不会成为热路径的瓶颈。
 */
class Logger {
  private level: LogLevel = 'info';
  private filePath: string | null = null;
  private stream: fs.WriteStream | null = null;

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setDirectory(dir: string): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'qingyu.log');
      this.filePath = file;
      this.stream?.end();
      this.stream = fs.createWriteStream(file, { flags: 'a' });
    } catch {
      this.filePath = null;
      this.stream = null;
    }
  }

  getFilePath(): string | null {
    return this.filePath;
  }

  private write(level: LogLevel, scope: string, message: string, extra?: unknown): void {
    if (ORDER[level] > ORDER[this.level]) return;
    const time = new Date().toISOString();
    const line = `[${time}] [${level.toUpperCase()}] [${scope}] ${message}`;
    const target = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    target(line);
    if (extra !== undefined) {
      const detail = extra instanceof Error ? (extra.stack ?? extra.message) : safeStringify(extra);
      target(`    ${detail}`);
    }
    if (this.stream) {
      try {
        this.stream.write(`${line}\n`);
        if (extra !== undefined) this.stream.write(`    ${safeStringify(extra)}\n`);
      } catch {
        /* 日志失败不能影响主流程 */
      }
    }
  }

  error(scope: string, message: string, extra?: unknown): void {
    this.write('error', scope, message, extra);
  }
  warn(scope: string, message: string, extra?: unknown): void {
    this.write('warn', scope, message, extra);
  }
  info(scope: string, message: string, extra?: unknown): void {
    this.write('info', scope, message, extra);
  }
  debug(scope: string, message: string, extra?: unknown): void {
    this.write('debug', scope, message, extra);
  }
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export const log = new Logger();
