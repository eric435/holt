import { ENTRY_FIELD_LIMITS } from "@holt/protocol";
import { describe, expect, it } from "vitest";
import { ApiError } from "../shared/api.js";
import type { PendingScreenshot } from "../shared/state.js";
import { PENDING_SCREENSHOT_TTL_MS, isAbandoned, isPermanentEntryError, orphanedScreenshotNote, screenshotEntry } from "./pending-screenshot-model.js";

const pending: PendingScreenshot = {
  id: "s1",
  page: { url: "http://localhost:5173/checkout", title: "Checkout" },
  capturedAt: "2026-10-13T14:53:12.000Z",
  file: "001-screenshot.png",
  serverUrl: "http://localhost:5173",
  mode: "area",
  width: 640,
  height: 480,
  windowId: 1,
  tabId: 7,
  at: 1_000_000,
  popupWindowId: 9,
};

describe("screenshotEntry", () => {
  it("builds the one screenshot entry with the trimmed note", () => {
    expect(screenshotEntry(pending, "  Button overlaps the footer \n")).toEqual({
      kind: "screenshot",
      capturedAt: pending.capturedAt,
      page: pending.page,
      file: "001-screenshot.png",
      mode: "area",
      width: 640,
      height: 480,
      note: "Button overlaps the footer",
    });
  });

  it("leaves the note out when there is none (Skip, window closed, timeout)", () => {
    expect(screenshotEntry(pending, "")).not.toHaveProperty("note");
    expect(screenshotEntry(pending, "  \n ")).not.toHaveProperty("note");
  });

  it("carries no bookkeeping fields to the server", () => {
    const entry = screenshotEntry({ ...pending, draft: "d", sessionGone: true }, "x");
    for (const key of ["id", "windowId", "tabId", "at", "popupWindowId", "draft", "sessionGone", "serverUrl"]) expect(entry).not.toHaveProperty(key);
  });

  it("keeps the note within the server's limit", () => {
    expect(screenshotEntry(pending, "x".repeat(ENTRY_FIELD_LIMITS.note + 50)).note).toHaveLength(ENTRY_FIELD_LIMITS.note);
  });
});

describe("orphanedScreenshotNote", () => {
  it("a plain note on the screenshot's page that names the screenshot", () => {
    expect(orphanedScreenshotNote(pending, "  The footer overlaps \n")).toEqual({
      kind: "note",
      capturedAt: pending.capturedAt,
      page: pending.page,
      note: "About screenshot 001-screenshot.png from an earlier session: The footer overlaps",
    });
  });
  it("stays within the server's limit with the prefix added", () => {
    expect(orphanedScreenshotNote(pending, "x".repeat(ENTRY_FIELD_LIMITS.note)).note).toHaveLength(ENTRY_FIELD_LIMITS.note);
  });
});

describe("isPermanentEntryError", () => {
  const api = (status: number, code = "bad-request") => new ApiError(code as never, "m", status);
  it("a 4xx the request can never get past: the session has moved on", () => {
    expect(isPermanentEntryError(api(400))).toBe(true);
    expect(isPermanentEntryError(api(404, "not-found"))).toBe(true);
    expect(isPermanentEntryError(api(413, "payload-too-large"))).toBe(true);
  });
  it("not the 4xx a retry can fix, a 5xx, or no answer", () => {
    for (const status of [403, 408, 409, 429, 500, 503]) expect(isPermanentEntryError(api(status)), String(status)).toBe(false);
    expect(isPermanentEntryError(new ApiError("unreachable", "down"))).toBe(false);
    expect(isPermanentEntryError(new Error("boom"))).toBe(false);
    expect(isPermanentEntryError({ status: 400 })).toBe(false);
  });
});

describe("isAbandoned", () => {
  const old = pending.at + PENDING_SCREENSHOT_TTL_MS + 1;
  it("never while the prompt window is open, however old", () => {
    expect(isAbandoned(pending, old, true)).toBe(false);
    expect(isAbandoned(pending, pending.at + 24 * 3_600_000, true)).toBe(false);
  });
  it("not while young, even without a window (it may still be opening)", () => {
    expect(isAbandoned(pending, pending.at + 1_000, false)).toBe(false);
  });
  it("old and no window: post it without a note", () => {
    expect(isAbandoned(pending, old, false)).toBe(true);
  });
});
