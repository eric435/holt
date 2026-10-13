/**
 * Just enough PNG decoding for tests to sample pixels: 8-bit, non-interlaced,
 * RGB or RGBA (what Chrome's captureVisibleTab and our OffscreenCanvas
 * produce). Concatenate the IDAT chunks, inflate with node:zlib, and undo
 * the per-row filters (None, Sub, Up, Average, Paeth).
 */

import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Signature + IHDR only (cheap): { ok, width, height, bytes } or { ok: false, reason }. */
export function pngInfo(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE)) return { ok: false, reason: "bad PNG signature" };
  if (buf.toString("ascii", 12, 16) !== "IHDR") return { ok: false, reason: "first chunk is not IHDR" };
  return { ok: true, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

/** Decode to { width, height, pixel(x, y) -> [r, g, b, a] }. Throws on unsupported formats. */
export function decodePng(buf) {
  const info = pngInfo(buf);
  if (!info.ok) throw new Error(info.reason);
  const { width, height } = info;
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  const channels = { 2: 3, 6: 4 }[colorType];
  if (bitDepth !== 8 || !channels || interlace !== 0) {
    throw new Error(`unsupported PNG (bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace})`);
  }

  const idat = [];
  for (let offset = 8; offset < buf.length; ) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(buf.subarray(offset + 8, offset + 8 + length));
    if (type === "IEND") break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));

  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0; // left
      const b = prev ? prev[i] : 0; // up
      const c = prev && i >= channels ? prev[i - channels] : 0; // up-left
      let value;
      switch (filter) {
        case 0: value = line[i]; break;
        case 1: value = line[i] + a; break;
        case 2: value = line[i] + b; break;
        case 3: value = line[i] + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad PNG filter type ${filter} on row ${y}`);
      }
      out[i] = value & 0xff;
    }
  }

  return {
    width,
    height,
    pixel(x, y) {
      const i = (Math.round(y) * width + Math.round(x)) * channels;
      return [pixels[i], pixels[i + 1], pixels[i + 2], channels === 4 ? pixels[i + 3] : 255];
    },
  };
}

/** "rgb(76, 110, 245)" / "rgba(...)" -> [r, g, b]. */
export function parseCssColor(css) {
  const m = css.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (!m) throw new Error(`can't parse colour ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function colorClose([r1, g1, b1], [r2, g2, b2], tolerance = 12) {
  return Math.abs(r1 - r2) <= tolerance && Math.abs(g1 - g2) <= tolerance && Math.abs(b1 - b2) <= tolerance;
}
