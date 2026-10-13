import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_URL, isLoopbackHost, normalizeSettings, validateServerUrl } from "./settings.js";

describe("validateServerUrl", () => {
  it("accepts the default", () => {
    expect(validateServerUrl(DEFAULT_SERVER_URL)).toEqual({ ok: true, url: "http://127.0.0.1:4848" });
  });

  it("normalises to a bare origin", () => {
    expect(validateServerUrl("  http://localhost:5173/  ")).toEqual({ ok: true, url: "http://localhost:5173" });
    expect(validateServerUrl("HTTP://LocalHost:5173")).toEqual({ ok: true, url: "http://localhost:5173" });
  });

  it("tolerates a pasted /__nitpick base path", () => {
    expect(validateServerUrl("http://localhost:5173/__nitpick/")).toEqual({ ok: true, url: "http://localhost:5173" });
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
    expect(normalizeSettings({})).toEqual({ serverUrl: DEFAULT_SERVER_URL, token: "", keepAudio: true });
  });
  it("drops invalid stored values", () => {
    expect(normalizeSettings({ serverUrl: "ftp://x", token: 42, keepAudio: "yes" })).toEqual({
      serverUrl: DEFAULT_SERVER_URL,
      token: "",
      keepAudio: true,
    });
  });
  it("keeps valid stored values", () => {
    expect(normalizeSettings({ serverUrl: "http://localhost:5173/", token: " s3cret ", keepAudio: false })).toEqual({
      serverUrl: "http://localhost:5173",
      token: "s3cret",
      keepAudio: false,
    });
  });
});
