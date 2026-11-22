/**
 * 预解压 electron-builder 的 winCodeSign 缓存。
 *
 * 背景：winCodeSign 的 7z 里带着 **符号链接**（darwin/10.12/lib/*.dylib 指向
 * 同目录的其它文件）。Windows 默认不允许普通用户创建符号链接，于是
 * electron-builder 的自动解压会失败：
 *   ERROR: Cannot create symbolic link : 客户端没有所需特权
 *
 * 但我们打的是 Windows 包，darwin 目录根本用不上。这里先手动把压缩包解开
 * （跳过那两个符号链接），electron-builder 就会认为缓存已就绪，直接跳过解压。
 *
 * 用法：node scripts/prepare-wincodesign.cjs
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const cacheRoot =
  process.env.ELECTRON_BUILDER_CACHE ||
  path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache');
const winCodeSignDir = path.join(cacheRoot, 'winCodeSign');
const sevenZip = path.join(
  __dirname,
  '..',
  'node_modules',
  '7zip-bin',
  'win',
  'x64',
  '7za.exe',
);

if (!fs.existsSync(winCodeSignDir)) {
  console.log('缓存目录还不存在，等 electron-builder 下载后再跑一次');
  process.exit(0);
}
if (!fs.existsSync(sevenZip)) {
  console.error('找不到 7za.exe');
  process.exit(1);
}

const archives = fs
  .readdirSync(winCodeSignDir)
  .filter((name) => name.endsWith('.7z'))
  .map((name) => path.join(winCodeSignDir, name));

for (const archive of archives) {
  const target = archive.replace(/\.7z$/, '');
  // 已经解开且含 rcedit 就跳过
  if (fs.existsSync(path.join(target, 'rcedit-x64.exe'))) {
    console.log(`跳过（已就绪）：${path.basename(target)}`);
    continue;
  }
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`解压 ${path.basename(archive)} …`);
  execFileSync(
    sevenZip,
    [
      'x',
      '-snld',
      '-bd',
      archive,
      `-o${target}`,
      '-x!darwin\\10.12\\lib\\libcrypto.dylib',
      '-x!darwin\\10.12\\lib\\libssl.dylib',
    ],
    { stdio: 'inherit' },
  );
  const ok = fs.existsSync(path.join(target, 'rcedit-x64.exe'));
  console.log(`  → ${ok ? '✅ rcedit 就绪' : '❌ 缺少 rcedit-x64.exe'}`);
}
