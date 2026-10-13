import { describe, expect, it } from "vitest";
import { isMediaKind, isPlainFileName, mediaFileName, sessionFolderName } from "./naming.js";

describe("sessionFolderName", () => {
  it("formats local time as YYYY-MM-DD-HHMMSS with zero padding", () => {
    expect(sessionFolderName(new Date(2026, 9, 13, 7, 52, 0))).toBe("2026-10-13-075200");
    expect(sessionFolderName(new Date(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02-030405");
    expect(sessionFolderName(new Date(2026, 11, 31, 23, 59, 59))).toBe("2026-12-31-235959");
  });
});

describe("mediaFileName", () => {
  it("pads the sequence number to three digits", () => {
    expect(mediaFileName(1, "screenshot", "png")).toBe("001-screenshot.png");
    expect(mediaFileName(42, "voice-note", "webm")).toBe("042-voice-note.webm");
    expect(mediaFileName(1234, "media", "mp4")).toBe("1234-media.mp4");
  });
});

describe("isMediaKind", () => {
  it("accepts only the allow-listed kinds", () => {
    expect(isMediaKind("screenshot")).toBe(true);
    expect(isMediaKind("media")).toBe(true);
    expect(isMediaKind("note")).toBe(false);
    expect(isMediaKind("../x")).toBe(false);
    expect(isMediaKind(undefined)).toBe(false);
    expect(isMediaKind(["screenshot"])).toBe(false);
  });
});

describe("isPlainFileName", () => {
  it.each(["001-screenshot.png", "a", "x_y.z"])("accepts %s", (name) => {
    expect(isPlainFileName(name)).toBe(true);
  });

  it.each(["", ".", "..", ".hidden", "../x.png", "a/b.png", "a\\b.png", "/etc/passwd", "C:\\x", "a..b", "a b.png", "a\0.png", "x".repeat(200)])(
    "rejects %j",
    (name) => {
      expect(isPlainFileName(name)).toBe(false);
    },
  );
});
