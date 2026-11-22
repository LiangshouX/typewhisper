/**
 * 生成应用图标（PNG + ICO）。
 *
 * Windows 的托盘图标必须是 .ico，而 Electron 无法从 PNG 生成 HICON，
 * 所以这里手写一个最小 PNG 编码器 + ICO 容器。
 * 图标本身是「圆角方块 + 麦克风」的极简造型。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(root, 'build');

/* ---------------------------- PNG 编码 ---------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

/** 把 RGBA 像素数组编码成 PNG。 */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------- 绘图 ---------------------------- */

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 圆角矩形的有符号距离。 */
function roundedRectDistance(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** 胶囊（圆角矩形）距离场。 */
function capsuleDistance(px, py, x1, y1, x2, y2, radius) {
  const pax = px - x1;
  const pay = py - y1;
  const bax = x2 - x1;
  const bay = y2 - y1;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * h, pay - bay * h) - radius;
}

/** 抗锯齿覆盖率。 */
function coverage(distance) {
  return clamp01(0.5 - distance);
}

function blend(target, offset, r, g, b, a) {
  if (a <= 0) return;
  const inv = 1 - a;
  target[offset] = Math.round(r * a + target[offset] * inv);
  target[offset + 1] = Math.round(g * a + target[offset + 1] * inv);
  target[offset + 2] = Math.round(b * a + target[offset + 2] * inv);
  target[offset + 3] = Math.round(a * 255 + target[offset + 3] * inv);
}

/** 画一个 size×size 的图标。 */
function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4, 0);
  const s = (v) => (v * size) / 256;

  const bg = { r: 17, g: 22, b: 31 };
  const bgBottom = { r: 30, g: 41, b: 59 };
  const accent = { r: 76, g: 154, b: 255 };
  const white = { r: 240, g: 246, b: 252 };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const offset = (y * size + x) * 4;

      // 背景：圆角方块 + 竖直渐变
      const bgDist = roundedRectDistance(px, py, s(128), s(128), s(120), s(120), s(56));
      const bgA = coverage(bgDist);
      if (bgA > 0) {
        const t = py / size;
        blend(rgba, offset, bg.r + (bgBottom.r - bg.r) * t, bg.g + (bgBottom.g - bg.g) * t, bg.b + (bgBottom.b - bg.b) * t, bgA);
      }

      // 麦克风头部：胶囊
      const headDist = capsuleDistance(px, py, s(128), s(62), s(128), s(130), s(30));
      const headA = coverage(headDist);
      if (headA > 0) blend(rgba, offset, accent.r, accent.g, accent.b, headA);

      // 麦克风内芯（浅色）
      const innerDist = capsuleDistance(px, py, s(128), s(78), s(128), s(124), s(14));
      const innerA = coverage(innerDist);
      if (innerA > 0) blend(rgba, offset, white.r, white.g, white.b, innerA);

      // 支架：一个开口的 U 形，用两个圆弧近似（左右两段）
      const arcR = s(56);
      const arcCx = s(128);
      const arcCy = s(104);
      const ring = Math.abs(Math.hypot(px - arcCx, py - arcCy) - arcR) - s(7);
      const below = py > arcCy ? 1 : 0;
      const arcA = below ? coverage(ring) : 0;
      if (arcA > 0) blend(rgba, offset, accent.r, accent.g, accent.b, arcA);

      // 底座
      const stemDist = roundedRectDistance(px, py, s(128), s(164), s(9), s(16), s(6));
      const stemA = coverage(stemDist);
      if (stemA > 0) blend(rgba, offset, accent.r, accent.g, accent.b, stemA);

      const baseDist = roundedRectDistance(px, py, s(128), s(188), s(40), s(9), s(9));
      const baseA = coverage(baseDist);
      if (baseA > 0) blend(rgba, offset, accent.r, accent.g, accent.b, baseA);
    }
  }
  return rgba;
}

/* ---------------------------- ICO 容器 ---------------------------- */

function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;

  entries.forEach((entry, index) => {
    const base = index * 16;
    directory[base] = entry.size >= 256 ? 0 : entry.size;
    directory[base + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[base + 2] = 0;
    directory[base + 3] = 0;
    directory.writeUInt16LE(1, base + 4);
    directory.writeUInt16LE(32, base + 6);
    directory.writeUInt32LE(entry.data.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]);
}

/* ---------------------------- 主流程 ---------------------------- */

const SIZES = [16, 24, 32, 48, 64, 128, 256];

fs.mkdirSync(buildDir, { recursive: true });

const entries = [];
for (const size of SIZES) {
  const rgba = renderIcon(size);
  const png = encodePng(size, size, rgba);
  entries.push({ size, data: png });
  if (size === 256) {
    fs.writeFileSync(path.join(buildDir, 'icon.png'), png);
  }
}

fs.writeFileSync(path.join(buildDir, 'icon.ico'), buildIco(entries));
console.log(`[icon] 已生成 build/icon.ico（${SIZES.join('/')}）与 build/icon.png`);
