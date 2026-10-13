/**
 * Capture the visible part of the active tab as a PNG Blob.
 *
 * `chrome.tabs.captureVisibleTab` needs either the `<all_urls>` host
 * permission (which we deliberately don't request) or an `activeTab` grant
 * for the tab. activeTab is granted when the user invokes the extension on
 * that tab: pressing one of our keyboard shortcuts or clicking the toolbar
 * icon. The grant lasts until the tab navigates to another page.
 *
 * Chrome also rate-limits the call (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND,
 * currently 2). Exceeding it makes the call fail, which matters for full-page
 * capture where we take many shots in a row, so every capture goes through
 * a shared limiter.
 *
 * The limiter state is a module-level variable on purpose: it only needs to
 * survive for the duration of one burst of captures, during which the worker
 * is busy and cannot be terminated. If the worker restarts, the previous
 * burst is long over, so starting from "no recent calls" is correct.
 */

import { createRateLimiter } from "./throttle.js";

/** Not in @types/chrome 0.0.287, but present at runtime. */
const callsPerSecond =
  (chrome.tabs as { MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND?: number }).MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND ?? 2;

/** Small safety margin on top of the documented interval. */
const waitForCaptureSlot = createRateLimiter(Math.ceil(1000 / callsPerSecond) + 50);

/** PNG of the active tab in `windowId`, at device resolution. */
export async function captureViewportPng(windowId: number): Promise<Blob> {
  await waitForCaptureSlot();
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  // fetch() understands data: URLs and is the shortest way to get a Blob
  // in a service worker (no atob/Uint8Array loop needed).
  return (await fetch(dataUrl)).blob();
}

/** Decode a PNG Blob into something we can draw on an OffscreenCanvas. */
export function decode(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob);
}

/**
 * Throws (with Chrome's activeTab error) if we are not allowed to capture the
 * active tab of `windowId`. There is no API to ask "do I have activeTab?", so
 * we take a tiny throwaway JPEG. Used before showing the area overlay, so the
 * user isn't asked to drag a rectangle only to get an error afterwards.
 */
export async function assertCanCapture(windowId: number): Promise<void> {
  await waitForCaptureSlot();
  await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 1 });
}
