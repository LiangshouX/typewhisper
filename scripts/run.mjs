/**
 * 启动脚本。
 *
 * 为什么要它：DSH 宿主本身是 Electron 应用，会把 `ELECTRON_RUN_AS_NODE=1`
 * 传给它的子进程环境。这个变量会让 electron.exe **退化成普通 Node**，
 * 于是 `require('electron')` 拿到的是 npm 包导出的路径字符串而不是运行时 API，
 * 一启动就报 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`。
 *
 * 这里显式清掉这个变量再启动 electron，保证拿到真正的 GUI 运行时。
 *
 * 用法：node scripts/run.mjs [传给 electron 的参数...]
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// electron 这个 npm 包导出的是「可执行文件路径」
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const args = [root, ...process.argv.slice(2)];

const child = spawn(electronPath, args, {
  stdio: 'inherit',
  env,
  windowsHide: false,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
