/**
 * 给设置页拍一张截图（按主题分别拍）。
 * 用法：node scripts/shoot-themes.cjs <light|dark> <输出路径>
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const theme = process.argv[2] || 'light';
const out = process.argv[3] || path.join(process.env.TEMP, `typewhisper-${theme}.png`);
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const appDir = path.join(process.env.APPDATA, pkg.productName);
const settingsPath = path.join(appDir, 'settings.json');

const settings = {
  version: 1,
  hotkey: { accelerator: 'Control+Super+K', mode: 'hold', cancelKey: 'Escape', clearClipboardOnTrigger: false },
  asr: {
    modelRoot: path.join(process.env.USERPROFILE, '.dsh', 'speech-to-text', 'sensevoice', 'models'),
    senseVoiceModel: '', tokens: '', vadModel: '',
    threads: 2, language: 'auto', vadThreshold: 0.5,
    minSpeechSeconds: 0.25, minSilenceSeconds: 0.5, maxSpeechSeconds: 30, itn: true,
  },
  llm: {
    enabled: false, baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat',
    temperature: 0, timeoutMs: 1200, maxTotalLatencyMs: 2500,
    usePartialOnTimeout: false, streaming: true, extraSystemPrompt: '', terms: [],
  },
  input: { mode: 'type', restoreClipboard: true, trailingSpace: false },
  advanced: { logLevel: 'info', autoLaunch: false, startMinimized: true, showHud: true },
  ui: { theme },
};

fs.mkdirSync(appDir, { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

const electronPath = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const root = path.dirname(__dirname);
const child = spawn(electronPath, [root, '--shot', out], { stdio: 'inherit', env });
child.on('exit', (code) => {
  // 拍完就还原成默认设置，别把测试配置留在用户机器上
  fs.rmSync(settingsPath, { force: true });
  process.exit(code ?? 0);
});
