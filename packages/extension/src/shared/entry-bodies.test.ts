/**
 * The bodies themselves. That the server accepts every one of them as is
 * (and keeps every field) is the protocol contract test's job, against the
 * real server: packages/server/src/http/extension-contract.test.ts.
 */
import { ENTRY_FIELD_LIMITS } from "@holt/protocol";
import { describe, expect, it } from "vitest";
import { noteText, quickNoteEntry, recordingEntry, voiceNoteEntry } from "./entry-bodies.js";

const page = { url: "http://localhost:5173/checkout", title: "Checkout" };
const base = { capturedAt: "2026-10-13T14:53:12.000Z", page, durationMs: 4_200 };

describe("noteText", () => {
  it("trims and keeps within the server's limit", () => {
    expect(noteText("  hi \n")).toBe("hi");
    expect(noteText("x".repeat(ENTRY_FIELD_LIMITS.note + 1))).toHaveLength(ENTRY_FIELD_LIMITS.note);
  });
});

describe("recordingEntry", () => {
  it("carries the narration as the note", () => {
    expect(recordingEntry(base, "002-recording.webm", " It froze here ")).toEqual({
      kind: "recording",
      capturedAt: base.capturedAt,
      page,
      file: "002-recording.webm",
      durationMs: 4_200,
      note: "It froze here",
    });
  });

  it("leaves the note out without narration", () => {
    expect(recordingEntry(base, "002-recording.webm", "  ")).not.toHaveProperty("note");
  });
});

describe("voiceNoteEntry", () => {
  it("audio and transcript", () => {
    expect(voiceNoteEntry(base, "003-voice-note.webm", "words")).toEqual({ kind: "voice-note", capturedAt: base.capturedAt, page, file: "003-voice-note.webm", durationMs: 4_200, note: "words" });
  });

  it("audio only, or transcript only", () => {
    expect(voiceNoteEntry(base, "003-voice-note.webm", " ")).toEqual({ kind: "voice-note", capturedAt: base.capturedAt, page, file: "003-voice-note.webm", durationMs: 4_200 });
    expect(voiceNoteEntry(base, undefined, "words")).toEqual({ kind: "voice-note", capturedAt: base.capturedAt, page, durationMs: 4_200, note: "words" });
  });
});

describe("quickNoteEntry", () => {
  it("is the trimmed note on its page", () => {
    expect(quickNoteEntry(page, " Coupon field \n", base.capturedAt)).toEqual({ kind: "note", capturedAt: base.capturedAt, page, note: "Coupon field" });
  });
});
