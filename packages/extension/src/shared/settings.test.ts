import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_URL, DEFAULT_SETTINGS, isLoopbackHost, normalizeMicrophone, normalizeSettings, planSyncMigration, validateServerUrl } from "./settings.js";

describe("validateServerUrl", () => {
  it("accepts the default", () => {
    expect(validateServerUrl(DEFAULT_SERVER_URL)).toEqual({ ok: true, url: "http://127.0.0.1:4848" });
  });

  it("normalises to a bare origin", () => {
    expect(validateServerUrl("  http://localhost:5173/  ")).toEqual({ ok: true, url: "http://localhost:5173" });
    expect(validateServerUrl("HTTP://LocalHost:5173")).toEqual({ ok: true, url: "http://localhost:5173" });
  });

  it("tolerates a pasted /__holt base path", () => {
    expect(validateServerUrl("http://localhost:5173/__holt/")).toEqual({ ok: true, url: "http://localhost:5173" });
  });

  it("accepts https and IPv6 loopback without a warning", () => {
    expect(validateServerUrl("https://localhost:8443")).toEqual({ ok: true, url: "https://localhost:8443" });
    expect(validateServerUrl("http://[::1]:4848")).toEqual({ ok: true, url: "http://[::1]:4848" });
  });

  it("warns for non-loopback hosts but allows them", () => {
    const result = validateServerUrl("http://192.168.1.20:4848");
    expect(result.ok).toBe(true);
    expect(result.ok && result.warning).toMatch(/not a loopback/);
  });

  it.each([
    ["", /empty/],
    ["not a url", /not a valid URL/],
    ["ftp://127.0.0.1:4848", /http:\/\/ or https:\/\//],
    ["chrome-extension://abc", /http:\/\/ or https:\/\//],
    ["http://user:pass@127.0.0.1:4848", /user name or password/],
    ["http://127.0.0.1:4848/?x=1", /query string/],
    ["http://127.0.0.1:4848/#x", /fragment/],
    ["http://127.0.0.1:4848/api", /just the origin/],
  ])("rejects %j", (input, error) => {
    const result = validateServerUrl(input);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(error);
  });
});

describe("isLoopbackHost", () => {
  it.each(["localhost", "app.localhost", "127.0.0.1", "127.1.2.3", "[::1]"])("%s is loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });
  it.each(["example.com", "10.0.0.1", "localhost.example.com", "0.0.0.0", "128.0.0.1"])("%s is not", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("normalizeSettings", () => {
  it("fills defaults", () => {
    expect(normalizeSettings({})).toEqual({
      serverUrl: DEFAULT_SERVER_URL,
      token: "",
      keepAudio: true,
      microphoneId: "",
      microphoneLabel: "",
      hideShortcutHint: false,
    });
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });
  it("drops invalid stored values", () => {
    expect(normalizeSettings({ serverUrl: "ftp://x", token: 42, keepAudio: "yes", microphoneId: 7, microphoneLabel: "x", hideShortcutHint: "true" })).toEqual(
      DEFAULT_SETTINGS,
    );
  });
  it("keeps valid stored values", () => {
    expect(
      normalizeSettings({
        serverUrl: "http://localhost:5173/",
        token: " s3cret ",
        keepAudio: false,
        microphoneId: "abc123",
        microphoneLabel: " USB Mic ",
        hideShortcutHint: true,
      }),
    ).toEqual({
      serverUrl: "http://localhost:5173",
      token: "s3cret",
      keepAudio: false,
      microphoneId: "abc123",
      microphoneLabel: "USB Mic",
      hideShortcutHint: true,
    });
  });
});

describe("normalizeMicrophone", () => {
  it("treats empty, blank and Chrome's 'default' alias as the system default", () => {
    for (const id of ["", "   ", "default"]) {
      expect(normalizeMicrophone(id, "Some label")).toEqual({ microphoneId: "", microphoneLabel: "" });
    }
  });
  it("keeps an id with or without a label", () => {
    expect(normalizeMicrophone("dev-1", "Headset")).toEqual({ microphoneId: "dev-1", microphoneLabel: "Headset" });
    expect(normalizeMicrophone("dev-1", undefined)).toEqual({ microphoneId: "dev-1", microphoneLabel: "" });
  });
  it("drops non-strings and absurdly long ids, and caps the label", () => {
    expect(normalizeMicrophone(42, "x")).toEqual({ microphoneId: "", microphoneLabel: "" });
    expect(normalizeMicrophone("x".repeat(513), "x")).toEqual({ microphoneId: "", microphoneLabel: "" });
    expect(normalizeMicrophone("dev", "y".repeat(500)).microphoneLabel).toHaveLength(200);
  });
});

describe("planSyncMigration", () => {
  it("does nothing when sync is empty", () => {
    expect(planSyncMigration({}, {})).toEqual({ toLocal: {}, removeFromSync: [] });
  });

  it("moves a loopback serverUrl and keepAudio to local, then removes them from sync", () => {
    expect(planSyncMigration({ serverUrl: "http://localhost:5173/", keepAudio: false }, {})).toEqual({
      toLocal: { serverUrl: "http://localhost:5173", keepAudio: false },
      removeFromSync: ["serverUrl", "keepAudio"],
    });
  });

  it("keeps values already set locally", () => {
    expect(planSyncMigration({ serverUrl: "http://localhost:1", keepAudio: false }, { serverUrl: "http://127.0.0.1:2", keepAudio: true })).toEqual({
      toLocal: {},
      removeFromSync: ["serverUrl", "keepAudio"],
    });
  });

  it("drops a synced non-loopback or invalid serverUrl instead of trusting it", () => {
    expect(planSyncMigration({ serverUrl: "http://203.0.113.9:4848" }, {})).toEqual({ toLocal: {}, removeFromSync: ["serverUrl"] });
    expect(planSyncMigration({ serverUrl: "ftp://x" }, {})).toEqual({ toLocal: {}, removeFromSync: ["serverUrl"] });
  });

  it("ignores junk types but still cleans them out of sync", () => {
    expect(planSyncMigration({ serverUrl: 42, keepAudio: "yes" }, {})).toEqual({ toLocal: {}, removeFromSync: ["serverUrl", "keepAudio"] });
  });
});
