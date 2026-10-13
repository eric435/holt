import { describe, expect, it } from "vitest";
import {
  MAX_CANVAS_DIMENSION,
  MAX_CANVAS_PIXELS,
  captureScale,
  cropRect,
  maxStitchHeightCss,
  planTiles,
  tileSourceY,
  tileToDevice,
} from "./stitch.js";

const NO_LIMIT = { maxHeight: 1e9, maxTiles: 1e9 };

describe("planTiles", () => {
  it("uses a single tile when the page fits in the viewport", () => {
    const plan = planTiles({ pageHeight: 500, viewportHeight: 800, ...NO_LIMIT });
    // Never smaller than the viewport: that's what captureVisibleTab returns.
    expect(plan).toEqual({ tiles: [{ scrollY: 0, destY: 0, height: 800 }], outputHeight: 800, truncated: false });
  });

  it("tiles an exact multiple of the viewport with full tiles", () => {
    const plan = planTiles({ pageHeight: 2400, viewportHeight: 800, ...NO_LIMIT });
    expect(plan.tiles).toEqual([
      { scrollY: 0, destY: 0, height: 800 },
      { scrollY: 800, destY: 800, height: 800 },
      { scrollY: 1600, destY: 1600, height: 800 },
    ]);
    expect(plan.outputHeight).toBe(2400);
    expect(plan.truncated).toBe(false);
  });

  it("scrolls to the bottom for a partial last tile and copies only its lower part", () => {
    const plan = planTiles({ pageHeight: 2000, viewportHeight: 800, ...NO_LIMIT });
    expect(plan.tiles).toEqual([
      { scrollY: 0, destY: 0, height: 800 },
      { scrollY: 800, destY: 800, height: 800 },
      // Browser can't scroll past 2000 - 800 = 1200, so the band 1600..2000
      // is found 400px down inside that capture.
      { scrollY: 1200, destY: 1600, height: 400 },
    ]);
    const last = plan.tiles[2]!;
    expect(tileSourceY(last, 1200, 800)).toBe(400);
  });

  it("rounds a fractional page height up", () => {
    const plan = planTiles({ pageHeight: 1600.4, viewportHeight: 800, ...NO_LIMIT });
    expect(plan.outputHeight).toBe(1601);
    expect(plan.tiles.at(-1)).toEqual({ scrollY: 801, destY: 1600, height: 1 });
  });

  it("truncates at maxHeight; the last tile can scroll normally since the page continues", () => {
    const plan = planTiles({ pageHeight: 50_000, viewportHeight: 800, maxHeight: 2000, maxTiles: 100 });
    expect(plan.truncated).toBe(true);
    expect(plan.outputHeight).toBe(2000);
    expect(plan.tiles.at(-1)).toEqual({ scrollY: 1600, destY: 1600, height: 400 });
    expect(tileSourceY(plan.tiles.at(-1)!, 1600, 800)).toBe(0);
  });

  it("truncates at maxTiles", () => {
    const plan = planTiles({ pageHeight: 50_000, viewportHeight: 1000, maxHeight: 1e9, maxTiles: 3 });
    expect(plan.tiles).toHaveLength(3);
    expect(plan.outputHeight).toBe(3000);
    expect(plan.truncated).toBe(true);
  });

  it("rejects a zero viewport", () => {
    expect(() => planTiles({ pageHeight: 100, viewportHeight: 0, ...NO_LIMIT })).toThrow(/viewport/);
  });
});

describe("tileSourceY", () => {
  it("uses the scroll position actually reached", () => {
    // Asked for 800, page only scrolled to 700 (e.g. it got shorter): pixels start 100px down.
    expect(tileSourceY({ scrollY: 800, destY: 800, height: 700 }, 700, 800)).toBe(100);
  });

  it("clamps so the band never reads past the viewport", () => {
    expect(tileSourceY({ scrollY: 800, destY: 800, height: 800 }, 0, 800)).toBe(0);
    expect(tileSourceY({ scrollY: 0, destY: 0, height: 800 }, 300, 800)).toBe(0);
  });
});

describe("tileToDevice", () => {
  it("scales by DPR", () => {
    expect(tileToDevice({ scrollY: 1200, destY: 1600, height: 400 }, 400, 2, 1600)).toEqual({ sy: 800, sh: 800, dy: 3200, dh: 800 });
  });

  it("leaves no seams between bands at fractional scales", () => {
    const scale = 1.25;
    const plan = planTiles({ pageHeight: 3001, viewportHeight: 777, ...NO_LIMIT });
    const bitmapHeight = Math.round(777 * scale);
    let expectedDy = 0;
    for (const tile of plan.tiles) {
      const band = tileToDevice(tile, tileSourceY(tile, tile.scrollY, 777), scale, bitmapHeight);
      expect(band.dy).toBe(expectedDy);
      expect(band.sy + band.sh).toBeLessThanOrEqual(bitmapHeight);
      expect(Math.abs(band.dh - band.sh)).toBeLessThanOrEqual(1);
      expectedDy = band.dy + band.dh;
    }
    expect(expectedDy).toBe(Math.round(3001 * scale));
  });
});

describe("captureScale", () => {
  it("measures device px per CSS px from the bitmap", () => {
    expect(captureScale(2880, 1440, 1)).toBe(2);
    expect(captureScale(1800, 1440, 2)).toBe(1.25);
  });
  it("falls back to DPR, then 1", () => {
    expect(captureScale(0, 1440, 2)).toBe(2);
    expect(captureScale(100, 0, 0)).toBe(1);
  });
});

describe("cropRect", () => {
  it("scales a CSS rect to device pixels", () => {
    expect(cropRect({ x: 10, y: 20, width: 100, height: 50 }, 2, 2000, 1000)).toEqual({ sx: 20, sy: 40, sw: 200, sh: 100 });
  });

  it("rounds edges, not sizes, at fractional scales", () => {
    // 10.5 * 1.5 = 15.75 -> 16; (10.5 + 33.3) * 1.5 = 65.7 -> 66
    expect(cropRect({ x: 10.5, y: 0, width: 33.3, height: 10 }, 1.5, 1000, 1000)).toEqual({ sx: 16, sy: 0, sw: 50, sh: 15 });
  });

  it("clamps to the bitmap", () => {
    expect(cropRect({ x: -10, y: 900, width: 100, height: 200 }, 1, 1000, 1000)).toEqual({ sx: 0, sy: 900, sw: 90, sh: 100 });
  });

  it("returns null when nothing is left", () => {
    expect(cropRect({ x: 2000, y: 0, width: 10, height: 10 }, 1, 1000, 1000)).toBeNull();
  });
});

describe("maxStitchHeightCss", () => {
  it("respects the canvas dimension limit", () => {
    expect(maxStitchHeightCss(100, 2)).toBe(Math.floor(MAX_CANVAS_DIMENSION / 2));
  });
  it("respects the pixel budget for wide viewports", () => {
    const h = maxStitchHeightCss(1440, 2);
    expect(h * 2 * 1440 * 2).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    expect(h).toBeLessThan(MAX_CANVAS_DIMENSION / 2);
  });
});
