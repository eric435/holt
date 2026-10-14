/**
 * Entries are the things a QA session is made of. The extension creates them;
 * the server appends them to the session's markdown file.
 *
 * One capture is one entry: the page it was taken on, the media file (if
 * any), and the user's own words in `note`. `note` is the single field for
 * what the user said or typed about the capture on every kind, whether they
 * typed it or dictated it and reviewed the transcript, so the markdown and
 * the extension's list render it the same way everywhere.
 *
 * Media-bearing entries (screenshot, recording, voice note) reference a file
 * that was uploaded *first* via `POST /media` (see http.ts). The server
 * verifies the referenced file belongs to the current session, and was
 * uploaded for the same kind of entry, so the extension can never make the
 * markdown point outside the session folder.
 *
 * Length limits (ENTRY_FIELD_LIMITS in constants.ts; over the limit is a
 * 400 naming the field): `page.title` 1,000 characters, `page.url` 8,192,
 * `note` 100,000, `file` 255.
 *
 * Retired fields: `transcript` (voice notes) and `text` (notes) were
 * replaced by `note`. The server rejects a body that still carries either
 * with a 400 saying the extension is out of date, rather than dropping the
 * unknown key and, with it, the user's words.
 */

/** Where the entry was captured. Always recorded so notes have context. */
export interface PageContext {
  /** At most 8,192 characters. Empty on pages without one. */
  url: string;
  /** At most 1,000 characters. Empty on pages without one. */
  title: string;
}

export type EntryKind = "screenshot" | "recording" | "voice-note" | "note";

interface EntryBase<K extends EntryKind> {
  kind: K;
  /** ISO 8601 timestamp set by the extension at capture time. */
  capturedAt: string;
  page: PageContext;
  /**
   * The user's words about this capture: typed, or dictated and reviewed.
   * Optional on every kind except `note`, where it is the whole entry.
   * At most 100,000 characters.
   */
  note?: string;
}

export type ScreenshotMode = "viewport" | "full-page" | "area";

export interface ScreenshotEntry extends EntryBase<"screenshot"> {
  /**
   * File name returned by the media upload, e.g. "003-screenshot.png", at
   * most 255 characters. Must be an upload made with `x-holt-kind` set to
   * this entry's kind.
   */
  file: string;
  mode: ScreenshotMode;
  width: number;
  height: number;
}

export interface RecordingEntry extends EntryBase<"recording"> {
  file: string;
  durationMs: number;
  // `note` holds the narration: what the user said while recording
  // (microphone, live speech recognition), as they reviewed it.
}

/**
 * A dictated note. `note` is the reviewed transcript, `file` the audio if
 * the user keeps audio (or recognition produced nothing usable). At least
 * one of `note` / `file` is present.
 */
export interface VoiceNoteEntry extends EntryBase<"voice-note"> {
  file?: string;
  durationMs: number;
}

/** A typed note with no media: `note` is required and is the entry's body. */
export interface NoteEntry extends EntryBase<"note"> {
  note: string;
}

/** What the extension sends. The server assigns the id and sequence number. */
export type EntryInput = ScreenshotEntry | RecordingEntry | VoiceNoteEntry | NoteEntry;

/** What the server stores and returns. */
export type Entry = EntryInput & {
  id: string;
  /** 1-based position within the session; also used as the file-name prefix. */
  seq: number;
  /** ISO timestamp when the server accepted the entry. */
  receivedAt: string;
};
