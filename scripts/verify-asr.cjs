/**
 * 独立验证脚本（不依赖 Electron）：
 * 用 sherpa-onnx-node 跑一遍本机的 SenseVoice + Silero VAD 模型。
 * 用法：node scripts/verify-asr.cjs <wav文件> [模型根目录]
 */
const path = require('node:path');
const fs = require('node:fs');
const sherpa = require('sherpa-onnx-node');

const wavPath = process.argv[2];
const modelRoot =
  process.argv[3] ||
  path.join(process.env.USERPROFILE, '.dsh', 'speech-to-text', 'sensevoice', 'models');

const model = path.join(modelRoot, 'sensevoice-onnx', 'model.int8.onnx');
const tokens = path.join(modelRoot, 'sensevoice-onnx', 'tokens.txt');
const vad = path.join(modelRoot, 'silero', 'silero_vad.onnx');

for (const [label, file] of [
  ['model', model],
  ['tokens', tokens],
  ['vad', vad],
]) {
  if (!fs.existsSync(file)) {
    console.error(`缺少 ${label}: ${file}`);
    process.exit(1);
  }
}

/** 读 16bit PCM 单声道 WAV。 */
function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 WAV 文件');
  let offset = 12;
  let sampleRate = 16000;
  let bits = 16;
  let channels = 1;
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

const config = {
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    senseVoice: { model, language: 'auto', useInverseTextNormalization: 1 },
    tokens,
    numThreads: 2,
    provider: 'cpu',
    debug: 0,
  },
};

console.log('加载模型中…');
let t0 = Date.now();
const recognizer = new sherpa.OfflineRecognizer(config);
console.log(`模型加载完成 ${Date.now() - t0}ms`);

const detector = new sherpa.Vad(
  {
    sileroVad: {
      model: vad,
      threshold: 0.5,
      minSilenceDuration: 0.5,
      minSpeechDuration: 0.25,
      maxSpeechDuration: 30,
      windowSize: 512,
    },
    sampleRate: 16000,
    numThreads: 2,
    provider: 'cpu',
    debug: 0,
  },
  31.5,
);

const { samples, sampleRate } = readWav(wavPath);
console.log(`音频 ${(samples.length / sampleRate).toFixed(2)}s @ ${sampleRate}Hz`);

let pcm = samples;
if (sampleRate !== 16000) {
  const rs = new sherpa.LinearResampler(sampleRate, 16000);
  pcm = rs.flush(samples);
}

t0 = Date.now();
detector.reset();
const parts = [];
const drain = () => {
  while (!detector.isEmpty()) {
    const segment = detector.front(false);
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples: segment.samples });
    recognizer.decode(stream);
    parts.push(recognizer.getResult(stream).text.trim());
    detector.pop();
  }
};
for (let off = 0; off < pcm.length; off += 512) {
  detector.acceptWaveform(pcm.subarray(off, off + 512));
  drain();
}
detector.flush();
drain();

console.log(`识别完成 ${Date.now() - t0}ms`);
console.log('分段:', JSON.stringify(parts, null, 2));
console.log('合并:', parts.filter(Boolean).join(''));
