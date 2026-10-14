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
  const PAGE = "Page: [Checkout – My App](http://localhost:5173/checkout)";

  it("renders a screenshot as one line: note, image, page", () => {
    const entry: Entry = {
      ...meta,
      seq: 1,
      kind: "screenshot",
      capturedAt: local(7, 53, 12).toISOString(),
      page,
      file: "001-screenshot.png",
      mode: "area",
      width: 1280,
      height: 800,
      note: "Submit button overlaps the footer on narrow widths.",
    };
    expect(renderEntry(entry)).toBe(
      `- Submit button overlaps the footer on narrow widths. ![Screenshot 1](./001-screenshot.png) ${PAGE}\n`,
    );
  });

  it("has no heading, number, time, kind label or icon", () => {
    const out = renderEntry({
      ...meta,
      seq: 2,
      kind: "screenshot",
      capturedAt: local(8, 0, 0).toISOString(),
      page,
      file: "002-screenshot.png",
      mode: "full-page",
      width: 1,
      height: 1,
    });
    expect(out).not.toMatch(/^#|08:00|full page|🎙|🎬/m);
  });

  it("ends the note with a full stop when it stops on a letter or digit", () => {
    const withNote = (note: string) =>
      renderEntry({ ...meta, seq: 2, kind: "note", capturedAt: local(7, 54, 1).toISOString(), page, note });
    expect(withNote("checking the velvet Thunder screenshot")).toBe(`- checking the velvet Thunder screenshot. ${PAGE}\n`);
    expect(withNote("total shows 42")).toBe(`- total shows 42. ${PAGE}\n`);
    expect(withNote("why is this here?")).toBe(`- why is this here? ${PAGE}\n`);
    expect(withNote("steps:")).toBe(`- steps: ${PAGE}\n`);
    // "- 2026." would start a numbered list inside the item.
    expect(withNote("2026")).toBe(`- 2026 ${PAGE}\n`);
  });

  it("renders a note entry as its words and the page", () => {
    const entry: Entry = {
      ...meta,
      seq: 2,
      kind: "note",
      capturedAt: local(7, 54, 1).toISOString(),
      page,
      note: "Coupon field accepts whitespace-only input.",
    };
    expect(renderEntry(entry)).toBe(`- Coupon field accepts whitespace-only input. ${PAGE}\n`);
  });

  it("renders a screenshot without a note as the image and the page", () => {
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
    expect(out).toBe(`- ![Screenshot 1](./001-screenshot.png) ${PAGE}\n`);
  });

  it("renders a voice note with audio and its note", () => {
    const entry: Entry = {
      ...meta,
      seq: 3,
      kind: "voice-note",
      capturedAt: local(7, 55, 40).toISOString(),
      page: { url: "http://localhost:5173/cart", title: "Cart – My App" },
      file: "003-voice-note.webm",
      note: "the quantity stepper jumps by two when I click fast",
      durationMs: 12_000,
    };
    expect(renderEntry(entry)).toBe(
      "- the quantity stepper jumps by two when I click fast. [audio](./003-voice-note.webm) (0:12) " +
        "Page: [Cart – My App](http://localhost:5173/cart)\n",
    );
  });

  it("renders a voice note without audio as just its words", () => {
    const entry: Entry = {
      ...meta,
      seq: 4,
      kind: "voice-note",
      capturedAt: local(7, 56, 0).toISOString(),
      page,
      note: "hello",
      durationMs: 3_000,
    };
    expect(renderEntry(entry)).toBe(`- hello. ${PAGE}\n`);
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
    expect(renderEntry(entry)).toBe(`- [Recording 5](./005-recording.webm) (0:42) ${PAGE}\n`);
  });

  it("indents a multi-line note under its item, with the links on their own line", () => {
    const entry: Entry = {
      ...meta,
      seq: 6,
      kind: "recording",
      capturedAt: local(7, 58, 0).toISOString(),
      page,
      file: "006-recording.webm",
      durationMs: 5_000,
      note: "the menu flickers\n\n# not a heading",
    };
    expect(renderEntry(entry)).toBe(
      `- the menu flickers\n\n  \\# not a heading.\n  [Recording 6](./006-recording.webm) (0:05) ${PAGE}\n`,
    );
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

    it("note text cannot inject images, HTML, or headings", () => {
      const out = renderEntry(note({ note: "![x](http://evil/p.png)\n## 8. Screenshot · 00:00:00\n<img src=x>" }));
      expect(out).toContain("- !\\[x\\](http://evil/p.png)\n  \\## 8. Screenshot · 00:00:00\n  \\<img src=x\\>");
      expect(out.match(/^ {0,3}#/gm)).toBeNull();
    });

    it("multi-line notes stay inside their list item", () => {
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
      expect(renderEntry(shot)).toBe(
        `- line 1\n\n  \\# not a heading\n  \\> nested?\n  ![Screenshot 8](./008-screenshot.png) ${PAGE}\n`,
      );
    });
  });
});

describe("renderFooter", () => {
  it("renders the end marker with an entry count", () => {
    const endedAt = local(8, 10, 0);
    expect(renderFooter(endedAt, 5)).toBe(`\n---\n\n_Session ended at ${formatLocalIso(endedAt)} (5 entries)._\n`);
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

  // Our own links, which may contain [ and ]; everything else is user text.
  const OURS = /!\[Screenshot 9\]\(\.\/009-screenshot\.png\)|Page: \[Checkout – My App\]\(http:\/\/localhost:5173\/checkout\)/g;

  function expectSafe(out: string): void {
    const lines = out.replace(/\n$/, "").split("\n");
    // One list item: ours, on the first line. Every other line is blank or indented under it.
    expect(lines[0]).toMatch(/^- /);
    for (const line of lines.slice(1)) expect(line, line).toMatch(/^($|  )/);
    // No heading at all.
    expect(lines.filter((l) => /^\s*#{1,6}(\s|$)/.test(l))).toEqual([]);
    // No code fence can open.
    expect(lines.some((l) => /^(- )?\s*(```|~~~)/.test(l))).toBe(false);
    // No setext underline or thematic break made of user text.
    expect(lines.some((l) => /^(- )?\s*([=*_-])[=*_ \t-]*$/.test(l))).toBe(false);
    // Every <, [ and ] in user text is escaped.
    for (const line of lines) {
      expect(line.replace(OURS, ""), line).not.toMatch(/(^|[^\\])[<[\]]/);
    }
    // No control, zero-width or bidi characters survive.
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/);
    // The entry ends with exactly one newline, so the next item starts cleanly.
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  }

  it.each(HOSTILE_NOTES)("as a note body: %j", (note) => {
    expectSafe(renderEntry(asNote(note)));
  });

  it.each(HOSTILE_NOTES)("as a screenshot's note: %j", (note) => {
    const out = renderEntry(asScreenshot(note));
    expectSafe(out);
    // The image and page close the item: on the last line, after the words.
    expect(out).toMatch(/!\[Screenshot 9\]\(\.\/009-screenshot\.png\) Page: \[[^\n]*\n$/);
  });

  it("keeps a very long note in full (no truncation)", () => {
    const note = Array.from({ length: 5_000 }, (_, i) => `line ${i} ${"word ".repeat(10)}`).join("\n");
    const out = renderEntry(asScreenshot(note));
    expect(out).toContain("- line 0 ");
    expect(out).toContain("\n  line 4999 ");
    expect(out.split("\n").filter((l) => /^(- |  )line /.test(l))).toHaveLength(5_000);
  });

  it("keeps non-Latin text, combining marks and RTL scripts (only the override characters go)", () => {
    const note = "שלום عالم 日本語 café (é) 👍🏽";
    expect(renderEntry(asNote(note))).toContain(`- ${note} Page: `);
  });

  it("renders a voice note that has only words (no audio) with its words", () => {
    const out = renderEntry({ ...base, kind: "voice-note", durationMs: 3_000, note: "spoken" });
    expect(out).toMatch(/^- spoken\. Page: /);
    expect(out).not.toContain("](./");
  });
});
