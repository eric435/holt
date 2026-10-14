/**
 * Renders the session's notes.md: a header when the session starts, one
 * block per entry, and a footer when it ends. The format is documented in
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
import { blockquote, escapeBlock, escapeInline, safeUrl } from "./escape.js";

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
  return entryCount === 0 ? line : `---\n\n${line}`;
}

export function renderEntry(entry: Entry): string {
  const blocks: string[] = [];
  const time = formatLocalTime(new Date(entry.capturedAt));
  const heading = `## ${entry.seq}. ${entryLabel(entry)} · ${time}`;
  const page = renderPage(entry.page);
  blocks.push(page ? `${heading}\n${page}` : heading);

  switch (entry.kind) {
    case "screenshot":
      blocks.push(`![Screenshot ${entry.seq}](./${entry.file})`);
      break;
    case "recording":
      blocks.push(`🎬 [Recording ${entry.seq}](./${entry.file}) (${formatDuration(entry.durationMs)})`);
      if (entry.transcript) blocks.push(blockquote(`Transcript: ${entry.transcript}`));
      break;
    case "voice-note":
      blocks.push(
        entry.file
          ? `🎙 [audio](./${entry.file}) (${formatDuration(entry.durationMs)})`
          : `🎙 (${formatDuration(entry.durationMs)}, transcript only)`,
      );
      if (entry.transcript) blocks.push(blockquote(`Transcript: ${entry.transcript}`));
      break;
    case "note":
      blocks.push(escapeBlock(entry.text));
      break;
  }

  if (entry.note) blocks.push(blockquote(entry.note));
  return `${blocks.join("\n\n")}\n\n`;
}

function entryLabel(entry: Entry): string {
  switch (entry.kind) {
    case "screenshot":
      // The default (viewport) stays plain "Screenshot" as in the documented
      // format; the other modes are worth knowing when reading the notes.
      if (entry.mode === "full-page") return "Screenshot (full page)";
      if (entry.mode === "area") return "Screenshot (area)";
      return "Screenshot";
    case "recording":
      return "Recording";
    case "voice-note":
      return "Voice note";
    case "note":
      return "Note";
  }
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
