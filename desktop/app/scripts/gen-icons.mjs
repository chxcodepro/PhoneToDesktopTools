// 生成应用图标和托盘图标（PNG），不依赖任何图像库。
// 图形：圆角方形底色 + 白色手机轮廓。托盘图标按状态换底色。
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 点 (x,y) 是否在圆角矩形内（坐标为 0~1 的相对值）
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function draw(size, bg) {
  const out = Buffer.alloc(size * size * 4);
  const ss = 4; // 超采样抗锯齿
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let a = 0, white = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          if (!inRoundRect(x, y, 0.04, 0.04, 0.96, 0.96, 0.22)) continue;
          a++;
          // 手机外框（环）+ 底部圆点
          const outer = inRoundRect(x, y, 0.32, 0.18, 0.68, 0.82, 0.08);
          const inner = inRoundRect(x, y, 0.39, 0.25, 0.61, 0.67, 0.03);
          const dot = (x - 0.5) ** 2 + (y - 0.745) ** 2 <= 0.035 ** 2;
          if ((outer && !inner) || dot) white++;
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      if (a === 0) continue;
      const w = white / a;
      out[i] = Math.round(bg[0] * (1 - w) + 255 * w);
      out[i + 1] = Math.round(bg[1] * (1 - w) + 255 * w);
      out[i + 2] = Math.round(bg[2] * (1 - w) + 255 * w);
      out[i + 3] = Math.round((a / n) * 255);
    }
  }
  return png(size, out);
}

const BLUE = [37, 99, 235];
const SLATE = [100, 116, 139];
const AMBER = [217, 119, 6];
const RED = [220, 38, 38];

const files = {
  'build/icon.png': draw(256, BLUE),
  'build/icons/app.png': draw(256, BLUE),
  'build/icons/tray-idle.png': draw(32, SLATE),
  'build/icons/tray-connecting.png': draw(32, AMBER),
  'build/icons/tray-controlled.png': draw(32, RED),
};
for (const [rel, data] of Object.entries(files)) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
}
console.log('图标已生成：', Object.keys(files).join(', '));
