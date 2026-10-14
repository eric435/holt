/**
 * The Web Speech wrapper (shared/speech.ts), against a scripted fake
 * recogniser. The real API needs Chrome, a microphone and Google's speech
 * service, so it is only exercised by hand; but the wrapper's own logic is
 * what the rest of the extension relies on:
 *   - `final` only ever grows, across Chrome's automatic restarts
 *     (shared/transcript-text.ts appends to the user's edits on that basis);
 *   - restarts happen after Chrome ends a "continuous" session by itself,
 *     but not after a fatal error or stop();
 *   - stop() waits a moment for the last results, and always resolves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSpeechRecognition, type TranscriptUpdate } from "./speech.js";

interface Result {
  isFinal: boolean;
  0: { transcript: string };
}

/** Every recogniser the code under test created, newest last. */
let instances: FakeRecognition[] = [];

class FakeRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((e: { results: ArrayLike<Result> }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  starts: (unknown[])[] = [];
  stops = 0;
  /** Behave like a Chrome that knows start(track) but refuses this track. */
  static rejectTrack = false;

  constructor() {
    instances.push(this);
  }
  start(...args: unknown[]): void {
    if (args.length > 0 && FakeRecognition.rejectTrack) throw new TypeError("parameter 1 is not of type 'MediaStreamTrack'");
    this.starts.push(args);
  }
  stop(): void {
    this.stops++;
  }

  // --- scripting helpers ---
  results(...items: [string, boolean][]): void {
    this.onresult?.({ results: items.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })) });
  }
  end(): void {
    this.onend?.();
  }
  error(code: string): void {
    this.onerror?.({ error: code });
  }
}

const track = { kind: "audio" } as unknown as MediaStreamTrack;
const describeError = (code: string) => `failed: ${code}`;

let updates: TranscriptUpdate[];
const onTranscript = (u: TranscriptUpdate) => updates.push(u);
const finals = () => updates.map((u) => u.final);

beforeEach(() => {
  instances = [];
  updates = [];
  vi.stubGlobal("window", { webkitSpeechRecognition: FakeRecognition });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("startSpeechRecognition", () => {
  it("reports an error right away when the browser has no speech recognition", async () => {
    vi.stubGlobal("window", {});
    const t = startSpeechRecognition(onTranscript, track, describeError);
    expect(updates).toEqual([{ final: "", interim: "", error: "Speech recognition is not available in this browser." }]);
    expect(await t.stop()).toEqual({ text: "", error: "Speech recognition is not available in this browser." });
  });

  it("starts a continuous, interim recogniser on the selected microphone's track", () => {
    startSpeechRecognition(onTranscript, track, describeError);
    const r = instances[0]!;
    expect([r.continuous, r.interimResults]).toEqual([true, true]);
    expect(r.lang).toBeTruthy();
    expect(r.starts).toEqual([[track]]);
  });

  it("falls back to plain start() (the default microphone) if the track is refused, and keeps doing so", () => {
    FakeRecognition.rejectTrack = true;
    try {
      startSpeechRecognition(onTranscript, track, describeError);
      const r = instances[0]!;
      expect(r.starts).toEqual([[]]);
      r.end(); // Chrome ends the session by itself: restart, again without the track
      expect(r.starts).toEqual([[], []]);
    } finally {
      FakeRecognition.rejectTrack = false;
    }
  });

  it("splits final and interim text, and `final` only grows across automatic restarts", () => {
    startSpeechRecognition(onTranscript, track, describeError);
    const r = instances[0]!;
    r.results(["the menu", false]);
    r.results(["the menu", true], [" flick", false]);
    r.results(["the menu", true], [" flickers", true]);
    r.end(); // silence: Chrome ends; the wrapper restarts, results start over
    expect(r.starts).toHaveLength(2);
    r.results(["on hover", false]);
    r.results(["on hover", true]);

    expect(updates.map((u) => u.interim)).toEqual(["the menu", "flick", "", "on hover", ""]);
    expect(finals()).toEqual(["", "the menu", "the menu flickers", "the menu flickers", "the menu flickers on hover"]);
    for (let i = 1; i < updates.length; i++) expect(finals()[i]!.startsWith(finals()[i - 1]!)).toBe(true);
  });

  it("ignores routine errors and keeps going", () => {
    startSpeechRecognition(onTranscript, track, describeError);
    const r = instances[0]!;
    r.error("no-speech");
    r.error("aborted");
    expect(updates).toEqual([]);
    r.end();
    expect(r.starts).toHaveLength(2);
  });

  it("reports a fatal error immediately, with what was recognised so far, and does not restart", async () => {
    const t = startSpeechRecognition(onTranscript, track, describeError);
    const r = instances[0]!;
    r.results(["kept", true]);
    r.error("network");
    expect(updates.at(-1)).toEqual({ final: "kept", interim: "", error: "failed: network" });
    r.end();
    expect(r.starts).toHaveLength(1);
    // stop() after a fatal error resolves at once.
    expect(await t.stop()).toEqual({ text: "kept", error: "failed: network" });
  });

  it("a non-fatal error is reported but recognition restarts", () => {
    startSpeechRecognition(onTranscript, track, describeError);
    const r = instances[0]!;
    r.error("bad-grammar");
    expect(updates.at(-1)?.error).toBe("failed: bad-grammar");
    r.end();
    expect(r.starts).toHaveLength(2);
  });

  it("stop() includes results that arrive before the recogniser ends", async () => {
    const t = startSpeechRecognition(onTranscript, track, describeError);
    const r = instances[0]!;
    r.results(["first", true]);
    const done = t.stop();
    expect(r.stops).toBe(1);
    r.results(["first", true], [" last words", true]);
    r.end();
    expect(await done).toEqual({ text: "first last words" });
    expect(r.starts).toHaveLength(1); // no restart after stop()
  });

  it("stop() resolves after a grace period even if the recogniser never ends", async () => {
    const t = startSpeechRecognition(onTranscript, track, describeError);
    instances[0]!.results(["hello", true]);
    const done = t.stop();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await done).toEqual({ text: "hello" });
  });

  it("reports a recogniser that cannot start at all", async () => {
    const Broken = class extends FakeRecognition {
      override start(): void {
        throw new Error("already started");
      }
    };
    vi.stubGlobal("window", { SpeechRecognition: Broken });
    const t = startSpeechRecognition(onTranscript, undefined, describeError);
    expect(updates).toEqual([{ final: "", interim: "", error: "Speech recognition could not start: already started" }]);
    expect(await t.stop()).toEqual({ text: "", error: "Speech recognition could not start: already started" });
  });
});
