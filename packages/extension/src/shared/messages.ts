/**
 * Typed message bus between the extension's execution contexts.
 *
 * holt runs code in five places that cannot share memory:
 *
 *   service worker (background)  <-- chrome.runtime.sendMessage --  note popup ("I saved this entry")
 *   service worker (background)  <-- chrome.runtime.sendMessage --  content scripts
 *   service worker (background)  -- chrome.tabs.sendMessage -->     content scripts
 *   service worker (background)  -- chrome.runtime.sendMessage -->  side panel (broadcast)
 *   service worker (background)  <-- chrome.runtime.sendMessage --> offscreen document (recorders)
 *   offscreen document           -- chrome.runtime.sendMessage -->  worker (live transcript, finished recordings)
 *   service worker (background)  <-- chrome.tabs.sendMessage -->    voice overlay (editable transcript on the page)
 *   service worker (background)  <-- chrome.runtime.sendMessage --  toolbar menu (menu.html)
 *   service worker (background)  <-- chrome.runtime.sendMessage --  screenshot note prompt (note.html?mode=screenshot)
 *   service worker (background)  <-- chrome.runtime.sendMessage --  menu, side panel ("check the server again")
 *
 * Messages are JSON-serialised when they cross a context boundary, so only
 * plain data goes through here (no Blobs, no MediaStreams, no class
 * instances, no functions). That is also why whoever records something
 * uploads it: the offscreen document uploads tab recordings and voice notes,
 * the worker uploads the screenshots it took, and the note popup posts its
 * own note.
 *
 * Message names: `offscreen:*` are requests the worker sends to the
 * offscreen document; `recorder:*` are what the offscreen document reports;
 * `voice-overlay:*` go between the worker and the transcript box on the page
 * (shown for voice notes and tab recordings alike); `menu:run` is the
 * toolbar menu asking the worker to do what one of the shortcuts does;
 * `screenshot-note:*` are the note prompt shown after a screenshot: its
 * text as the user types (`draft`, so no way out loses it) and the user's
 * answer (`finish`), after which the worker writes the screenshot's one
 * entry; `server-info:refresh` asks the worker to check the server for the
 * page in front again (background/server-info.ts).
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

import type { Entry, PageContext, SessionInfo } from "@holt/protocol";

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

/**
 * Screenshot note prompt -> worker: the user answered the prompt for the
 * pending screenshot `id` (see background/pending-screenshot.ts): Save with
 * `note`, or Skip (`note` empty). The worker posts the screenshot entry, with
 * the note if there is one, and answers with it.
 */
export interface ScreenshotNoteFinishMessage {
  type: "screenshot-note:finish";
  id: string;
  note: string;
}

export type ScreenshotNoteFinishResponse =
  | {
      ok: true;
      /** The entry written; absent if this screenshot had already been saved (without the note), or was dropped. */
      entry?: Entry;
      /**
       * The screenshot's session was gone (the server no longer has its
       * upload as an unused file of the current session), so `entry` is the
       * user's words as a separate note entry, or, with nothing typed,
       * nothing was written.
       */
      sessionGone?: true;
    }
  | { ok: false; error: string };

/**
 * Screenshot note prompt -> worker: what is in the textarea now (debounced,
 * and once more when the prompt goes away). Kept with the pending
 * screenshot, so the paths that write it without the prompt's answer (the
 * next screenshot, the window closing, a browser restart) still have the
 * user's words.
 */
export interface ScreenshotNoteDraftMessage {
  type: "screenshot-note:draft";
  id: string;
  draft: string;
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
  /** Transcribe the microphone (Settings.transcribe); false: no speech recogniser is started. */
  transcribe: boolean;
  keepAudio: boolean;
  microphoneId: string;
  microphoneLabel: string;
}

/**
 * The shortcuts the toolbar menu runs through the worker (a subset of
 * CommandName in shared/shortcuts.ts). Its Quick note item opens the note
 * page in the menu's own popup instead, and Settings opens the panel itself.
 */
export type MenuCommand = "screenshot-area" | "screenshot-viewport" | "screenshot-full" | "toggle-voice" | "toggle-recording";

/**
 * Toolbar menu -> worker: do what this shortcut does, on the active tab of
 * `windowId`. Answered right away, before the work is done, so the menu can
 * close (it has to, for an area selection) without cutting the work short.
 */
export interface MenuRunRequest {
  type: "menu:run";
  command: MenuCommand;
  windowId: number;
}

/**
 * Menu / side panel -> worker: check the server for the page in front again
 * and update `serverInfo` (background/server-info.ts). Answered once done.
 */
export interface ServerInfoRefreshRequest {
  type: "server-info:refresh";
}

/** What starting or stopping a recorder came to (the shortcuts, the menu, the box's Stop). */
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
      /**
       * The recorder was already running a recording, with this id: one the
       * worker has lost track of (its state was cleared under it), since the
       * worker only starts a recorder whose slot is empty. The worker stops
       * it (which saves it) rather than leaving it orphaned.
       */
      runningId?: string;
    };

/**
 * Worker -> offscreen: stop a recorder. It reports `recorder:finished` with
 * the transcript, then waits for `offscreen:commit` before it uploads.
 */
export interface OffscreenStopRequest {
  type: "offscreen:stop";
  recorder: RecorderKind;
}

/** Worker -> offscreen: what are you doing? (used before closing the document). */
export interface OffscreenStatusRequest {
  type: "offscreen:status";
}

/**
 * Worker -> offscreen: what to do with a finished recording (`recorder:finished`):
 * save it with `transcript` (the user's reviewed text), or throw it away.
 */
export interface OffscreenCommitRequest {
  type: "offscreen:commit";
  id: string;
  save: boolean;
  transcript: string;
}

export interface OffscreenCommitResponse {
  ok: true;
  /** False if no finished recording with this id was waiting (already committed, or timed out and saved). */
  found: boolean;
}

export interface OffscreenStatusResponse {
  ok: true;
  /** Id of the running recording per recorder, or null. */
  tab: string | null;
  voice: string | null;
  /** Recordings stopped but not saved yet (waiting for the user's review, or uploading). */
  finishing: number;
}

/** Offscreen -> worker: a recorder stopped (by request, or because its stream ended). */
export interface RecorderStoppedMessage {
  type: "recorder:stopped";
  recorder: RecorderKind;
  id: string;
}

/**
 * Offscreen -> worker: recording `id` has stopped and this is its complete
 * transcript. The worker lets the user review it (voice-overlay:finish) and
 * answers with `offscreen:commit`.
 */
export interface RecorderFinishedMessage {
  type: "recorder:finished";
  recorder: RecorderKind;
  id: string;
  transcript: string;
  error?: string;
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

/**
 * Offscreen -> worker: live transcript of a running voice note or tab
 * recording (best effort). The worker forwards it to the box on the page.
 */
export interface RecorderTranscriptMessage {
  type: "recorder:transcript";
  recorder: RecorderKind;
  id: string;
  /** Everything recognised so far; only ever grows. */
  final: string;
  interim: string;
  /** Why transcription stopped working, if it did (the audio is still recorded). */
  error?: string;
}

// ---- voice overlay (content script: the editable transcript on the page) --

/**
 * What the user has made of a transcript so far: their `text`, and the
 * recogniser's `final` it was based on (speech recognised later is appended
 * to `text`; see shared/transcript-text.ts).
 */
export interface TranscriptDraft {
  text: string;
  heard: string;
}

/** Worker -> voice overlay: show this (creates the box if needed). */
export interface VoiceOverlayUpdate {
  type: "voice-overlay:update";
  /** The recording this box belongs to. */
  id: string;
  recorder: RecorderKind;
  /** When the recording started (epoch ms), for the timer. */
  startedAt: number;
  final: string;
  interim: string;
  error?: string;
  /** The user's edits, kept by the worker, for a box re-created after a navigation. */
  draft?: TranscriptDraft;
  /** Transcription is off for this recording (Settings.transcribe): the box says so instead of "Listening…". */
  untranscribed?: true;
}

/**
 * Worker -> voice overlay: recording `id` stopped and this is its whole
 * transcript. The box closes (review: false: save the transcript as is) or,
 * if the user has clicked into it or edited it, stays open for them to
 * finish and Save or Discard (review: true; the answer comes later as
 * `voice-overlay:decision`).
 */
export interface VoiceOverlayFinish {
  type: "voice-overlay:finish";
  id: string;
  transcript: string;
}

export interface VoiceOverlayFinishResponse {
  ok: true;
  review: boolean;
}

/**
 * Worker -> voice overlay: hide the box for a screenshot (answered once the
 * page has repainted without it) or show it again.
 */
export interface VoiceOverlayVisibility {
  type: "voice-overlay:visibility";
  hidden: boolean;
}

/** Worker -> voice overlay: recording `id` is gone (nothing to save); remove its box. */
export interface VoiceOverlayClose {
  type: "voice-overlay:close";
  id: string;
}

/** Voice overlay -> worker: the user clicked Stop in the box of recording `id`. */
export interface VoiceOverlayStop {
  type: "voice-overlay:stop";
  id: string;
}

/** Voice overlay -> worker: the user edited the transcript (debounced); kept so a navigation doesn't lose it. */
export interface VoiceOverlayDraft {
  type: "voice-overlay:draft";
  id: string;
  draft: TranscriptDraft;
}

/** Voice overlay -> worker: the user reviewed recording `id`'s transcript: Save (with `text`) or Discard. */
export interface VoiceOverlayDecision {
  type: "voice-overlay:decision";
  id: string;
  save: boolean;
  text: string;
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
  | AreaSelectedMessage
  | AreaCancelledMessage
  | EntryAddedMessage
  | ToastMessage
  | EntryCreatedMessage
  | MenuRunRequest
  | ScreenshotNoteFinishMessage
  | ScreenshotNoteDraftMessage
  | ServerInfoRefreshRequest
  | OffscreenStartTabRequest
  | OffscreenStartVoiceRequest
  | OffscreenStopRequest
  | OffscreenStatusRequest
  | OffscreenCommitRequest
  | RecorderStoppedMessage
  | RecorderFinishedMessage
  | RecorderToastMessage
  | RecorderIdleMessage
  | RecorderTranscriptMessage
  | VoiceOverlayUpdate
  | VoiceOverlayVisibility
  | VoiceOverlayFinish
  | VoiceOverlayClose
  | VoiceOverlayStop
  | VoiceOverlayDraft
  | VoiceOverlayDecision
  | HelperMetricsRequest
  | HelperScrollRequest
  | HelperRestoreRequest;

export type MessageType = Message["type"];

/** What the receiver answers for each message type. */
export interface ResponseMap {
  "area-selected": Ack;
  "area-cancelled": Ack;
  "entry-added": Ack;
  toast: Ack;
  "entry-created": Ack;
  "menu:run": Ack | { ok: false; error: string };
  "screenshot-note:finish": ScreenshotNoteFinishResponse;
  "screenshot-note:draft": Ack;
  "server-info:refresh": Ack;
  "offscreen:start-tab": OffscreenStartResponse;
  "offscreen:start-voice": OffscreenStartResponse;
  "offscreen:stop": { ok: true; wasRunning: boolean };
  "offscreen:status": OffscreenStatusResponse;
  "offscreen:commit": OffscreenCommitResponse;
  "recorder:stopped": Ack;
  "recorder:finished": Ack;
  "recorder:toast": Ack;
  "recorder:idle": Ack;
  "recorder:transcript": Ack;
  "voice-overlay:update": Ack;
  "voice-overlay:visibility": Ack;
  "voice-overlay:finish": VoiceOverlayFinishResponse;
  "voice-overlay:close": Ack;
  "voice-overlay:stop": RecorderToggleResponse;
  "voice-overlay:draft": Ack;
  "voice-overlay:decision": Ack | { ok: false; error: string };
  "helper:metrics": PageMetrics;
  "helper:scroll-to": HelperScrollResponse;
  "helper:restore": Ack;
}

export type ResponseFor<M extends Message> = ResponseMap[M["type"]];

export interface Ack {
  ok: true;
}

/** What `takeScreenshot` (background/actions.ts) came to. */
export type CaptureResponse =
  | {
      ok: true;
      /**
       * Always true: the entry is written later, once the user answered the
       * note prompt (or, in area mode, finished dragging first). It arrives
       * as an `entry-added` broadcast.
       */
      pending: true;
    }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Type guards
//
// Messages from content scripts originate in a web page's renderer process,
// so the worker validates them field by field instead of trusting the type.
// ---------------------------------------------------------------------------

const MESSAGE_TYPES: ReadonlySet<string> = new Set<MessageType>([
  "area-selected",
  "area-cancelled",
  "entry-added",
  "toast",
  "entry-created",
  "menu:run",
  "screenshot-note:finish",
  "screenshot-note:draft",
  "server-info:refresh",
  "offscreen:start-tab",
  "offscreen:start-voice",
  "offscreen:stop",
  "offscreen:status",
  "offscreen:commit",
  "recorder:stopped",
  "recorder:finished",
  "recorder:toast",
  "recorder:idle",
  "recorder:transcript",
  "voice-overlay:update",
  "voice-overlay:visibility",
  "voice-overlay:finish",
  "voice-overlay:close",
  "voice-overlay:stop",
  "voice-overlay:draft",
  "voice-overlay:decision",
  "helper:metrics",
  "helper:scroll-to",
  "helper:restore",
]);

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

const MENU_COMMANDS: ReadonlySet<string> = new Set<MenuCommand>(["screenshot-area", "screenshot-viewport", "screenshot-full", "toggle-voice", "toggle-recording"]);

export function isMenuRunRequest(value: unknown): value is MenuRunRequest {
  return isRecord(value) && value.type === "menu:run" && typeof value.command === "string" && MENU_COMMANDS.has(value.command) && Number.isInteger(value.windowId);
}

/**
 * The prompt is an extension page, but a screenshot note is user text bound
 * for notes.md, so the shape is still checked (the length cap matches the
 * transcript box's).
 */
export function isScreenshotNoteFinishMessage(value: unknown): value is ScreenshotNoteFinishMessage {
  return isRecord(value) && value.type === "screenshot-note:finish" && isRecordingId(value.id) && isTranscriptText(value.note);
}

export function isScreenshotNoteDraftMessage(value: unknown): value is ScreenshotNoteDraftMessage {
  return isRecord(value) && value.type === "screenshot-note:draft" && isRecordingId(value.id) && isTranscriptText(value.draft);
}

export function isRecorderStoppedMessage(value: unknown): value is RecorderStoppedMessage {
  return isRecord(value) && value.type === "recorder:stopped" && typeof value.recorder === "string" && RECORDERS.has(value.recorder) && typeof value.id === "string";
}

export function isRecorderTranscriptMessage(value: unknown): value is RecorderTranscriptMessage {
  return (
    isRecord(value) &&
    value.type === "recorder:transcript" &&
    isRecorderKind(value.recorder) &&
    typeof value.id === "string" &&
    typeof value.final === "string" &&
    typeof value.interim === "string" &&
    (value.error === undefined || typeof value.error === "string")
  );
}

export function isRecorderFinishedMessage(value: unknown): value is RecorderFinishedMessage {
  return (
    isRecord(value) &&
    value.type === "recorder:finished" &&
    isRecorderKind(value.recorder) &&
    typeof value.id === "string" &&
    typeof value.transcript === "string" &&
    (value.error === undefined || typeof value.error === "string")
  );
}

export function isOffscreenCommitRequest(value: unknown): value is OffscreenCommitRequest {
  return isRecord(value) && value.type === "offscreen:commit" && typeof value.id === "string" && typeof value.save === "boolean" && typeof value.transcript === "string";
}

// The overlay's messages come from inside a web page: shapes are checked
// here, and the worker also checks that the sender is the tab the box is in.

/** Longest transcript the overlay may send (a very long note is ~10k characters). */
const MAX_TRANSCRIPT_CHARS = 100_000;

function isTranscriptText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TRANSCRIPT_CHARS;
}

function isRecordingId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 100;
}

export function isVoiceOverlayStopMessage(value: unknown): value is VoiceOverlayStop {
  return isRecord(value) && value.type === "voice-overlay:stop" && isRecordingId(value.id);
}

export function isVoiceOverlayDraftMessage(value: unknown): value is VoiceOverlayDraft {
  return (
    isRecord(value) &&
    value.type === "voice-overlay:draft" &&
    isRecordingId(value.id) &&
    isRecord(value.draft) &&
    isTranscriptText(value.draft.text) &&
    isTranscriptText(value.draft.heard)
  );
}

export function isVoiceOverlayDecisionMessage(value: unknown): value is VoiceOverlayDecision {
  return isRecord(value) && value.type === "voice-overlay:decision" && isRecordingId(value.id) && typeof value.save === "boolean" && isTranscriptText(value.text);
}

function isPageContext(value: unknown): value is PageContext {
  return isRecord(value) && typeof value.url === "string" && typeof value.title === "string";
}

function isRecorderSettings(value: unknown): value is RecorderSettings {
  return (
    isRecord(value) &&
    typeof value.serverUrl === "string" &&
    typeof value.token === "string" &&
    typeof value.transcribe === "boolean" &&
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
  return isRecord(value) && value.type === "offscreen:stop" && isRecorderKind(value.recorder);
}

function isRecorderKind(value: unknown): value is RecorderKind {
  return typeof value === "string" && RECORDERS.has(value);
}

// ---------------------------------------------------------------------------
// Sender checks
//
// `chrome.runtime.onMessage` only delivers messages from our own extension,
// but "our own extension" includes content scripts, which run inside web
// pages. A compromised page renderer could forge messages from them. So:
//  - commands that act (menu:run) and broadcasts the panel trusts
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
