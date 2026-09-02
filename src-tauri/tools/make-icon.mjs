// Genera el PNG fuente del icono (terminal con prompt ">_") sin dependencias.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const S = 1024;
const px = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const BG = px("#1b1f26");
const ACCENT = px("#d97757");

const clamp01 = (v) => Math.min(1, Math.max(0, v));
// Cobertura suavizada: 1 dentro de la forma, 0 fuera, transición de ~1.5 px.
const cover = (d) => clamp01(0.5 - d / 1.5);

function roundedBox(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

function segment(x, y, ax, ay, bx, by, halfWidth) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = clamp01(((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy));
  return Math.hypot(x - (ax + vx * t), y - (ay + vy * t)) - halfWidth;
}

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  const rowStart = y * (S * 4 + 1);
  raw[rowStart] = 0; // filtro «none»
  for (let x = 0; x < S; x++) {
    const bg = cover(roundedBox(x, y, S / 2, S / 2, S / 2, S / 2, S * 0.22));
    const chevron = Math.min(
      segment(x, y, 300, 340, 500, 512, 42),
      segment(x, y, 300, 684, 500, 512, 42),
    );
    const underscore = roundedBox(x, y, 660, 672, 110, 30, 28);
    const ink = Math.max(cover(Math.min(chevron, underscore)), 0);

    const o = rowStart + 1 + x * 4;
    for (let c = 0; c < 3; c++) raw[o + c] = Math.round(BG[c] * (1 - ink) + ACCENT[c] * ink);
    raw[o + 3] = Math.round(bg * 255);
  }
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crcTable = (chunk.table ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crcBuf]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;
ihdr[9] = 6; // RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync("tools/icon-source.png", png);
console.log("tools/icon-source.png", png.length, "bytes", createHash("md5").update(png).digest("hex").slice(0, 8));
