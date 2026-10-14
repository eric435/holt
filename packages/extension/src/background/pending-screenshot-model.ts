/**
 * Pure parts of the screenshot note prompt's lifecycle
 * (background/pending-screenshot.ts), unit-tested.
 */

import { ENTRY_FIELD_LIMITS, type NoteEntry, type ScreenshotEntry } from "@holt/protocol";
import { ApiError } from "../shared/api.js";
import { clampText } from "../shared/page-context.js";
import type { PendingScreenshot } from "../shared/state.js";

/**
 * A pending screenshot older than this, whose prompt window is gone, is
 * posted without a note when a worker starts. Long enough for the prompt to
 * open; the window being open is what really says "the user is still
 * typing", so a slow typist is never cut off.
 */
export const PENDING_SCREENSHOT_TTL_MS = 2 * 60_000;

/**
 * How long the storage.local backup of a pending screenshot is worth
 * recovering after a browser restart (background/pending-screenshot.ts):
 * while the server is not up yet, recovery is retried at each worker start,
 * but not forever.
 */
export const PENDING_SCREENSHOT_BACKUP_MAX_AGE_MS = 24 * 60 * 60_000;

/** The single entry for a screenshot: the note only if the user wrote one. */
export function screenshotEntry(pending: PendingScreenshot, note: string): ScreenshotEntry {
  const text = noteText(note);
  return {
    kind: "screenshot",
    capturedAt: pending.capturedAt,
    page: pending.page,
    file: pending.file,
    mode: pending.mode,
    width: pending.width,
    height: pending.height,
    ...(text && { note: text }),
  };
}

/**
 * At worker start: is this pending screenshot abandoned, i.e. should it be
 * posted without a note now? Only if its prompt window is not open (an open
 * one will answer, or its closing will) and it is past the TTL.
 */
export function isAbandoned(pending: PendingScreenshot, now: number, promptOpen: boolean): boolean {
  return !promptOpen && now - pending.at > PENDING_SCREENSHOT_TTL_MS;
}

/**
 * The user's words about a screenshot whose own entry can no longer be
 * written (`isPermanentEntryError`): a plain note on the same page, saying
 * which screenshot it was about, so the words are not lost.
 */
export function orphanedScreenshotNote(pending: PendingScreenshot, note: string): NoteEntry {
  return {
    kind: "note",
    capturedAt: pending.capturedAt,
    page: pending.page,
    note: noteText(`About screenshot ${pending.file} from an earlier session: ${note.trim()}`),
  };
}

/**
 * Did the server refuse a screenshot's entry for good? A 4xx means the
 * request itself can never succeed, typically "not an unused upload in the
 * current session": the session changed under the open prompt (a new one
 * was started, or the server or dev server restarted), so the PNG belongs
 * to a session that is over. Retrying would fail the same way forever.
 *
 * Not permanent: no answer at all, a 5xx, and the 4xx a retry can fix:
 * 403 (a wrong token, fixable in Settings), 408, 409 (the server's
 * "raced with a session change, retry") and 429 (an upload limit that
 * frees up as entries are written).
 */
export function isPermanentEntryError(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status === undefined) return false;
  if (error.status < 400 || error.status >= 500) return false;
  return ![403, 408, 409, 429].includes(error.status);
}

/** Note text as the server takes it: trimmed, within its length limit. */
function noteText(note: string): string {
  return clampText(note.trim(), ENTRY_FIELD_LIMITS.note);
}
