/**
 * Side panel entry point (dist/sidepanel.js, loaded by sidepanel.html).
 *
 * The side panel is an ordinary extension page (origin chrome-extension://<id>)
 * shown next to the tab. It stays open across navigations in the window, and
 * is destroyed when the user closes it. It is the UI and hosts the recorders.
 *
 * Inputs it reacts to:
 *  - broadcasts from the worker (entry-added, toast) via runtime messages;
 *  - commands from keyboard shortcuts via the "panel inbox" in
 *    storage.session (see shared/state.ts for why not a message);
 *  - setting changes made in another window's panel (storage.onChanged).
 */

import type { Entry } from "@nitpick/protocol";
import { isEntryAddedMessage, isToastMessage, onMessage } from "../shared/messages.js";
import { loadSettings, onSettingsChanged } from "../shared/settings.js";
import { clearState, getState as getStoredState, onStateChanged, type PanelInboxItem } from "../shared/state.js";
import { getState, update } from "./store.js";
import { mountActions } from "./ui/actions.js";
import { mountEntries } from "./ui/entries.js";
import { mountNotes } from "./ui/notes.js";
import { mountSettings } from "./ui/settings.js";
import { mountStatus, refreshStatus } from "./ui/status.js";
import { mountToasts, toast } from "./ui/toast.js";

/** Ignore inbox commands older than this (e.g. left over from a closed panel). */
const INBOX_MAX_AGE_MS = 15_000;

const LABELS: Record<Entry["kind"], string> = {
  screenshot: "Screenshot",
  recording: "Recording",
  "voice-note": "Voice note",
  note: "Note",
};

function section(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`sidepanel.html is missing #${id}`);
  return el;
}

function announce(entry: Entry): void {
  toast("success", `${LABELS[entry.kind]} #${entry.seq} saved.`);
}

// Listen for worker broadcasts right away, before any await, so a broadcast
// that arrives while we are still booting isn't treated as "panel closed".
mountToasts(section("toasts"));
onMessage((message) => {
  if (isEntryAddedMessage(message)) {
    update({ session: message.session });
    announce(message.entry);
    return { ok: true };
  }
  if (isToastMessage(message)) {
    toast(message.level, message.message);
    return { ok: true };
  }
  return undefined; // capture/area/helper messages are for the worker
});

async function main(): Promise<void> {
  const [win, settings] = await Promise.all([chrome.windows.getCurrent(), loadSettings()]);
  update({ windowId: win.id ?? chrome.windows.WINDOW_ID_CURRENT, settings });

  mountStatus(section("status"));
  const actions = mountActions(section("actions"), announce);
  const notes = mountNotes(section("notes"), announce);
  mountEntries(section("entries"));
  mountSettings(section("settings"));

  onSettingsChanged(() => {
    void loadSettings().then((next) => {
      update({ settings: next });
      void refreshStatus();
    });
  });

  // ---- commands forwarded from keyboard shortcuts -------------------------
  let lastHandled = "";
  const handleInbox = (item: PanelInboxItem | undefined): void => {
    if (!item || item.id === lastHandled || Date.now() - item.at > INBOX_MAX_AGE_MS) return;
    if (item.windowId !== undefined && item.windowId !== getState().windowId) return; // another window's panel
    lastHandled = item.id;
    void clearState("panelInbox");
    switch (item.command) {
      case "toggle-recording":
        actions.toggleRecording();
        break;
      case "toggle-voice":
        actions.toggleVoice();
        break;
      case "quick-note":
        notes.focus();
        break;
      case "open-panel":
        break; // opening was the whole point
    }
  };
  onStateChanged("panelInbox", handleInbox);
  handleInbox(await getStoredState("panelInbox"));
}

main().catch((error: unknown) => {
  console.error("[nitpick] side panel failed to start", error);
  toast("error", `The panel failed to start: ${String(error)}`);
});
