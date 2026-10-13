#!/usr/bin/env node
/**
 * Generate the extension's PNG icons with zero dependencies.
 *
 * Chrome wants PNG icons at 16/32/48/128 px. Rather than check in binary
 * files from an image editor, we draw them here: a rounded square with a
 * white lowercase "n", anti-aliased by 4x4 supersampling, then encode a PNG
 * by hand (signature + IHDR + IDAT (zlib) + IEND, each chunk with a CRC32).
 *
 * Output goes to public/icons and is committed, so a normal build does not
 * need to run this. Re-run with `pnpm --filter @nitpick/extension icons`.
 */

import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "public/icons");
const SIZES = [16, 32, 48, 128];
const BG = [76, 110, 245]; // #4c6ef5
const FG = [255, 255, 255];

// ---- geometry, in a unit square [0,1]x[0,1] ---------------------------------

const CORNER = 0.22; // corner radius of the background square

/** Signed distance to a rounded square filling the unit square (negative = inside). */
function roundedSquareDistance(x, y) {
  const qx = Math.abs(x - 0.5) - (0.5 - CORNER);
  const qy = Math.abs(y - 0.5) - (0.5 - CORNER);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - CORNER;
}

// The "n": left stem, an arch (upper half circle), right stem.
const STROKE = 0.085; // half the stroke width
const ARCH_R = 0.16;
const ARCH_CX = 0.5;
const ARCH_CY = 0.45;
const BASELINE = 0.74;
const X_LEFT = ARCH_CX - ARCH_R;
const X_RIGHT = ARCH_CX + ARCH_R;
const TOP = ARCH_CY - ARCH_R - 0.02;

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function letterDistance(x, y) {
  const leftStem = segmentDistance(x, y, X_LEFT, TOP, X_LEFT, BASELINE);
  const rightStem = segmentDistance(x, y, X_RIGHT, ARCH_CY, X_RIGHT, BASELINE);
  // Upper half of the arch circle only.
  const arch = y <= ARCH_CY ? Math.abs(Math.hypot(x - ARCH_CX, y - ARCH_CY) - ARCH_R) : Infinity;
  return Math.min(leftStem, rightStem, arch) - STROKE;
}

// ---- raster ------------------------------------------------------------------

function render(size) {
  const SS = 4; // supersamples per axis
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgCover = 0;
      let fgCover = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (roundedSquareDistance(x, y) <= 0) {
            bgCover++;
            if (letterDistance(x, y) <= 0) fgCover++;
          }
        }
      }
      const n = SS * SS;
      const alpha = bgCover / n;
      const mix = bgCover ? fgCover / bgCover : 0;
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(BG[c] * (1 - mix) + FG[c] * mix);
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

// ---- PNG encoding ------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace
  // Each scanline is prefixed with a filter-type byte (0 = none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

await mkdir(outDir, { recursive: true });
for (const size of SIZES) {
  const file = join(outDir, `icon-${size}.png`);
  await writeFile(file, encodePng(size, render(size)));
  console.log(`wrote ${file}`);
}
