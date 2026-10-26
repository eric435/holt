/**
 * Every `POST /entries` body the extension sends is built here (pure,
 * unit-tested), one function per thing the user captures:
 *
 *   screenshotEntry         the screenshot, with the note from its prompt
 *                           (background/pending-screenshot.ts)
 *   orphanedScreenshotNote  that note on its own, when the screenshot's
 *                           session ended under the prompt (same file)
 *   recordingEntry          a tab recording and its narration (offscreen/index.ts)
 *   voiceNoteEntry          a voice note: reviewed transcript, audio, or both (same file)
 *   quickNoteEntry          a typed quick note (note/note.ts)
 *
 * Why one module: the callers are chrome.* glue (the worker, the offscreen
 * document, the note page) that can't run in Node, and the bodies are the
 * one thing the server's parser (packages/server/src/http/entry-input.ts)
 * must accept as is. Keeping them here, with nothing that touches chrome.*,
 * lets the protocol contract test
 * (packages/server/src/http/extension-contract.test.ts) send exactly these
 * bodies, through the extension's own API client, to the real server.
 *
 * The user's words (`note`) are trimmed and cut to the server's limit
 * (ENTRY_FIELD_LIMITS: it refuses longer ones with a 400), and left out
 * when empty, on every kind.
 */

import { ENTRY_FIELD_LIMITS, type NoteEntry, type PageContext, type RecordingEntry, type ScreenshotEntry, type ScreenshotMode, type VoiceNoteEntry } from "@holt/protocol";
import { clampText } from "./page-context.js";

/** What every capture knows about itself. */
export interface CaptureBase {
  /** ISO 8601. */
  capturedAt: string;
  page: PageContext;
}

/** A screenshot that has been uploaded (a PendingScreenshot in shared/state.ts has all of these). */
export interface UploadedScreenshot extends CaptureBase {
  /** The name the media upload returned. */
  file: string;
  mode: ScreenshotMode;
  width: number;
  height: number;
}

/** Note text as the server takes it: trimmed, within its length limit. */
export function noteText(text: string): string {
  return clampText(text.trim(), ENTRY_FIELD_LIMITS.note);
}

/** The single entry for a screenshot: the note only if the user wrote one. */
export function screenshotEntry(shot: UploadedScreenshot, note: string): ScreenshotEntry {
  const text = noteText(note);
  return {
    kind: "screenshot",
    capturedAt: shot.capturedAt,
    page: shot.page,
    file: shot.file,
    mode: shot.mode,
    width: shot.width,
    height: shot.height,
    ...(text && { note: text }),
  };
}

/**
 * The user's words about a screenshot whose own entry can no longer be
 * written (background/pending-screenshot-model.ts `isPermanentEntryError`):
 * a plain note on the same page, saying which screenshot it was about, so
 * the words are not lost.
 */
export function orphanedScreenshotNote(shot: CaptureBase & { file: string }, note: string): NoteEntry {
  return {
    kind: "note",
    capturedAt: shot.capturedAt,
    page: shot.page,
    note: noteText(`About screenshot ${shot.file} from an earlier session: ${note.trim()}`),
  };
}

/** A tab recording; `narration` is what the user said while recording, as they reviewed it. */
export function recordingEntry(base: CaptureBase & { durationMs: number }, file: string, narration: string): RecordingEntry {
  const text = noteText(narration);
  return {
    kind: "recording",
    capturedAt: base.capturedAt,
    page: base.page,
    file,
    durationMs: base.durationMs,
    ...(text && { note: text }),
  };
}

/**
 * A voice note: `file` is the audio if it was kept (undefined: not
 * uploaded), `note` the reviewed transcript. Which to keep is the caller's
 * decision (shared/settings.ts `keepsVoiceAudio`, which never drops the
 * audio when there are no words, so at least one is present, as the server
 * requires).
 */
export function voiceNoteEntry(base: CaptureBase & { durationMs: number }, file: string | undefined, note: string): VoiceNoteEntry {
  const text = noteText(note);
  return {
    kind: "voice-note",
    capturedAt: base.capturedAt,
    page: base.page,
    ...(file && { file }),
    durationMs: base.durationMs,
    ...(text && { note: text }),
  };
}

/** A typed quick note; `note` must not be blank (the server refuses an empty note). */
export function quickNoteEntry(page: PageContext, note: string, capturedAt: string): NoteEntry {
  return { kind: "note", capturedAt, page, note: noteText(note) };
}
