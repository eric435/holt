/**
 * The side panel's entry list says it mirrors notes.md
 * (server/src/session/markdown.ts). The two are separate code in separate
 * packages, so this compares them directly: same label per kind and mode,
 * same duration text. If one changes without the other, this fails.
 */
import type { Entry } from "@holt/protocol";
import { describe, expect, it } from "vitest";
import { formatDuration as serverDuration, renderEntry } from "../../../server/src/session/markdown.js";
import { entryView, formatDuration } from "./entry-view.js";

const base = {
  id: "e",
  seq: 4,
  receivedAt: "2026-10-13T14:53:13.000Z",
  capturedAt: "2026-10-13T14:53:12.000Z",
  page: { url: "http://localhost:5173/checkout", title: "Checkout" },
};

const ENTRIES: Entry[] = [
  { ...base, kind: "screenshot", file: "004-screenshot.png", mode: "viewport", width: 1, height: 1 },
  { ...base, kind: "screenshot", file: "004-screenshot.png", mode: "full-page", width: 1, height: 1 },
  { ...base, kind: "screenshot", file: "004-screenshot.png", mode: "area", width: 1, height: 1 },
  { ...base, kind: "recording", file: "004-recording.webm", durationMs: 42_000 },
  { ...base, kind: "voice-note", durationMs: 1_000, note: "words" },
  { ...base, kind: "note", note: "words" },
];

describe("side panel entry list vs notes.md", () => {
  it.each(ENTRIES.map((e) => [e.kind === "screenshot" ? `screenshot (${e.mode})` : e.kind, e] as const))(
    "%s has the same label in both",
    (_name, entry) => {
      const heading = renderEntry(entry).split("\n")[0] ?? "";
      const markdownLabel = /^## \d+\. (.*) · /.exec(heading)?.[1];
      const panelLabel = entryView(entry).title.replace(/^#\d+ /, "");
      expect(panelLabel).toBe(markdownLabel);
    },
  );

  it.each([0, 400, 499, 500, 12_400, 59_499, 59_500, 65_000, 3_599_500, 3_600_000, 3_723_000, 36_000_000, -5_000])(
    "formats %d ms the same way",
    (ms) => {
      expect(formatDuration(ms)).toBe(serverDuration(ms));
    },
  );
});
