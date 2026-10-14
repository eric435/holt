/**
 * The two modes of note.html, and how the worker addresses them in the URL.
 *
 *   note.html                              the quick note (Alt+T), as the action popup
 *   note.html?window=1                     the same, in a popup window (openPopup failed)
 *   note.html?mode=screenshot&id=<id>      the note prompt after a screenshot, always a
 *                                          popup window (see background/pending-screenshot.ts)
 *
 * In screenshot mode the page answers for the pending screenshot `id` only;
 * anything else in the URL is ignored. Pure so it is unit-tested.
 */

import { NOTE_PAGE } from "./pages.js";

export type NotePromptMode = { mode: "note"; inWindow: boolean } | { mode: "screenshot"; id: string };

/** Longest id we accept from the URL (ours are UUIDs). */
const MAX_ID_LENGTH = 100;

/** The note page's path (relative to the extension root) for `mode`. */
export function notePageUrl(prompt: NotePromptMode): string {
  if (prompt.mode === "screenshot") return `${NOTE_PAGE}?mode=screenshot&id=${encodeURIComponent(prompt.id)}`;
  return prompt.inWindow ? `${NOTE_PAGE}?window=1` : NOTE_PAGE;
}

/** What `location.search` asks the note page to be. A malformed screenshot URL falls back to a plain note. */
export function parseNotePageParams(search: string): NotePromptMode {
  const params = new URLSearchParams(search);
  const id = params.get("id") ?? "";
  if (params.get("mode") === "screenshot" && id && id.length <= MAX_ID_LENGTH) return { mode: "screenshot", id };
  return { mode: "note", inWindow: params.has("window") };
}
