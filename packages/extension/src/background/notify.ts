/**
 * Tell the user how an action went.
 *
 * Preferred channel: a broadcast to the side panel, which shows a toast and
 * updates its entry list. If the panel is closed, the broadcast fails with
 * "Receiving end does not exist", and we fall back to a short badge on the
 * toolbar icon ("✓" or "!") plus the error in the icon's tooltip. This avoids
 * the `notifications` permission. The badge itself belongs to indicator.ts,
 * which restores "REC"/"MIC" after the flash if something is still recording.
 *
 * Everything the user should hear about goes through here: the worker's own
 * results, and everything the offscreen recorder and the note popup report
 * (they message the worker, see index.ts), so headless actions always end in
 * either a panel toast or a badge flash.
 */

import type { Entry, SessionInfo } from "@holt/protocol";
import { isNoReceiverError, sendMessage, type ToastAction, type ToastLevel } from "../shared/messages.js";
import { addRecentEntry } from "../shared/state.js";
import { flashBadge } from "./indicator.js";

export async function notifyEntryAdded(entry: Entry, session: SessionInfo): Promise<void> {
  await addRecentEntry({ sessionId: session.id, entry });
  const delivered = await broadcast(() => sendMessage({ type: "entry-added", entry, session }));
  if (!delivered) await flashBadge("✓", "#2f9e44");
}

/** Returns true if an open side panel showed it. */
export async function notifyToast(level: ToastLevel, message: string, action?: ToastAction): Promise<boolean> {
  const delivered = await broadcast(() => sendMessage(action ? { type: "toast", level, message, action } : { type: "toast", level, message }));
  if (!delivered && level === "error") await flashBadge("!", "#e03131", `holt: ${message}`);
  return delivered;
}

/**
 * Returns true only if the side panel acknowledged (`{ ok: true }`). Other
 * extension pages hear the broadcast too (the offscreen document, the note
 * popup) but don't answer it; depending on who is open, "nobody answered"
 * then shows up as a rejection ("Receiving end does not exist" / "message
 * port closed") or as an undefined response, and both mean "panel closed".
 */
async function broadcast(send: () => Promise<unknown>): Promise<boolean> {
  try {
    const response = await send();
    return (response as { ok?: unknown } | undefined)?.ok === true;
  } catch (error) {
    if (isNoReceiverError(error)) return false;
    throw error;
  }
}
