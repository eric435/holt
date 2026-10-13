/**
 * The side panel's in-memory state, with a minimal subscribe/notify so the
 * UI modules can re-render when something changes. No framework needed for
 * this little.
 *
 * Module-level state is fine here (unlike in the service worker): the panel
 * is a normal page that lives as long as it is open.
 */

import type { SessionInfo, StatusResponse } from "@holt/protocol";
import { DEFAULT_SETTINGS, type Settings } from "../shared/settings.js";
import type { ShortcutMap } from "../shared/shortcuts.js";
import type { RecordingState } from "../shared/state.js";

export type ServerState =
  | { kind: "checking" }
  | { kind: "ok"; status: StatusResponse }
  | { kind: "down"; message: string };

export interface PanelState {
  /** The browser window this panel belongs to. */
  windowId: number;
  settings: Settings;
  server: ServerState;
  /** Latest known session (from /status or from any upload response). */
  session: SessionInfo | null;
  /** What is recording (mirrored from storage.session; the offscreen recorders and this panel write it). */
  recording: RecordingState;
  /** Current keyboard shortcuts (chrome.commands.getAll()). */
  shortcuts: ShortcutMap;
}

type Listener = (state: PanelState, previous: PanelState) => void;

let state: PanelState = {
  windowId: -1,
  settings: { ...DEFAULT_SETTINGS },
  server: { kind: "checking" },
  session: null,
  recording: {},
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
