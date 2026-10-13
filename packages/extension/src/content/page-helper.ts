/**
 * Page helper for full-page screenshots (dist/content/page-helper.js).
 *
 * Injected on demand by the worker with chrome.scripting.executeScript. It
 * runs in an "isolated world": it sees the page's DOM but not the page's
 * JavaScript variables, and the page cannot see it. It answers three
 * messages from the worker (chrome.tabs.sendMessage):
 *
 *   helper:metrics    wait until the viewport width is stable (the side panel
 *                     may still be animating open), then report document
 *                     size, viewport size, DPR, scroll position (and remember
 *                     the scroll position for restore)
 *   helper:scroll-to  optionally hide fixed/sticky elements (see pinned.ts),
 *                     scroll, then answer once the new position is painted
 *   helper:restore    un-hide everything and scroll back to where the user was
 *
 * Safety net: if the worker disappears mid-capture (it can be terminated),
 * nobody would send helper:restore and the page would keep its header
 * hidden. A watchdog restores on its own if no message arrives for a while.
 *
 * Idempotent: the worker injects it before every full-page capture. All
 * injections from this extension share one isolated world per page, so a
 * global flag tells a second copy to do nothing.
 *
 * Built as an IIFE (not an ES module): executeScript({ files }) runs classic
 * scripts only.
 */

import { onMessage, type HelperScrollResponse, type PageMetrics } from "../shared/messages.js";
import { findPinned, hideInline } from "./pinned.js";

declare global {
  interface Window {
    __nitpickPageHelper?: true;
  }
}

/** Extra wait after scrolling for sticky headers, lazy images, scroll handlers. */
const SETTLE_MS = 120;
/** Viewport-width stability check: sample this far apart, give up after the max. */
const WIDTH_SAMPLE_MS = 100;
const WIDTH_WAIT_MAX_MS = 1_000;
/** Restore the page by ourselves if the worker goes quiet for this long. */
const WATCHDOG_MS = 15_000;

if (!window.__nitpickPageHelper) {
  window.__nitpickPageHelper = true;
  install();
}

function install(): void {
  let savedScroll: { x: number; y: number } | null = null;
  let hidden: { restore: Array<() => void>; scanTruncated: boolean } | null = null;
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  const unhide = (): void => {
    if (!hidden) return;
    for (const restore of hidden.restore) restore();
    hidden = null;
  };

  const restoreAll = (): void => {
    clearTimeout(watchdog);
    unhide();
    if (savedScroll) window.scrollTo({ left: savedScroll.x, top: savedScroll.y, behavior: "instant" });
    savedScroll = null;
  };

  const armWatchdog = (): void => {
    clearTimeout(watchdog);
    watchdog = setTimeout(restoreAll, WATCHDOG_MS);
  };

  const hidePinned = (): void => {
    if (hidden) return;
    const root = document.body ?? document.documentElement;
    const scan = findPinned(descendants(root), (el) => getComputedStyle(el).position);
    hidden = { restore: scan.elements.map((el) => hideInline(el.style)), scanTruncated: scan.truncated };
  };

  onMessage((message) => {
    switch (message.type) {
      case "helper:metrics":
        return (async (): Promise<PageMetrics> => {
          const widthStable = await waitForStableWidth();
          savedScroll = { x: window.scrollX, y: window.scrollY };
          armWatchdog();
          return metrics(widthStable);
        })();
      case "helper:scroll-to":
        return (async (): Promise<HelperScrollResponse> => {
          armWatchdog();
          try {
            if (message.hideFixed) hidePinned();
            else unhide();
            const scrollY = await scrollToAndSettle(Number(message.y) || 0, savedScroll?.x ?? window.scrollX);
            return { scrollY, hiddenCount: hidden?.restore.length ?? 0, scanTruncated: hidden?.scanTruncated ?? false };
          } catch (error) {
            restoreAll(); // never leave the page altered
            throw error;
          }
        })();
      case "helper:restore":
        restoreAll();
        return { ok: true };
      default:
        return undefined;
    }
  });
}

/** Every element under `root`, lazily, in document order. */
function* descendants(root: Element): Generator<HTMLElement> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof HTMLElement) yield node;
  }
}

/**
 * Wait until innerWidth is unchanged across two consecutive samples taken
 * one frame + ~100 ms apart (three equal readings), at most ~1 s. Opening the
 * side panel animates the page narrower; capturing during that animation
 * would produce tiles of different widths.
 */
async function waitForStableWidth(): Promise<boolean> {
  const deadline = performance.now() + WIDTH_WAIT_MAX_MS;
  let last = window.innerWidth;
  let unchanged = 0;
  while (performance.now() < deadline) {
    await nextFrame();
    await sleep(WIDTH_SAMPLE_MS);
    const width = window.innerWidth;
    unchanged = width === last ? unchanged + 1 : 0;
    last = width;
    if (unchanged >= 2) return true;
  }
  return false;
}

function metrics(widthStable: boolean): PageMetrics {
  const doc = document.documentElement;
  return {
    widthStable,
    scrollHeight: Math.max(doc.scrollHeight, document.body?.scrollHeight ?? 0),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}

async function scrollToAndSettle(y: number, x: number): Promise<number> {
  // behavior: "instant" overrides any `scroll-behavior: smooth` in the page's CSS.
  window.scrollTo({ left: x, top: y, behavior: "instant" });
  await nextFrame();
  await nextFrame(); // the second frame callback runs after the first has painted
  await sleep(SETTLE_MS);
  return window.scrollY;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
