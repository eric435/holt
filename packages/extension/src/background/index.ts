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
  onMessage,
  type CaptureResponse,
  type Message,
} from "../shared/messages.js";
import { cancelAreaSelection, finishAreaSelection, takeScreenshot } from "./actions.js";
import { handleCommand, openSidePanel } from "./commands.js";

// ---------------------------------------------------------------------------
// Listeners: top level, synchronous. Do not move these into an async function.
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener(handleCommand);

onMessage((message: Message, sender) => {
  switch (message.type) {
    case "capture":
      // From the side panel. Validate anyway: cheap, and keeps the shape honest.
      if (!isCaptureRequest(message)) return { ok: false, error: "Malformed capture request." };
      return handleCaptureRequest(message.windowId, message.mode);

    case "area-selected":
      // From a content script, i.e. from inside a web page: validate every field.
      if (!isAreaSelectedMessage(message)) return { ok: true };
      void finishAreaSelection(message, sender);
      return { ok: true };

    case "area-cancelled":
      if (isAreaCancelledMessage(message)) void cancelAreaSelection();
      return { ok: true };

    default:
      // entry-added / toast are for the panel; helper:* are for content scripts.
      return undefined;
  }
});

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
  console.warn("[nitpick] setPanelBehavior failed", error);
});
chrome.action.onClicked.addListener((tab) => openSidePanel(tab.windowId));

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
