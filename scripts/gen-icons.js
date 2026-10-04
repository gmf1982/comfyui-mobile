/**
 * 生成应用图标：icon.svg + icon-192.png + icon-512.png（纯 Node 实现，无图像库依赖）。
 * 图案：圆角底板 + 白色圆环（ComfyUI 风格）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'web', 'icons');
fs.mkdirSync(outDir, { recursive: true });

// ---------- SVG ----------
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="#4d7cff"/>
  <circle cx="256" cy="256" r="118" fill="none" stroke="#ffffff" stroke-width="52"/>
  <circle cx="256" cy="256" r="26" fill="#ffffff"/>
</svg>
`;
fs.writeFileSync(path.join(outDir, 'icon.svg'), svg);

// ---------- PNG ----------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const r = 0.22 * size;          // 圆角半径
  const cx = size / 2;
  const outerR = 0.235 * size;
  const ringW = 0.105 * size;
  const dotR = 0.05 * size;
  const bg = [0x4d, 0x7c, 0xff];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 圆角矩形内测试
      const dx = Math.max(r - x, 0, x - (size - 1 - r));
      const dy = Math.max(r - y, 0, y - (size - 1 - r));
      const inRect = dx * dx + dy * dy <= r * r;
      let px = bg[0], pg = bg[1], pb = bg[2], pa = inRect ? 255 : 0;
      if (inRect) {
        const dist = Math.hypot(x - cx, y - cx);
        const inRing = Math.abs(dist - outerR) <= ringW / 2 || dist <= dotR;
        if (inRing) {
          px = 0xff; pg = 0xff; pb = 0xff;
        }
      }
      const i = (y * size + x) * 4;
      rgba[i] = px; rgba[i + 1] = pg; rgba[i + 2] = pb; rgba[i + 3] = pa;
    }
  }
  return encodePng(size, size, rgba);
}

for (const size of [192, 512]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), drawIcon(size));
  console.log(`icon-${size}.png 已生成`);
}
