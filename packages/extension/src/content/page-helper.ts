/**
 * Page helper for full-page screenshots (dist/content/page-helper.js).
 *
 * Injected on demand by the worker with chrome.scripting.executeScript. It
 * runs in an "isolated world": it sees the page's DOM but not the page's
 * JavaScript variables, and the page cannot see it. It answers three
 * messages from the worker (chrome.tabs.sendMessage):
 *
 *   helper:metrics    document size, viewport size, DPR, scroll position
 *                     (also remembers the scroll position for restore)
 *   helper:scroll-to  scroll, then answer once the new position is painted
 *   helper:restore    scroll back to where the user was
 *
 * Idempotent: the worker injects it before every full-page capture. All
 * injections from this extension share one isolated world per page, so a
 * global flag tells a second copy to do nothing.
 *
 * Built as an IIFE (not an ES module): executeScript({ files }) runs classic
 * scripts only.
 */

import { onMessage, type PageMetrics } from "../shared/messages.js";

declare global {
  interface Window {
    __nitpickPageHelper?: true;
  }
}

/** Extra wait after scrolling for sticky headers, lazy images, scroll handlers. */
const SETTLE_MS = 120;

if (!window.__nitpickPageHelper) {
  window.__nitpickPageHelper = true;
  install();
}

function install(): void {
  let saved: { x: number; y: number } | null = null;

  onMessage((message) => {
    switch (message.type) {
      case "helper:metrics":
        saved = { x: window.scrollX, y: window.scrollY };
        return metrics();
      case "helper:scroll-to":
        return scrollToAndSettle(Number(message.y) || 0, saved?.x ?? window.scrollX);
      case "helper:restore":
        if (saved) window.scrollTo({ left: saved.x, top: saved.y, behavior: "instant" });
        saved = null;
        return { ok: true };
      default:
        return undefined;
    }
  });
}

function metrics(): PageMetrics {
  const doc = document.documentElement;
  return {
    scrollHeight: Math.max(doc.scrollHeight, document.body?.scrollHeight ?? 0),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}

async function scrollToAndSettle(y: number, x: number): Promise<{ scrollY: number }> {
  // behavior: "instant" overrides any `scroll-behavior: smooth` in the page's CSS.
  window.scrollTo({ left: x, top: y, behavior: "instant" });
  await nextFrame();
  await nextFrame(); // the second frame callback runs after the first has painted
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  return { scrollY: window.scrollY };
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
