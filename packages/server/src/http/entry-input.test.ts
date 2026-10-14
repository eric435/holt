/**
 * `parseEntryInput` is the only thing standing between untrusted JSON and
 * the markdown writer, so every kind, every required field and every
 * rejection is pinned down here (the handler tests only spot-check it over
 * HTTP).
 */
import { ENTRY_FIELD_LIMITS } from "@holt/protocol";
import { describe, expect, it } from "vitest";
import { parseEntryInput } from "./entry-input.js";
import { HttpError } from "./errors.js";

const page = { url: "http://localhost:5173/checkout", title: "Checkout" };
const capturedAt = "2026-10-13T14:53:12.000Z";

const valid = {
  screenshot: { kind: "screenshot", capturedAt, page, file: "001-screenshot.png", mode: "viewport", width: 1280, height: 800 },
  recording: { kind: "recording", capturedAt, page, file: "002-recording.webm", durationMs: 42_000 },
  "voice-note": { kind: "voice-note", capturedAt, page, file: "003-voice-note.webm", durationMs: 12_000 },
  note: { kind: "note", capturedAt, page, note: "Coupon field accepts whitespace" },
} as const;

type Kind = keyof typeof valid;
const KINDS = Object.keys(valid) as Kind[];

/** The 400 message for `body`, or a failure if it parsed. */
function rejection(body: unknown): string {
  try {
    parseEntryInput(body);
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).code).toBe("bad-request");
    return (err as Error).message;
  }
  throw new Error(`expected ${JSON.stringify(body)} to be rejected`);
}

const without = (o: object, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

describe("parseEntryInput: valid entries", () => {
  it.each(KINDS)("accepts a minimal %s and returns exactly its fields", (kind) => {
    expect(parseEntryInput(valid[kind])).toEqual(valid[kind]);
  });

  it.each(["viewport", "full-page", "area"])("accepts screenshot mode %s", (mode) => {
    expect(parseEntryInput({ ...valid.screenshot, mode })).toMatchObject({ mode });
  });

  it.each(KINDS)("drops unknown keys on a %s (they never reach the markdown or the response)", (kind) => {
    // JSON.parse turns "__proto__" into an own property, which a careless
    // spread would copy through.
    const body = JSON.parse(
      JSON.stringify({ ...valid[kind], id: "x", seq: 99, receivedAt: "t", path: "../../etc/passwd", extra: { a: 1 } }).replace(
        /^\{/,
        '{"__proto__":{"polluted":true},',
      ),
    ) as unknown;
    const parsed = parseEntryInput(body);
    expect(parsed).toEqual(valid[kind]);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(valid[kind]).sort());
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("copies the page down to url and title", () => {
    const parsed = parseEntryInput({ ...valid.note, page: { ...page, favicon: "x", html: "<b>" } });
    expect(parsed.page).toEqual(page);
  });

  it("accepts zero sizes and durations (an empty capture is odd but not malformed)", () => {
    expect(parseEntryInput({ ...valid.screenshot, width: 0, height: 0 })).toMatchObject({ width: 0, height: 0 });
    expect(parseEntryInput({ ...valid.recording, durationMs: 0 })).toMatchObject({ durationMs: 0 });
  });

  it("accepts a fractional duration but not a fractional size", () => {
    expect(parseEntryInput({ ...valid.recording, durationMs: 1234.5 })).toMatchObject({ durationMs: 1234.5 });
    expect(rejection({ ...valid.screenshot, width: 10.5 })).toMatch(/"width" must be an integer/);
  });

  it("accepts empty page url and title (chrome:// pages have neither)", () => {
    expect(parseEntryInput({ ...valid.note, page: { url: "", title: "" } }).page).toEqual({ url: "", title: "" });
  });
});

describe("parseEntryInput: the note field", () => {
  it.each(["screenshot", "recording", "voice-note"] as const)("is optional on a %s and kept verbatim when present", (kind) => {
    const note = "  Line one\n\n## not a heading\n";
    expect(parseEntryInput({ ...valid[kind], note })).toEqual({ ...valid[kind], note });
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["blank", " \n\t "],
  ])("%s means 'no note' on media entries (no note key at all)", (_what, note) => {
    const parsed = parseEntryInput({ ...valid.screenshot, note });
    expect(parsed).not.toHaveProperty("note");
  });

  it.each([42, true, ["a"], { text: "a" }])("must be a string when given (%j)", (note) => {
    expect(rejection({ ...valid.screenshot, note })).toMatch(/"note" must be a string/);
  });

  it("is required on a note entry", () => {
    expect(rejection(without(valid.note, "note"))).toMatch(/"note" must be a string/);
    expect(rejection({ ...valid.note, note: null })).toMatch(/"note" must be a string/);
  });

  it.each(["", "   ", "\n\n", "\t"])("must not be blank on a note entry (%j)", (note) => {
    expect(rejection({ ...valid.note, note })).toMatch(/"note" must not be empty/);
  });

  it("keeps a note of exactly the maximum length in full", () => {
    const note = "x".repeat(ENTRY_FIELD_LIMITS.note);
    expect((parseEntryInput({ ...valid.note, note }) as { note: string }).note).toHaveLength(100_000);
  });

  it("a voice note needs a file, a note, or both", () => {
    const bare = without(valid["voice-note"], "file");
    expect(rejection(bare)).toMatch(/voice-note needs "file", "note", or both/);
    expect(rejection({ ...bare, note: "   " })).toMatch(/voice-note needs/);
    expect(parseEntryInput({ ...bare, note: "words only" })).toEqual({ ...bare, note: "words only" });
    expect(parseEntryInput({ ...valid["voice-note"], note: "both" })).toEqual({ ...valid["voice-note"], note: "both" });
  });

  it("a voice note's file, when present, must be a string", () => {
    expect(rejection({ ...valid["voice-note"], file: null, note: "x" })).toMatch(/"file" must be a string/);
    expect(rejection({ ...valid["voice-note"], file: 3 })).toMatch(/"file" must be a string/);
  });
});

describe("parseEntryInput: rejected bodies", () => {
  it.each([null, [], "note", 42, true])("rejects a non-object body (%j)", (body) => {
    expect(rejection(body)).toMatch(/"entry" must be a JSON object/);
  });

  it.each([undefined, "Screenshot", "image", "", 1, "constructor", "__proto__"])("rejects kind %j, naming every valid kind", (kind) => {
    expect(rejection({ ...valid.screenshot, kind })).toMatch(
      /"kind" must be one of "screenshot", "recording", "voice-note", "note"/,
    );
  });

  it("reports a bad kind before any other problem", () => {
    expect(rejection({ kind: "nope" })).toMatch(/"kind"/);
  });

  // Required fields per kind, and the field named in the message.
  const required: [Kind, string, RegExp][] = [
    ["screenshot", "file", /"file" must be a string/],
    ["screenshot", "mode", /"mode" must be one of "viewport", "full-page", "area"/],
    ["screenshot", "width", /"width" must be a non-negative number/],
    ["screenshot", "height", /"height" must be a non-negative number/],
    ["recording", "file", /"file" must be a string/],
    ["recording", "durationMs", /"durationMs" must be a non-negative number/],
    ["voice-note", "durationMs", /"durationMs" must be a non-negative number/],
  ];
  for (const kind of KINDS) {
    required.push([kind, "capturedAt", /"capturedAt" must be a string/], [kind, "page", /"page" must be a JSON object/]);
  }
  it.each(required)("a %s without %s is rejected", (kind, key, message) => {
    expect(rejection(without(valid[kind], key))).toMatch(message);
  });

  it.each([
    ["page.url", { title: "t" }],
    ["page.title", { url: "http://localhost/" }],
    ["page.url", { url: 1, title: "t" }],
    ["page.title", { url: "http://localhost/", title: null }],
  ])("names %s when the page is incomplete", (label, badPage) => {
    expect(rejection({ ...valid.note, page: badPage })).toContain(`"${label}" must be a string`);
  });

  it.each([[[]], ["http://localhost/"], [null]])("rejects a page that is not an object (%j)", (badPage) => {
    expect(rejection({ ...valid.note, page: badPage })).toMatch(/"page" must be a JSON object/);
  });

  it.each(["yesterday", "", "2026-13-45T99:99:99Z", `2026-10-13T14:53:12.000Z${" ".repeat(60)}`])(
    "rejects capturedAt %j",
    (value) => {
      expect(rejection({ ...valid.note, capturedAt: value })).toMatch(/"capturedAt" must be an ISO 8601 timestamp/);
    },
  );

  it.each([-1, -0.001, Number.NaN, Number.POSITIVE_INFINITY, "12", null])("rejects durationMs %j", (durationMs) => {
    expect(rejection({ ...valid.recording, durationMs })).toMatch(/"durationMs" must be a non-negative number/);
  });

  it.each([-1, Number.NaN, "1280", 1e400])("rejects width %j", (width) => {
    expect(rejection({ ...valid.screenshot, width })).toMatch(/"width" must be a non-negative/);
  });

  it.each(["VIEWPORT", "fullpage", "", null, 0])("rejects screenshot mode %j", (mode) => {
    expect(rejection({ ...valid.screenshot, mode })).toMatch(/"mode" must be one of/);
  });

  it("accepts any string as file here: whether it is a real upload is the store's job", () => {
    // The session store rejects "../x", absolute paths and unknown names
    // (see store.test.ts); the parser only checks the type.
    expect(parseEntryInput({ ...valid.screenshot, file: "../notes.md" })).toMatchObject({ file: "../notes.md" });
  });
});

describe("parseEntryInput: field length caps", () => {
  it("pins the documented limits (packages/shared entries.ts and http.ts quote these numbers)", () => {
    expect(ENTRY_FIELD_LIMITS).toEqual({ "page.title": 1_000, "page.url": 8_192, note: 100_000, file: 255 });
  });

  // [label, body with the field at `length` characters]
  const atLength: [string, Kind, (length: number) => object][] = [
    ["page.title", "note", (n) => ({ ...valid.note, page: { ...page, title: "t".repeat(n) } })],
    ["page.url", "note", (n) => ({ ...valid.note, page: { ...page, url: `http://localhost/${"a".repeat(n - 17)}` } })],
    ["note", "note", (n) => ({ ...valid.note, note: "n".repeat(n) })],
    ["note", "screenshot", (n) => ({ ...valid.screenshot, note: "n".repeat(n) })],
    ["file", "screenshot", (n) => ({ ...valid.screenshot, file: "f".repeat(n) })],
    ["file", "recording", (n) => ({ ...valid.recording, file: "f".repeat(n) })],
    ["file", "voice-note", (n) => ({ ...valid["voice-note"], file: "f".repeat(n) })],
  ];

  it.each(atLength)("accepts %s at exactly its limit (on a %s)", (label, _kind, body) => {
    const limit = ENTRY_FIELD_LIMITS[label as keyof typeof ENTRY_FIELD_LIMITS];
    expect(() => parseEntryInput(body(limit))).not.toThrow();
  });

  it.each(atLength)("rejects %s one character over its limit (on a %s), naming the field", (label, _kind, body) => {
    const limit = ENTRY_FIELD_LIMITS[label as keyof typeof ENTRY_FIELD_LIMITS];
    expect(rejection(body(limit + 1))).toBe(
      `"${label}" is too long (${limit + 1} characters; at most ${limit} allowed)`,
    );
  });

  it("counts a blank optional note against the cap before treating it as 'no note'", () => {
    expect(rejection({ ...valid.recording, note: " ".repeat(ENTRY_FIELD_LIMITS.note + 1) })).toMatch(/"note" is too long/);
  });

  it("counts UTF-16 code units, like the extension's own guard", () => {
    // "😀" is two code units: 50,001 of them is 100,002 characters.
    expect(rejection({ ...valid.note, note: "😀".repeat(50_001) })).toMatch(/"note" is too long \(100002 characters/);
  });

  it("checks the type before the length", () => {
    expect(rejection({ ...valid.note, page: { ...page, title: ["t".repeat(2_000)] } })).toMatch(/"page.title" must be a string/);
  });
});

describe("parseEntryInput: retired protocol keys", () => {
  // An extension older than the `note` field sends the user's words as
  // `transcript` (voice notes) or `text` (notes). Silently dropping those
  // keys would lose the words, so the server says the extension is stale.
  it.each([
    ["transcript", { ...valid["voice-note"], transcript: "what I said" }],
    ["transcript", { kind: "voice-note", capturedAt, page, durationMs: 1, transcript: "words only" }],
    ["text", { kind: "note", capturedAt, page, text: "what I typed" }],
    ["text", { ...valid.note, text: "both" }],
    ["transcript", { ...valid.screenshot, transcript: "" }],
    ["transcript", { ...valid.recording, transcript: null }],
  ])("rejects a body carrying %j, saying the extension is out of date", (key, body) => {
    const message = rejection(body);
    expect(message).toContain(`"${key}" is no longer part of the protocol`);
    expect(message).toMatch(/extension is out of date/);
  });

  it("still reports a bad kind first", () => {
    expect(rejection({ kind: "nope", text: "x" })).toMatch(/"kind" must be one of/);
  });

  it("only looks at the top level (a page may have a text property of its own)", () => {
    expect(parseEntryInput({ ...valid.note, page: { ...page, text: "x" } }).page).toEqual(page);
  });
});
