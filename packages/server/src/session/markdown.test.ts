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
      note: "Coupon field accepts whitespace-only input.",
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

  it("renders a note entry's words once, as the body (no blockquote)", () => {
    const out = renderEntry({
      ...meta,
      seq: 2,
      kind: "note",
      capturedAt: local(7, 54, 1).toISOString(),
      page,
      note: "once",
    });
    expect(out.match(/once/g)).toHaveLength(1);
    expect(out).not.toContain(">");
  });

  it("renders a screenshot without a note as just the image", () => {
    const out = renderEntry({
      ...meta,
      seq: 1,
      kind: "screenshot",
      capturedAt: local(7, 53, 12).toISOString(),
      page,
      file: "001-screenshot.png",
      mode: "viewport",
      width: 1,
      height: 1,
    });
    expect(out.endsWith("![Screenshot 1](./001-screenshot.png)\n\n")).toBe(true);
  });

  it("renders a voice note with audio and its note", () => {
    const entry: Entry = {
      ...meta,
      seq: 3,
      kind: "voice-note",
      capturedAt: local(7, 55, 40).toISOString(),
      page: { url: "http://localhost:5173/cart", title: "Cart – My App" },
      file: "003-voice-note.webm",
      note: "the quantity stepper jumps by two when I click fast.",
      durationMs: 12_000,
    };
    expect(renderEntry(entry)).toBe(
      [
        "## 3. Voice note · 07:55:40",
        "Page: [Cart – My App](http://localhost:5173/cart)",
        "",
        "🎙 [audio](./003-voice-note.webm) (0:12)",
        "",
        "> the quantity stepper jumps by two when I click fast.",
        "",
        "",
      ].join("\n"),
    );
  });

  it("renders a voice note without audio", () => {
    const entry: Entry = {
      ...meta,
      seq: 4,
      kind: "voice-note",
      capturedAt: local(7, 56, 0).toISOString(),
      page,
      note: "hello",
      durationMs: 3_000,
    };
    expect(renderEntry(entry)).toContain("🎙 (0:03)\n\n> hello\n");
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
    expect(renderEntry(entry)).not.toContain(">");
  });

  it("renders a recording's narration under the link", () => {
    const entry: Entry = {
      ...meta,
      seq: 6,
      kind: "recording",
      capturedAt: local(7, 58, 0).toISOString(),
      page,
      file: "006-recording.webm",
      durationMs: 5_000,
      note: "the menu flickers\n# not a heading",
    };
    expect(renderEntry(entry)).toContain("🎬 [Recording 6](./006-recording.webm) (0:05)\n\n> the menu flickers\n> \\# not a heading\n");
  });

  describe("escaping user-controlled text", () => {
    const note = (overrides: Partial<Extract<Entry, { kind: "note" }>>): Entry => ({
      ...meta,
      seq: 7,
      kind: "note",
      capturedAt: local(9, 0, 0).toISOString(),
      page,
      note: "text",
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
      const out = renderEntry(note({ note: "![x](http://evil/p.png)\n## 8. Screenshot · 00:00:00\n<img src=x>" }));
      expect(out).toContain("!\\[x\\](http://evil/p.png)\n\\## 8. Screenshot · 00:00:00\n\\<img src=x\\>");
      expect(out.match(/^## /gm)).toHaveLength(1);
    });

    it("multi-line notes stay inside their blockquote", () => {
      const shot: Entry = {
        ...meta,
        seq: 8,
        kind: "screenshot",
        capturedAt: local(9, 0, 0).toISOString(),
        page,
        file: "008-screenshot.png",
        mode: "viewport",
        width: 1,
        height: 1,
        note: "line 1\n\n# not a heading\n> nested?",
      };
      expect(renderEntry(shot)).toContain("> line 1\n>\n> \\# not a heading\n> \\> nested?\n");
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

/**
 * Structural invariants for hostile notes: whatever the user (or a page,
 * via a dictated transcript) puts in `note`, the rendered entry must stay
 * one entry. These would catch a regression in escape.ts that the
 * example-based tests above happen not to exercise.
 */
describe("renderEntry: hostile notes keep the document's structure", () => {
  const HOSTILE_NOTES = [
    "## 9. Screenshot · 00:00:00\nfake entry",
    "  ### indented heading",
    "\t# tab-indented heading",
    "```\nunclosed fence swallowing the rest",
    "   ~~~js\nanother fence",
    "Title\n===",
    "Title\n---",
    "***",
    "- - -",
    "_ _ _",
    "<script>alert(1)</script>",
    "<!-- hide everything after this",
    "[x]: http://evil.example/ref-definition",
    "![pixel](http://evil.example/p.png)",
    "<http://evil.example/autolink>",
    "> pretend quote\n>> nested",
    "trailing backslash for a hard break \\\nnext",
    "\\[pre-escaped\\](http://evil.example)",
    "line\r\nwith\rmixed\nline endings",
    "paragraph one\n\n\n\nparagraph two",
    "  \n  \nleading blank lines",
    "rlo ‮evil.example‬ zero​width bom﻿",
    "nul \u0000 bell \u0007 esc \u001b[31m red",
  ];

  const base = { ...meta, seq: 9, capturedAt: local(9, 0, 0).toISOString(), page };
  const asNote = (note: string): Entry => ({ ...base, kind: "note", note });
  const asScreenshot = (note: string): Entry => ({
    ...base,
    kind: "screenshot",
    file: "009-screenshot.png",
    mode: "viewport",
    width: 1,
    height: 1,
    note,
  });

  function expectSafe(out: string): void {
    const lines = out.split("\n");
    // Exactly one heading: ours, on the first line.
    expect(lines.filter((l) => /^ {0,3}#{1,6}(\s|$)/.test(l))).toEqual([lines[0]]);
    // No code fence can open.
    expect(lines.some((l) => /^(\s*>)?\s*(```|~~~)/.test(l))).toBe(false);
    // No setext underline or thematic break made of user text.
    expect(lines.some((l) => /^(\s*>)?\s*([=*_-])[=*_ \t-]*$/.test(l) && l.trim() !== ">")).toBe(false);
    // Every <, [ and ] in user text is escaped (the Page: line is ours).
    for (const line of lines.slice(2)) {
      if (line.startsWith("![Screenshot 9](./009-screenshot.png)")) continue;
      expect(line, line).not.toMatch(/(^|[^\\])[<[\]]/);
    }
    // No control, zero-width or bidi characters survive.
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/);
    // The entry ends with a blank line, so the next one starts cleanly.
    expect(out.endsWith("\n\n")).toBe(true);
    expect(out.endsWith("\n\n\n")).toBe(false);
  }

  it.each(HOSTILE_NOTES)("as a note body: %j", (note) => {
    expectSafe(renderEntry(asNote(note)));
  });

  it.each(HOSTILE_NOTES)("as a screenshot's blockquote: %j", (note) => {
    const out = renderEntry(asScreenshot(note));
    expectSafe(out);
    // Every line after the image is part of the quote.
    const quote = out.split("\n\n").slice(2).join("\n\n").replace(/\n+$/, "");
    for (const line of quote.split("\n")) expect(line, line).toMatch(/^>( |$)/);
  });

  it("keeps a very long note in full (no truncation)", () => {
    const note = Array.from({ length: 5_000 }, (_, i) => `line ${i} ${"word ".repeat(10)}`).join("\n");
    const out = renderEntry(asScreenshot(note));
    expect(out).toContain("> line 0 ");
    expect(out).toContain("> line 4999 ");
    expect(out.split("\n").filter((l) => l.startsWith("> line "))).toHaveLength(5_000);
  });

  it("keeps non-Latin text, combining marks and RTL scripts (only the override characters go)", () => {
    const note = "שלום عالم 日本語 café (é) 👍🏽";
    expect(renderEntry(asNote(note))).toContain(`\n${note}\n`);
  });

  it("renders a voice note that has only words (no audio) with its words", () => {
    const out = renderEntry({ ...base, kind: "voice-note", durationMs: 3_000, note: "spoken" });
    expect(out).toContain("🎙 (0:03)\n\n> spoken\n");
    expect(out).not.toContain("](./");
  });
});
