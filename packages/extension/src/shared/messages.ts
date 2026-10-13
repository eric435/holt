/**
 * Typed message bus between the extension's execution contexts.
 *
 * holt runs code in five places that cannot share memory:
 *
 *   service worker (background)  <-- chrome.runtime.sendMessage --  side panel, note popup
 *   service worker (background)  <-- chrome.runtime.sendMessage --  content scripts
 *   service worker (background)  -- chrome.tabs.sendMessage -->     content scripts
 *   service worker (background)  -- chrome.runtime.sendMessage -->  side panel (broadcast)
 *   service worker (background)  <-- chrome.runtime.sendMessage --> offscreen document (recorders)
 *   offscreen document           -- chrome.runtime.sendMessage -->  side panel (live transcript)
 *
 * Messages are JSON-serialised when they cross a context boundary, so only
 * plain data goes through here (no Blobs, no MediaStreams, no class
 * instances, no functions). That is also why whoever records something
 * uploads it: the offscreen document uploads tab recordings and voice notes,
 * the side panel uploads window/screen recordings, and the worker uploads
 * the screenshots it took.
 *
 * Message names: `offscreen:*` are requests the worker sends to the
 * offscreen document; `recorder:*` are what the offscreen document reports
 * (plus `recorder:toggle`, the panel asking the worker to start/stop one).
 *
 * ---------------------------------------------------------------------------
 * The async-response gotcha
 * ---------------------------------------------------------------------------
 * `chrome.runtime.onMessage` listeners get `(message, sender, sendResponse)`.
 * To answer asynchronously you must call `sendResponse` later AND return the
 * literal `true` from the listener synchronously, which tells Chrome to keep
 * the channel open. Returning a Promise (or using an `async` listener, which
 * returns a Promise) does NOT work in Chrome: the channel closes immediately
 * and the sender gets `undefined` or "The message port closed before a
 * response was received". `onMessage()` below hides this behind a handler that
 * may return a value or a Promise.
 *
 * The other half of the gotcha: every extension page AND the worker receive
 * every `chrome.runtime.sendMessage` (except the sender itself). A listener
 * that doesn't handle a message must return `false`/`undefined` without
 * calling `sendResponse`, so the context that does handle it can answer.
 */

import type { Entry, PageContext, ScreenshotMode, SessionInfo } from "@holt/protocol";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** A rectangle in CSS pixels, relative to the top-left of the viewport. */
export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Side panel -> worker: take a screenshot of the active tab in `windowId`. */
export interface CaptureRequest {
  type: "capture";
  mode: ScreenshotMode;
  windowId: number;
}

/** Content script (area-select) -> worker: the user finished dragging. */
export interface AreaSelectedMessage {
  type: "area-selected";
  rect: CssRect;
  /** Viewport size in CSS px at selection time, to derive the capture scale. */
  viewport: { width: number; height: number };
  devicePixelRatio: number;
}

/** Content script (area-select) -> worker: the user pressed Esc. */
export interface AreaCancelledMessage {
  type: "area-cancelled";
}

/** Worker -> side panel: an entry was written (broadcast). */
export interface EntryAddedMessage {
  type: "entry-added";
  entry: Entry;
  session: SessionInfo;
}

export type ToastLevel = "info" | "success" | "error";

/**
 * A button the panel can show on a toast. An id, not a function or URL, so a
 * message can only ever trigger one of these fixed, harmless actions.
 */
export type ToastAction = "open-permissions" | "open-shortcuts";

/** Worker -> side panel: something to tell the user (broadcast). */
export interface ToastMessage {
  type: "toast";
  level: ToastLevel;
  message: string;
  action?: ToastAction;
}

/**
 * Note popup / offscreen document -> worker: "I saved this entry". The
 * worker adds it to the recent list and tells the panel (or flashes the
 * badge), exactly as for its own screenshots.
 */
export interface EntryCreatedMessage {
  type: "entry-created";
  entry: Entry;
  session: SessionInfo;
}

// ---- recorders (offscreen document) ---------------------------------------

export type RecorderKind = "tab" | "voice";

/**
 * Everything the offscreen document needs from settings. It has no
 * chrome.storage (offscreen documents only get chrome.runtime), so the worker
 * reads settings and sends them along with every start request.
 */
export interface RecorderSettings {
  serverUrl: string;
  token: string;
  keepAudio: boolean;
  microphoneId: string;
  microphoneLabel: string;
}

/** Side panel -> worker: start or stop a recorder (same as the shortcut). */
export interface RecorderToggleRequest {
  type: "recorder:toggle";
  recorder: RecorderKind;
  /** The panel's window; the worker records that window's active tab. */
  windowId: number;
}

export type RecorderToggleResponse = { ok: true; running: boolean } | { ok: false; error: string };

/** Worker -> offscreen: record the tab behind `streamId` (from chrome.tabCapture.getMediaStreamId). */
export interface OffscreenStartTabRequest {
  type: "offscreen:start-tab";
  id: string;
  streamId: string;
  page: PageContext;
  settings: RecorderSettings;
}

/** Worker -> offscreen: start a voice note. */
export interface OffscreenStartVoiceRequest {
  type: "offscreen:start-voice";
  id: string;
  page: PageContext;
  settings: RecorderSettings;
}

export type OffscreenStartResponse =
  | {
      ok: true;
      /** Label of the microphone actually used (voice), if the browser reveals it. */
      microphoneLabel?: string;
      /** The chosen microphone was missing; the default one is used instead. */
      microphoneFallback?: boolean;
    }
  | {
      ok: false;
      error: string;
      /** DOMException name (NotAllowedError, NotFoundError, ...) so the worker can offer the right fix. */
      errorName?: string;
    };

/** Worker -> offscreen: stop a recorder; it then uploads and reports `entry-created`. */
export interface OffscreenStopRequest {
  type: "offscreen:stop";
  recorder: RecorderKind;
}

/** Worker -> offscreen: what are you doing? (used before closing the document). */
export interface OffscreenStatusRequest {
  type: "offscreen:status";
}

export interface OffscreenStatusResponse {
  ok: true;
  /** Id of the running recording per recorder, or null. */
  tab: string | null;
  voice: string | null;
  /** Recordings stopped but still uploading. */
  uploading: number;
}

/** Offscreen -> worker: a recorder stopped (by request, or because its stream ended). */
export interface RecorderStoppedMessage {
  type: "recorder:stopped";
  recorder: RecorderKind;
  id: string;
}

/** Offscreen -> worker: show this to the user (the worker owns toasts and the badge fallback). */
export interface RecorderToastMessage {
  type: "recorder:toast";
  level: ToastLevel;
  message: string;
  action?: ToastAction;
}

/** Offscreen -> worker: no recording and no upload left; the document may be closed. */
export interface RecorderIdleMessage {
  type: "recorder:idle";
}

/** Offscreen -> side panel: live transcript of the running voice note (broadcast, best effort). */
export interface RecorderTranscriptMessage {
  type: "recorder:transcript";
  final: string;
  interim: string;
}

/** Worker -> page-helper content script. */
export interface HelperMetricsRequest {
  type: "helper:metrics";
}
export interface HelperScrollRequest {
  type: "helper:scroll-to";
  y: number;
  /**
   * Hide position: fixed/sticky elements before this tile (the worker sets it
   * for every tile after the first, so a fixed header appears only once).
   * Restored by helper:restore.
   */
  hideFixed: boolean;
}

export interface HelperScrollResponse {
  scrollY: number;
  /** Pinned elements currently hidden by the helper. */
  hiddenCount: number;
  /** True if the pinned-element scan stopped at its limit on a huge page. */
  scanTruncated: boolean;
}
export interface HelperRestoreRequest {
  type: "helper:restore";
}

export interface PageMetrics {
  /**
   * False if the viewport width was still changing when the helper gave up
   * waiting (e.g. the side panel was animating open).
   */
  widthStable: boolean;
  /** Full document height in CSS px. */
  scrollHeight: number;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
}

export type Message =
  | CaptureRequest
  | AreaSelectedMessage
  | AreaCancelledMessage
  | EntryAddedMessage
  | ToastMessage
  | EntryCreatedMessage
  | RecorderToggleRequest
  | OffscreenStartTabRequest
  | OffscreenStartVoiceRequest
  | OffscreenStopRequest
  | OffscreenStatusRequest
  | RecorderStoppedMessage
  | RecorderToastMessage
  | RecorderIdleMessage
  | RecorderTranscriptMessage
  | HelperMetricsRequest
  | HelperScrollRequest
  | HelperRestoreRequest;

export type MessageType = Message["type"];

/** What the receiver answers for each message type. */
export interface ResponseMap {
  capture: CaptureResponse;
  "area-selected": Ack;
  "area-cancelled": Ack;
  "entry-added": Ack;
  toast: Ack;
  "entry-created": Ack;
  "recorder:toggle": RecorderToggleResponse;
  "offscreen:start-tab": OffscreenStartResponse;
  "offscreen:start-voice": OffscreenStartResponse;
  "offscreen:stop": { ok: true; wasRunning: boolean };
  "offscreen:status": OffscreenStatusResponse;
  "recorder:stopped": Ack;
  "recorder:toast": Ack;
  "recorder:idle": Ack;
  "recorder:transcript": Ack;
  "helper:metrics": PageMetrics;
  "helper:scroll-to": HelperScrollResponse;
  "helper:restore": Ack;
}

export type ResponseFor<M extends Message> = ResponseMap[M["type"]];

export interface Ack {
  ok: true;
}

export type CaptureResponse =
  | {
      ok: true;
      /** The entry that was written. Absent while an area selection is pending. */
      entry?: Entry;
      /** Area mode: the overlay is up; the result arrives as an `entry-added` broadcast. */
      pending?: boolean;
    }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Type guards
//
// Messages from content scripts originate in a web page's renderer process,
// so the worker validates them field by field instead of trusting the type.
// ---------------------------------------------------------------------------

const MESSAGE_TYPES: ReadonlySet<string> = new Set<MessageType>([
  "capture",
  "area-selected",
  "area-cancelled",
  "entry-added",
  "toast",
  "entry-created",
  "recorder:toggle",
  "offscreen:start-tab",
  "offscreen:start-voice",
  "offscreen:stop",
  "offscreen:status",
  "recorder:stopped",
  "recorder:toast",
  "recorder:idle",
  "recorder:transcript",
  "helper:metrics",
  "helper:scroll-to",
  "helper:restore",
]);

const SCREENSHOT_MODES: ReadonlySet<string> = new Set<ScreenshotMode>(["viewport", "full-page", "area"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Is this one of our messages at all (by `type`)? */
export function isMessage(value: unknown): value is Message {
  return isRecord(value) && typeof value.type === "string" && MESSAGE_TYPES.has(value.type);
}

export function isCaptureRequest(value: unknown): value is CaptureRequest {
  return (
    isRecord(value) &&
    value.type === "capture" &&
    typeof value.mode === "string" &&
    SCREENSHOT_MODES.has(value.mode) &&
    Number.isInteger(value.windowId)
  );
}

export function isCssRect(value: unknown): value is CssRect {
  return (
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height) &&
    value.width > 0 &&
    value.height > 0
  );
}

export function isAreaSelectedMessage(value: unknown): value is AreaSelectedMessage {
  if (!isRecord(value) || value.type !== "area-selected") return false;
  const { viewport, devicePixelRatio } = value;
  return (
    isCssRect(value.rect) &&
    isRecord(viewport) &&
    isFiniteNumber(viewport.width) &&
    isFiniteNumber(viewport.height) &&
    viewport.width > 0 &&
    viewport.height > 0 &&
    isFiniteNumber(devicePixelRatio) &&
    devicePixelRatio > 0
  );
}

export function isAreaCancelledMessage(value: unknown): value is AreaCancelledMessage {
  return isRecord(value) && value.type === "area-cancelled";
}

export function isEntryAddedMessage(value: unknown): value is EntryAddedMessage {
  return isRecord(value) && value.type === "entry-added" && isRecord(value.entry) && isRecord(value.session);
}

const TOAST_ACTIONS: ReadonlySet<string> = new Set<ToastAction>(["open-permissions", "open-shortcuts"]);
const RECORDERS: ReadonlySet<string> = new Set<RecorderKind>(["tab", "voice"]);

function isToastLevel(value: unknown): value is ToastLevel {
  return value === "info" || value === "success" || value === "error";
}

/** Shared by `toast` and `recorder:toast`: a level, a message, and optionally a known action. */
function isToastShape(value: Record<string, unknown>): boolean {
  return isToastLevel(value.level) && typeof value.message === "string" && (value.action === undefined || (typeof value.action === "string" && TOAST_ACTIONS.has(value.action)));
}

export function isToastMessage(value: unknown): value is ToastMessage {
  return isRecord(value) && value.type === "toast" && isToastShape(value);
}

export function isRecorderToastMessage(value: unknown): value is RecorderToastMessage {
  return isRecord(value) && value.type === "recorder:toast" && isToastShape(value);
}

export function isEntryCreatedMessage(value: unknown): value is EntryCreatedMessage {
  return (
    isRecord(value) &&
    value.type === "entry-created" &&
    isRecord(value.entry) &&
    typeof value.entry.id === "string" &&
    Number.isInteger(value.entry.seq) &&
    isRecord(value.session) &&
    typeof value.session.id === "string"
  );
}

export function isRecorderToggleRequest(value: unknown): value is RecorderToggleRequest {
  return (
    isRecord(value) &&
    value.type === "recorder:toggle" &&
    typeof value.recorder === "string" &&
    RECORDERS.has(value.recorder) &&
    Number.isInteger(value.windowId)
  );
}

export function isRecorderStoppedMessage(value: unknown): value is RecorderStoppedMessage {
  return isRecord(value) && value.type === "recorder:stopped" && typeof value.recorder === "string" && RECORDERS.has(value.recorder) && typeof value.id === "string";
}

export function isRecorderTranscriptMessage(value: unknown): value is RecorderTranscriptMessage {
  return isRecord(value) && value.type === "recorder:transcript" && typeof value.final === "string" && typeof value.interim === "string";
}

function isPageContext(value: unknown): value is PageContext {
  return isRecord(value) && typeof value.url === "string" && typeof value.title === "string";
}

function isRecorderSettings(value: unknown): value is RecorderSettings {
  return (
    isRecord(value) &&
    typeof value.serverUrl === "string" &&
    typeof value.token === "string" &&
    typeof value.keepAudio === "boolean" &&
    typeof value.microphoneId === "string" &&
    typeof value.microphoneLabel === "string"
  );
}

export function isOffscreenStartTabRequest(value: unknown): value is OffscreenStartTabRequest {
  return (
    isRecord(value) &&
    value.type === "offscreen:start-tab" &&
    typeof value.id === "string" &&
    typeof value.streamId === "string" &&
    value.streamId !== "" &&
    isPageContext(value.page) &&
    isRecorderSettings(value.settings)
  );
}

export function isOffscreenStartVoiceRequest(value: unknown): value is OffscreenStartVoiceRequest {
  return isRecord(value) && value.type === "offscreen:start-voice" && typeof value.id === "string" && isPageContext(value.page) && isRecorderSettings(value.settings);
}

export function isOffscreenStopRequest(value: unknown): value is OffscreenStopRequest {
  return isRecord(value) && value.type === "offscreen:stop" && typeof value.recorder === "string" && RECORDERS.has(value.recorder);
}

// ---------------------------------------------------------------------------
// Sender checks
//
// `chrome.runtime.onMessage` only delivers messages from our own extension,
// but "our own extension" includes content scripts, which run inside web
// pages. A compromised page renderer could forge messages from them. So:
//  - commands that act (capture) and broadcasts the panel trusts
//    (entry-added, toast) must come from an extension page or the worker,
//    never from a tab;
//  - area-select results must come from the top frame of the tab we
//    injected the overlay into.
// ---------------------------------------------------------------------------

/** The MessageSender fields we look at (keeps the helpers pure and testable). */
export interface SenderLike {
  id?: string | undefined;
  tab?: { id?: number | undefined } | undefined;
  frameId?: number | undefined;
  url?: string | undefined;
}

/**
 * Sent by our worker or one of our extension pages (side panel), not by a
 * content script. Content-script messages always carry `sender.tab`. (An
 * extension page opened in a tab also has `sender.tab`, and is refused too:
 * the panel is never a tab.)
 */
export function isTrustedExtensionSender(sender: SenderLike, runtimeId: string): boolean {
  return Boolean(runtimeId) && sender.id === runtimeId && !sender.tab;
}

/**
 * Sent by one of our own extension pages, wherever it is shown: the side
 * panel, the offscreen document, the note popup, or the note page opened in
 * its own popup window (which, unlike the action popup, IS a tab, so
 * `isTrustedExtensionSender` would refuse it). A content script's
 * `sender.url` is the URL of the web page it runs in, and no web page can
 * have our chrome-extension:// URL because we expose no
 * web_accessible_resources.
 */
export function isOwnPageSender(sender: SenderLike, runtimeId: string): boolean {
  return Boolean(runtimeId) && sender.id === runtimeId && (sender.url ?? "").startsWith(`chrome-extension://${runtimeId}/`);
}

/** Sent by the page at exactly `pageUrl` (e.g. our offscreen document), not from a tab. */
export function isSenderPage(sender: SenderLike, runtimeId: string, pageUrl: string): boolean {
  return isTrustedExtensionSender(sender, runtimeId) && sender.url === pageUrl;
}

/** Sent from the top frame (frameId 0) of tab `tabId`. */
export function isTopFrameOfTab(sender: SenderLike, tabId: number): boolean {
  return sender.tab?.id === tabId && sender.frameId === 0;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Send to the extension's own contexts (worker + open extension pages).
 * Resolves with the first response. Rejects with "Could not establish
 * connection. Receiving end does not exist." when nobody is listening, which
 * the worker uses to detect that the side panel is closed.
 */
export function sendMessage<M extends Message>(message: M): Promise<ResponseFor<M>> {
  return chrome.runtime.sendMessage<M, ResponseFor<M>>(message);
}

/** Send to the content scripts of one tab (the worker -> page-helper direction). */
export function sendToTab<M extends Message>(tabId: number, message: M): Promise<ResponseFor<M>> {
  return chrome.tabs.sendMessage<M, ResponseFor<M>>(tabId, message);
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

/**
 * A handler returns:
 *  - `undefined` if it does not handle this message (another context will), or
 *  - a response value, or a Promise of one.
 * A thrown error / rejected Promise is answered as `{ ok: false, error }`.
 */
export type MessageHandler = (
  message: Message,
  sender: chrome.runtime.MessageSender,
) => unknown;

/**
 * Register a typed `chrome.runtime.onMessage` listener that copes with the
 * async-response rules described at the top of this file. Returns a function
 * that removes the listener.
 */
export function onMessage(handler: MessageHandler): () => void {
  const listener = (
    raw: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    if (!isMessage(raw)) return false;
    let result: unknown;
    try {
      result = handler(raw, sender);
    } catch (error) {
      sendResponse({ ok: false, error: errorMessage(error) });
      return false;
    }
    if (result === undefined) return false; // not ours: let another context answer
    if (result instanceof Promise) {
      result.then(sendResponse, (error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }));
      return true; // keep the channel open until sendResponse is called
    }
    sendResponse(result);
    return false;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

/** Best-effort human-readable text for anything that was thrown. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** True for the error Chrome raises when no context is listening. */
export function isNoReceiverError(error: unknown): boolean {
  const text = errorMessage(error);
  return text.includes("Receiving end does not exist") || text.includes("message port closed");
}
