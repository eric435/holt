import { describe, expect, it } from "vitest";
import { COMMAND_LABELS } from "../shared/shortcuts.js";
import { serverLine, shortcutRows } from "./welcome-model.js";

const url = "http://127.0.0.1:4848";

describe("serverLine", () => {
  it("is grey while checking", () => {
    expect(serverLine({ kind: "checking", serverUrl: url })).toEqual({ tone: "grey", text: "Looking for a holt server at 127.0.0.1:4848…" });
  });

  it("names the project when the server says which", () => {
    expect(serverLine({ kind: "ok", serverUrl: url, status: { version: "0.1.0", project: { name: " acme-web " } } })).toEqual({
      tone: "green",
      text: "Connected to acme-web",
      detail: "holt 0.1.0 · 127.0.0.1:4848",
    });
  });

  it("still says connected for an older server without a project name or version", () => {
    expect(serverLine({ kind: "ok", serverUrl: url, status: { version: "0.0.9" } })).toEqual({ tone: "green", text: "Connected to holt 0.0.9 at 127.0.0.1:4848" });
    expect(serverLine({ kind: "ok", serverUrl: url, status: {} })).toEqual({ tone: "green", text: "Connected to holt at 127.0.0.1:4848" });
  });

  it("says that a server which wants a token was found", () => {
    const line = serverLine({ kind: "needs-token", serverUrl: url });
    expect(line.tone).toBe("green");
    expect(line.detail).toMatch(/token/);
  });

  it("is red for a holt server of another protocol version, with the message saying what to update", () => {
    const message = "The holt server in acme-web is too old for this extension. Update it: …";
    expect(serverLine({ kind: "incompatible", serverUrl: url, message })).toEqual({
      tone: "red",
      text: "Found holt at 127.0.0.1:4848, but it doesn't work with this version of the extension.",
      detail: message,
    });
  });

  it("says 'not yet' when nothing answers, and why that can be fine with the Vite plugin", () => {
    const line = serverLine({ kind: "down", serverUrl: "http://localhost:5173" });
    expect(line.tone).toBe("red");
    expect(line.text).toBe("No server found at localhost:5173 yet.");
    expect(line.detail).toMatch(/Vite plugin/);
  });
});

describe("shortcutRows", () => {
  it("lists every command in the panel's order, with null for unbound ones", () => {
    const rows = shortcutRows({ "screenshot-area": "⌥S", "toggle-voice": "", "quick-note": "Alt+T" });
    expect(rows.map((r) => r.command)).toEqual(COMMAND_LABELS.map(([name]) => name));
    expect(rows.find((r) => r.command === "screenshot-area")).toEqual({ command: "screenshot-area", label: "Screenshot: select area", key: "⌥S" });
    expect(rows.find((r) => r.command === "toggle-voice")?.key).toBeNull();
    expect(rows.find((r) => r.command === "screenshot-full")?.key).toBeNull();
  });
});
