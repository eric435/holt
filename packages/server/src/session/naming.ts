/**
 * Every name the server writes to disk is generated here, from a timestamp,
 * a counter and an allow-list. The extension never supplies a file name or
 * path (see docs/SECURITY.md, "Path traversal"), so the only names that ever
 * reach the file system are ones these functions produced.
 */

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/**
 * Session folder name: `YYYY-MM-DD-HHMMSS` in local time. Local, not UTC,
 * because humans browse these folders and expect the time on their clock.
 * The format also sorts chronologically as plain text.
 */
export function sessionFolderName(date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${day}-${time}`;
}

/**
 * The name segments a media file may use. This is a closed list on purpose:
 * the `x-nitpick-kind` header comes from the client, and only these exact
 * strings may end up in a file name.
 */
export const MEDIA_KINDS = ["screenshot", "recording", "voice-note", "media"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export function isMediaKind(value: unknown): value is MediaKind {
  return typeof value === "string" && (MEDIA_KINDS as readonly string[]).includes(value);
}

/** Media file name: `001-screenshot.png`. Zero-padded so files sort in capture order. */
export function mediaFileName(seq: number, kind: MediaKind, ext: string): string {
  return `${pad(seq, 3)}-${kind}.${ext}`;
}

/**
 * True for a bare file name like `003-screenshot.png`: letters, digits, dot,
 * dash and underscore only, not starting with a dot, no `..`, no separators.
 * Used to reject anything a client sends that is not a name we could have
 * generated, before it gets anywhere near `path.resolve`.
 */
export function isPlainFileName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) &&
    !name.includes("..")
  );
}
