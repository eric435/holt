import type { Entry } from "@holt/protocol";
import { describe, expect, it } from "vitest";
import { entryView, formatDuration } from "./entry-view.js";

const base = {
  id: "e",
  receivedAt: "2026-10-13T14:53:13.000Z",
  capturedAt: "2026-10-13T14:53:12.000Z",
  page: { url: "http://localhost:5173/checkout", title: "Checkout" },
};

describe("entryView", () => {
  it("screenshot: page, file and size, and its note", () => {
    const entry: Entry = { ...base, seq: 1, kind: "screenshot", file: "001-screenshot.png", mode: "area", width: 640, height: 480, note: " Overlaps the footer " };
    expect(entryView(entry)).toEqual({
      title: "#1 Screenshot (area)",
      page: "Checkout",
      pageUrl: "http://localhost:5173/checkout",
      media: "001-screenshot.png · 640×480",
      note: "Overlaps the footer",
    });
  });

  it("screenshot without a note", () => {
    const entry: Entry = { ...base, seq: 2, kind: "screenshot", file: "002-screenshot.png", mode: "viewport", width: 1, height: 1 };
    expect(entryView(entry)).toMatchObject({ title: "#2 Screenshot", note: null });
  });

  it("recording: file and duration, narration as the note", () => {
    const entry: Entry = { ...base, seq: 3, kind: "recording", file: "003-recording.webm", durationMs: 42_000, note: "the menu flickers" };
    expect(entryView(entry)).toMatchObject({ title: "#3 Recording", media: "003-recording.webm · 0:42", note: "the menu flickers" });
  });

  it("voice note with and without its audio", () => {
    const withAudio: Entry = { ...base, seq: 4, kind: "voice-note", file: "004-voice-note.webm", durationMs: 12_000, note: "hello" };
    expect(entryView(withAudio)).toMatchObject({ media: "004-voice-note.webm · 0:12", note: "hello" });
    const wordsOnly: Entry = { ...base, seq: 5, kind: "voice-note", durationMs: 3_000, note: "hello" };
    expect(entryView(wordsOnly)).toMatchObject({ media: "0:03 · audio not kept", note: "hello" });
  });

  it("note: no media, the words are the note", () => {
    const entry: Entry = { ...base, seq: 6, kind: "note", note: "Coupon accepts spaces" };
    expect(entryView(entry)).toMatchObject({ title: "#6 Note", media: null, note: "Coupon accepts spaces" });
  });

  it("falls back to the URL when the page has no title", () => {
    const entry: Entry = { ...base, page: { url: "http://localhost/x", title: "" }, seq: 7, kind: "note", note: "x" };
    expect(entryView(entry).page).toBe("http://localhost/x");
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0:00"],
    [12_400, "0:12"],
    [65_000, "1:05"],
    [3_723_000, "1:02:03"],
  ])("%d ms -> %s", (ms, text) => expect(formatDuration(ms)).toBe(text));
});
