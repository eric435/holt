/**
 * Typed message bus between the extension's execution contexts.
 *
 * nitpick runs code in three places that cannot share memory:
 *
 *   service worker (background)  <-- chrome.runtime.sendMessage --  side panel
 *   service worker (background)  <-- chrome.runtime.sendMessage --  content scripts
 *   service worker (background)  -- chrome.tabs.sendMessage -->     content scripts
 *   service worker (background)  -- chrome.runtime.sendMessage -->  side panel (broadcast)
 *
 * Messages are JSON-serialised when they cross a context boundary, so only
 * plain data goes through here (no Blobs, no class instances, no functions).
 * That is also why the side panel uploads its own recordings instead of
 * handing them to the worker.
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

import type { Entry, ScreenshotMode, SessionInfo } from "@nitpick/protocol";

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

/** Worker -> side panel: something to tell the user (broadcast). */
export interface ToastMessage {
  type: "toast";
  level: ToastLevel;
  message: string;
}

/** Worker -> page-helper content script. */
export interface HelperMetricsRequest {
  type: "helper:metrics";
}
export interface HelperScrollRequest {
  type: "helper:scroll-to";
  y: number;
}
export interface HelperRestoreRequest {
  type: "helper:restore";
}

export interface PageMetrics {
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
  "helper:metrics": PageMetrics;
  "helper:scroll-to": { scrollY: number };
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

export function isToastMessage(value: unknown): value is ToastMessage {
  return (
    isRecord(value) &&
    value.type === "toast" &&
    typeof value.message === "string" &&
    (value.level === "info" || value.level === "success" || value.level === "error")
  );
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
