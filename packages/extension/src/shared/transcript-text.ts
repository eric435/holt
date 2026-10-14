/**
 * Merging live speech recognition into a transcript the user is editing.
 *
 * The recogniser reports `final`: everything recognised so far, which only
 * ever grows (see shared/speech.ts: earlier runs are committed, and a
 * run's final results are never revised). The user edits their own copy.
 * To combine the two without overwriting the user's edits, we remember the
 * `final` the copy already contains (`heard`) and append only what was
 * recognised after it.
 *
 * Used by the box on the page (content/voice-overlay.ts) and the screenshot
 * note prompt's dictation (note/note.ts) as speech arrives (`applyFinal`,
 * the same for both), and by the worker for the case where the box is gone
 * (the page navigated) and the recording ends (`mergeTranscript`).
 *
 * Pure so it is unit-tested (`applyFinal` takes the textarea through the
 * small `SpeechField` interface, so a plain object stands in for it).
 */

import type { TranscriptDraft } from "./messages.js";

/**
 * What `final` adds to `heard`, trimmed ("" if nothing). Null if `final` does
 * not extend `heard`, which the recogniser should never do; callers then
 * keep the user's text as it is.
 */
export function newSpeech(heard: string, final: string): string | null {
  if (!final.startsWith(heard)) return null;
  return final.slice(heard.length).trim();
}

/** `addition` appended to `text`, with a space between them unless `text` is empty or already ends in whitespace. */
export function appendSpeech(text: string, addition: string): string {
  if (!addition) return text;
  return text === "" || /\s$/.test(text) ? text + addition : `${text} ${addition}`;
}

/** The user's draft with whatever was recognised since, i.e. the text to save. */
export function mergeTranscript(draft: TranscriptDraft, final: string): string {
  return appendSpeech(draft.text, newSpeech(draft.heard, final) ?? "");
}

/** The parts of a <textarea> that `applyFinal` reads and writes. */
export interface SpeechField {
  value: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  scrollTop: number;
  readonly scrollHeight: number;
  setRangeText(replacement: string, start: number, end: number, selectionMode: "end" | "preserve"): void;
}

export interface ApplyFinalOptions {
  /**
   * The text is the user's: they edited it, or (the note prompt) it is their
   * note that dictation adds to. Never replaced wholesale then.
   */
  edited: boolean;
  /** The field has focus, so the user may be reading or typing at the caret. */
  focused: boolean;
}

/**
 * Bring what the recogniser finalised since `heard` into `field`, keeping
 * the user's edits, and return the new `heard`.
 *
 * New words go at the end. If the caret is at the very end it moves past
 * them, so typing continues after them; anywhere else it (and any
 * selection) stays where the user put it. The field scrolls to the new
 * words unless the user is working elsewhere in it.
 *
 * A `final` that does not extend `heard` (the recogniser shouldn't do that)
 * replaces the text only while it is not the user's; either way it becomes
 * the new `heard`, so what is recognised after it is appended again instead
 * of being dropped for the rest of the session.
 */
export function applyFinal(field: SpeechField, heard: string, final: string, { edited, focused }: ApplyFinalOptions): string {
  const added = newSpeech(heard, final);
  if (added === null) {
    if (!edited) field.value = final;
    return final;
  }
  if (added) {
    const before = field.value;
    const insert = appendSpeech(before, added).slice(before.length);
    const atEnd = field.selectionStart === before.length && field.selectionEnd === before.length;
    field.setRangeText(insert, before.length, before.length, atEnd ? "end" : "preserve");
    if (atEnd || !focused) field.scrollTop = field.scrollHeight;
  }
  return final;
}
