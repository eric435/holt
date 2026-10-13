import type { Entry } from "@holt/protocol";
import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatLocalIso,
  renderEntry,
  renderFooter,
  renderHeader,
} from "./markdown.js";

// Build timestamps from local components so the tests pass in any time zone.
const local = (h: number, m: number, s: number) => new Date(2026, 9, 13, h, m, s);

const page = { url: "http://localhost:5173/checkout", title: "Checkout – My App" };
const meta = { id: "id-1", receivedAt: "2026-10-13T14:53:13.000Z" };

describe("renderHeader", () => {
  it("renders the documented header", () => {
    const startedAt = local(7, 52, 0);
    expect(renderHeader({ title: "QA session", startedAt, root: "/Users/you/app" })).toBe(
      [
        "# QA session 2026-10-13 07:52",
        "",
        `- Started: ${formatLocalIso(startedAt)}`,
        "- Project: /Users/you/app",
        "",
        "---",
        "",
        "",
      ].join("\n"),
    );
  });

  it("escapes the title and keeps it on one line", () => {
    // After newlines collapse, the "#" is mid-line and harmless.
    const header = renderHeader({ title: "x](http://evil)\n# y", startedAt: local(7, 52, 0), root: "/r" });
    expect(header.split("\n")[0]).toBe("# x\\](http://evil) # y 2026-10-13 07:52");
  });
});

describe("formatLocalIso", () => {
  it("includes the local UTC offset", () => {
    expect(formatLocalIso(local(7, 52, 0))).toMatch(/^2026-10-13T07:52:00[+-]\d{2}:\d{2}$/);
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0:00"],
    [12_000, "0:12"],
    [12_400, "0:12"],
    [65_000, "1:05"],
    [3_723_000, "1:02:03"],
  ])("%d ms -> %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("renderEntry", () => {
  it("renders a screenshot with its note", () => {
    const entry: Entry = {
      ...meta,
      seq: 1,
      kind: "screenshot",
      capturedAt: local(7, 53, 12).toISOString(),
      page,
      file: "001-screenshot.png",
      mode: "viewport",
      width: 1280,
      height: 800,
      note: "Submit button overlaps the footer on narrow widths.",
    };
    expect(renderEntry(entry)).toBe(
      [
        "## 1. Screenshot · 07:53:12",
        "Page: [Checkout – My App](http://localhost:5173/checkout)",
        "",
        "![Screenshot 1](./001-screenshot.png)",
        "",
        "> Submit button overlaps the footer on narrow widths.",
        "",
        "",
      ].join("\n"),
    );
  });

  it("labels full-page and area screenshots", () => {
    const base = {
      ...meta,
      seq: 2,
      kind: "screenshot" as const,
      capturedAt: local(8, 0, 0).toISOString(),
      page,
      file: "002-screenshot.png",
      width: 1,
      height: 1,
    };
    expect(renderEntry({ ...base, mode: "full-page" })).toMatch(/^## 2\. Screenshot \(full page\) · 08:00:00\n/);
    expect(renderEntry({ ...base, mode: "area" })).toMatch(/^## 2\. Screenshot \(area\) · /);
  });

  it("renders a note entry as a paragraph", () => {
    const entry: Entry = {
      ...meta,
      seq: 2,
      kind: "note",
      capturedAt: local(7, 54, 1).toISOString(),
      page,
      text: "Coupon field accepts whitespace-only input.",
    };
    expect(renderEntry(entry)).toBe(
      [
        "## 2. Note · 07:54:01",
        "Page: [Checkout – My App](http://localhost:5173/checkout)",
        "",
        "Coupon field accepts whitespace-only input.",
        "",
        "",
      ].join("\n"),
    );
  });

  it("renders a voice note with audio and transcript", () => {
    const entry: Entry = {
      ...meta,
      seq: 3,
      kind: "voice-note",
      capturedAt: local(7, 55, 40).toISOString(),
      page: { url: "http://localhost:5173/cart", title: "Cart – My App" },
      file: "003-voice-note.webm",
      transcript: "the quantity stepper jumps by two when I click fast.",
      durationMs: 12_000,
    };
    expect(renderEntry(entry)).toBe(
      [
        "## 3. Voice note · 07:55:40",
        "Page: [Cart – My App](http://localhost:5173/cart)",
        "",
        "🎙 [audio](./003-voice-note.webm) (0:12)",
        "",
        "> Transcript: the quantity stepper jumps by two when I click fast.",
        "",
        "",
      ].join("\n"),
    );
  });

  it("renders a transcript-only voice note", () => {
    const entry: Entry = {
      ...meta,
      seq: 4,
      kind: "voice-note",
      capturedAt: local(7, 56, 0).toISOString(),
      page,
      transcript: "hello",
      durationMs: 3_000,
    };
    expect(renderEntry(entry)).toContain("🎙 (0:03, transcript only)\n\n> Transcript: hello\n");
  });

  it("renders a recording", () => {
    const entry: Entry = {
      ...meta,
      seq: 5,
      kind: "recording",
      capturedAt: local(7, 57, 0).toISOString(),
      page,
      file: "005-recording.webm",
      durationMs: 42_000,
    };
    expect(renderEntry(entry)).toContain("## 5. Recording · 07:57:00\n");
    expect(renderEntry(entry)).toContain("🎬 [Recording 5](./005-recording.webm) (0:42)");
  });

  describe("escaping user-controlled text", () => {
    const note = (overrides: Partial<Extract<Entry, { kind: "note" }>>): Entry => ({
      ...meta,
      seq: 7,
      kind: "note",
      capturedAt: local(9, 0, 0).toISOString(),
      page,
      text: "text",
      ...overrides,
    });

    it("a malicious page title cannot close the link and inject its own", () => {
      const out = renderEntry(note({ page: { url: "http://localhost/", title: "](http://evil) ![x](http://evil/p.png" } }));
      expect(out).toContain("Page: [\\](http://evil) !\\[x\\](http://evil/p.png](http://localhost/)");
    });

    it("a URL with ) or spaces cannot end the link destination early", () => {
      const out = renderEntry(note({ page: { url: "http://localhost/a) [x](http://evil", title: "T" } }));
      expect(out).toContain("Page: [T](http://localhost/a%29%20%5Bx%5D%28http://evil)");
    });

    it("non-http URLs are shown as text, not linked", () => {
      const out = renderEntry(note({ page: { url: "javascript:alert(1)", title: "Click me" } }));
      expect(out).toContain("Page: Click me — javascript:alert(1)\n");
      expect(out).not.toContain("](javascript");
    });

    it("falls back to the URL as link text when the title is empty", () => {
      expect(renderEntry(note({ page: { url: "http://localhost/x", title: "" } }))).toContain(
        "Page: [http://localhost/x](http://localhost/x)",
      );
    });

    it("note text cannot inject images, HTML, or fake entry headings", () => {
      const out = renderEntry(note({ text: "![x](http://evil/p.png)\n## 8. Screenshot · 00:00:00\n<img src=x>" }));
      expect(out).toContain("!\\[x\\](http://evil/p.png)\n\\## 8. Screenshot · 00:00:00\n\\<img src=x\\>");
      expect(out.match(/^## /gm)).toHaveLength(1);
    });

    it("multi-line notes stay inside their blockquote", () => {
      const out = renderEntry(note({ note: "line 1\n\n# not a heading\n> nested?" }));
      expect(out).toContain("> line 1\n>\n> \\# not a heading\n> \\> nested?\n");
    });
  });
});

describe("renderFooter", () => {
  it("renders the end marker with an entry count", () => {
    const endedAt = local(8, 10, 0);
    expect(renderFooter(endedAt, 5)).toBe(`---\n\n_Session ended at ${formatLocalIso(endedAt)} (5 entries)._\n`);
    expect(renderFooter(endedAt, 1)).toContain("(1 entry)");
    expect(renderFooter(endedAt, 0)).toBe(`_Session ended at ${formatLocalIso(endedAt)} (0 entries)._\n`);
  });
});
