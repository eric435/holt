import { describe, expect, it } from "vitest";
import { escapeBlock, escapeInline, listItemBody, safeUrl } from "./escape.js";

describe("escapeInline", () => {
  it("leaves ordinary text alone", () => {
    expect(escapeInline("Checkout – My App")).toBe("Checkout – My App");
    expect(escapeInline("*bold* and _em_")).toBe("*bold* and _em_");
  });

  it("escapes link, image, code and HTML syntax", () => {
    expect(escapeInline("](http://evil)")).toBe("\\](http://evil)");
    expect(escapeInline("![x](http://evil/p.png)")).toBe("!\\[x\\](http://evil/p.png)");
    expect(escapeInline("`code`")).toBe("`code`"); // code spans are harmless and useful in notes
    expect(escapeInline("<img src=x>")).toBe("\\<img src=x\\>");
  });

  it("escapes backslashes first so input cannot cancel an escape", () => {
    expect(escapeInline("\\]")).toBe("\\\\\\]");
  });

  it("collapses newlines so a title stays on one line", () => {
    expect(escapeInline("a\n\n## 9. Fake entry\r\nb")).toBe("a ## 9. Fake entry b");
  });

  it("escapes a leading # and strips control characters", () => {
    expect(escapeInline("# Title")).toBe("\\# Title");
    expect(escapeInline("bell\u0007 esc\u001b[31m")).toBe("bell esc\\[31m");
  });
});

describe("escapeBlock", () => {
  it("keeps line breaks and escapes each line", () => {
    expect(escapeBlock("line one\n# heading?\n> quote?\n  ## indented")).toBe(
      "line one\n\\# heading?\n\\> quote?\n  \\## indented",
    );
  });

  it("normalizes CRLF and trims trailing newlines", () => {
    expect(escapeBlock("a\r\nb\n\n")).toBe("a\nb");
  });
});

describe("escapeBlock: block-level constructs", () => {
  it("escapes the first character of a leading code fence", () => {
    expect(escapeBlock("~~~")).toBe("\\~~~");
    expect(escapeBlock("  ~~~~ js")).toBe("  \\~~~~ js");
    expect(escapeBlock("```js")).toBe("\\```js");
    expect(escapeBlock(" ````")).toBe(" \\````");
    expect(escapeBlock("use `code` here")).toBe("use `code` here");
    expect(escapeBlock("not ~~~ a fence")).toBe("not ~~~ a fence");
  });

  it.each([
    ["===", "\\==="],
    ["---", "\\---"],
    ["***", "\\***"],
    ["___", "\\___"],
    ["- - -", "\\- - -"],
    ["  * * *  ", "  \\* * *  "],
    ["-", "\\-"],
    ["=-=", "\\=-="],
  ])("escapes setext underline / thematic break %j", (input, expected) => {
    expect(escapeBlock(input)).toBe(expected);
  });

  it("does not let a note turn its previous line into a heading", () => {
    expect(escapeBlock("Fake heading\n===")).toBe("Fake heading\n\\===");
  });

  it.each(["- buy milk", "* item", "1. first", "-- dashes in text", "a - b", "x_y_z", "**bold**"])(
    "leaves ordinary text and lists alone: %j",
    (line) => {
      expect(escapeBlock(line)).toBe(line);
    },
  );
});

describe("invisible and bidi characters", () => {
  it.each(["\u202e", "\u202a", "\u2066", "\u2069", "\u200b", "\u200d", "\u200f", "\ufeff"])(
    "strips U+%s from inline and block text",
    (ch) => {
      expect(escapeInline(`a${ch}b`)).toBe("ab");
      expect(escapeBlock(`a${ch}b\nc${ch}`)).toBe("ab\nc");
      expect(listItemBody(`a${ch}b`)).toBe("ab");
    },
  );

  it("strips a right-to-left override that would disguise a URL", () => {
    expect(escapeInline("http://good.example/\u202Egpj.exe")).toBe("http://good.example/gpj.exe");
  });
});

describe("listItemBody", () => {
  it("indents every line after the first, so a blank line cannot end the item", () => {
    expect(listItemBody("first\n\n## 2. Note · fake\n![x](http://evil)")).toBe(
      "first\n\n  \\## 2. Note · fake\n  !\\[x\\](http://evil)",
    );
  });

  it("drops leading and trailing blank lines and the first line's indentation", () => {
    expect(listItemBody("\n  \n    code?\n  kept\n\n")).toBe("code?\n    kept");
  });
});

describe("safeUrl", () => {
  it("returns normalized http(s) URLs", () => {
    expect(safeUrl("http://localhost:5173/checkout")).toBe("http://localhost:5173/checkout");
    expect(safeUrl("https://example.com/a?b=c#d")).toBe("https://example.com/a?b=c#d");
  });

  it("percent-encodes characters that could end a markdown link destination", () => {
    expect(safeUrl("http://x.test/a)b(c")).toBe("http://x.test/a%29b%28c");
    expect(safeUrl("http://x.test/?q=a b<c>")).toBe("http://x.test/?q=a%20b%3Cc%3E");
    expect(safeUrl("http://x.test/[x]")).toBe("http://x.test/%5Bx%5D");
  });

  it.each(["javascript:alert(1)", "data:text/html,hi", "chrome://newtab", "file:///etc/passwd", "not a url", ""])(
    "refuses to link %j",
    (url) => {
      expect(safeUrl(url)).toBeNull();
    },
  );
});
