/**
 * Ephemeral, cross-context state kept in `chrome.storage.session`.
 *
 * Why not module-level variables? An MV3 service worker is not a long-lived
 * background page: Chrome terminates it after ~30 s without events and starts
 * a fresh one (re-running background.js from the top) when the next event
 * arrives. Anything kept in a `let` at module scope silently resets. Example:
 * the user starts an area selection, takes 40 s to drag, and the
 * "area-selected" message wakes up a brand-new worker that never heard of
 * the selection. State that has to outlive one event therefore goes here.
 *
 * Why `storage.session` and not `storage.local`? It lives in memory only, is
 * cleared when the browser restarts (exactly the lifetime we want for "what
 * is pending right now"), and by default is visible only to trusted
 * extension contexts (worker + extension pages), not to content scripts that
 * run inside web pages.
 *
 * It is also the source of truth for "what is recording right now"
 * (`recordingScreen`, `recordingVoice`): the recorders run in the offscreen
 * document, which has no chrome.storage, so the worker mirrors their state
 * here; a restarted worker, the toolbar menu, the note prompt and the
 * toolbar indicator all read it from here. Only the worker writes them
 * (background/recording.ts, serialised there); two keys, so a stop of one
 * never has to read-modify-write the other.
 *
 * This lives in shared/ (not background/) because extension pages read the
 * same keys: the menu and the indicator the recording state, the note popup
 * `noteContext` (which the menu also writes, for its Quick note item), the
 * screenshot note prompt `pendingScreenshot` (the worker alone writes it).
 *
 * One exception to "session only": the pending screenshot is mirrored into
 * chrome.storage.local (`PENDING_SCREENSHOT_BACKUP_KEY`, see
 * background/pending-screenshot.ts), so quitting the browser with its note
 * prompt open doesn't lose the entry. storage.local is restricted to trusted
 * contexts too (shared/settings.ts, `restrictStorageAccess`).
 */

import type { Entry, PageContext, ScreenshotMode } from "@holt/protocol";
import type { RecorderKind, TranscriptDraft } from "./messages.js";
import type { ProbeCache, ServerSource } from "./server-resolve.js";

/** An area selection the worker started and is waiting to hear back about. */
export interface PendingArea {
  tabId: number;
  windowId: number;
  page: PageContext;
  startedAt: number;
}

/**
 * A running tab recording: chrome.tabCapture in the offscreen document,
 * started by the worker (background/recording.ts). The key is still called
 * `recordingScreen` (the slot once also held window/screen recordings).
 */
export interface ScreenRecordingState {
  /** Random id, so late events from an older recording can't clear a newer one. */
  id: string;
  startedAt: number;
  page: PageContext;
  /** The captured tab. */
  tabId: number;
}

/** A running voice note (offscreen document). */
export interface VoiceRecordingState {
  id: string;
  startedAt: number;
  page: PageContext;
  /** Label of the microphone in use, if known ("" = system default). */
  microphoneLabel: string;
  /** The selected microphone was missing, so the default is used. */
  microphoneFallback?: boolean;
  /** The tab the note was started on, where its live transcript is shown (content/voice-overlay.ts). */
  tabId?: number;
}

/**
 * The editable transcript box of a voice note or tab recording, from the
 * start of the recording until its transcript is saved or discarded (which
 * is after the recording stopped, if the user reviews it). Written by the
 * worker only (background/voice-overlay.ts).
 */
export interface TranscriptBoxState {
  recorder: RecorderKind;
  /** The tab the box is shown in; only that tab's top frame may act on it. */
  tabId: number;
  startedAt: number;
  /** The user's edits, so a box re-created after a navigation keeps them. */
  draft?: TranscriptDraft;
  /** Transcription was off when the recording started: the box says so (and only shows what the user types). */
  untranscribed?: true;
}

/** Both recording slots, as read together by the indicator and the panel. */
export interface RecordingState {
  screen?: ScreenRecordingState | undefined;
  voice?: VoiceRecordingState | undefined;
}

/** What the worker hands the note popup: the page the user was on when they pressed the shortcut. */
export interface NoteContext {
  page: PageContext;
  /** Window the note was requested in (the popup may be in its own window). */
  windowId: number;
  /** When the shortcut was pressed (epoch ms); also identifies this context. */
  at: number;
  /**
   * The server for that page (shared/server.ts). Written a moment after the
   * rest: the popup has to be opened synchronously in the shortcut's
   * handler, before the server could be resolved, so the worker writes the
   * context twice and the popup waits for this field when it saves.
   */
  serverUrl?: string;
}

/**
 * A screenshot that is uploaded (`POST /media` returned `file`) but whose
 * entry is not written yet: the worker is waiting for the user's note in
 * the note prompt (background/pending-screenshot.ts). At most one at a time.
 */
export interface PendingScreenshot {
  /** Random id; the prompt answers for this id, so a stale prompt can't finish a newer screenshot. */
  id: string;
  page: PageContext;
  /** ISO timestamp of the capture (the entry's `capturedAt`). */
  capturedAt: string;
  /** File name the server chose for the upload. */
  file: string;
  /**
   * The server the PNG was uploaded to: the entry must go to the same one
   * (the file only exists in that server's session), even if the tab has
   * navigated or the settings changed since.
   */
  serverUrl: string;
  mode: ScreenshotMode;
  width: number;
  height: number;
  /** The browser window and tab the screenshot was taken in. */
  windowId: number;
  tabId: number;
  /** When it became pending (epoch ms). */
  at: number;
  /** The prompt's popup window, once it is open. */
  popupWindowId?: number;
  /**
   * What the user has typed in the prompt so far (`screenshot-note:draft`).
   * Posted as the note by every path that writes the screenshot without the
   * prompt's own answer: the next screenshot, the window closing, a worker
   * or browser restart.
   */
  draft?: string;
  /**
   * The server refused the screenshot's entry for good (a 4xx: its upload
   * is not an unused file of the current session any more, e.g. a new
   * session was started meanwhile). The user's words are then saved as a
   * separate note instead (background/pending-screenshot.ts).
   */
  sessionGone?: true;
}

/**
 * Is there a holt server for the page the user is looking at? Written only
 * by the worker (background/server-info.ts) for the active tab of the last
 * focused browser window, read by the toolbar indicator (badge and tooltip)
 * and the toolbar menu (header).
 *
 * "Connected" (`ok: true`) means: the server that a capture on that tab
 * would go to right now (shared/server.ts) answered GET /status as holt,
 * with our token if one is set.
 */
export type ServerInfo = ServerInfoBase & (
  | { ok: true; project: string | null; version: string }
  | { ok: false; message: string }
);

interface ServerInfoBase {
  serverUrl: string;
  source: ServerSource;
  /** The tab is an http(s) page on a loopback host, i.e. where you'd use holt (the red "!" badge is only shown there). */
  localPage: boolean;
}

/** An entry shown in the panel's list (kept so the list survives closing the panel). */
export interface RecentEntry {
  sessionId: string;
  entry: Entry;
}

interface SessionState {
  pendingArea: PendingArea;
  recentEntries: RecentEntry[];
  recordingScreen: ScreenRecordingState;
  recordingVoice: VoiceRecordingState;
  noteContext: NoteContext;
  pendingScreenshot: PendingScreenshot;
  serverInfo: ServerInfo;
  /** Auto-detection results by origin (shared/server-resolve.ts). */
  serverProbes: ProbeCache;
  /**
   * Origins that have answered as holt at least once since the browser
   * started (shared/server-resolve.ts): for those, a failed probe is an
   * error ("holt isn't answering"), never a fallback to another server.
   */
  holtOrigins: string[];
  /** By recording id. */
  transcriptBoxes: Record<string, TranscriptBoxState>;
}

export type StateKey = keyof SessionState;

const MAX_RECENT_ENTRIES = 30;

export async function getState<K extends StateKey>(key: K): Promise<SessionState[K] | undefined> {
  const result = await chrome.storage.session.get(key);
  return result[key] as SessionState[K] | undefined;
}

export function setState<K extends StateKey>(key: K, value: SessionState[K]): Promise<void> {
  return chrome.storage.session.set({ [key]: value });
}

export function clearState(key: StateKey): Promise<void> {
  return chrome.storage.session.remove(key);
}

/** Run `listener` with the new value whenever `key` changes, in any context. */
export function onStateChanged<K extends StateKey>(key: K, listener: (value: SessionState[K] | undefined) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    const change = changes[key];
    if (area === "session" && change) listener(change.newValue as SessionState[K] | undefined);
  });
}

/**
 * Prepend an entry to the recent list. Only the worker writes it (every
 * saved entry reaches it: its own screenshots, and `entry-created` from the
 * offscreen document and the note popup), but two of those can land at
 * once, e.g. a flushed screenshot and a recording's upload. The
 * read-modify-write is therefore serialised, like the transcript boxes'
 * (background/voice-overlay.ts), so neither drops the other from the list.
 */
let recentWrites: Promise<unknown> = Promise.resolve();
export function addRecentEntry(item: RecentEntry): Promise<void> {
  const run = recentWrites.then(async () => {
    const list = (await getState("recentEntries")) ?? [];
    await setState("recentEntries", prependRecent(list, item));
  });
  recentWrites = run.catch(() => undefined);
  return run;
}

/** `item` first, without an older copy of the same entry, capped. Pure. */
export function prependRecent(list: readonly RecentEntry[], item: RecentEntry): RecentEntry[] {
  return [item, ...list.filter((e) => e.entry.id !== item.entry.id)].slice(0, MAX_RECENT_ENTRIES);
}

// ---------------------------------------------------------------------------
// The pending screenshot's backup in storage.local (see the header)
// ---------------------------------------------------------------------------

export const PENDING_SCREENSHOT_BACKUP_KEY = "pendingScreenshotBackup";

export async function getPendingScreenshotBackup(): Promise<PendingScreenshot | undefined> {
  const result = await chrome.storage.local.get(PENDING_SCREENSHOT_BACKUP_KEY);
  return result[PENDING_SCREENSHOT_BACKUP_KEY] as PendingScreenshot | undefined;
}

export function setPendingScreenshotBackup(value: PendingScreenshot): Promise<void> {
  return chrome.storage.local.set({ [PENDING_SCREENSHOT_BACKUP_KEY]: value });
}

export function clearPendingScreenshotBackup(): Promise<void> {
  return chrome.storage.local.remove(PENDING_SCREENSHOT_BACKUP_KEY);
}

/** Both recording slots in one read. */
export async function getRecordingState(): Promise<RecordingState> {
  const result = await chrome.storage.session.get(["recordingScreen", "recordingVoice"]);
  return {
    screen: result.recordingScreen as ScreenRecordingState | undefined,
    voice: result.recordingVoice as VoiceRecordingState | undefined,
  };
}

/** Call `listener` with both slots whenever either changes, in any context. */
export function onRecordingStateChanged(listener: (state: RecordingState) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && (changes.recordingScreen || changes.recordingVoice)) void getRecordingState().then(listener);
  });
}
