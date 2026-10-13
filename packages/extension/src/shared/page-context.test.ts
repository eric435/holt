import { describe, expect, it } from "vitest";
import { UNKNOWN_PAGE_TITLE, pageContextFromTab, sanitizeUrl } from "./page-context.js";

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
