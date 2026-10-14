/**
 * Keyboard shortcuts (the "commands" key in manifest.json).
 *
 * Defaults: Alt+S select area, Alt+A voice note, Alt+R tab recording,
 * Alt+T text note. Chrome allows at most 4 `suggested_key` entries per
 * extension (a fifth is a manifest load error; scripts/check-manifest.mjs
 * enforces it), so screenshot-viewport (we suggest Alt+X), screenshot-full
 * (Alt+W) and open-panel ship unbound. A suggested key that is also a
 * built-in Chrome shortcut on some platform is silently not assigned there
 * (Alt+D, "focus the address bar" on Windows/Linux, is why recording is
 * Alt+R). The panel shows a hint and the real bindings
 * (chrome.commands.getAll()), since users can rebind everything at
 * chrome://extensions/shortcuts.
 *
 * The toolbar menu (src/menu/) runs the same commands through
 * `handleCommand` (a `menu:run` message, see index.ts), so a menu item and
 * its shortcut always behave the same.
 *
 * Every command works with the side panel closed ("headless"):
 *   screenshots      captured and uploaded by the worker;
 *   toggle-voice,
 *   toggle-recording run in the offscreen document (recording.ts); both
 *                    show an editable transcript on the page (voice-overlay.ts);
 *   quick-note       opens the note popup (note-popup.ts);
 *   open-panel       opens the panel.
 * Results and errors go to the panel if it is open, else to the badge.
 *
 * A keyboard shortcut is a user gesture and grants `activeTab` for the
 * current tab. APIs differ in what they need from it:
 *  - chrome.sidePanel.open() must be called during the synchronous part of
 *    the listener; after an await Chrome rejects it with "may only be called
 *    in response to a user gesture". So it is called before anything else.
 *  - chrome.action.openPopup(): called synchronously too (note-popup.ts), so
 *    the question of whether it needs the gesture never arises.
 *  - chrome.tabCapture.getMediaStreamId() and captureVisibleTab() need the
 *    activeTab grant, which outlives the gesture (until the tab navigates),
 *    so they may run after awaits (verified, see recording.ts).
 * That is why `handleCommand` is a plain (non-async) function.
 *
 * Our own pages in front: the screenshot note prompt opens focused (a
 * popup window), so a shortcut pressed while it is up arrives with the
 * prompt as "the active tab". Run as is, Alt+S would fail on it, Alt+A would
 * start a voice note about it, Alt+R would try to record it. So a command
 * whose tab is one of our extension pages is retargeted (`commandTarget`):
 * to the tab the pending screenshot was taken of (its activeTab grant from
 * that capture still holds), or else to the active tab of the last focused
 * normal window. Finding either is asynchronous, so a retargeted command
 * runs after an await: the side panel can't open then (no gesture left),
 * and the quick note opens as a popup window instead of the action popup,
 * both of which the code below already copes with. Commands on web pages
 * (the normal case) keep their synchronous path.
 */

import type { ScreenshotMode } from "@holt/protocol";
import { isOwnExtensionPage } from "../shared/pages.js";
import { getState } from "../shared/state.js";
import { takeScreenshot } from "./actions.js";
import { openNotePopup } from "./note-popup.js";
import { notifyToast } from "./notify.js";
import { toggleTabRecording, toggleVoice } from "./recording.js";

const SCREENSHOT_COMMANDS: Readonly<Record<string, ScreenshotMode>> = {
  "screenshot-viewport": "viewport",
  "screenshot-full": "full-page",
  "screenshot-area": "area",
};

export function handleCommand(command: string, tab: chrome.tabs.Tab | undefined): void {
  if (tab && isOwnExtensionPage(tab.url, chrome.runtime.id)) {
    void commandTarget().then(
      (target) => runCommand(command, target),
      (error: unknown) => console.warn("[holt] could not find the page for", command, error),
    );
    return;
  }
  runCommand(command, tab);
}

function runCommand(command: string, tab: chrome.tabs.Tab | undefined): void {
  switch (command) {
    case "open-panel":
      // Synchronously, while the gesture is still active.
      if (tab) openSidePanel(tab.windowId);
      return;
    case "quick-note":
      openNotePopup(tab); // synchronous part first, see note-popup.ts
      return;
    case "toggle-voice":
      void toggleVoice(tab);
      return;
    case "toggle-recording":
      void toggleTabRecording(tab);
      return;
  }

  const mode = SCREENSHOT_COMMANDS[command];
  if (mode) {
    if (!tab) {
      void notifyToast("error", "No active tab to capture (is a DevTools window focused?).");
      return;
    }
    void takeScreenshot(mode, tab);
  }
}

/**
 * The page a command pressed on one of our own pages is meant
 * for, see the header: the pending screenshot's tab while its prompt is up,
 * else the active tab of the last focused normal window. Undefined if
 * neither exists (the command then reports "no active tab").
 */
async function commandTarget(): Promise<chrome.tabs.Tab | undefined> {
  const pending = await getState("pendingScreenshot");
  if (pending && pending.tabId >= 0) {
    const tab = await chrome.tabs.get(pending.tabId).catch(() => undefined);
    if (tab) return tab;
  }
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (win.id === undefined) return undefined;
    // Possibly `ownPage` itself again (e.g. holt's permissions page in a
    // normal window): then the command runs on it and says why it can't.
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    return tab;
  } catch {
    return undefined; // no normal window left
  }
}

/** Must be called synchronously from a user-gesture handler. */
export function openSidePanel(windowId: number): void {
  chrome.sidePanel.open({ windowId }).catch((error: unknown) => {
    console.warn("[holt] could not open the side panel", error);
  });
}
