import { ENTRY_FIELD_LIMITS } from "@holt/protocol";
import { describe, expect, it } from "vitest";
import { UNKNOWN_PAGE_TITLE, clampText, pageContextFromTab, sanitizeUrl } from "./page-context.js";

describe("pageContextFromTab", () => {
  it("uses url and title when Chrome provides them", () => {
    expect(pageContextFromTab({ url: "http://localhost:5173/cart", title: "Cart – My App" })).toEqual({
      url: "http://localhost:5173/cart",
      title: "Cart – My App",
    });
  });

  it("falls back to pendingUrl while a tab is loading", () => {
    expect(pageContextFromTab({ pendingUrl: "http://localhost:5173/next", title: "" })).toEqual({
      url: "http://localhost:5173/next",
      title: "http://localhost:5173/next",
    });
  });

  it("uses the url as title when the title is blank", () => {
    expect(pageContextFromTab({ url: "http://localhost/", title: "   " }).title).toBe("http://localhost/");
  });

  it("returns placeholders when we have no access to the tab", () => {
    expect(pageContextFromTab({})).toEqual({ url: "", title: UNKNOWN_PAGE_TITLE });
    expect(pageContextFromTab(undefined)).toEqual({ url: "", title: UNKNOWN_PAGE_TITLE });
  });

  it("strips credentials from the url", () => {
    expect(pageContextFromTab({ url: "https://bob:hunter2@staging.example.com/a?b=1#c", title: "T" }).url).toBe(
      "https://staging.example.com/a?b=1#c",
    );
  });
});

describe("sanitizeUrl", () => {
  it("leaves non-URL strings alone", () => {
    expect(sanitizeUrl("not a url")).toBe("not a url");
    expect(sanitizeUrl("")).toBe("");
  });
});

describe("the server's field limits", () => {
  const URL_MAX = ENTRY_FIELD_LIMITS["page.url"];
  const TITLE_MAX = ENTRY_FIELD_LIMITS["page.title"];

  it("cuts a huge URL and title down instead of failing (the capture must still save)", () => {
    const url = `http://localhost:5173/search?q=${"x".repeat(20_000)}`;
    const page = pageContextFromTab({ url, title: "T".repeat(5_000) });
    expect(page.url).toHaveLength(URL_MAX);
    expect(url.startsWith(page.url)).toBe(true);
    expect(page.title).toHaveLength(TITLE_MAX);
  });

  it("a title that falls back to a long URL is clamped to the title's limit", () => {
    const page = pageContextFromTab({ url: `http://localhost/${"a".repeat(3_000)}`, title: "" });
    expect(page.title).toHaveLength(TITLE_MAX);
    expect(page.url.length).toBeGreaterThan(TITLE_MAX);
  });

  it("leaves anything within the limits alone", () => {
    const url = `http://localhost/${"a".repeat(URL_MAX - "http://localhost/".length)}`;
    expect(pageContextFromTab({ url, title: "t".repeat(TITLE_MAX) })).toEqual({ url, title: "t".repeat(TITLE_MAX) });
  });
});

describe("clampText", () => {
  it("cuts to the limit in UTF-16 code units", () => {
    expect(clampText("abcdef", 3)).toBe("abc");
    expect(clampText("abc", 3)).toBe("abc");
    expect(clampText("", 0)).toBe("");
  });
  it("never leaves half of a surrogate pair at the end", () => {
    expect(clampText("ab😀cd", 3)).toBe("ab"); // the emoji would be cut in half
    expect(clampText("ab😀cd", 4)).toBe("ab😀");
  });
});
