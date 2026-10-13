/**
 * Keyboard shortcuts (the "commands" key in manifest.json).
 *
 * Defaults: Alt+S visible area, Alt+X select area, Alt+A voice note,
 * Alt+D tab recording. Chrome allows at most 4 `suggested_key` entries per
 * extension (a fifth is a manifest load error; scripts/check-manifest.mjs
 * enforces it), so screenshot-full (we suggest Alt+W), quick-note (Alt+T)
 * and open-panel ship unbound; the panel shows a hint and the real bindings
 * (chrome.commands.getAll()), since users can rebind everything at
 * chrome://extensions/shortcuts.
 *
 * Every command works with the side panel closed ("headless"):
 *   screenshots      captured and uploaded by the worker;
 *   toggle-voice,
 *   toggle-recording run in the offscreen document (recording.ts);
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
 */

import type { ScreenshotMode } from "@nitpick/protocol";
import { pageContextFromTab } from "../shared/page-context.js";
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
  switch (command) {
    case "open-panel":
      // Synchronously, while the gesture is still active.
      if (tab) openSidePanel(tab.windowId);
      return;
    case "quick-note":
      openNotePopup(tab); // synchronous part first, see note-popup.ts
      return;
    case "toggle-voice":
      void toggleVoice(pageContextFromTab(tab));
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

/** Must be called synchronously from a user-gesture handler. */
export function openSidePanel(windowId: number): void {
  chrome.sidePanel.open({ windowId }).catch((error: unknown) => {
    console.warn("[nitpick] could not open the side panel", error);
  });
}
