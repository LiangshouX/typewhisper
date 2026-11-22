/**
 * 把 release/win-unpacked 打成免安装 zip。
 *
 * 为什么要自己打：图标改写（rcedit）发生在 electron-builder 之后，
 * 如果让 electron-builder 自己出 zip，改完图标 zip 里还是旧 exe。
 * 所以流程是：--dir 出目录 → 打图标 → 这里打包。
 *
 * 用法：node scripts/make-zip.cjs [目录]
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const source = process.argv[2] || path.join(root, 'release', 'win-unpacked');
const outDir = path.join(root, 'release');
const zipPath = path.join(outDir, `${pkg.productName}-${pkg.version}-x64-免安装.zip`);

if (!fs.existsSync(source)) {
  console.error(`找不到目录：${source}`);
  process.exit(1);
}

// 优先用系统 tar（Win10 自带 bsdtar，支持 zip）
function zipWithTar() {
  execFileSync(
    'tar',
    ['-a', '-c', '-f', zipPath, '-C', outDir, path.basename(source)],
    { stdio: 'inherit' },
  );
}

function zipWithPowerShell() {
  const escaped = zipPath.replace(/'/g, "''");
  const ps = `Compress-Archive -Path '${source}\\*' -DestinationPath '${escaped}' -Force`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
}

fs.rmSync(zipPath, { force: true });
try {
  zipWithTar();
  console.log(`✅ ${path.basename(zipPath)}`);
} catch {
  console.log('tar 不可用，改用 PowerShell Compress-Archive…');
  zipWithPowerShell();
  console.log(`✅ ${path.basename(zipPath)}`);
}

const size = fs.statSync(zipPath).size;
console.log(`   ${(size / 1024 / 1024).toFixed(1)} MB`);
