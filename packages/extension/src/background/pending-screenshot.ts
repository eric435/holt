/**
 * One screenshot, one entry: the picture, the page, and the user's words.
 *
 * A screenshot is uploaded as soon as it is captured, but its entry is only
 * written once the user has said something about it (or chosen not to), so
 * notes.md gets one block with the image and the note under it rather than
 * a screenshot and, later, a separate note about it.
 *
 * Lifecycle of `pendingScreenshot` (chrome.storage.session, written only
 * here; at most one at a time):
 *
 *   capture -> POST /media (to the server for that tab) -> begin():
 *       a screenshot still pending?  post it with its draft, close its prompt
 *       store pendingScreenshot { id, file, serverUrl, page, ... }
 *       (every later post goes to that serverUrl: the file is there)
 *       open note.html?mode=screenshot&id=<id> in a popup window, and store
 *       its window id (if the window can't be opened: post without a note)
 *   prompt: as the user types -> "screenshot-note:draft" { id, draft }
 *       -> kept as pendingScreenshot.draft
 *   prompt: Save (Enter, or Esc with text) / Skip (Esc with nothing typed)
 *       -> "screenshot-note:finish" { id, note } -> finish(): post the entry
 *          with the note (if any), notifyEntryAdded, answer; the prompt closes
 *   prompt window closed by the user (chrome.windows.onRemoved)
 *       -> post with the draft
 *   a worker starts (reconcilePendingScreenshot, from index.ts)
 *       -> older than PENDING_SCREENSHOT_TTL_MS and its window is gone:
 *          post with the draft
 *
 * Why a popup window and not the action popup (note-popup.ts tries that
 * first for Alt+T): the capture is asynchronous (full page scrolls, area
 * waits for a drag), so the shortcut's gesture is long gone by the time the
 * prompt is needed and `action.openPopup()` would mostly fail. A popup
 * window also survives focus changes, so the user can look back at the page
 * (or dictate) while writing.
 *
 * A second screenshot while one is pending flushes the first (posted with
 * whatever was typed so far) rather than focusing its prompt: the user asked
 * for a new capture, which must not be dropped or queued behind a prompt
 * they have evidently moved on from, and flushing keeps "at most one
 * pending" simple. Its prompt window is closed; its onRemoved then finds
 * nothing to do.
 *
 * Never posted twice: every path goes through `take(id)`, which reads and
 * clears the state in one step of a serial chain and returns it only to the
 * first caller with a matching id. Only one worker instance exists at a
 * time, so the chain covers all callers.
 *
 * When a post fails:
 *  - the server refused it for good (a 4xx, see isPermanentEntryError): the
 *    upload is no longer an unused file of the current session, typically
 *    because the session changed under the open prompt (Start/End session,
 *    or the server or dev server restarted). Retrying can't help, so the
 *    screenshot is dropped from the notes (the PNG stays where it was) and
 *    the user's words, if any, are posted as a separate note to the same
 *    server, so they are not lost;
 *  - anything else (unreachable, a 5xx, a wrong token): after the prompt's
 *    Save the state is put back, the prompt shows the error and the user can
 *    try again; Skip always closes (the failure is reported like the
 *    automatic paths'); on an automatic path it is reported as an error.
 *
 * Quitting the browser with the prompt open: storage.session is cleared
 * with it, so the pending screenshot (with its draft) is also kept in
 * chrome.storage.local (state.ts, PENDING_SCREENSHOT_BACKUP_KEY) until its
 * entry is settled. A worker that finds a backup without the session state
 * (after a browser restart or an extension reload) posts it with its draft;
 * while the server isn't answering yet it keeps the backup and tries again
 * at the next worker start, for up to PENDING_SCREENSHOT_BACKUP_MAX_AGE_MS.
 */

import type { Entry, SessionInfo } from "@holt/protocol";
import { ApiError, getApi } from "../shared/api.js";
import { apiForServer } from "../shared/server.js";
import { errorMessage, type ScreenshotNoteFinishResponse } from "../shared/messages.js";
import { notePageUrl } from "../shared/note-prompt.js";
import {
  clearPendingScreenshotBackup,
  clearState,
  getPendingScreenshotBackup,
  getState,
  setPendingScreenshotBackup,
  setState,
  type PendingScreenshot,
} from "../shared/state.js";
import { openPopupWindow } from "./note-popup.js";
import { notifyEntryAdded, notifyToast } from "./notify.js";
import {
  PENDING_SCREENSHOT_BACKUP_MAX_AGE_MS,
  isAbandoned,
  isPermanentEntryError,
  orphanedScreenshotNote,
  screenshotEntry,
} from "./pending-screenshot-model.js";

/** A bit larger than the quick note's window: there is a mic button and a Skip button. */
const PROMPT_WINDOW_SIZE = { width: 440, height: 260 };

/** All state transitions run one after another (see the header). */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
}

/** Store the pending screenshot, in storage.session and its storage.local backup. */
async function put(pending: PendingScreenshot): Promise<void> {
  await setState("pendingScreenshot", pending);
  await backup(() => setPendingScreenshotBackup(pending));
}

/**
 * Read and clear the pending screenshot, if it is `id` (any, without an
 * id). The backup stays until the entry is settled (`settle`), so a browser
 * quit mid-post still has it.
 */
async function take(id?: string): Promise<PendingScreenshot | null> {
  const pending = await getState("pendingScreenshot");
  if (!pending || (id !== undefined && pending.id !== id)) return null;
  await clearState("pendingScreenshot");
  return pending;
}

/** Screenshot `id` is written (or given up): drop its backup. */
async function settle(id: string): Promise<void> {
  await backup(async () => {
    if ((await getPendingScreenshotBackup())?.id === id) await clearPendingScreenshotBackup();
  });
}

/** The backup is a safety net: if storage.local fails, everything else still works. */
async function backup(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.warn("[holt] could not update the pending screenshot's backup", error);
  }
}

/**
 * The screenshot is uploaded; ask the user for a note before writing its
 * entry. Resolves once the prompt is open (or the entry is written, if it
 * could not be opened).
 */
export function beginScreenshotNote(shot: Omit<PendingScreenshot, "id" | "at" | "popupWindowId">): Promise<void> {
  return serial(async () => {
    // Only one at a time: the previous one goes in as it is, with what was typed for it.
    const previous = await take();
    if (previous) {
      await postQuietly(previous);
      if (previous.popupWindowId !== undefined) await chrome.windows.remove(previous.popupWindowId).catch(() => undefined);
    }

    const pending: PendingScreenshot = { ...shot, id: crypto.randomUUID(), at: Date.now() };
    await put(pending);
    try {
      const win = await openPopupWindow(notePageUrl({ mode: "screenshot", id: pending.id }), shot.windowId, PROMPT_WINDOW_SIZE);
      if (win.id !== undefined) await put({ ...pending, popupWindowId: win.id });
    } catch (error) {
      console.warn("[holt] could not open the screenshot note prompt; saving without a note", error);
      const own = await take(pending.id);
      if (own) await postQuietly(own);
    }
  });
}

/** The prompt's text so far, for screenshot `id` (ignored once it is no longer pending). */
export function saveScreenshotDraft(id: string, draft: string): Promise<void> {
  return serial(async () => {
    const pending = await getState("pendingScreenshot");
    if (pending?.id !== id || (pending.draft ?? "") === draft) return;
    await put({ ...pending, draft });
  });
}

/** The prompt's Save (with `note`) or Skip (`note` empty) for screenshot `id`. */
export function finishScreenshotNote(id: string, note: string): Promise<ScreenshotNoteFinishResponse> {
  return serial(async () => {
    const pending = await take(id);
    // Already written without a note (window closed, superseded, timed out).
    if (!pending) return { ok: true };
    if (!note.trim()) {
      // Skip always closes the prompt: a failure is reported like the automatic paths'.
      const outcome = await postQuietly({ ...pending, draft: "" });
      return { ok: true, ...outcome };
    }
    try {
      const outcome = await write(pending, note);
      await settle(pending.id);
      return { ok: true, ...outcome };
    } catch (error) {
      // Put it back so the prompt can try again (nothing else can have
      // taken the slot meanwhile: this runs inside the serial chain). With
      // `sessionGone` if that was found out, so a retry posts the note alone.
      await put(pending);
      return { ok: false, error: describe(error) };
    }
  });
}

/** chrome.windows.onRemoved: the user closed the prompt without answering. */
export function onPromptWindowClosed(windowId: number): Promise<void> {
  return serial(async () => {
    const pending = await getState("pendingScreenshot");
    if (pending?.popupWindowId !== windowId) return;
    const own = await take(pending.id);
    if (own) await postQuietly(own);
  });
}

/**
 * On every worker start: recover a backup whose session state is gone
 * (browser restart, extension reload), and post a screenshot whose prompt
 * is gone and that nobody answered.
 */
export function reconcilePendingScreenshot(): Promise<void> {
  return serial(async () => {
    const pending = await getState("pendingScreenshot");
    const saved = await getPendingScreenshotBackup().catch(() => undefined);
    if (saved && saved.id !== pending?.id) {
      await recover(saved);
      // The session's own pending screenshot (a different one, unusual) keeps its backup.
      if (pending) await backup(() => setPendingScreenshotBackup(pending));
    }
    if (!pending) return;
    if (!isAbandoned(pending, Date.now(), await windowOpen(pending.popupWindowId))) return;
    const own = await take(pending.id);
    if (own) await postQuietly(own);
  });
}

async function windowOpen(windowId: number | undefined): Promise<boolean> {
  if (windowId === undefined) return false;
  try {
    await chrome.windows.get(windowId);
    return true;
  } catch {
    return false;
  }
}

type Outcome = { entry?: Entry; sessionGone?: true };

/**
 * Write `pending`'s entry with `note`: the screenshot entry, or, once the
 * server has refused that for good (see the header), the note on its own.
 * Throws whatever else goes wrong; `pending.sessionGone` then says how far
 * it got.
 */
async function write(pending: PendingScreenshot, note: string): Promise<Outcome> {
  // The server the PNG went to (an older build's pending screenshot has none: the settings' URL, as it used then).
  const api = pending.serverUrl ? await apiForServer(pending.serverUrl) : await getApi();
  if (!pending.sessionGone) {
    try {
      const { entry, session } = await api.postEntry(screenshotEntry(pending, note));
      await announce(entry, session);
      return { entry };
    } catch (error) {
      if (!isPermanentEntryError(error)) throw error;
      console.warn(`[holt] the server refused screenshot ${pending.file}'s entry for good (its session has ended?):`, describe(error));
      pending.sessionGone = true;
    }
  }
  if (!note.trim()) return { sessionGone: true };
  const { entry, session } = await api.postEntry(orphanedScreenshotNote(pending, note));
  await announce(entry, session);
  return { entry, sessionGone: true };
}

/**
 * Tell the panel / badge. The entry is already saved, so a failure here must
 * not look like a failed save (a retry would then be refused as a duplicate).
 */
async function announce(entry: Entry, session: SessionInfo): Promise<void> {
  try {
    await notifyEntryAdded(entry, session);
  } catch (error) {
    console.warn("[holt] saved, but could not list or announce the entry", error);
  }
}

/**
 * Post with the draft (if any); nobody is waiting for the answer, so a
 * failure becomes a toast/badge. Settles the backup either way.
 */
async function postQuietly(pending: PendingScreenshot): Promise<Outcome> {
  const note = pending.draft ?? "";
  try {
    const outcome = await write(pending, note);
    if (outcome.sessionGone && !outcome.entry) {
      console.warn(`[holt] screenshot ${pending.file} belongs to a session that has ended; it is not in the notes`);
      await notifyToast("error", `Screenshot ${pending.file} could not be added to the notes: its session has ended (the PNG is in that session's folder).`);
    }
    return outcome;
  } catch (error) {
    // The words are lost with the entry: show them, so they can be copied (the badge's tooltip has room for a few).
    const words = note.trim();
    const lost = words ? ` Your note was: “${words.length > 300 ? `${words.slice(0, 299)}…` : words}”` : "";
    await notifyToast("error", `Screenshot ${pending.file} is in the session folder but could not be added to the notes: ${describe(error)}${lost}`);
    return {};
  } finally {
    await settle(pending.id);
  }
}

/**
 * A pending screenshot found only in the storage.local backup: its session
 * state went away (the browser was quit with the prompt open, or the
 * extension reloaded). Post it with its draft. A refused one is dropped and
 * logged; if the server isn't answering (it may not be up yet after a
 * restart) the backup stays for the next worker start, up to a day.
 */
async function recover(saved: PendingScreenshot): Promise<void> {
  if (Date.now() - saved.at > PENDING_SCREENSHOT_BACKUP_MAX_AGE_MS) {
    console.warn(`[holt] dropping screenshot ${saved.file}'s pending entry: too old to recover`);
    await settle(saved.id);
    return;
  }
  try {
    const outcome = await write(saved, saved.draft ?? "");
    if (outcome.sessionGone && !outcome.entry) console.warn(`[holt] screenshot ${saved.file} belongs to a session that has ended; not added to the notes`);
    await settle(saved.id);
  } catch (error) {
    console.warn(`[holt] could not write screenshot ${saved.file}'s entry yet; will try again at the next start:`, describe(error));
    await backup(() => setPendingScreenshotBackup(saved)); // with `sessionGone`, if found out
  }
}

function describe(error: unknown): string {
  return error instanceof ApiError ? error.message : errorMessage(error);
}
