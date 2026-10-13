/**
 * Service worker entry point (dist/background.js).
 *
 * MV3 lifecycle in one paragraph: this file is NOT a long-running page. Chrome
 * starts the worker when one of our events fires (a shortcut, a message, the
 * extension being installed), runs this file top to bottom, dispatches the
 * event, and kills the worker again after ~30 s of inactivity. Next event:
 * fresh start, all module variables reset.
 *
 * Consequence: every event listener must be registered synchronously at the
 * top level of this file, on every start. If a listener were added after an
 * `await` (or inside a callback), the event that woke the worker would
 * already have been dispatched to nobody, and would be lost. Durable state
 * lives in chrome.storage (see shared/state.ts), not here.
 */

import {
  isAreaCancelledMessage,
  isAreaSelectedMessage,
  isCaptureRequest,
  isEntryCreatedMessage,
  isOwnPageSender,
  isRecorderStoppedMessage,
  isRecorderToastMessage,
  isRecorderToggleRequest,
  isSenderPage,
  isTrustedExtensionSender,
  onMessage,
  type CaptureResponse,
  type Message,
  type RecorderToggleRequest,
  type RecorderToggleResponse,
} from "../shared/messages.js";
import { pageContextFromTab } from "../shared/page-context.js";
import { migrateFromSync, restrictStorageAccess } from "../shared/settings.js";
import { onRecordingStateChanged, onStateChanged } from "../shared/state.js";
import { cancelAreaSelection, finishAreaSelection, takeScreenshot } from "./actions.js";
import { handleCommand, openSidePanel } from "./commands.js";
import { refreshIndicator } from "./indicator.js";
import { notifyEntryAdded, notifyToast } from "./notify.js";
import { OFFSCREEN_URL, closeOffscreenIfIdle } from "./offscreen.js";
import { onRecorderStopped, reconcileRecordingState, toggleTabRecording, toggleVoice } from "./recording.js";

// Before anything else touches settings: make storage.local/sync readable
// only by the worker and extension pages (not content scripts), and move
// legacy settings out of storage.sync. Neither blocks listener registration.
void restrictStorageAccess().then(migrateFromSync);

// ---------------------------------------------------------------------------
// Listeners: top level, synchronous. Do not move these into an async function.
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener(handleCommand);

onMessage((message: Message, sender) => {
  switch (message.type) {
    case "capture":
      // Only from the side panel: a content script (i.e. a web page) must
      // not be able to trigger captures. Validate the shape too.
      if (!isTrustedExtensionSender(sender, chrome.runtime.id)) return { ok: false, error: "Capture requests must come from the side panel." };
      if (!isCaptureRequest(message)) return { ok: false, error: "Malformed capture request." };
      return handleCaptureRequest(message.windowId, message.mode);

    case "area-selected":
      // From the overlay content script, i.e. from inside a web page:
      // validate every field here, and the sender (top frame of the tab we
      // injected into) in finishAreaSelection, which knows that tab.
      if (!isAreaSelectedMessage(message)) return { ok: true };
      void finishAreaSelection(message, sender);
      return { ok: true };

    case "area-cancelled":
      if (isAreaCancelledMessage(message)) void cancelAreaSelection(sender);
      return { ok: true };

    case "recorder:toggle":
      // The panel's Record tab / Voice note buttons: same path as the shortcuts.
      if (!isTrustedExtensionSender(sender, chrome.runtime.id)) return { ok: false, error: "Recorder requests must come from the side panel." };
      if (!isRecorderToggleRequest(message)) return { ok: false, error: "Malformed recorder request." };
      return handleRecorderToggle(message);

    case "entry-created":
      // The note popup (possibly in its own window, i.e. a tab) or the
      // offscreen document saved an entry: list it and tell the user.
      if (!isOwnPageSender(sender, chrome.runtime.id) || !isEntryCreatedMessage(message)) return undefined;
      return notifyEntryAdded(message.entry, message.session).then(() => ({ ok: true }));

    // ---- reports from the offscreen document --------------------------------
    case "recorder:stopped":
      if (!fromOffscreen(sender) || !isRecorderStoppedMessage(message)) return undefined;
      return onRecorderStopped(message.recorder, message.id).then(() => ({ ok: true }));
    case "recorder:toast":
      // Every recorder error ends up here, so it reaches the panel or the badge.
      if (!fromOffscreen(sender) || !isRecorderToastMessage(message)) return undefined;
      return notifyToast(message.level, message.message, message.action).then(() => ({ ok: true }));
    case "recorder:idle":
      if (!fromOffscreen(sender)) return undefined;
      void closeOffscreenIfIdle();
      return { ok: true };

    default:
      // entry-added / toast / recorder:transcript are for the panel;
      // offscreen:* for the offscreen document; helper:* for content scripts.
      return undefined;
  }
});

/** The recorder reports are only believed from our offscreen document. */
function fromOffscreen(sender: chrome.runtime.MessageSender): boolean {
  return isSenderPage(sender, chrome.runtime.id, OFFSCREEN_URL);
}

// The toolbar indicator follows the recording state and the project name,
// whichever context changed them (worker, panel, or a previous worker
// instance). storage.onChanged also wakes the worker, so it can't be missed.
onRecordingStateChanged(() => void refreshIndicator());
onStateChanged("serverInfo", () => void refreshIndicator());

// Clicking the toolbar icon opens the side panel.
//
// Chrome offers a declarative shortcut for this,
// sidePanel.setPanelBehavior({ openPanelOnActionClick: true }), but with it
// the click is routed straight to the side panel and is NOT treated as an
// action invocation, so it does not grant `activeTab` (verified with Chrome
// 155: captures from the panel then fail). Handling the click ourselves gives
// us both: action.onClicked grants activeTab for the tab, and the click is a
// user gesture, so sidePanel.open() is allowed if called synchronously.
//
// The behaviour flag is persisted by Chrome, so we explicitly turn it off on
// every start in case an earlier build turned it on (otherwise onClicked
// would never fire).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch((error: unknown) => {
  console.warn("[holt] setPanelBehavior failed", error);
});
chrome.action.onClicked.addListener((tab) => openSidePanel(tab.windowId));

// On every worker start: forget recordings nothing backs any more, and make
// the icon match the state (the action's badge/icon survive worker restarts,
// but not an extension reload).
void reconcileRecordingState().then(refreshIndicator);

/**
 * Test seam: lets scripts/e2e.mjs run a keyboard command, since a real
 * shortcut can't be pressed through the DevTools protocol. Only code running
 * inside this worker (DevTools / CDP) can reach it: web pages, content
 * scripts and other extensions can't see the worker's global scope.
 */
(globalThis as { holtTest?: unknown }).holtTest = { handleCommand };

// ---------------------------------------------------------------------------

async function handleCaptureRequest(windowId: number, mode: CaptureRequestMode): Promise<CaptureResponse> {
  // The side panel isn't a tab, so we look up the active tab of its window.
  // Without the "tabs" permission this still works; url/title are only
  // filled in if we have access to the tab (see shared/page-context.ts).
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab) return { ok: false, error: "No active tab in this window." };
  return takeScreenshot(mode, tab);
}

type CaptureRequestMode = Parameters<typeof takeScreenshot>[0];

async function handleRecorderToggle(request: RecorderToggleRequest): Promise<RecorderToggleResponse> {
  const [tab] = await chrome.tabs.query({ active: true, windowId: request.windowId });
  return request.recorder === "tab" ? toggleTabRecording(tab) : toggleVoice(pageContextFromTab(tab));
}
