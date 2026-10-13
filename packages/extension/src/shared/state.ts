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
 * It is also how the worker hands things to the side panel when the panel
 * may not be loaded yet (the "panel inbox"): the panel reads the inbox on
 * startup and listens for changes afterwards, so there is no race between
 * "worker opens the panel" and "panel starts listening for messages".
 *
 * This lives in shared/ (not background/) because the side panel reads and
 * writes the same keys.
 */

import type { Entry, PageContext, ScreenshotMode } from "@nitpick/protocol";

/** An area selection the worker started and is waiting to hear back about. */
export interface PendingArea {
  tabId: number;
  windowId: number;
  page: PageContext;
  startedAt: number;
}

/** Commands the worker forwards to the side panel. */
export type PanelCommand = "open-panel" | "toggle-recording" | "toggle-voice" | "quick-note";

export interface PanelInboxItem {
  id: string;
  command: PanelCommand;
  at: number;
  /** Only the panel in this window should react (each window has its own panel). */
  windowId?: number;
}

/** An entry shown in the panel's list (kept so the list survives closing the panel). */
export interface RecentEntry {
  sessionId: string;
  entry: Entry;
  mode?: ScreenshotMode;
}

interface SessionState {
  pendingArea: PendingArea;
  panelInbox: PanelInboxItem;
  recentEntries: RecentEntry[];
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

export async function postToPanelInbox(command: PanelCommand, windowId: number | undefined): Promise<void> {
  const item: PanelInboxItem = { id: crypto.randomUUID(), command, at: Date.now() };
  if (windowId !== undefined) item.windowId = windowId;
  await setState("panelInbox", item);
}
