import { describe, expect, it } from "vitest";
import { friendlyCaptureError, friendlyRecordingError } from "./errors.js";

describe("friendlyCaptureError", () => {
  it("explains a missing activeTab grant", () => {
    const msg = friendlyCaptureError(new Error("Either the '<all_urls>' or 'activeTab' permission is required."));
    expect(msg).toMatch(/invoke nitpick/);
    expect(msg).toMatch(/Alt\+S\b/);
  });

  it("explains restricted pages", () => {
    expect(friendlyCaptureError(new Error("Cannot access a chrome:// URL"))).toMatch(/does not allow/);
  });

  it("passes other errors through", () => {
    expect(friendlyCaptureError(new Error("boom"))).toBe("boom");
    expect(friendlyCaptureError("plain")).toBe("plain");
  });
});

describe("friendlyCaptureError: pass-through of our own messages", () => {
  it("does not mangle the resize error", () => {
    const msg = "The page was resized during capture; try again.";
    expect(friendlyCaptureError(new Error(msg))).toBe(msg);
  });
  it("still recognises Chrome's rate-limit error", () => {
    expect(friendlyCaptureError(new Error("This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota."))).toMatch(/rate limit/);
  });
});

describe("friendlyRecordingError", () => {
  it("explains a missing activeTab grant and offers the window/screen option", () => {
    const msg = friendlyRecordingError(
      new Error("Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured."),
    );
    expect(msg).toMatch(/invoke nitpick/);
    expect(msg).toMatch(/Record a window or screen/);
  });
  it("explains a tab that is already captured", () => {
    expect(friendlyRecordingError(new Error("Cannot capture a tab with an active stream."))).toMatch(/already being captured/);
  });
  it("falls back to the capture translations", () => {
    expect(friendlyRecordingError("No tab with id: 4.")).toMatch(/tab was closed/);
    expect(friendlyRecordingError("boom")).toBe("boom");
  });
});
