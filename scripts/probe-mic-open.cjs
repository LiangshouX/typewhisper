/**
 * 测一下「按需打开麦克风」的开销：连续开关三次，看每次打开设备要多久。
 * 用法：npx electron scripts/probe-mic-open.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  const html = `<!doctype html><html><body><script>
    window.probe = async (times) => {
      const out = [];
      for (let i = 0; i < times; i++) {
        const t0 = performance.now();
        const stream = await navigator.mediaDevices.getUserMedia({ audio: {
          channelCount: 1, echoCancellation: false, noiseSuppression: false,
          autoGainControl: false, sampleRate: 16000,
        }});
        const openMs = Math.round(performance.now() - t0);
        for (const track of stream.getTracks()) track.stop();
        await new Promise((r) => setTimeout(r, 150));
        out.push(openMs);
      }
      return out;
    };
    window.__ready = true;
  </script></body></html>`;

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 500));

  const times = await win.webContents.executeJavaScript('window.probe(4)');
  console.log('每次打开麦克风的耗时(ms):', times.join(', '));

  // 再测一次「间隔 5 秒后打开」，看设备会不会被系统释放
  await new Promise((r) => setTimeout(r, 5000));
  const later = await win.webContents.executeJavaScript('window.probe(1)');
  console.log('间隔 5 秒后再打开(ms):', later.join(', '));

  app.exit(0);
});
