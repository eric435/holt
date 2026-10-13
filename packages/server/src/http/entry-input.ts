/**
 * Runtime validation of `POST /entries` bodies against the protocol's
 * `EntryInput` type.
 *
 * TypeScript types vanish at runtime, and the body is untrusted JSON, so
 * every field is checked by hand. The parser *builds a new object* with only
 * the known fields instead of passing the parsed body through: unexpected
 * keys never reach the markdown writer or the response.
 *
 * Whether `file` refers to a real upload is checked later by the session
 * store, which knows what was uploaded.
 */
import type {
  EntryInput,
  EntryKind,
  NoteEntry,
  PageContext,
  RecordingEntry,
  ScreenshotEntry,
  ScreenshotMode,
  VoiceNoteEntry,
} from "@holt/protocol";
import { HttpError } from "./errors.js";

type Json = Record<string, unknown>;

const SCREENSHOT_MODES: readonly ScreenshotMode[] = ["viewport", "full-page", "area"];

const ENTRY_KINDS: readonly EntryKind[] = ["screenshot", "recording", "voice-note", "note"];

export function parseEntryInput(body: unknown): EntryInput {
  const o = asObject(body, "entry");
  // Check the kind first: if it is wrong, that is the most useful error.
  oneOf(o, "kind", ENTRY_KINDS);
  const base = {
    capturedAt: isoDate(o, "capturedAt"),
    page: parsePage(o.page),
    ...optionalText(o, "note"),
  };

  switch (o.kind) {
    case "screenshot": {
      const entry: ScreenshotEntry = {
        kind: "screenshot",
        ...base,
        file: requiredString(o, "file"),
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
        file: requiredString(o, "file"),
        durationMs: nonNegativeNumber(o, "durationMs"),
      };
      return entry;
    }
    case "voice-note": {
      const file = o.file === undefined ? {} : { file: requiredString(o, "file") };
      const transcript = optionalText(o, "transcript");
      if (!("file" in file) && !("transcript" in transcript)) {
        bad(`A voice-note needs "file", "transcript", or both`);
      }
      const entry: VoiceNoteEntry = {
        kind: "voice-note",
        ...base,
        ...file,
        ...transcript,
        durationMs: nonNegativeNumber(o, "durationMs"),
      };
      return entry;
    }
    case "note": {
      const text = requiredString(o, "text");
      if (text.trim() === "") bad(`"text" must not be empty`);
      const entry: NoteEntry = { kind: "note", ...base, text };
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
  return { url: requiredString(o, "url", "page.url"), title: requiredString(o, "title", "page.title") };
}

function requiredString(o: Json, key: string, label = key): string {
  const v = o[key];
  if (typeof v !== "string") bad(`"${label}" must be a string`);
  return v;
}

/** Optional free text. Missing, null or blank all mean "not provided". */
function optionalText<K extends string>(o: Json, key: K): { [P in K]?: string } {
  const v = o[key];
  if (v === undefined || v === null) return {};
  if (typeof v !== "string") bad(`"${key}" must be a string`);
  return v.trim() === "" ? {} : ({ [key]: v } as { [P in K]?: string });
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
