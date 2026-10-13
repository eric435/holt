/**
 * Entries are the things a QA session is made of. The extension creates them;
 * the server appends them to the session's markdown file.
 *
 * Media-bearing entries (screenshot, recording, voice note) reference a file
 * that was uploaded *first* via `POST /media` (see http.ts). The server
 * verifies the referenced file belongs to the current session, so the
 * extension can never make the markdown point outside the session folder.
 */

/** Where the entry was captured. Always recorded so notes have context. */
export interface PageContext {
  url: string;
  title: string;
}

export type EntryKind = "screenshot" | "recording" | "voice-note" | "note";

interface EntryBase<K extends EntryKind> {
  kind: K;
  /** ISO 8601 timestamp set by the extension at capture time. */
  capturedAt: string;
  page: PageContext;
  /** Optional free-text the user attached to this entry. */
  note?: string;
}

export type ScreenshotMode = "viewport" | "full-page" | "area";

export interface ScreenshotEntry extends EntryBase<"screenshot"> {
  /** File name returned by the media upload, e.g. "003-screenshot.png". */
  file: string;
  mode: ScreenshotMode;
  width: number;
  height: number;
}

export interface RecordingEntry extends EntryBase<"recording"> {
  file: string;
  durationMs: number;
}

export interface VoiceNoteEntry extends EntryBase<"voice-note"> {
  /** Audio file, if the user chose to keep audio alongside the transcript. */
  file?: string;
  /** Transcript text, if transcription succeeded. At least one of file/transcript must be present. */
  transcript?: string;
  durationMs: number;
}

export interface NoteEntry extends EntryBase<"note"> {
  text: string;
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
