import fs from 'node:fs';
import path from 'node:path';

import type { AppSettings } from '../shared/contract.js';
import { capture } from './capture/capture.js';
import { hotkey } from './hotkey/hotkey.js';
import { log } from './logger.js';
import { pipeline } from './pipeline.js';

/** 读 16bit PCM 的 WAV（只处理单声道/双声道常见格式）。 */
function readWav(file: string): { samples: Float32Array; sampleRate: number } {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 WAV 文件');
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
  if (dataOffset < 0) throw new Error('WAV 没有 data 块');
  if (bits !== 16) throw new Error(`只支持 16bit，当前 ${bits}`);

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

/** 线性重采样到目标采样率（自检用，够用即可）。 */
function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const frac = position - index;
    const a = samples[index] ?? 0;
    const b = samples[index + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** 找测试用的语音样本。 */
function findFixture(): string | null {
  const candidates = [
    // 打包后：dist/fixtures（构建脚本会拷过去）
    path.join(__dirname, '..', 'fixtures', 'sample-speech.wav'),
    // 开发时：项目里的 scripts/fixtures
    path.join(__dirname, '..', '..', 'scripts', 'fixtures', 'sample-speech.wav'),
    path.join(process.cwd(), 'scripts', 'fixtures', 'sample-speech.wav'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * 快捷键 + 语音全链路自检。
 *
 * 复现并守住那个「按住就抖」的 bug：
 * Windows 在按住组合键时会**自动重复**地发快捷键，
 * 如果录音中的重复触发没有被挡掉，就会变成
 * 「空闲 → 录制中 → 空闲 → 录制中」地来回跳，什么也录不进去。
 *
 * 这里用模拟的按键状态把整个按住流程走一遍：
 *   按下 → 连发 8 次自动重复 → 松手
 * 断言全程只录了一次，且录音时长符合预期。
 *
 * 再往采集流里注入一段真实语音，验证「按住 → 出文字」整条链路是通的
 * （不依赖房间里有声音）。
 */
export async function runHotkeyTest(): Promise<boolean> {
  let failures = 0;
  const check = (label: string, ok: boolean, detail?: string): void => {
    if (!ok) failures++;
    log.info('hotkey-test', `${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  };

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  // 先等录音窗口与麦克风就绪，否则测的是「窗口还在创建」而不是「按住逻辑」
  await capture.ensureReady();
  await sleep(300);

  // 模拟「主键一直按着」
  let keyDown = false;
  hotkey.setKeyStateProbe(() => keyDown);

  const stages: string[] = [];
  pipeline.on('status', (status) => {
    stages.push(status.stage);
  });

  // 准备一段真实语音，在录音期间注入采集流。
  // 统一重采样到 16k（跟麦克风一致），免得两种采样率混在一个缓冲区里。
  const fixture = findFixture();
  let injected: { samples: Float32Array; sampleRate: number } | null = null;
  if (fixture) {
    try {
      const wav = readWav(fixture);
      const samples = resample(wav.samples, wav.sampleRate, 16_000);
      injected = { samples, sampleRate: 16_000 };
      log.info(
        'hotkey-test',
        `已载入语音样本 ${path.basename(fixture)}（${(samples.length / 16_000).toFixed(2)}s）`,
      );
    } catch (error) {
      log.warn('hotkey-test', `语音样本读取失败：${String(error)}`);
    }
  } else {
    log.warn('hotkey-test', '找不到语音样本，跳过文字识别校验');
  }

  let lastResultText = '';
  let resultArrived = false;
  pipeline.on('result', (result) => {
    lastResultText = result.final;
    resultArrived = true;
  });

  try {
    /* ---- 1. 按下（走真实快捷键路径） ---- */
    keyDown = true;
    // 自检时丢掉真实麦克风的数据，只留注入的音频
    capture.setIgnoreMicAudio(true);
    hotkey.triggerForTest();
    // 开麦克风要一点时间（设备是按需打开的），这里留够余量
    await sleep(1200);
    check('按下后进入录音', pipeline.status.stage === 'recording', pipeline.status.stage);

    /* ---- 2. 系统自动重复：连按 8 次 ---- */
    const before = stages.length;
    for (let i = 0; i < 8; i++) {
      hotkey.triggerForTest();
      await sleep(40);
    }
    const repeats = stages.slice(before).filter((s) => s === 'idle' || s === 'decoding');
    check(
      '自动重复没有打断录音',
      pipeline.status.stage === 'recording' && repeats.length === 0,
      `重复期间出现了 ${repeats.length} 次中断，当前阶段 ${pipeline.status.stage}`,
    );

    /* ---- 3. 保持按住，并注入真实语音 ---- */
    const heldFrom = Date.now();
    if (injected) {
      // 分两半注入，模拟「说了一半」
      const half = Math.floor(injected.samples.length / 2);
      capture.injectTestAudio(injected.samples.subarray(0, half), injected.sampleRate);
      await sleep(500);
      capture.injectTestAudio(injected.samples.subarray(half), injected.sampleRate);
    }
    await sleep(1200);
    check('按住期间一直是录音态', pipeline.status.stage === 'recording', pipeline.status.stage);

    /* ---- 4. 松手 ---- */
    keyDown = false;
    await sleep(400);
    const heldMs = Date.now() - heldFrom;
    check(
      '松手后结束录音',
      pipeline.status.stage !== 'recording',
      `阶段 ${pipeline.status.stage}`,
    );
    check('录音时长符合按住时长', heldMs >= 1100, `按住 ${heldMs}ms`);

    /* ---- 5. 松手后不应该自动再开一轮 ---- */
    const recordingStages = stages.filter((s) => s === 'recording').length;
    check('全程只开了一轮录音', recordingStages === 1, `录音态出现了 ${recordingStages} 次`);

    /* ---- 6. 注入的语音有没有被识别出来 ---- */
    if (injected) {
      // 等真正出结果，别用固定时长 —— 打包版首次加载模型要好几秒
      const deadline = Date.now() + 40_000;
      while (!resultArrived && Date.now() < deadline) {
        await sleep(200);
      }
      log.info('hotkey-test', `识别结果：${lastResultText || '(空)'}`);
      // 断言用「按住说话」这个短语，而不是「轻语」——
      // 声学模型本来就可能把「轻语」听成「听语」，那是纠偏层该管的事。
      check(
        '注入的真实语音被识别成文字',
        lastResultText.includes('按住说话'),
        lastResultText || '(没有识别出文字)',
      );
    }
  } finally {
    hotkey.setKeyStateProbe(null);
    capture.setIgnoreMicAudio(false);
  }

  log.info('hotkey-test', failures === 0 ? '✅ 快捷键自检全部通过' : `❌ ${failures} 项不通过`);
  return failures === 0;
}
