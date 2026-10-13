import { describe, expect, it } from "vitest";
import { altKeyLabel, shortcutMap, unboundHint, withShortcut } from "./shortcuts.js";

// What chrome.commands.getAll() returned in Chrome 155 on macOS with our manifest.
const MAC_DEFAULTS = [
  { name: "_execute_action", shortcut: "" },
  { name: "open-panel", shortcut: "" },
  { name: "quick-note", shortcut: "" },
  { name: "screenshot-area", shortcut: "⌥X" },
  { name: "screenshot-full", shortcut: "" },
  { name: "screenshot-viewport", shortcut: "⌥S" },
  { name: "toggle-recording", shortcut: "⌥D" },
  { name: "toggle-voice", shortcut: "⌥A" },
];

describe("shortcutMap", () => {
  it("maps names to bindings, unbound as empty string", () => {
    const map = shortcutMap(MAC_DEFAULTS);
    expect(map["toggle-voice"]).toBe("⌥A");
    expect(map["quick-note"]).toBe("");
    expect(map["nope"]).toBeUndefined();
  });
  it("skips nameless entries and missing shortcuts", () => {
    expect(shortcutMap([{ shortcut: "Alt+Q" }, { name: "x" }])).toEqual({ x: "" });
  });
});

describe("withShortcut", () => {
  const map = shortcutMap(MAC_DEFAULTS);
  it("appends the current binding", () => {
    expect(withShortcut("Visible", map, "screenshot-viewport")).toBe("Visible (⌥S)");
  });
  it("leaves the text alone when unbound or unknown", () => {
    expect(withShortcut("Full page", map, "screenshot-full")).toBe("Full page");
    expect(withShortcut("Full page", {}, "screenshot-full")).toBe("Full page");
  });
});

describe("unboundHint", () => {
  it("names both suggested keys while both are unbound", () => {
    expect(unboundHint(shortcutMap(MAC_DEFAULTS), false)).toBe(
      "Set Alt+W (full-page screenshot) and Alt+T (text note) at chrome://extensions/shortcuts",
    );
    expect(unboundHint(shortcutMap(MAC_DEFAULTS), true)).toMatch(/^Set ⌥W .* and ⌥T /);
  });
  it("names only what is still missing, and disappears when all are set", () => {
    expect(unboundHint({ "screenshot-full": "Alt+W", "quick-note": "" }, false)).toBe("Set Alt+T (text note) at chrome://extensions/shortcuts");
    expect(unboundHint({ "screenshot-full": "Alt+W", "quick-note": "Alt+T" }, false)).toBeNull();
  });
  it("altKeyLabel", () => {
    expect(altKeyLabel("W", false)).toBe("Alt+W");
    expect(altKeyLabel("W", true)).toBe("⌥W");
  });
});
