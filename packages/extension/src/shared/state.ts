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
 * here; a restarted worker, the side panel and the toolbar indicator all read
 * it from here. The two recordings use separate keys on purpose: the panel
 * (window/screen recording) and the worker (tab recording, voice) write them
 * independently, and one key per writer avoids lost read-modify-write updates.
 *
 * This lives in shared/ (not background/) because the side panel and the
 * note popup read and write the same keys.
 */

import type { Entry, PageContext, ScreenshotMode } from "@holt/protocol";

/** An area selection the worker started and is waiting to hear back about. */
export interface PendingArea {
  tabId: number;
  windowId: number;
  page: PageContext;
  startedAt: number;
}

/**
 * A running tab or window/screen recording.
 *  - "tab": chrome.tabCapture in the offscreen document (started by the
 *    worker; survives the panel closing).
 *  - "display": getDisplayMedia in the side panel (the picker needs a click
 *    in a document; dies with the panel).
 */
export interface ScreenRecordingState {
  /** Random id, so late events from an older recording can't clear a newer one. */
  id: string;
  source: "tab" | "display";
  startedAt: number;
  page: PageContext;
  /** The captured tab ("tab" source only). */
  tabId?: number;
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
  at: number;
}

/** What the side panel last learned about the server, for the toolbar tooltip. */
export interface ServerInfo {
  projectName: string;
}

/** An entry shown in the panel's list (kept so the list survives closing the panel). */
export interface RecentEntry {
  sessionId: string;
  entry: Entry;
  mode?: ScreenshotMode;
}

interface SessionState {
  pendingArea: PendingArea;
  recentEntries: RecentEntry[];
  recordingScreen: ScreenRecordingState;
  recordingVoice: VoiceRecordingState;
  noteContext: NoteContext;
  serverInfo: ServerInfo;
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
 * Prepend an entry to the recent list. Read-modify-write is not atomic across
 * contexts; two entries landing in the same millisecond from the worker and
 * the panel could drop one from this display list (never from the server).
 * Acceptable for a convenience list.
 */
export async function addRecentEntry(item: RecentEntry): Promise<void> {
  const list = (await getState("recentEntries")) ?? [];
  const next = [item, ...list.filter((e) => e.entry.id !== item.entry.id)].slice(0, MAX_RECENT_ENTRIES);
  await setState("recentEntries", next);
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
