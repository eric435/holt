/**
 * Side panel entry point (dist/sidepanel.js, loaded by sidepanel.html).
 *
 * The side panel is an ordinary extension page (origin chrome-extension://<id>)
 * shown next to the tab. It stays open across navigations in the window, and
 * is destroyed when the user closes it. It is the UI. Since the recorders
 * moved to the offscreen document it is optional: every shortcut works
 * without it, and closing it only stops a window/screen recording.
 *
 * Inputs it reacts to:
 *  - broadcasts from the worker (entry-added, toast) via runtime messages;
 *  - the live transcript from the offscreen voice recorder (recorder:transcript);
 *  - the recording state in storage.session (who is recording what);
 *  - setting changes made elsewhere (storage.onChanged).
 */

import type { Entry } from "@holt/protocol";
import {
  isEntryAddedMessage,
  isRecorderTranscriptMessage,
  isToastMessage,
  isTrustedExtensionSender,
  onMessage,
  type ToastAction,
} from "../shared/messages.js";
import { loadSettings, onSettingsChanged } from "../shared/settings.js";
import { getRecordingState, onRecordingStateChanged } from "../shared/state.js";
import { update } from "./store.js";
import { mountActions, type ActionsApi } from "./ui/actions.js";
import { mountEntries } from "./ui/entries.js";
import { openPermissionsPage } from "./ui/microphone.js";
import { mountNotes } from "./ui/notes.js";
import { mountSettings } from "./ui/settings.js";
import { openShortcutsPage, refreshShortcuts } from "./ui/shortcuts.js";
import { mountStatus, refreshStatus } from "./ui/status.js";
import { mountToasts, toast, type ToastActionButton } from "./ui/toast.js";

/** The buttons a worker toast may ask for (see ToastAction in shared/messages.ts). */
const TOAST_ACTIONS: Record<ToastAction, ToastActionButton> = {
  "open-permissions": { label: "Grant microphone access", run: openPermissionsPage },
  "open-shortcuts": { label: "Open shortcut settings", run: () => openShortcutsPage() },
};

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
let actions: ActionsApi | null = null;
onMessage((message, sender) => {
  // Broadcasts are only believed from our worker / offscreen document.
  // Content scripts' messages reach this listener too (they carry
  // sender.tab) and are not ours.
  if (!isTrustedExtensionSender(sender, chrome.runtime.id)) return undefined;
  if (isEntryAddedMessage(message)) {
    update({ session: message.session });
    announce(message.entry);
    return { ok: true };
  }
  if (isToastMessage(message)) {
    toast(message.level, message.message, message.action && TOAST_ACTIONS[message.action]);
    return { ok: true };
  }
  if (isRecorderTranscriptMessage(message)) {
    actions?.showTranscript(message.final, message.interim);
    return undefined; // a broadcast; let nobody answer, the sender doesn't wait
  }
  return undefined; // capture/area/recorder/offscreen/helper messages are for the worker or the recorder
});

async function main(): Promise<void> {
  const [win, settings] = await Promise.all([chrome.windows.getCurrent(), loadSettings()]);
  update({ windowId: win.id ?? chrome.windows.WINDOW_ID_CURRENT, settings });

  update({ recording: await getRecordingState() });
  onRecordingStateChanged((recording) => update({ recording }));
  void refreshShortcuts();
  // The user may have rebound shortcuts at chrome://extensions/shortcuts meanwhile.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshShortcuts();
  });

  mountStatus(section("status"));
  actions = mountActions(section("actions"), announce);
  mountNotes(section("notes"), announce);
  mountEntries(section("entries"));
  mountSettings(section("settings"));

  onSettingsChanged(() => {
    void loadSettings().then((next) => {
      update({ settings: next });
      void refreshStatus();
    });
  });
}

main().catch((error: unknown) => {
  console.error("[holt] side panel failed to start", error);
  toast("error", `The panel failed to start: ${String(error)}`);
});
