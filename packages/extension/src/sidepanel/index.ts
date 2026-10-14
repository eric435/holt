/**
 * Side panel entry point (dist/sidepanel.js, loaded by sidepanel.html): the
 * "settings panel", opened from the toolbar menu's Settings item.
 *
 * The side panel is an ordinary extension page (origin chrome-extension://<id>)
 * shown next to the tab. It stays open across navigations in the window, and
 * is destroyed when the user closes it. Capturing happens elsewhere (the
 * toolbar menu, the shortcuts, the transcript box on the page); the panel
 * shows the server and session, this session's entries, and the settings.
 * It is optional: everything works without it.
 *
 * Inputs it reacts to:
 *  - broadcasts from the worker (entry-added, toast) via runtime messages;
 *  - setting changes made elsewhere (storage.onChanged).
 */

import type { Entry } from "@holt/protocol";
import { isEntryAddedMessage, isToastMessage, isTrustedExtensionSender, onMessage, type ToastAction } from "../shared/messages.js";
import { loadSettings, onSettingsChanged } from "../shared/settings.js";
import { KIND_LABELS } from "./entry-view.js";
import { update } from "./store.js";
import { mountEntries } from "./ui/entries.js";
import { openPermissionsPage } from "./ui/microphone.js";
import { mountSettings } from "./ui/settings.js";
import { mountShortcutHint, openShortcutsPage, refreshShortcuts } from "./ui/shortcuts.js";
import { mountStatus, refreshStatus } from "./ui/status.js";
import { mountToasts, toast, type ToastActionButton } from "./ui/toast.js";

/** The buttons a worker toast may ask for (see ToastAction in shared/messages.ts). */
const TOAST_ACTIONS: Record<ToastAction, ToastActionButton> = {
  "open-permissions": { label: "Grant microphone access", run: openPermissionsPage },
  "open-shortcuts": { label: "Open shortcut settings", run: () => openShortcutsPage() },
};

function section(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`sidepanel.html is missing #${id}`);
  return el;
}

function announce(entry: Entry): void {
  toast("success", `${KIND_LABELS[entry.kind]} #${entry.seq} saved.`);
}

// Listen for worker broadcasts right away, before any await, so a broadcast
// that arrives while we are still booting isn't treated as "panel closed".
mountToasts(section("toasts"));
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
  return undefined; // area/menu/recorder/offscreen/helper messages are for the worker or the recorder
});

async function main(): Promise<void> {
  const [win, settings] = await Promise.all([chrome.windows.getCurrent(), loadSettings()]);
  update({ windowId: win.id ?? chrome.windows.WINDOW_ID_CURRENT, settings });

  void refreshShortcuts();
  // The user may have rebound shortcuts at chrome://extensions/shortcuts meanwhile.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshShortcuts();
  });

  mountStatus(section("status"));
  mountEntries(section("entries"));
  mountSettings(section("settings"));
  mountShortcutHint(section("shortcut-hint"));

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
