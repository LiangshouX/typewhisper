/**
 * 探测哪些全局快捷键组合在这台机器上能注册成功。
 * 用法：node scripts/probe-accelerators.cjs
 */
const { app, globalShortcut } = require('electron');

const CANDIDATES = [
  'Control+Alt+V',
  'Control+Super+V',
  'Control+Super+Space',
  'Control+Super+D',
  'Control+Super+J',
  'Control+Super+K',
  'Control+Super+X',
  'Control+Super+B',
  'Control+Super+Shift+V',
  'Control+Alt+Space',
  'Control+Alt+Shift+V',
  'Super+V',
];

app.whenReady().then(() => {
  const results = [];
  for (const accelerator of CANDIDATES) {
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, () => {});
    } catch (error) {
      ok = `throw: ${error.message}`;
    }
    if (ok === true) globalShortcut.unregister(accelerator);
    results.push({ accelerator, ok });
    console.log(`${ok === true ? '✅' : '❌'} ${accelerator}${ok === true ? '' : `  → ${ok}`}`);
  }
  console.log('\n可用组合：', results.filter((r) => r.ok === true).map((r) => r.accelerator).join('  |  '));
  app.exit(0);
});
