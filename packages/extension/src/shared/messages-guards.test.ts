/**
 * Systematic checks of the message type guards (messages.test.ts has the
 * hand-written examples). Messages from content scripts come from inside a
 * web page, so each guard must reject anything that is not exactly its
 * shape. For every guard, from one valid sample:
 *   - every required field missing -> rejected
 *   - every field with the wrong type -> rejected
 *   - every other guard's valid sample -> rejected (no type confusion)
 *   - non-objects -> rejected
 * plus the `onMessage` dispatcher's response rules, against a minimal
 * stand-in for chrome.runtime.onMessage.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isAreaCancelledMessage,
  isAreaSelectedMessage,
  isEntryAddedMessage,
  isEntryCreatedMessage,
  isMenuRunRequest,
  isMessage,
  isOffscreenCommitRequest,
  isOffscreenStartTabRequest,
  isOffscreenStartVoiceRequest,
  isOffscreenStopRequest,
  isRecorderFinishedMessage,
  isRecorderStoppedMessage,
  isRecorderToastMessage,
  isRecorderTranscriptMessage,
  isScreenshotNoteDraftMessage,
  isScreenshotNoteFinishMessage,
  isToastMessage,
  isVoiceOverlayDecisionMessage,
  isVoiceOverlayDraftMessage,
  isVoiceOverlayStopMessage,
  onMessage,
} from "./messages.js";

const page = { url: "http://localhost/", title: "App" };
const settings = { serverUrl: "http://127.0.0.1:4848", token: "", transcribe: true, keepAudio: false, microphoneId: "", microphoneLabel: "" };

interface GuardCase {
  guard: (value: unknown) => boolean;
  sample: Record<string, unknown>;
  /** Fields that may be absent. */
  optional?: string[];
  /**
   * Only checks that its nested objects are objects. entry-added is a
   * broadcast from the worker that only the side panel acts on, after
   * isTrustedExtensionSender; it carries the server's own Entry.
   */
  shallow?: boolean;
}

const CASES: Record<string, GuardCase> = {
  "area-selected": {
    guard: isAreaSelectedMessage,
    sample: { type: "area-selected", rect: { x: 0, y: 0, width: 10, height: 10 }, viewport: { width: 100, height: 100 }, devicePixelRatio: 1 },
  },
  "entry-added": { guard: isEntryAddedMessage, sample: { type: "entry-added", entry: { id: "e" }, session: { id: "s" } }, shallow: true },
  toast: { guard: isToastMessage, sample: { type: "toast", level: "error", message: "m", action: "open-permissions" }, optional: ["action"] },
  "recorder:toast": {
    guard: isRecorderToastMessage,
    sample: { type: "recorder:toast", level: "info", message: "m", action: "open-shortcuts" },
    optional: ["action"],
  },
  "entry-created": { guard: isEntryCreatedMessage, sample: { type: "entry-created", entry: { id: "e", seq: 1 }, session: { id: "s" } } },
  "menu:run": { guard: isMenuRunRequest, sample: { type: "menu:run", command: "toggle-voice", windowId: 3 } },
  "screenshot-note:finish": { guard: isScreenshotNoteFinishMessage, sample: { type: "screenshot-note:finish", id: "p1", note: "" } },
  "screenshot-note:draft": { guard: isScreenshotNoteDraftMessage, sample: { type: "screenshot-note:draft", id: "p1", draft: "half a thought" } },
  "recorder:stopped": { guard: isRecorderStoppedMessage, sample: { type: "recorder:stopped", recorder: "voice", id: "r1" } },
  "recorder:transcript": {
    guard: isRecorderTranscriptMessage,
    sample: { type: "recorder:transcript", recorder: "tab", id: "r1", final: "a", interim: "b", error: "e" },
    optional: ["error"],
  },
  "recorder:finished": {
    guard: isRecorderFinishedMessage,
    sample: { type: "recorder:finished", recorder: "voice", id: "r1", transcript: "t", error: "e" },
    optional: ["error"],
  },
  "offscreen:commit": { guard: isOffscreenCommitRequest, sample: { type: "offscreen:commit", id: "r1", save: true, transcript: "t" } },
  "offscreen:start-tab": {
    guard: isOffscreenStartTabRequest,
    sample: { type: "offscreen:start-tab", id: "r1", streamId: "s", page, settings },
  },
  "offscreen:start-voice": { guard: isOffscreenStartVoiceRequest, sample: { type: "offscreen:start-voice", id: "r1", page, settings } },
  "offscreen:stop": { guard: isOffscreenStopRequest, sample: { type: "offscreen:stop", recorder: "tab" } },
  "voice-overlay:stop": { guard: isVoiceOverlayStopMessage, sample: { type: "voice-overlay:stop", id: "r1" } },
  "voice-overlay:draft": { guard: isVoiceOverlayDraftMessage, sample: { type: "voice-overlay:draft", id: "r1", draft: { text: "t", heard: "h" } } },
  "voice-overlay:decision": { guard: isVoiceOverlayDecisionMessage, sample: { type: "voice-overlay:decision", id: "r1", save: false, text: "t" } },
};

/** A value of a different JSON type than `value`. */
function wrongType(value: unknown): unknown {
  if (typeof value === "string") return 42;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : 0;
  if (Array.isArray(value)) return "[]";
  if (typeof value === "object" && value !== null) return "object";
  return {};
}

const entries = Object.entries(CASES);

describe.each(entries)("guard for %s", (type, { guard, sample, optional = [], shallow = false }) => {
  it("accepts its sample, with and without optional fields, and is a known message", () => {
    expect(guard(sample)).toBe(true);
    const bare = Object.fromEntries(Object.entries(sample).filter(([k]) => !optional.includes(k)));
    expect(guard(bare)).toBe(true);
    expect(isMessage(sample)).toBe(true);
  });

  it.each(Object.keys(sample).filter((k) => !optional.includes(k)))("rejects it without %s", (key) => {
    const { [key]: _removed, ...rest } = sample;
    expect(guard(rest)).toBe(false);
  });

  it.each(Object.keys(sample))("rejects %s with the wrong type", (key) => {
    expect(guard({ ...sample, [key]: wrongType(sample[key]) })).toBe(false);
  });

  it.each(Object.keys(sample).filter((k) => !shallow && typeof sample[k] === "object"))("rejects nested %s fields with the wrong type", (key) => {
    const nested = sample[key] as Record<string, unknown>;
    for (const inner of Object.keys(nested)) {
      expect(guard({ ...sample, [key]: { ...nested, [inner]: wrongType(nested[inner]) } }), `${key}.${inner}`).toBe(false);
    }
  });

  it("rejects every other message's valid sample", () => {
    for (const [otherType, other] of entries) {
      if (otherType !== type) expect(guard(other.sample), otherType).toBe(false);
    }
  });

  it("rejects non-objects and arrays", () => {
    for (const value of [undefined, null, 0, "x", true, [sample], [type]]) expect(guard(value)).toBe(false);
  });
});

describe("guards: bounds on strings coming from web pages", () => {
  it("ids are 1-100 characters", () => {
    expect(isVoiceOverlayStopMessage({ type: "voice-overlay:stop", id: "" })).toBe(false);
    expect(isVoiceOverlayStopMessage({ type: "voice-overlay:stop", id: "x".repeat(100) })).toBe(true);
    expect(isVoiceOverlayStopMessage({ type: "voice-overlay:stop", id: "x".repeat(101) })).toBe(false);
  });

  it("transcript text is capped at 100k characters", () => {
    const decision = (text: string) => ({ type: "voice-overlay:decision", id: "r1", save: true, text });
    expect(isVoiceOverlayDecisionMessage(decision("x".repeat(100_000)))).toBe(true);
    expect(isVoiceOverlayDecisionMessage(decision("x".repeat(100_001)))).toBe(false);
    const draft = (text: string, heard: string) => ({ type: "voice-overlay:draft", id: "r1", draft: { text, heard } });
    expect(isVoiceOverlayDraftMessage(draft("x".repeat(100_001), ""))).toBe(false);
    expect(isVoiceOverlayDraftMessage(draft("", "x".repeat(100_001)))).toBe(false);
  });

  it("area selections need positive, finite sizes and pixel ratios", () => {
    const area = CASES["area-selected"]!.sample;
    for (const bad of [
      { rect: { x: 0, y: 0, width: 0, height: 10 } },
      { rect: { x: 0, y: 0, width: 10, height: -1 } },
      { rect: { x: Number.NaN, y: 0, width: 10, height: 10 } },
      { rect: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 } },
      { viewport: { width: 0, height: 100 } },
      { devicePixelRatio: 0 },
      { devicePixelRatio: Number.NaN },
    ]) {
      expect(isAreaSelectedMessage({ ...area, ...bad }), JSON.stringify(bad)).toBe(false);
    }
  });

  it("windowIds must be integers", () => {
    expect(isMenuRunRequest({ type: "menu:run", command: "screenshot-area", windowId: 1.5 })).toBe(false);
    expect(isMenuRunRequest({ type: "menu:run", command: "toggle-voice", windowId: Number.NaN })).toBe(false);
  });

  it("the area-cancelled message has no payload to check, but still needs its type", () => {
    expect(isAreaCancelledMessage({ type: "area-cancelled" })).toBe(true);
    expect(isAreaCancelledMessage({ type: "area-selected" })).toBe(false);
  });
});

describe("onMessage (the dispatcher's response rules)", () => {
  type Listener = (raw: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;
  let listeners: Listener[] = [];

  function install() {
    listeners = [];
    vi.stubGlobal("chrome", {
      runtime: {
        onMessage: {
          addListener: (l: Listener) => listeners.push(l),
          removeListener: (l: Listener) => (listeners = listeners.filter((x) => x !== l)),
        },
      },
    });
  }
  afterEach(() => vi.unstubAllGlobals());

  function deliver(raw: unknown): { keepOpen: boolean; response: Promise<unknown>; sendResponse: ReturnType<typeof vi.fn> } {
    let resolve!: (r: unknown) => void;
    const response = new Promise((r) => (resolve = r));
    const sendResponse = vi.fn((r: unknown) => resolve(r));
    const keepOpen = listeners[0]!(raw, { id: "ext" }, sendResponse);
    return { keepOpen, response, sendResponse };
  }

  it("ignores anything that is not one of our messages, without calling the handler", () => {
    install();
    const handler = vi.fn(() => ({ ok: true }));
    onMessage(handler);
    for (const raw of [null, "toast", { type: "evil" }, { type: 1 }]) {
      const { keepOpen, sendResponse } = deliver(raw);
      expect(keepOpen).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("a synchronous result is sent right away", async () => {
    install();
    onMessage(() => ({ ok: true, n: 1 }));
    const { keepOpen, response } = deliver({ type: "server-info:refresh" });
    expect(keepOpen).toBe(false);
    expect(await response).toEqual({ ok: true, n: 1 });
  });

  it("undefined means 'not mine': no response, so another context can answer", () => {
    install();
    onMessage(() => undefined);
    const { keepOpen, sendResponse } = deliver({ type: "server-info:refresh" });
    expect(keepOpen).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("a Promise keeps the channel open and sends what it resolves to", async () => {
    install();
    onMessage(async () => ({ ok: true, later: true }));
    const { keepOpen, response } = deliver({ type: "server-info:refresh" });
    expect(keepOpen).toBe(true);
    expect(await response).toEqual({ ok: true, later: true });
  });

  it("a throw or a rejection becomes { ok: false, error }", async () => {
    install();
    onMessage(() => {
      throw new Error("sync boom");
    });
    expect(await deliver({ type: "server-info:refresh" }).response).toEqual({ ok: false, error: "sync boom" });

    install();
    onMessage(async () => Promise.reject(new Error("async boom")));
    const rejected = deliver({ type: "server-info:refresh" });
    expect(rejected.keepOpen).toBe(true);
    expect(await rejected.response).toEqual({ ok: false, error: "async boom" });
  });

  it("returns a function that removes the listener", () => {
    install();
    const off = onMessage(() => ({ ok: true }));
    expect(listeners).toHaveLength(1);
    off();
    expect(listeners).toHaveLength(0);
  });
});
