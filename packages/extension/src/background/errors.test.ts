import { describe, expect, it } from "vitest";
import { friendlyCaptureError } from "./errors.js";

describe("friendlyCaptureError", () => {
  it("explains a missing activeTab grant", () => {
    const msg = friendlyCaptureError(new Error("Either the '<all_urls>' or 'activeTab' permission is required."));
    expect(msg).toMatch(/invoke nitpick/);
    expect(msg).toMatch(/Alt\+Shift\+S/);
  });

  it("explains restricted pages", () => {
    expect(friendlyCaptureError(new Error("Cannot access a chrome:// URL"))).toMatch(/does not allow/);
  });

  it("passes other errors through", () => {
    expect(friendlyCaptureError(new Error("boom"))).toBe("boom");
    expect(friendlyCaptureError("plain")).toBe("plain");
  });
});
