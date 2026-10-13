import { describe, expect, it } from "vitest";
import {
  errorMessage,
  isAreaCancelledMessage,
  isAreaSelectedMessage,
  isCaptureRequest,
  isCssRect,
  isEntryAddedMessage,
  isMessage,
  isNoReceiverError,
  isTopFrameOfTab,
  isTrustedExtensionSender,
  isToastMessage,
} from "./messages.js";

const validArea = {
  type: "area-selected",
  rect: { x: 1, y: 2, width: 30, height: 40 },
  viewport: { width: 1280, height: 720 },
  devicePixelRatio: 2,
};

describe("isMessage", () => {
  it("accepts known types only", () => {
    expect(isMessage({ type: "capture" })).toBe(true);
    expect(isMessage({ type: "helper:metrics" })).toBe(true);
    expect(isMessage({ type: "something-else" })).toBe(false);
    expect(isMessage(null)).toBe(false);
    expect(isMessage("capture")).toBe(false);
    expect(isMessage([{ type: "capture" }])).toBe(false);
  });
});

describe("isCaptureRequest", () => {
  it("validates mode and windowId", () => {
    expect(isCaptureRequest({ type: "capture", mode: "viewport", windowId: 3 })).toBe(true);
    expect(isCaptureRequest({ type: "capture", mode: "full-page", windowId: 3 })).toBe(true);
    expect(isCaptureRequest({ type: "capture", mode: "fullscreen", windowId: 3 })).toBe(false);
    expect(isCaptureRequest({ type: "capture", mode: "area", windowId: "3" })).toBe(false);
    expect(isCaptureRequest({ type: "capture", mode: "area", windowId: 1.5 })).toBe(false);
  });
});

describe("isAreaSelectedMessage (untrusted, from a content script)", () => {
  it("accepts a well-formed message", () => {
    expect(isAreaSelectedMessage(validArea)).toBe(true);
  });

  it.each([
    ["negative width", { ...validArea, rect: { ...validArea.rect, width: -1 } }],
    ["zero height", { ...validArea, rect: { ...validArea.rect, height: 0 } }],
    ["NaN x", { ...validArea, rect: { ...validArea.rect, x: Number.NaN } }],
    ["Infinity y", { ...validArea, rect: { ...validArea.rect, y: Infinity } }],
    ["string coordinate", { ...validArea, rect: { ...validArea.rect, x: "1" } }],
    ["missing viewport", { ...validArea, viewport: undefined }],
    ["zero DPR", { ...validArea, devicePixelRatio: 0 }],
    ["wrong type", { ...validArea, type: "area-cancelled" }],
  ])("rejects %s", (_, message) => {
    expect(isAreaSelectedMessage(message)).toBe(false);
  });
});

describe("other guards", () => {
  it("isCssRect", () => {
    expect(isCssRect({ x: 0, y: 0, width: 1, height: 1 })).toBe(true);
    expect(isCssRect({ x: 0, y: 0, width: 1 })).toBe(false);
  });
  it("isAreaCancelledMessage", () => {
    expect(isAreaCancelledMessage({ type: "area-cancelled" })).toBe(true);
    expect(isAreaCancelledMessage({ type: "area-selected" })).toBe(false);
  });
  it("isToastMessage", () => {
    expect(isToastMessage({ type: "toast", level: "error", message: "x" })).toBe(true);
    expect(isToastMessage({ type: "toast", level: "fatal", message: "x" })).toBe(false);
    expect(isToastMessage({ type: "toast", level: "info" })).toBe(false);
  });
  it("isEntryAddedMessage", () => {
    expect(isEntryAddedMessage({ type: "entry-added", entry: {}, session: {} })).toBe(true);
    expect(isEntryAddedMessage({ type: "entry-added", entry: {} })).toBe(false);
  });
});

describe("errors", () => {
  it("errorMessage handles anything thrown", () => {
    expect(errorMessage(new Error("a"))).toBe("a");
    expect(errorMessage("b")).toBe("b");
    expect(errorMessage({ c: 1 })).toBe('{"c":1}');
  });
  it("isNoReceiverError recognises Chrome's 'nobody listening' errors", () => {
    expect(isNoReceiverError(new Error("Could not establish connection. Receiving end does not exist."))).toBe(true);
    expect(isNoReceiverError(new Error("The message port closed before a response was received."))).toBe(true);
    expect(isNoReceiverError(new Error("Other"))).toBe(false);
  });
});

describe("isTrustedExtensionSender", () => {
  const ID = "abcdefghijklmnopabcdefghijklmnop";
  it("accepts our worker / side panel (no tab)", () => {
    expect(isTrustedExtensionSender({ id: ID }, ID)).toBe(true);
    expect(isTrustedExtensionSender({ id: ID, frameId: 0 }, ID)).toBe(true);
  });
  it("refuses our own content scripts (they have a tab)", () => {
    expect(isTrustedExtensionSender({ id: ID, tab: { id: 7 }, frameId: 0 }, ID)).toBe(false);
  });
  it("refuses other extensions and missing ids", () => {
    expect(isTrustedExtensionSender({ id: "other" }, ID)).toBe(false);
    expect(isTrustedExtensionSender({}, ID)).toBe(false);
    expect(isTrustedExtensionSender({ id: "" }, "")).toBe(false);
  });
});

describe("isTopFrameOfTab", () => {
  it("accepts the top frame of the expected tab", () => {
    expect(isTopFrameOfTab({ tab: { id: 7 }, frameId: 0 }, 7)).toBe(true);
  });
  it("refuses subframes, other tabs and non-tab senders", () => {
    expect(isTopFrameOfTab({ tab: { id: 7 }, frameId: 3 }, 7)).toBe(false);
    expect(isTopFrameOfTab({ tab: { id: 8 }, frameId: 0 }, 7)).toBe(false);
    expect(isTopFrameOfTab({ tab: { id: 7 } }, 7)).toBe(false);
    expect(isTopFrameOfTab({}, 7)).toBe(false);
  });
});
