import { describe, expect, it } from "vitest";
import {
  errorMessage,
  isAreaCancelledMessage,
  isAreaSelectedMessage,
  isCssRect,
  isEntryAddedMessage,
  isEntryCreatedMessage,
  isMenuRunRequest,
  isMessage,
  isNoReceiverError,
  isOffscreenCommitRequest,
  isOffscreenStartTabRequest,
  isOffscreenStartVoiceRequest,
  isOffscreenStopRequest,
  isOwnPageSender,
  isRecorderFinishedMessage,
  isRecorderStoppedMessage,
  isRecorderToastMessage,
  isRecorderTranscriptMessage,
  isScreenshotNoteDraftMessage,
  isScreenshotNoteFinishMessage,
  isSenderPage,
  isTopFrameOfTab,
  isTrustedExtensionSender,
  isToastMessage,
  isVoiceOverlayDecisionMessage,
  isVoiceOverlayDraftMessage,
  isVoiceOverlayStopMessage,
} from "./messages.js";

const validArea = {
  type: "area-selected",
  rect: { x: 1, y: 2, width: 30, height: 40 },
  viewport: { width: 1280, height: 720 },
  devicePixelRatio: 2,
};

describe("isMessage", () => {
  it("accepts known types only", () => {
    expect(isMessage({ type: "area-cancelled" })).toBe(true);
    expect(isMessage({ type: "helper:metrics" })).toBe(true);
    expect(isMessage({ type: "something-else" })).toBe(false);
    expect(isMessage(null)).toBe(false);
    expect(isMessage("area-cancelled")).toBe(false);
    expect(isMessage([{ type: "area-cancelled" }])).toBe(false);
  });
});

describe("removed messages", () => {
  it("the side panel's old capture and recorder:toggle requests are no longer messages at all", () => {
    // The panel stopped capturing; the worker no longer handles them, so the
    // dispatcher must not even consider them.
    expect(isMessage({ type: "capture", mode: "viewport", windowId: 3 })).toBe(false);
    expect(isMessage({ type: "recorder:toggle", recorder: "tab", windowId: 1 })).toBe(false);
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

describe("toast actions", () => {
  it("accepts only known action ids", () => {
    expect(isToastMessage({ type: "toast", level: "error", message: "x", action: "open-permissions" })).toBe(true);
    expect(isToastMessage({ type: "toast", level: "error", message: "x", action: "open-shortcuts" })).toBe(true);
    expect(isToastMessage({ type: "toast", level: "error", message: "x", action: "https://evil.example" })).toBe(false);
    expect(isToastMessage({ type: "toast", level: "error", message: "x", action: 1 })).toBe(false);
  });
  it("recorder:toast has the same shape", () => {
    expect(isRecorderToastMessage({ type: "recorder:toast", level: "info", message: "Uploading" })).toBe(true);
    expect(isRecorderToastMessage({ type: "recorder:toast", level: "loud", message: "x" })).toBe(false);
    expect(isRecorderToastMessage({ type: "toast", level: "info", message: "x" })).toBe(false);
  });
});

describe("recorder messages", () => {
  const settings = { serverUrl: "http://127.0.0.1:4848", token: "", keepAudio: true, microphoneId: "", microphoneLabel: "" };
  const page = { url: "http://localhost/", title: "App" };

  it("offscreen:start-tab needs a stream id, page and full settings", () => {
    const ok = { type: "offscreen:start-tab", id: "r1", streamId: "abc", page, settings };
    expect(isOffscreenStartTabRequest(ok)).toBe(true);
    expect(isOffscreenStartTabRequest({ ...ok, streamId: "" })).toBe(false);
    expect(isOffscreenStartTabRequest({ ...ok, page: { url: "u" } })).toBe(false);
    expect(isOffscreenStartTabRequest({ ...ok, settings: { ...settings, keepAudio: "yes" } })).toBe(false);
  });

  it("offscreen:start-voice and offscreen:stop", () => {
    expect(isOffscreenStartVoiceRequest({ type: "offscreen:start-voice", id: "r1", page, settings })).toBe(true);
    expect(isOffscreenStartVoiceRequest({ type: "offscreen:start-voice", id: "r1", page })).toBe(false);
    expect(isOffscreenStopRequest({ type: "offscreen:stop", recorder: "voice" })).toBe(true);
    expect(isOffscreenStopRequest({ type: "offscreen:stop", recorder: "all" })).toBe(false);
  });

  it("recorder:stopped, recorder:transcript, entry-created", () => {
    expect(isRecorderStoppedMessage({ type: "recorder:stopped", recorder: "tab", id: "r1" })).toBe(true);
    expect(isRecorderStoppedMessage({ type: "recorder:stopped", recorder: "tab" })).toBe(false);
    const transcript = { type: "recorder:transcript", recorder: "voice", id: "r1", final: "a", interim: "" };
    expect(isRecorderTranscriptMessage(transcript)).toBe(true);
    expect(isRecorderTranscriptMessage({ ...transcript, recorder: "tab" })).toBe(true);
    expect(isRecorderTranscriptMessage({ ...transcript, recorder: "screen" })).toBe(false);
    expect(isRecorderTranscriptMessage({ ...transcript, id: undefined })).toBe(false);
    expect(isRecorderTranscriptMessage({ ...transcript, interim: undefined })).toBe(false);
    expect(isRecorderTranscriptMessage({ ...transcript, error: "offline" })).toBe(true);
    expect(isRecorderTranscriptMessage({ ...transcript, error: 42 })).toBe(false);
    expect(isEntryCreatedMessage({ type: "entry-created", entry: { id: "e", seq: 3 }, session: { id: "s" } })).toBe(true);
    expect(isEntryCreatedMessage({ type: "entry-created", entry: { id: "e", seq: "3" }, session: { id: "s" } })).toBe(false);
    expect(isEntryCreatedMessage({ type: "entry-created", entry: { id: "e", seq: 3 } })).toBe(false);
  });

  it("recorder:finished and offscreen:commit (the review handshake)", () => {
    const finished = { type: "recorder:finished", recorder: "tab", id: "r1", transcript: "it flickers" };
    expect(isRecorderFinishedMessage(finished)).toBe(true);
    expect(isRecorderFinishedMessage({ ...finished, error: "offline" })).toBe(true);
    expect(isRecorderFinishedMessage({ ...finished, transcript: undefined })).toBe(false);
    expect(isRecorderFinishedMessage({ ...finished, recorder: "all" })).toBe(false);
    expect(isOffscreenCommitRequest({ type: "offscreen:commit", id: "r1", save: true, transcript: "x" })).toBe(true);
    expect(isOffscreenCommitRequest({ type: "offscreen:commit", id: "r1", save: "yes", transcript: "x" })).toBe(false);
    expect(isOffscreenCommitRequest({ type: "offscreen:commit", id: "r1", save: false })).toBe(false);
  });

  it("all new types are known to isMessage", () => {
    for (const type of ["entry-created", "menu:run", "screenshot-note:draft", "offscreen:start-tab", "offscreen:start-voice", "offscreen:stop", "offscreen:status", "offscreen:commit", "recorder:stopped", "recorder:finished", "recorder:toast", "recorder:idle", "recorder:transcript", "voice-overlay:update", "voice-overlay:visibility", "voice-overlay:finish", "voice-overlay:close", "voice-overlay:stop", "voice-overlay:draft", "voice-overlay:decision", "server-info:refresh"]) {
      expect(isMessage({ type })).toBe(true);
    }
  });
});

describe("menu:run", () => {
  it("only the menu's commands, with a window", () => {
    expect(isMenuRunRequest({ type: "menu:run", command: "screenshot-area", windowId: 1 })).toBe(true);
    expect(isMenuRunRequest({ type: "menu:run", command: "screenshot-viewport", windowId: 1 })).toBe(true);
    expect(isMenuRunRequest({ type: "menu:run", command: "toggle-recording", windowId: 1 })).toBe(true);
    // Real commands, but not ones the menu runs through the worker (its
    // Quick note opens the note page in the menu itself).
    expect(isMenuRunRequest({ type: "menu:run", command: "quick-note", windowId: 1 })).toBe(false);
    expect(isMenuRunRequest({ type: "menu:run", command: "open-panel", windowId: 1 })).toBe(false);
    expect(isMenuRunRequest({ type: "menu:run", command: "screenshot-area" })).toBe(false);
  });
});

describe("screenshot-note:finish", () => {
  const finish = { type: "screenshot-note:finish", id: "s1", note: "Button overlaps the footer" };
  it("names the pending screenshot and carries the note (empty = skip)", () => {
    expect(isMessage(finish)).toBe(true);
    expect(isScreenshotNoteFinishMessage(finish)).toBe(true);
    expect(isScreenshotNoteFinishMessage({ ...finish, note: "" })).toBe(true);
  });
  it("refuses a missing or oversized id or note", () => {
    expect(isScreenshotNoteFinishMessage({ type: "screenshot-note:finish", id: "s1" })).toBe(false);
    expect(isScreenshotNoteFinishMessage({ ...finish, note: 42 })).toBe(false);
    expect(isScreenshotNoteFinishMessage({ ...finish, id: "" })).toBe(false);
    expect(isScreenshotNoteFinishMessage({ ...finish, id: "x".repeat(101) })).toBe(false);
    expect(isScreenshotNoteFinishMessage({ ...finish, note: "x".repeat(100_001) })).toBe(false);
    expect(isScreenshotNoteFinishMessage({ ...finish, type: "entry-created" })).toBe(false);
  });
  it("is only taken from our own pages: the prompt window is a tab, so isTrustedExtensionSender would refuse it", () => {
    const ID = "abcdefghijklmnopabcdefghijklmnop";
    const prompt = { id: ID, url: `chrome-extension://${ID}/note.html?mode=screenshot&id=s1`, tab: { id: 9 }, frameId: 0 };
    expect(isOwnPageSender(prompt, ID)).toBe(true);
    expect(isTrustedExtensionSender(prompt, ID)).toBe(false);
    // The tab the screenshot was taken of (a content script there) can't answer for the user.
    expect(isOwnPageSender({ id: ID, url: "http://localhost:5173/checkout", tab: { id: 4 }, frameId: 0 }, ID)).toBe(false);
  });
});

describe("screenshot-note:draft", () => {
  const draft = { type: "screenshot-note:draft", id: "s1", draft: "Button overl" };
  it("names the pending screenshot and carries the textarea's text (empty allowed)", () => {
    expect(isMessage(draft)).toBe(true);
    expect(isScreenshotNoteDraftMessage(draft)).toBe(true);
    expect(isScreenshotNoteDraftMessage({ ...draft, draft: "" })).toBe(true);
  });
  it("refuses a missing id, a non-string or oversized draft", () => {
    expect(isScreenshotNoteDraftMessage({ ...draft, id: "" })).toBe(false);
    expect(isScreenshotNoteDraftMessage({ ...draft, draft: { text: "x" } })).toBe(false);
    expect(isScreenshotNoteDraftMessage({ ...draft, draft: "x".repeat(100_001) })).toBe(false);
    expect(isScreenshotNoteDraftMessage({ ...draft, type: "screenshot-note:finish" })).toBe(false);
  });
});

describe("transcript box messages (sent from inside a web page)", () => {
  it("voice-overlay:stop names the recording", () => {
    expect(isVoiceOverlayStopMessage({ type: "voice-overlay:stop", id: "r1" })).toBe(true);
    expect(isVoiceOverlayStopMessage({ type: "voice-overlay:stop" })).toBe(false);
    expect(isVoiceOverlayStopMessage({ type: "voice-overlay:stop", id: "" })).toBe(false);
    expect(isVoiceOverlayStopMessage({ type: "voice-overlay:close", id: "r1" })).toBe(false);
  });

  it("voice-overlay:draft carries text and what it was based on", () => {
    expect(isVoiceOverlayDraftMessage({ type: "voice-overlay:draft", id: "r1", draft: { text: "Mine", heard: "mine" } })).toBe(true);
    expect(isVoiceOverlayDraftMessage({ type: "voice-overlay:draft", id: "r1", draft: { text: "Mine" } })).toBe(false);
    expect(isVoiceOverlayDraftMessage({ type: "voice-overlay:draft", id: "r1", draft: "Mine" })).toBe(false);
  });

  it("voice-overlay:decision: save or discard, with bounded text", () => {
    const decision = { type: "voice-overlay:decision", id: "r1", save: true, text: "ok" };
    expect(isVoiceOverlayDecisionMessage(decision)).toBe(true);
    expect(isVoiceOverlayDecisionMessage({ ...decision, save: false, text: "" })).toBe(true);
    expect(isVoiceOverlayDecisionMessage({ ...decision, save: "true" })).toBe(false);
    expect(isVoiceOverlayDecisionMessage({ ...decision, text: "x".repeat(100_001) })).toBe(false);
    expect(isVoiceOverlayDecisionMessage({ ...decision, id: "x".repeat(101) })).toBe(false);
  });
});

describe("isOwnPageSender / isSenderPage", () => {
  const ID = "abcdefghijklmnopabcdefghijklmnop";
  const base = `chrome-extension://${ID}/`;
  it("accepts our pages, also when shown in a tab (the note popup window)", () => {
    expect(isOwnPageSender({ id: ID, url: `${base}note.html` }, ID)).toBe(true);
    expect(isOwnPageSender({ id: ID, url: `${base}note.html?window=1`, tab: { id: 3 }, frameId: 0 }, ID)).toBe(true);
  });
  it("refuses content scripts (their url is the web page's) and other extensions", () => {
    expect(isOwnPageSender({ id: ID, url: "http://localhost:5173/", tab: { id: 3 }, frameId: 0 }, ID)).toBe(false);
    expect(isOwnPageSender({ id: "other", url: `chrome-extension://other/note.html` }, ID)).toBe(false);
    expect(isOwnPageSender({ id: ID, url: `chrome-extension://${ID}x/note.html` }, ID)).toBe(false);
    expect(isOwnPageSender({ id: ID }, ID)).toBe(false);
  });
  it("isSenderPage pins one exact page outside any tab", () => {
    expect(isSenderPage({ id: ID, url: `${base}offscreen.html` }, ID, `${base}offscreen.html`)).toBe(true);
    expect(isSenderPage({ id: ID, url: `${base}sidepanel.html` }, ID, `${base}offscreen.html`)).toBe(false);
    expect(isSenderPage({ id: ID, url: `${base}offscreen.html`, tab: { id: 1 } }, ID, `${base}offscreen.html`)).toBe(false);
  });
});
