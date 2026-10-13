/**
 * Keyboard shortcuts (the "commands" key in manifest.json).
 *
 * Users can rebind or add shortcuts at chrome://extensions/shortcuts. Chrome
 * only honours 4 `suggested_key` defaults per extension, so toggle-recording,
 * toggle-voice and quick-note ship unbound.
 *
 * A keyboard shortcut is a user gesture: it grants `activeTab` for the
 * current tab, and allows `chrome.sidePanel.open()`. The gesture only counts
 * during the synchronous part of the listener, so `chrome.sidePanel.open`
 * must be called BEFORE the first `await`; after an await Chrome rejects it
 * with "sidePanel.open() may only be called in response to a user gesture".
 * That is why `handleCommand` is a plain (non-async) function.
 */

import type { ScreenshotMode } from "@nitpick/protocol";
import { postToPanelInbox, type PanelCommand } from "../shared/state.js";
import { takeScreenshot } from "./actions.js";
import { notifyToast } from "./notify.js";

const SCREENSHOT_COMMANDS: Readonly<Record<string, ScreenshotMode>> = {
  "screenshot-viewport": "viewport",
  "screenshot-full": "full-page",
  "screenshot-area": "area",
};

const PANEL_COMMANDS: ReadonlySet<string> = new Set<PanelCommand>([
  "open-panel",
  "toggle-recording",
  "toggle-voice",
  "quick-note",
]);

export function handleCommand(command: string, tab: chrome.tabs.Tab | undefined): void {
  if (PANEL_COMMANDS.has(command)) {
    // Synchronously, while the gesture is still active.
    if (tab) openSidePanel(tab.windowId);
    // The recorders live in the panel (they need a document). The panel may
    // still be loading, so hand it the command via storage, not a message.
    void postToPanelInbox(command as PanelCommand, tab?.windowId);
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
