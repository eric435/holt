/**
 * Area screenshot.
 *
 * This is split in two halves on purpose, because the user can take as long
 * as they like to drag a rectangle and the service worker may be terminated
 * and restarted in the meantime (see shared/state.ts):
 *
 *   startAreaSelection()  remember what we're doing in storage.session, then
 *                         inject the overlay content script. Returns at once.
 *   captureArea()         runs when the overlay's "area-selected" message
 *                         arrives, possibly in a fresh worker instance:
 *                         capture the viewport and crop it.
 *
 * The overlay removes itself and waits for the page to repaint before it
 * sends the message, so it is not in the screenshot.
 */

import type { PageContext } from "@nitpick/protocol";
import type { AreaSelectedMessage } from "../../shared/messages.js";
import { setState } from "../../shared/state.js";
import { AREA_SELECT_FILE, injectFile } from "./inject.js";
import { captureScale, cropRect } from "./stitch.js";
import { assertCanCapture, captureViewportPng, decode } from "./viewport.js";

export async function startAreaSelection(tabId: number, windowId: number, page: PageContext): Promise<void> {
  // On localhost pages our host_permissions let us inject the overlay even
  // without an activeTab grant, but the capture would then fail after the
  // drag. Check first.
  await assertCanCapture(windowId);
  await setState("pendingArea", { tabId, windowId, page, startedAt: Date.now() });
  await injectFile(tabId, AREA_SELECT_FILE);
}

export interface AreaResult {
  blob: Blob;
  width: number;
  height: number;
}

export async function captureArea(windowId: number, selection: AreaSelectedMessage): Promise<AreaResult> {
  const bitmap = await decode(await captureViewportPng(windowId));
  try {
    const scale = captureScale(bitmap.width, selection.viewport.width, selection.devicePixelRatio);
    const crop = cropRect(selection.rect, scale, bitmap.width, bitmap.height);
    if (!crop) throw new Error("The selected area is outside the visible page.");
    const canvas = new OffscreenCanvas(crop.sw, crop.sh);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not create a 2D canvas for cropping.");
    ctx.drawImage(bitmap, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
    return { blob: await canvas.convertToBlob({ type: "image/png" }), width: crop.sw, height: crop.sh };
  } finally {
    bitmap.close();
  }
}
