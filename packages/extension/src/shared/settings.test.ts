import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_URL,
  DEFAULT_SETTINGS,
  isLoopbackHost,
  keepAudioForced,
  keepsVoiceAudio,
  normalizeMicrophone,
  normalizeSettings,
  validateServerUrl,
} from "./settings.js";

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
      serverMode: "auto",
      serverUrl: DEFAULT_SERVER_URL,
      token: "",
      transcribe: true,
      keepAudio: false,
      microphoneId: "",
      microphoneLabel: "",
      hideShortcutHint: false,
    });
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });
  it("drops invalid stored values", () => {
    expect(normalizeSettings({ serverMode: "manual", serverUrl: "ftp://x", token: 42, transcribe: "no", keepAudio: "yes", microphoneId: 7, microphoneLabel: "x", hideShortcutHint: "true" })).toEqual(
      DEFAULT_SETTINGS,
    );
  });
  it("auto-detects the server unless told otherwise", () => {
    expect(normalizeSettings({ serverMode: "auto" }).serverMode).toBe("auto");
    expect(normalizeSettings({ serverMode: "fixed" }).serverMode).toBe("fixed");
    expect(normalizeSettings({ serverMode: 1 }).serverMode).toBe("auto");
  });
  it("keeps valid stored values", () => {
    expect(
      normalizeSettings({
        serverMode: "fixed",
        serverUrl: "http://localhost:5173/",
        token: " s3cret ",
        transcribe: false,
        keepAudio: true,
        microphoneId: "abc123",
        microphoneLabel: " USB Mic ",
        hideShortcutHint: true,
      }),
    ).toEqual({
      serverMode: "fixed",
      serverUrl: "http://localhost:5173",
      token: "s3cret",
      transcribe: false,
      keepAudio: true,
      microphoneId: "abc123",
      microphoneLabel: "USB Mic",
      hideShortcutHint: true,
    });
  });
});

describe("transcribe", () => {
  it("is on unless explicitly turned off (installs from before the setting keep transcribing)", () => {
    expect(normalizeSettings({}).transcribe).toBe(true);
    expect(normalizeSettings({ transcribe: true }).transcribe).toBe(true);
    expect(normalizeSettings({ transcribe: false }).transcribe).toBe(false);
    for (const junk of [0, "", "false", null]) expect(normalizeSettings({ transcribe: junk }).transcribe).toBe(true);
  });
});

describe("keepsVoiceAudio", () => {
  const on = { transcribe: true, keepAudio: false };
  it("drops the audio by default when there are words", () => {
    expect(keepsVoiceAudio(on, "the button is misaligned")).toBe(false);
  });
  it("keeps it when asked to", () => {
    expect(keepsVoiceAudio({ ...on, keepAudio: true }, "words")).toBe(true);
  });
  it("keeps it when nothing usable was recognised, or the words were all deleted", () => {
    expect(keepsVoiceAudio(on, "")).toBe(true);
    expect(keepsVoiceAudio(on, "  \n ")).toBe(true);
  });
  it("always keeps it while transcription is off, even with words typed into the box", () => {
    expect(keepsVoiceAudio({ transcribe: false, keepAudio: false }, "")).toBe(true);
    expect(keepsVoiceAudio({ transcribe: false, keepAudio: false }, "typed by hand")).toBe(true);
  });
  it("keepAudioForced says when the setting doesn't apply", () => {
    expect(keepAudioForced({ transcribe: false })).toBe(true);
    expect(keepAudioForced({ transcribe: true })).toBe(false);
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
