/**
 * High-level actions the worker performs, independent of what triggered them
 * (keyboard shortcut or side panel button):
 *
 *   takeScreenshot(mode, tab) = capture -> upload media -> post entry -> notify
 *
 * Area mode is asynchronous (the user has to drag), so takeScreenshot only
 * starts it; `finishAreaSelection` completes it when the content script
 * reports back.
 */

import type { Entry, PageContext, ScreenshotMode } from "@holt/protocol";
import { ApiError, getApi } from "../shared/api.js";
import { errorMessage, isTopFrameOfTab, type AreaSelectedMessage, type CaptureResponse } from "../shared/messages.js";
import { pageContextFromTab } from "../shared/page-context.js";
import { clearState, getState, type PendingArea } from "../shared/state.js";
import { captureArea, startAreaSelection } from "./capture/area.js";
import { captureFullPage } from "./capture/full-page.js";
import { captureViewportPng, decode } from "./capture/viewport.js";
import { friendlyCaptureError } from "./errors.js";
import { notifyEntryAdded, notifyToast } from "./notify.js";

/** An area selection older than this is considered abandoned. */
const AREA_SELECTION_TTL_MS = 10 * 60_000;

/**
 * Captures are serialised: two at once would fight over the scroll position
 * and the captureVisibleTab rate limit. A module-level promise chain is
 * enough because a capture keeps the worker busy (and thus alive) from start
 * to finish.
 */
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

export function takeScreenshot(mode: ScreenshotMode, tab: chrome.tabs.Tab): Promise<CaptureResponse> {
  return exclusive(async () => {
    try {
      if (tab.id === undefined) throw new Error("No active tab to capture.");
      const page = pageContextFromTab(tab);

      if (mode === "area") {
        await startAreaSelection(tab.id, tab.windowId, page);
        return { ok: true, pending: true };
      }

      let shot: { blob: Blob; width: number; height: number };
      if (mode === "full-page") {
        const result = await captureFullPage(tab.id, tab.windowId);
        shot = result;
        if (result.pinnedScanTruncated) {
          await notifyToast("info", "This page has a lot of elements; some fixed or sticky ones may repeat in the full-page screenshot.");
        }
        if (result.truncated) {
          await notifyToast(
            "info",
            `This page is ${Math.round(result.pageHeight)} px tall; captured the top ${result.capturedHeight} px.`,
          );
        }
      } else {
        const blob = await captureViewportPng(tab.windowId);
        const bitmap = await decode(blob);
        shot = { blob, width: bitmap.width, height: bitmap.height };
        bitmap.close();
      }

      const entry = await upload(shot, mode, page);
      return { ok: true, entry };
    } catch (error) {
      const message = describe(error);
      await notifyToast("error", message);
      return { ok: false, error: message };
    }
  });
}

/**
 * The pending selection, if `sender` is the top frame of the tab we injected
 * the overlay into (and it hasn't expired). Anything else is ignored without
 * touching the pending state, so a forged message can't cancel a real
 * selection.
 */
async function pendingAreaFor(sender: chrome.runtime.MessageSender): Promise<PendingArea | null> {
  const pending = await getState("pendingArea");
  if (!pending || !isTopFrameOfTab(sender, pending.tabId)) return null;
  return pending;
}

/** Called when the area-select overlay reports a rectangle. */
export function finishAreaSelection(selection: AreaSelectedMessage, sender: chrome.runtime.MessageSender): Promise<void> {
  return exclusive(async () => {
    const pending = await pendingAreaFor(sender);
    if (!pending) return;
    await clearState("pendingArea");
    try {
      if (Date.now() - pending.startedAt > AREA_SELECTION_TTL_MS) {
        throw new Error("This area selection has expired. Start it again.");
      }
      const shot = await captureArea(pending.windowId, selection);
      // Prefer the tab's current title (SPA may have changed it), else what we stored.
      const page = sender.tab?.url ? pageContextFromTab(sender.tab) : pending.page;
      await upload(shot, "area", page);
    } catch (error) {
      await notifyToast("error", describe(error));
    }
  });
}

export async function cancelAreaSelection(sender: chrome.runtime.MessageSender): Promise<void> {
  if (!(await pendingAreaFor(sender))) return;
  await clearState("pendingArea");
  await notifyToast("info", "Area selection cancelled.");
}

async function upload(
  shot: { blob: Blob; width: number; height: number },
  mode: ScreenshotMode,
  page: PageContext,
): Promise<Entry> {
  const api = await getApi();
  const capturedAt = new Date().toISOString();
  const media = await api.uploadMedia(shot.blob, "screenshot");
  const { entry, session } = await api.postEntry({
    kind: "screenshot",
    capturedAt,
    page,
    file: media.file,
    mode,
    width: shot.width,
    height: shot.height,
  });
  await notifyEntryAdded(entry, session);
  return entry;
}

function describe(error: unknown): string {
  return error instanceof ApiError ? error.message : friendlyCaptureError(errorMessage(error));
}
