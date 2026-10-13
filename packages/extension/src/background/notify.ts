/**
 * Tell the user how an action went.
 *
 * Preferred channel: a broadcast to the side panel, which shows a toast and
 * updates its entry list. If the panel is closed, the broadcast fails with
 * "Receiving end does not exist", and we fall back to a short badge on the
 * toolbar icon ("✓" or "!") plus the error in the icon's tooltip. This avoids
 * the `notifications` permission.
 */

import type { Entry, SessionInfo } from "@nitpick/protocol";
import { isNoReceiverError, sendMessage, type ToastLevel } from "../shared/messages.js";
import { addRecentEntry } from "../shared/state.js";

const DEFAULT_TITLE = chrome.runtime.getManifest().action?.default_title ?? "nitpick";
const BADGE_MS = 2_500;

export async function notifyEntryAdded(entry: Entry, session: SessionInfo): Promise<void> {
  await addRecentEntry({ sessionId: session.id, entry });
  const delivered = await broadcast(() => sendMessage({ type: "entry-added", entry, session }));
  if (!delivered) await flashBadge("✓", "#2f9e44");
}

export async function notifyToast(level: ToastLevel, message: string): Promise<void> {
  const delivered = await broadcast(() => sendMessage({ type: "toast", level, message }));
  if (!delivered && level === "error") await flashBadge("!", "#e03131", `nitpick: ${message}`);
}

/** Returns false if no extension page was listening (panel closed). */
async function broadcast(send: () => Promise<unknown>): Promise<boolean> {
  try {
    await send();
    return true;
  } catch (error) {
    if (isNoReceiverError(error)) return false;
    throw error;
  }
}

/**
 * The badge is cleared with a plain setTimeout. That is safe here: we were
 * just doing work, and an MV3 worker lives ~30 s after its last event, far
 * longer than BADGE_MS. (For longer delays you'd need chrome.alarms.)
 */
async function flashBadge(text: string, color: string, title?: string): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  if (title) await chrome.action.setTitle({ title });
  setTimeout(() => {
    void chrome.action.setBadgeText({ text: "" });
    if (title) void chrome.action.setTitle({ title: DEFAULT_TITLE });
  }, title ? BADGE_MS * 3 : BADGE_MS);
}
