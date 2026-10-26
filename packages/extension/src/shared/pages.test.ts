import { describe, expect, it } from "vitest";
import { isOwnExtensionPage, opensWelcomeOn } from "./pages.js";

const ID = "abcdefghijklmnopabcdefghijklmnop";

describe("isOwnExtensionPage", () => {
  it("recognises our pages, whatever their query", () => {
    expect(isOwnExtensionPage(`chrome-extension://${ID}/note.html?mode=screenshot&id=x`, ID)).toBe(true);
    expect(isOwnExtensionPage(`chrome-extension://${ID}/permissions.html`, ID)).toBe(true);
  });
  it("not web pages, other extensions, a lookalike id, or an unreadable URL", () => {
    expect(isOwnExtensionPage("http://localhost:5173/", ID)).toBe(false);
    expect(isOwnExtensionPage(`chrome-extension://other/note.html`, ID)).toBe(false);
    expect(isOwnExtensionPage(`chrome-extension://${ID}x/note.html`, ID)).toBe(false);
    expect(isOwnExtensionPage(`http://localhost/chrome-extension://${ID}/`, ID)).toBe(false);
    expect(isOwnExtensionPage(undefined, ID)).toBe(false);
    expect(isOwnExtensionPage("", ID)).toBe(false);
    expect(isOwnExtensionPage(`chrome-extension:///note.html`, "")).toBe(false);
  });
});

describe("opensWelcomeOn", () => {
  it("opens the welcome page on a fresh install only", () => {
    expect(opensWelcomeOn("install")).toBe(true);
    for (const reason of ["update", "chrome_update", "shared_module_update", ""]) expect(opensWelcomeOn(reason)).toBe(false);
  });
});
