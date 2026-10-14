/**
 * Renders the session's notes.md: a header when the session starts, one
 * list item per entry, and a footer when it ends. The format is documented in
 * docs/ARCHITECTURE.md ("Markdown format").
 *
 * These are pure functions (data in, string out) so the format can be tested
 * without touching the disk, and so the file can be written append-only: the
 * store never has to read notes.md back or rewrite it.
 *
 * Every piece of user-controlled text passes through ./escape.ts. File names
 * are not escaped because the server generated them (see naming.ts).
 */
import type { Entry, PageContext } from "@holt/protocol";
import { escapeInline, listItemBody, safeUrl } from "./escape.js";

export interface HeaderInput {
  title: string;
  startedAt: Date;
  /** Absolute project root, shown for context. */
  root: string;
}

export function renderHeader({ title, startedAt, root }: HeaderInput): string {
  return [
    `# ${escapeInline(title)} ${formatLocalDateTime(startedAt)}`,
    "",
    `- Started: ${formatLocalIso(startedAt)}`,
    `- Project: ${escapeInline(root)}`,
    "",
    "---",
    "",
    "",
  ].join("\n");
}

/**
 * The session end marker. A trailing line (rather than an "Ended:" bullet
 * under the header) because notes.md is append-only: we never seek back and
 * rewrite the top of the file.
 */
export function renderFooter(endedAt: Date, entryCount: number): string {
  const line = `_Session ended at ${formatLocalIso(endedAt)} (${pluralEntries(entryCount)})._\n`;
  // With no entries, the header's own rule is right above; don't double it.
  // Otherwise a blank line first, so the rule cleanly ends the entry list.
  return entryCount === 0 ? line : `\n---\n\n${line}`;
}

/**
 * One `- ` list item per capture: the user's words, the media file (if
 * any), then the page. A one-line note keeps it all on one line; a longer
 * note's lines are indented under the item, with the media and page on
 * their own line after it.
 */
export function renderEntry(entry: Entry): string {
  const words = withFullStop(entry.note ? listItemBody(entry.note) : "");
  const trailer = [renderMedia(entry), renderPage(entry.page)].filter(Boolean).join(" ");
  if (!words) return `- ${trailer}\n`;
  if (!trailer) return `- ${words}\n`;
  return words.includes("\n") ? `- ${words}\n  ${trailer}\n` : `- ${words} ${trailer}\n`;
}

/** The entry's file as a link (an image for screenshots), or null. */
function renderMedia(entry: Entry): string | null {
  switch (entry.kind) {
    case "screenshot":
      return `![Screenshot ${entry.seq}](./${entry.file})`;
    case "recording":
      return `[Recording ${entry.seq}](./${entry.file}) (${formatDuration(entry.durationMs)})`;
    case "voice-note":
      return entry.file ? `[audio](./${entry.file}) (${formatDuration(entry.durationMs)})` : null;
    case "note":
      return null;
  }
}

/**
 * End the words with a full stop when they stop on a letter or digit, so
 * the links after them read as a separate sentence. A bare number is left
 * alone: "2026." at the start of a list item would become a numbered list.
 */
function withFullStop(words: string): string {
  return /[\p{L}\p{N}]$/u.test(words) && !/^\d+$/.test(words) ? `${words}.` : words;
}

/** `Page: [Title](url)`, or plain text if the URL is not http(s). */
function renderPage({ url, title }: PageContext): string | null {
  const href = safeUrl(url);
  const label = escapeInline(title) || escapeInline(url);
  if (!label) return null;
  if (href) return `Page: [${label}](${href})`;
  // Not linkable (chrome://, file:, javascript:, garbage): show it as text.
  const urlText = escapeInline(url);
  return urlText && urlText !== label ? `Page: ${label} — ${urlText}` : `Page: ${label}`;
}

/** "1 entry", "3 entries". */
export function pluralEntries(count: number): string {
  return count === 1 ? "1 entry" : `${count} entries`;
}

// --- time formatting (local time, matching the folder names) --------------

const pad = (n: number): string => String(n).padStart(2, "0");

/** `2026-10-13 07:52` */
export function formatLocalDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `07:53:12` */
export function formatLocalTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `2026-10-13T07:52:00-07:00`: ISO 8601 with the local UTC offset. */
export function formatLocalIso(d: Date): string {
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${formatLocalTime(d)}${offset}`;
}

/** `0:12`, `12:05`, `1:02:03` */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
