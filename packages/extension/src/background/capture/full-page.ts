/**
 * Full-page screenshot: scroll, capture each viewport, stitch.
 *
 *   1. Inject the page-helper content script; ask it for document metrics.
 *   2. Plan viewport-high tiles (stitch.ts), capped in height and count.
 *   3. For each tile: ask the helper to scroll (it answers after the page has
 *      painted), captureVisibleTab, draw the relevant band onto an
 *      OffscreenCanvas (available in service workers; a regular <canvas> is
 *      not, there is no DOM).
 *   4. Restore the user's scroll position, even on failure.
 *
 * Fixed and sticky elements: the first tile is captured as is; for every
 * later tile the helper hides them (visibility: hidden), so a fixed header
 * appears once, at the top. See content/pinned.ts.
 *
 * Resizes: the helper waits for the viewport width to settle before we
 * start (the side panel animates the page narrower when it opens), and we
 * abort if a later capture comes back with a different width rather than
 * stitching mismatched tiles.
 *
 * Known limitations (documented in the README):
 *  - Sticky elements that are not stuck yet are missing from later tiles.
 *  - Pages that scroll an inner element instead of the window (app shells
 *    with `overflow: auto` on a wrapper) are captured as one viewport.
 *  - Very tall pages are truncated at MAX_FULL_PAGE_HEIGHT (or less if the
 *    canvas would get too big); the caller tells the user.
 */

import type { PageMetrics } from "../../shared/messages.js";
import { sendToTab } from "../../shared/messages.js";
import { PAGE_HELPER_FILE, injectFile } from "./inject.js";
import { captureScale, maxStitchHeightCss, planTiles, tileSourceY, tileToDevice } from "./stitch.js";
import { captureViewportPng, decode } from "./viewport.js";

/** CSS px. Beyond this we stop and say so. */
export const MAX_FULL_PAGE_HEIGHT = 20_000;
/** At ~2 captures/second this bounds a full-page capture to ~20 s. */
export const MAX_FULL_PAGE_TILES = 40;

export interface FullPageResult {
  blob: Blob;
  width: number;
  height: number;
  truncated: boolean;
  /** Document height in CSS px, for the "page was truncated" message. */
  pageHeight: number;
  capturedHeight: number;
  /** Fixed/sticky elements hidden for tiles after the first. */
  pinnedHidden: number;
  /** The pinned-element scan stopped at its limit (huge page): some may repeat. */
  pinnedScanTruncated: boolean;
}

export const RESIZED_DURING_CAPTURE = "The page was resized during capture; try again.";

export async function captureFullPage(tabId: number, windowId: number): Promise<FullPageResult> {
  await injectFile(tabId, PAGE_HELPER_FILE);
  const metrics: PageMetrics = await sendToTab(tabId, { type: "helper:metrics" });

  const plan = planTiles({
    pageHeight: metrics.scrollHeight,
    viewportHeight: metrics.innerHeight,
    maxHeight: Math.min(MAX_FULL_PAGE_HEIGHT, maxStitchHeightCss(metrics.innerWidth, metrics.devicePixelRatio)),
    maxTiles: MAX_FULL_PAGE_TILES,
  });

  let canvas: OffscreenCanvas | undefined;
  let ctx: OffscreenCanvasRenderingContext2D | null = null;
  let scale = metrics.devicePixelRatio;
  let pinnedHidden = 0;
  let pinnedScanTruncated = false;

  try {
    for (const [index, tile] of plan.tiles.entries()) {
      const scrolled = await sendToTab(tabId, { type: "helper:scroll-to", y: tile.scrollY, hideFixed: index > 0 });
      pinnedHidden = Math.max(pinnedHidden, scrolled.hiddenCount);
      pinnedScanTruncated ||= scrolled.scanTruncated;
      const bitmap = await decode(await captureViewportPng(windowId));
      try {
        if (!canvas) {
          // Size the output from the first real capture rather than from DPR.
          scale = captureScale(bitmap.width, metrics.innerWidth, metrics.devicePixelRatio);
          canvas = new OffscreenCanvas(bitmap.width, Math.round(plan.outputHeight * scale));
          ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Could not create a 2D canvas for stitching.");
        } else if (bitmap.width !== canvas.width) {
          // The window or side panel changed size mid-capture.
          throw new Error(RESIZED_DURING_CAPTURE);
        }
        const srcY = tileSourceY(tile, scrolled.scrollY, metrics.innerHeight);
        const band = tileToDevice(tile, srcY, scale, bitmap.height);
        ctx!.drawImage(bitmap, 0, band.sy, bitmap.width, band.sh, 0, band.dy, bitmap.width, band.dh);
      } finally {
        bitmap.close();
      }
    }
  } finally {
    // Un-hide fixed elements and put the page back where the user had it,
    // even if a capture failed.
    await sendToTab(tabId, { type: "helper:restore" }).catch(() => undefined);
  }

  if (!canvas) throw new Error("Nothing was captured.");
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return {
    blob,
    width: canvas.width,
    height: canvas.height,
    truncated: plan.truncated,
    pageHeight: metrics.scrollHeight,
    capturedHeight: plan.outputHeight,
    pinnedHidden,
    pinnedScanTruncated,
  };
}
