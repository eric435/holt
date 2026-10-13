import { describe, expect, it } from "vitest";
import { noteKeyAction } from "./note-keys.js";

describe("noteKeyAction", () => {
  it("Enter saves", () => expect(noteKeyAction({ key: "Enter", shiftKey: false })).toBe("save"));
  it("Shift+Enter is a newline (default behaviour)", () => expect(noteKeyAction({ key: "Enter", shiftKey: true })).toBeNull());
  it("Ctrl/Cmd+Enter still saves", () => expect(noteKeyAction({ key: "Enter", shiftKey: false, ctrlKey: true } as never)).toBe("save"));
  it("Escape cancels", () => expect(noteKeyAction({ key: "Escape", shiftKey: false })).toBe("cancel"));
  it("other keys do nothing", () => expect(noteKeyAction({ key: "a", shiftKey: false })).toBeNull());
  it("never saves while an IME is composing", () => {
    expect(noteKeyAction({ key: "Enter", shiftKey: false, isComposing: true })).toBeNull();
    expect(noteKeyAction({ key: "Process", shiftKey: false, keyCode: 229 })).toBeNull();
    expect(noteKeyAction({ key: "Escape", shiftKey: false, isComposing: true })).toBeNull();
  });
});
