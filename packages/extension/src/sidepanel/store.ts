/**
 * The side panel's in-memory state, with a minimal subscribe/notify so the
 * UI modules can re-render when something changes. No framework needed for
 * this little.
 *
 * Module-level state is fine here (unlike in the service worker): the panel
 * is a normal page that lives as long as it is open.
 */

import type { SessionInfo, StatusResponse } from "@holt/protocol";
import type { ServerSource } from "../shared/server-resolve.js";
import { DEFAULT_SETTINGS, type Settings } from "../shared/settings.js";
import type { ShortcutMap } from "../shared/shortcuts.js";

export type ServerState =
  | { kind: "checking" }
  | { kind: "ok"; status: StatusResponse }
  | { kind: "down"; message: string };

export interface PanelState {
  /** The browser window this panel belongs to. */
  windowId: number;
  settings: Settings;
  /**
   * The server for the active tab of this window, as last resolved
   * (shared/server.ts); null until the first check. The session buttons
   * act on it, and the status line says where it came from.
   */
  resolved: { serverUrl: string; source: ServerSource } | null;
  server: ServerState;
  /** Latest known session (from /status or from any upload response). */
  session: SessionInfo | null;
  /** Current keyboard shortcuts (chrome.commands.getAll()). */
  shortcuts: ShortcutMap;
}

type Listener = (state: PanelState, previous: PanelState) => void;

let state: PanelState = {
  windowId: -1,
  settings: { ...DEFAULT_SETTINGS },
  resolved: null,
  server: { kind: "checking" },
  session: null,
  shortcuts: {},
};
const listeners = new Set<Listener>();

export function getState(): PanelState {
  return state;
}

export function update(patch: Partial<PanelState>): void {
  const previous = state;
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state, previous);
}

/** Subscribe and get called once immediately. Returns an unsubscribe function. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  listener(state, state);
  return () => listeners.delete(listener);
}
