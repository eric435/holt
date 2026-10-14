/**
 * Runtime validation of `POST /entries` bodies against the protocol's
 * `EntryInput` type.
 *
 * TypeScript types vanish at runtime, and the body is untrusted JSON, so
 * every field is checked by hand. The parser *builds a new object* with only
 * the known fields instead of passing the parsed body through: unexpected
 * keys never reach the markdown writer or the response.
 *
 * Free-text fields are capped per field (ENTRY_FIELD_LIMITS in
 * @holt/protocol): the JSON body limit bounds the request as a whole, not
 * how much of it a single title or URL may write into notes.md.
 *
 * Whether `file` refers to a real upload (of the same kind) is checked later
 * by the session store, which knows what was uploaded.
 */
import {
  ENTRY_FIELD_LIMITS,
  type EntryInput,
  type EntryKind,
  type NoteEntry,
  type PageContext,
  type RecordingEntry,
  type ScreenshotEntry,
  type ScreenshotMode,
  type VoiceNoteEntry,
} from "@holt/protocol";
import { HttpError } from "./errors.js";

type Json = Record<string, unknown>;

const SCREENSHOT_MODES: readonly ScreenshotMode[] = ["viewport", "full-page", "area"];

const ENTRY_KINDS: readonly EntryKind[] = ["screenshot", "recording", "voice-note", "note"];

/**
 * Keys that earlier versions of the protocol used for the user's words
 * (`transcript` on voice notes, `text` on notes; both are `note` now).
 * Unknown keys are normally dropped, but dropping these would throw away
 * what the user said or typed without anyone noticing, so a body that
 * carries one is refused with a message that says what to do.
 */
const RETIRED_KEYS = ["transcript", "text"] as const;

export function parseEntryInput(body: unknown): EntryInput {
  const o = asObject(body, "entry");
  // Check the kind first: if it is wrong, that is the most useful error.
  oneOf(o, "kind", ENTRY_KINDS);
  // Then retired keys, before any field check: an old extension's voice
  // note with only a `transcript` would otherwise get a confusing "needs
  // file or note" error, and one with a file would silently lose its words.
  for (const key of RETIRED_KEYS) {
    if (Object.hasOwn(o, key)) {
      bad(
        `"${key}" is no longer part of the protocol (the user's words go in "note"). ` +
          `The holt extension is out of date: update it to match this server.`,
      );
    }
  }
  const base = {
    capturedAt: isoDate(o, "capturedAt"),
    page: parsePage(o.page),
    ...optionalText(o, "note", ENTRY_FIELD_LIMITS.note),
  };

  switch (o.kind) {
    case "screenshot": {
      const entry: ScreenshotEntry = {
        kind: "screenshot",
        ...base,
        file: fileName(o),
        mode: oneOf(o, "mode", SCREENSHOT_MODES),
        width: nonNegativeInteger(o, "width"),
        height: nonNegativeInteger(o, "height"),
      };
      return entry;
    }
    case "recording": {
      const entry: RecordingEntry = {
        kind: "recording",
        ...base,
        file: fileName(o),
        durationMs: nonNegativeNumber(o, "durationMs"),
      };
      return entry;
    }
    case "voice-note": {
      const file = o.file === undefined ? {} : { file: fileName(o) };
      if (!("file" in file) && base.note === undefined) {
        bad(`A voice-note needs "file", "note", or both`);
      }
      const entry: VoiceNoteEntry = {
        kind: "voice-note",
        ...base,
        ...file,
        durationMs: nonNegativeNumber(o, "durationMs"),
      };
      return entry;
    }
    case "note": {
      // The note is the whole entry here, so it is required (and not blank).
      const note = requiredString(o, "note", "note", ENTRY_FIELD_LIMITS.note);
      if (note.trim() === "") bad(`"note" must not be empty`);
      const entry: NoteEntry = { kind: "note", ...base, note };
      return entry;
    }
    default:
      return bad(`unreachable: "kind" was checked above`);
  }
}

// --- field helpers: each returns the typed value or throws a 400 ----------

function bad(message: string): never {
  throw new HttpError(400, "bad-request", message);
}

function asObject(value: unknown, name: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    bad(`"${name}" must be a JSON object`);
  }
  return value as Json;
}

function parsePage(value: unknown): PageContext {
  const o = asObject(value, "page");
  return {
    url: requiredString(o, "url", "page.url", ENTRY_FIELD_LIMITS["page.url"]),
    title: requiredString(o, "title", "page.title", ENTRY_FIELD_LIMITS["page.title"]),
  };
}

function fileName(o: Json): string {
  return requiredString(o, "file", "file", ENTRY_FIELD_LIMITS.file);
}

function requiredString(o: Json, key: string, label = key, maxLength = Number.POSITIVE_INFINITY): string {
  const v = o[key];
  if (typeof v !== "string") bad(`"${label}" must be a string`);
  checkLength(v, label, maxLength);
  return v;
}

/**
 * Optional free text. Missing, null or blank all mean "not provided".
 * The length cap applies before trimming: a megabyte of spaces is still a
 * megabyte the client should not have sent.
 */
function optionalText<K extends string>(o: Json, key: K, maxLength: number): { [P in K]?: string } {
  const v = o[key];
  if (v === undefined || v === null) return {};
  if (typeof v !== "string") bad(`"${key}" must be a string`);
  checkLength(v, key, maxLength);
  return v.trim() === "" ? {} : ({ [key]: v } as { [P in K]?: string });
}

function checkLength(value: string, label: string, maxLength: number): void {
  if (value.length > maxLength) {
    bad(`"${label}" is too long (${value.length} characters; at most ${maxLength} allowed)`);
  }
}

function isoDate(o: Json, key: string): string {
  const v = requiredString(o, key);
  if (v.length > 64 || !Number.isFinite(Date.parse(v))) bad(`"${key}" must be an ISO 8601 timestamp`);
  return v;
}

function nonNegativeNumber(o: Json, key: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) bad(`"${key}" must be a non-negative number`);
  return v;
}

function nonNegativeInteger(o: Json, key: string): number {
  const v = nonNegativeNumber(o, key);
  if (!Number.isInteger(v)) bad(`"${key}" must be an integer`);
  return v;
}

function oneOf<T extends string>(o: Json, key: string, allowed: readonly T[]): T {
  const v = o[key];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    bad(`"${key}" must be one of ${allowed.map((a) => `"${a}"`).join(", ")}`);
  }
  return v as T;
}
