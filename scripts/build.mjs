/**
 * 构建脚本：用 esbuild 打包所有产物。
 *
 * 产物布局：
 *   dist/main/index.cjs        Electron 主进程
 *   dist/main/asr-worker.cjs   语音识别子进程
 *   dist/main/win32.cjs        Win32 封装（给独立测试脚本用）
 *   dist/preload/index.cjs     设置页 preload
 *   dist/preload/capture.cjs   录音窗口 preload
 *   dist/renderer/settings.js  设置页脚本
 *   dist/capture/capture.js    录音采集脚本
 *   dist/renderer/settings.html / .css
 *   dist/capture/capture.html / capture-worklet.js
 */
import { build, context } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

/** 原生模块与 electron 必须留给运行时 require，不能被打包进去。 */
const external = ['electron', 'koffi', 'sherpa-onnx-node', 'sherpa-onnx-win-x64'];

const nodeCommon = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external,
  logLevel: 'info',
};

const browserCommon = {
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
};

const entries = [
  { entryPoints: [path.join(root, 'src/main/index.ts')], outfile: path.join(outDir, 'main/index.cjs'), ...nodeCommon },
  { entryPoints: [path.join(root, 'src/main/asr/worker-entry.ts')], outfile: path.join(outDir, 'main/asr-worker.cjs'), ...nodeCommon },
  { entryPoints: [path.join(root, 'src/main/win32/win32.ts')], outfile: path.join(outDir, 'main/win32.cjs'), ...nodeCommon },
  { entryPoints: [path.join(root, 'src/main/llm/corrector.ts')], outfile: path.join(outDir, 'main/corrector.cjs'), ...nodeCommon },
  { entryPoints: [path.join(root, 'src/preload/index.ts')], outfile: path.join(outDir, 'preload/index.cjs'), ...nodeCommon },
  { entryPoints: [path.join(root, 'src/preload/capture.ts')], outfile: path.join(outDir, 'preload/capture.cjs'), ...nodeCommon },
  { entryPoints: [path.join(root, 'src/preload/hud.ts')], outfile: path.join(outDir, 'preload/hud.cjs'), ...nodeCommon },
  { entryPoints: [path.join(root, 'src/renderer/settings.ts')], outfile: path.join(outDir, 'renderer/settings.js'), ...browserCommon },
  { entryPoints: [path.join(root, 'src/capture/capture.ts')], outfile: path.join(outDir, 'capture/capture.js'), ...browserCommon },
  { entryPoints: [path.join(root, 'src/hud/hud.ts')], outfile: path.join(outDir, 'hud/hud.js'), ...browserCommon },
];

/** 原样拷贝的静态文件。 */
const assets = [
  ['src/renderer/settings.html', 'renderer/settings.html'],
  ['src/renderer/settings.css', 'renderer/settings.css'],
  ['src/capture/capture.html', 'capture/capture.html'],
  ['src/capture/capture-worklet.js', 'capture/capture-worklet.js'],
  ['src/hud/hud.html', 'hud/hud.html'],
  // 自检用的语音样本：打包后也要能跑完整链路校验
  ['scripts/fixtures/sample-speech.wav', 'fixtures/sample-speech.wav'],
];

async function copyAssets() {
  for (const [from, to] of assets) {
    const src = path.join(root, from);
    const dest = path.join(outDir, to);
    try {
      await fs.access(src);
    } catch {
      continue; // 文件还没写出来就跳过
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }
}

async function run() {
  await copyAssets();

  // 入口文件还没写出来就先跳过，免得整个构建挂掉
  const available = [];
  for (const config of entries) {
    const missing = [];
    for (const entry of config.entryPoints) {
      try {
        await fs.access(entry);
      } catch {
        missing.push(path.relative(root, entry));
      }
    }
    if (missing.length > 0) {
      console.log(`[build] 跳过（源文件不存在）：${missing.join(', ')}`);
      continue;
    }
    available.push(config);
  }

  if (watch) {
    const ctxs = await Promise.all(available.map((config) => context(config)));
    await Promise.all(ctxs.map((ctx) => ctx.watch()));
    console.log('[build] 监听中…');
    return;
  }
  await Promise.all(available.map((config) => build(config)));

  // 产物自检：少了任何一个入口都要**大声报出来**。
  // （之前漏了 hud 的 preload，页面里 window.hud 悄悄变成了 DOM 元素，
  //   表现成「悬浮条一直不出现」，排查了很久。）
  const missing = [];
  for (const config of available) {
    try {
      await fs.access(config.outfile);
    } catch {
      missing.push(path.relative(root, config.outfile));
    }
  }
  if (missing.length > 0) {
    console.error(`[build] ❌ 缺少产物：${missing.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[build] 完成（${available.length} 个入口）`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
