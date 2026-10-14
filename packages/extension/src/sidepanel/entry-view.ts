/**
 * What the side panel's entry list shows for one entry, as plain data.
 *
 * Every kind reads the same way, one item per capture: what it is, the page
 * it was taken on, the media file (if any), and the user's words (if any).
 * notes.md (server/src/session/markdown.ts) has the same parts minus the
 * label and number: the words, the file, then the page.
 *
 * Pure so it is unit-tested; ui/entries.ts turns it into elements.
 */

import type { Entry } from "@holt/protocol";

export interface EntryView {
  /** "#3 Screenshot (area)" */
  title: string;
  /** The page's title, or its URL if it has none. */
  page: string;
  /** Shown as the page's tooltip ("" for none). */
  pageUrl: string;
  /** File name and size or duration, e.g. "003-screenshot.png · 1280×800"; null for a plain note. */
  media: string | null;
  /** The user's words: the typed or dictated note, or a recording's narration. */
  note: string | null;
}

export function entryView(entry: Entry): EntryView {
  return {
    title: `#${entry.seq} ${label(entry)}`,
    page: entry.page.title || entry.page.url,
    pageUrl: entry.page.url,
    media: media(entry),
    note: entry.note?.trim() || null,
  };
}

/**
 * What each kind is called, the one place the panel spells it (the list's
 * titles, its "saved" toasts). notes.md has no labels; its file names
 * carry the kind instead.
 */
export const KIND_LABELS: Readonly<Record<Entry["kind"], string>> = {
  screenshot: "Screenshot",
  recording: "Recording",
  "voice-note": "Voice note",
  note: "Note",
};

function label(entry: Entry): string {
  if (entry.kind === "screenshot") {
    if (entry.mode === "full-page") return `${KIND_LABELS.screenshot} (full page)`;
    if (entry.mode === "area") return `${KIND_LABELS.screenshot} (area)`;
  }
  return KIND_LABELS[entry.kind];
}

function media(entry: Entry): string | null {
  switch (entry.kind) {
    case "screenshot":
      return `${entry.file} · ${entry.width}×${entry.height}`;
    case "recording":
      return `${entry.file} · ${formatDuration(entry.durationMs)}`;
    case "voice-note":
      return entry.file ? `${entry.file} · ${formatDuration(entry.durationMs)}` : `${formatDuration(entry.durationMs)} · audio not kept`;
    case "note":
      return null;
  }
}

/** `0:12`, `12:05`, `1:02:03` (as in notes.md). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
