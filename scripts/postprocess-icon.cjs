/**
 * 打包后处理：给产出的 exe 换上图标与版本信息。
 *
 * 为什么单独做：electron-builder 内置的 winCodeSign 压缩包里带符号链接，
 * Windows 普通用户没有创建符号链接的权限，它自己的解压会失败。
 * 所以打包时用 `win.signAndEditExecutable: false` 跳过，
 * 这里再用已经解压好的 rcedit 手动打图标。
 *
 * 用法：node scripts/postprocess-icon.cjs [release/win-unpacked]
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const outDir = process.argv[2] || path.join(root, 'release', 'win-unpacked');
const icon = path.join(root, 'build', 'icon.ico');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/** 在 electron-builder 缓存里找 rcedit。 */
function findRcedit() {
  // CI 上可以显式指定（见 .github/workflows/release.yml）
  if (process.env.RCEDIT_PATH && fs.existsSync(process.env.RCEDIT_PATH)) {
    return process.env.RCEDIT_PATH;
  }
  const cacheRoot =
    process.env.ELECTRON_BUILDER_CACHE ||
    path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache');
  const winCodeSign = path.join(cacheRoot, 'winCodeSign');
  if (!fs.existsSync(winCodeSign)) return null;
  const dirs = fs.readdirSync(winCodeSign).sort((a, b) => b.localeCompare(a));
  for (const dir of dirs) {
    const candidate = path.join(winCodeSign, dir, 'rcedit-x64.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

if (!fs.existsSync(outDir)) {
  console.error(`找不到产物目录：${outDir}`);
  process.exit(1);
}
if (!fs.existsSync(icon)) {
  console.error(`找不到图标：${icon}（先跑 npm run icon）`);
  process.exit(1);
}

const exe = path.join(outDir, `${pkg.productName}.exe`);
if (!fs.existsSync(exe)) {
  console.error(`找不到主程序：${exe}`);
  process.exit(1);
}

const rcedit = findRcedit();
if (!rcedit) {
  // 图标只是门面，找不到 rcedit 不该让整条流水线挂掉
  console.warn('⚠️ 找不到 rcedit-x64.exe，跳过图标替换（软件本身不受影响）');
  console.warn('   本地可跑：node scripts/prepare-wincodesign.cjs');
  process.exit(0);
}

const version = pkg.version.split('.').concat('0').slice(0, 3).join('.') + '.0';

const args = [
  exe,
  '--set-icon',
  icon,
  '--set-version-string',
  'FileDescription',
  pkg.productName,
  '--set-version-string',
  'ProductName',
  pkg.productName,
  '--set-version-string',
  'CompanyName',
  pkg.author ?? 'QingYu',
  '--set-version-string',
  'LegalCopyright',
  pkg.description ?? pkg.productName,
  '--set-file-version',
  version,
  '--set-product-version',
  version,
];

console.log(`给 ${path.basename(exe)} 打图标与版本信息（${version}）…`);
execFileSync(rcedit, args, { stdio: 'inherit' });
console.log('✅ 完成');
