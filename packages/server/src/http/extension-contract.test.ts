/**
 * The extension <-> server protocol contract, checked at run time.
 *
 * @holt/protocol's types make the two sides agree at compile time, but
 * nothing there checks that the bodies the extension really builds are
 * what the server's parser really accepts: a field the extension renames
 * is a 400 in the field, and one the server doesn't know is silently
 * dropped (entry-input.ts builds a new object with only the fields it
 * knows), both invisible to tsc. So this test puts the two real halves
 * together, in-process:
 *
 *   the extension's own code                    this package's own code
 *   ------------------------                    -----------------------
 *   createApi (shared/api.ts): headers,  ─HTTP─▶ a real standalone server
 *     content types, x-holt-kind, JSON           (createHolt + startStandalone,
 *   entry bodies (shared/entry-bodies.ts)        as in handler.test.ts): CORS
 *   media types (shared/media-types.ts)          and header checks, body limits,
 *   page context (shared/page-context.ts)        parseEntryInput, the session store
 *   protocolCompatibility (shared/protocol-compat.ts)
 *
 * and checks that every request the extension sends is accepted, and that
 * every entry comes back with exactly the fields that were sent (so a
 * field the server drops fails here too). The only thing faked is what
 * Chrome adds by itself: the `Origin: chrome-extension://…` header.
 *
 * Why it lives here, importing the extension's source by relative path:
 * the server's tsconfig and vitest (Node, no DOM, no chrome types) run it
 * with `pnpm test` / `pnpm typecheck` like any other server test, and the
 * extension modules it imports are kept free of chrome.* on purpose (their
 * headers say so). If one of them starts importing chrome glue, the
 * server's typecheck fails on `chrome` here: move the pure part out again
 * rather than adding chrome types to the server.
 *
 * Every kind in EntryKind must have cases (the table below is a
 * Record<EntryKind, …>), so a new kind does not compile until it is
 * covered.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ACCEPTED_MEDIA_TYPES, ENTRY_FIELD_LIMITS, PROTOCOL_VERSION, type EntryInput, type EntryKind, type StatusResponse } from "@holt/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, baseMediaType, createApi, isHoltStatus, type Api } from "../../../extension/src/shared/api.js";
import {
  orphanedScreenshotNote,
  quickNoteEntry,
  recordingEntry,
  screenshotEntry,
  voiceNoteEntry,
} from "../../../extension/src/shared/entry-bodies.js";
import { AUDIO_TYPES, VIDEO_TYPES } from "../../../extension/src/shared/media-types.js";
import { pageContextFromTab } from "../../../extension/src/shared/page-context.js";
import { protocolCompatibility } from "../../../extension/src/shared/protocol-compat.js";
import { startStandalone, type StandaloneServer } from "../adapters/standalone.js";
import { createHolt } from "../core.js";
import { silentLogger } from "../log.js";

/** What Chrome sends as Origin for an extension page or worker; the server requires one. */
const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
/** Screenshots are PNGs on every path (captureVisibleTab with format "png", OffscreenCanvas.convertToBlob). */
const SCREENSHOT_TYPE = "image/png";
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

let tempDir: string;
let running: StandaloneServer;
let serverUrl: string;
let api: Api;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "holt-contract-"));
  const holt = await createHolt({ cwd: tempDir, overrides: { port: 0, projectName: "contract-app" }, logger: silentLogger });
  running = await startStandalone(holt, { logger: silentLogger });
  serverUrl = running.url;
  api = createApi({ serverUrl, token: "" });
});
afterAll(async () => {
  await running.close();
  await rm(tempDir, { recursive: true, force: true });
});

// The extension's client calls the global fetch; add what Chrome would.
beforeEach(() => {
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) =>
    realFetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), origin: EXT_ORIGIN } }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Upload with the extension's client, as the extension does before posting a media entry. */
async function upload(type: string, kind: EntryKind): Promise<string> {
  const media = await api.uploadMedia(new Blob([BYTES], { type }), kind);
  return media.file;
}

/** The entry as the server stored and returned it, without what the server adds. */
function asSent(entry: EntryInput & { id: string; seq: number; receivedAt: string }): EntryInput {
  const { id: _id, seq: _seq, receivedAt: _receivedAt, ...rest } = entry;
  return rest;
}

const capturedAt = () => new Date().toISOString();
const page = pageContextFromTab({ url: "http://localhost:5173/checkout?step=2", title: "Checkout – My App" });

describe("GET /status", () => {
  it("is holt, speaks PROTOCOL_VERSION, and the extension's compatibility check accepts it", async () => {
    const status = await api.status();
    expect(isHoltStatus(status)).toBe(true);
    expect(status.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(protocolCompatibility(status, serverUrl)).toEqual({ ok: true, serverProtocol: PROTOCOL_VERSION });
  });

  it("an older server's status without protocolVersion still counts as protocol 1", async () => {
    const { protocolVersion: _dropped, ...older } = await api.status();
    expect(protocolCompatibility(older as Partial<StatusResponse>, serverUrl, 1).ok).toBe(true);
  });
});

describe("POST /session/start and /session/stop, as the side panel sends them", () => {
  it.each([["with a title", "Checkout pass"], ["without one", undefined], ["with a blank one", "   "]])("start %s, then stop", async (_what, title) => {
    const started = await api.startSession(title);
    expect(started.session?.endedAt).toBeUndefined();
    if (title?.trim()) expect(started.session?.markdownFile).toBeDefined();
    const stopped = await api.stopSession();
    expect(stopped.session?.endedAt).toBeDefined();
  });
});

describe("POST /media: every type the extension records is accepted for its kind", () => {
  const uploads: [string, EntryKind][] = [
    [SCREENSHOT_TYPE, "screenshot"],
    ...VIDEO_TYPES.map((type): [string, EntryKind] => [type, "recording"]),
    ...AUDIO_TYPES.map((type): [string, EntryKind] => [type, "voice-note"]),
  ];
  it.each(uploads)("%s as a %s", async (type, kind) => {
    expect(Object.hasOwn(ACCEPTED_MEDIA_TYPES, baseMediaType(type))).toBe(true);
    const file = await upload(type, kind);
    expect(file).toMatch(new RegExp(`^\\d{3}-${kind}\\.${ACCEPTED_MEDIA_TYPES[baseMediaType(type)]}$`));
  });
});

describe("POST /entries: every body the extension builds is accepted, field for field", () => {
  type Case = [name: string, build: () => Promise<EntryInput>];
  const huge = "x".repeat(ENTRY_FIELD_LIMITS.note + 1_000);
  const longPage = pageContextFromTab({
    url: `http://localhost:5173/search?q=${"a".repeat(ENTRY_FIELD_LIMITS["page.url"])}`,
    title: "T".repeat(ENTRY_FIELD_LIMITS["page.title"] + 10),
  });

  const screenshot = async (mode: "viewport" | "full-page" | "area", note: string, at = page) =>
    screenshotEntry({ capturedAt: capturedAt(), page: at, file: await upload(SCREENSHOT_TYPE, "screenshot"), mode, width: 1280, height: 800 }, note);

  const cases: Record<EntryKind, Case[]> = {
    screenshot: [
      ["viewport, with a note", () => screenshot("viewport", " Submit overlaps the footer ")],
      ["full page, without a note", () => screenshot("full-page", "")],
      ["area, without a note (Skip)", () => screenshot("area", "  ")],
      ["fields at the extension's clamps (page URL, title, note at their limits)", () => screenshot("viewport", huge, longPage)],
    ],
    recording: [
      ["with narration", async () => recordingEntry({ capturedAt: capturedAt(), page, durationMs: 4_200.5 }, await upload(VIDEO_TYPES[0], "recording"), "It froze here")],
      ["without narration", async () => recordingEntry({ capturedAt: capturedAt(), page, durationMs: 0 }, await upload("video/webm", "recording"), "")],
    ],
    "voice-note": [
      ["audio and transcript", async () => voiceNoteEntry({ capturedAt: capturedAt(), page, durationMs: 3_000 }, await upload(AUDIO_TYPES[0], "voice-note"), "The coupon field")],
      ["audio only", async () => voiceNoteEntry({ capturedAt: capturedAt(), page, durationMs: 3_000 }, await upload("audio/ogg;codecs=opus", "voice-note"), "")],
      ["transcript only (no audio kept)", async () => voiceNoteEntry({ capturedAt: capturedAt(), page, durationMs: 3_000 }, undefined, "The coupon field")],
    ],
    note: [
      ["a quick note", async () => quickNoteEntry(page, " Coupon field accepts whitespace ", capturedAt())],
      ["a quick note at the length limit", async () => quickNoteEntry(longPage, huge, capturedAt())],
      ["a screenshot's words saved on their own (its session ended)", async () => orphanedScreenshotNote({ capturedAt: capturedAt(), page, file: "001-screenshot.png" }, "The footer overlaps")],
    ],
  };

  for (const [kind, kindCases] of Object.entries(cases)) {
    it.each(kindCases)(`${kind}: %s`, async (_name, build) => {
      const body = await build();
      expect(body.kind).toBe(kind);
      const { entry } = await api.postEntry(body);
      // JSON round trip: what went over the wire, not the object in memory.
      expect(asSent(entry)).toEqual(JSON.parse(JSON.stringify(body)));
    });
  }

  it("an entry kind this server doesn't know: the extension's error carries the server's 'update the server' message", async () => {
    const future = { ...quickNoteEntry(page, "from the future", capturedAt()), kind: "sketch" } as unknown as EntryInput;
    const error = await api.postEntry(future).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "bad-request", status: 400 });
    expect((error as ApiError).message).toMatch(/extension is probably newer than this holt server/);
    expect((error as ApiError).message).toContain("npm i -D @velvet-thunder/holt@latest");
  });
});
