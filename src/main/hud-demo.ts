import fs from 'node:fs';
import path from 'node:path';

import { capture } from './capture/capture.js';
import { hud } from './hud/hud.js';
import { log } from './logger.js';

/** 读 16bit PCM 的 WAV。 */
function readWav(file: string): { samples: Float32Array; sampleRate: number } {
  const buf = fs.readFileSync(file);
  let offset = 12;
  let sampleRate = 16000;
  let channels = 1;
  let bits = 16;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, buf.length - body);
    }
    offset = body + size + (size % 2);
  }
  if (dataOffset < 0 || bits !== 16) throw new Error('WAV 格式不支持');

  const count = Math.floor(dataLength / 2 / channels);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += buf.readInt16LE(dataOffset + (i * channels + c) * 2) / 32768;
    }
    out[i] = sum / channels;
  }
  return { samples: out, sampleRate };
}

/** 找语音样本。 */
function findFixture(): string | null {
  const candidates = [
    path.join(__dirname, '..', 'fixtures', 'sample-speech.wav'),
    path.join(__dirname, '..', '..', 'scripts', 'fixtures', 'sample-speech.wav'),
    path.join(process.cwd(), 'scripts', 'fixtures', 'sample-speech.wav'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * 悬浮指示条演示：注入一段语音，让声波真的动起来。
 * 用来在真实桌面上检查指示条的位置与观感。
 */
export async function runHudDemo(seconds = 20): Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  await capture.ensureReady();
  // 等悬浮条页面真的加载完，否则截到的是空白
  await hud.ensureReady();
  log.info('hud-demo', '悬浮条与录音窗口都已就绪');

  const fixture = findFixture();
  if (!fixture) {
    log.warn('hud-demo', '找不到语音样本，声波不会有变化');
  }
  const wav = fixture ? readWav(fixture) : null;

  capture.setIgnoreMicAudio(true);
  await capture.start();
  hud.update({ stage: 'recording', label: '正在录音' });
  hud.reposition();

  const deadline = Date.now() + seconds * 1000;
  const startedAt = Date.now();
  let captured = false;
  while (Date.now() < deadline) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    hud.update({ stage: 'recording', label: '正在录音', detail: `${elapsed}s` });
    // 中途把悬浮条自己抓一张图（不用管它有没有被别的窗口挡住）
    if (!captured && Number(elapsed) > 2) {
      captured = true;
      const file = path.join(process.env.TEMP ?? '.', 'typewhisper-hud.png');
      await hud.capture(file);
      log.info('hud-demo', `悬浮条截图：${file}`);
    }
    if (wav) {
      const half = Math.floor(wav.samples.length / 2);
      capture.injectTestAudio(wav.samples.subarray(0, half), wav.sampleRate);
      await sleep(320);
      capture.injectTestAudio(wav.samples.subarray(half), wav.sampleRate);
      await sleep(320);
    } else {
      await sleep(200);
    }
  }

  await capture.stop();
  capture.setIgnoreMicAudio(false);
  hud.update({ stage: 'done', label: '已写入' });
  log.info('hud-demo', '演示结束');
}
