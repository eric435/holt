/**
 * Pure geometry for screenshots. No Chrome APIs here, so it is unit-tested.
 *
 * Coordinate systems:
 *  - CSS px: what the page sees (innerHeight, scrollY, getBoundingClientRect).
 *  - Device px: what captureVisibleTab returns. device = css * scale, where
 *    scale is normally window.devicePixelRatio (which already includes the
 *    browser zoom level). We measure it from the captured bitmap instead of
 *    trusting DPR, see `captureScale`.
 */

import type { CssRect } from "../../shared/messages.js";

// ---------------------------------------------------------------------------
// Full-page tile plan
// ---------------------------------------------------------------------------

export interface TilePlanInput {
  /** document scrollHeight in CSS px. */
  pageHeight: number;
  /** window.innerHeight in CSS px. */
  viewportHeight: number;
  /** Stop after this many CSS px (protects memory and canvas limits). */
  maxHeight: number;
  /** Stop after this many captures (captureVisibleTab is rate-limited). */
  maxTiles: number;
}

export interface Tile {
  /** Where we ask the page to scroll to. */
  scrollY: number;
  /** Where this tile's pixels go in the output image (CSS px). */
  destY: number;
  /** How many CSS px of this tile end up in the output. */
  height: number;
}

export interface TilePlan {
  tiles: Tile[];
  /** Height of the stitched image in CSS px. */
  outputHeight: number;
  /** True if the page is taller than what we capture. */
  truncated: boolean;
}

/**
 * Plan the scroll positions for a full-page capture.
 *
 * The page is cut into viewport-high bands. Every band except possibly the
 * last is a full viewport. The browser will not scroll past
 * `pageHeight - viewportHeight`, so for the last band we scroll to the bottom
 * and copy only its lower part (see `tileSourceY`).
 */
export function planTiles({ pageHeight, viewportHeight, maxHeight, maxTiles }: TilePlanInput): TilePlan {
  const vh = Math.floor(viewportHeight);
  if (!(vh > 0)) throw new Error(`Invalid viewport height: ${viewportHeight}`);
  const fullHeight = Math.max(vh, Math.ceil(pageHeight));
  const limit = Math.max(vh, Math.min(Math.floor(maxHeight), Math.max(1, Math.floor(maxTiles)) * vh));
  const outputHeight = Math.min(fullHeight, limit);
  const maxScroll = fullHeight - vh;

  const tiles: Tile[] = [];
  for (let destY = 0; destY < outputHeight; destY += vh) {
    tiles.push({
      scrollY: Math.min(destY, maxScroll),
      destY,
      height: Math.min(vh, outputHeight - destY),
    });
  }
  return { tiles, outputHeight, truncated: outputHeight < fullHeight };
}

/**
 * Where, inside the captured viewport, a tile's pixels start (CSS px).
 *
 * Uses the scroll position the page *actually* reached rather than the one we
 * asked for, so pages whose height changes while scrolling (lazy content)
 * still line up. Clamped so we never read outside the viewport.
 */
export function tileSourceY(tile: Tile, actualScrollY: number, viewportHeight: number): number {
  const srcY = tile.destY - actualScrollY;
  return Math.min(Math.max(0, srcY), Math.max(0, viewportHeight - tile.height));
}

export interface DeviceBand {
  /** Source y and height in the captured bitmap (device px). */
  sy: number;
  sh: number;
  /** Destination y and height in the output canvas (device px). */
  dy: number;
  dh: number;
}

/**
 * Convert one tile to device pixels.
 *
 * Destination start and end are rounded separately (instead of rounding the
 * height) so neighbouring bands share an edge exactly: no 1px gaps or
 * overlaps at fractional scales like 1.25. At such scales a viewport of
 * 777 CSS px is 971.25 device px; Chrome hands us 971 rows, but a band may
 * need 972 in the output. In that case `sh` is one less than `dh` and
 * drawImage stretches by a single row, which is invisible, rather than
 * leaving a transparent line.
 */
export function tileToDevice(tile: Tile, srcY: number, scale: number, bitmapHeight: number): DeviceBand {
  const dy = Math.round(tile.destY * scale);
  const dh = Math.round((tile.destY + tile.height) * scale) - dy;
  const sh = Math.min(dh, bitmapHeight);
  const sy = Math.max(0, Math.min(Math.round(srcY * scale), bitmapHeight - sh));
  return { sy, sh, dy, dh };
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Chrome refuses canvases taller/wider than this (device px). */
export const MAX_CANVAS_DIMENSION = 32_767;
/**
 * Our own cap on output pixels. Chrome allows ~268M, but each pixel is 4 bytes
 * of RAM in the service worker; 64M px is ~256 MB, already generous.
 */
export const MAX_CANVAS_PIXELS = 64_000_000;

/** Tallest output (CSS px) that fits the canvas limits at this width and scale. */
export function maxStitchHeightCss(viewportWidthCss: number, scale: number): number {
  const widthPx = Math.max(1, Math.round(viewportWidthCss * scale));
  const byDimension = MAX_CANVAS_DIMENSION / scale;
  const byArea = MAX_CANVAS_PIXELS / widthPx / scale;
  return Math.floor(Math.min(byDimension, byArea));
}

// ---------------------------------------------------------------------------
// Area crop
// ---------------------------------------------------------------------------

/**
 * Device px per CSS px, measured from a capture. captureVisibleTab returns the
 * viewport (including any scrollbar) at device resolution, and innerWidth
 * also includes the scrollbar, so the ratio is exact. Falls back to DPR.
 */
export function captureScale(bitmapWidth: number, viewportWidthCss: number, fallbackDpr: number): number {
  if (viewportWidthCss > 0 && bitmapWidth > 0) return bitmapWidth / viewportWidthCss;
  return fallbackDpr > 0 ? fallbackDpr : 1;
}

export interface PixelRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Turn a CSS-px selection into an integer device-px crop rectangle, clamped
 * to the bitmap. Returns null if nothing is left after clamping (e.g. the
 * selection was entirely off-screen).
 */
export function cropRect(rect: CssRect, scale: number, bitmapWidth: number, bitmapHeight: number): PixelRect | null {
  const x0 = clamp(Math.round(rect.x * scale), 0, bitmapWidth);
  const y0 = clamp(Math.round(rect.y * scale), 0, bitmapHeight);
  const x1 = clamp(Math.round((rect.x + rect.width) * scale), 0, bitmapWidth);
  const y1 = clamp(Math.round((rect.y + rect.height) * scale), 0, bitmapHeight);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
