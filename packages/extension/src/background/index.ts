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
  isEntryCreatedMessage,
  isMenuRunRequest,
  isOwnPageSender,
  isRecorderFinishedMessage,
  isRecorderStoppedMessage,
  isRecorderToastMessage,
  isRecorderTranscriptMessage,
  isScreenshotNoteDraftMessage,
  isScreenshotNoteFinishMessage,
  isSenderPage,
  isTrustedExtensionSender,
  isVoiceOverlayDecisionMessage,
  isVoiceOverlayDraftMessage,
  isVoiceOverlayStopMessage,
  onMessage,
  type MenuRunRequest,
  type Message,
} from "../shared/messages.js";
import { migrateFromSync, onSettingsChanged, restrictStorageAccess } from "../shared/settings.js";
import { onRecordingStateChanged, onStateChanged } from "../shared/state.js";
import { cancelAreaSelection, finishAreaSelection } from "./actions.js";
import { handleCommand } from "./commands.js";
import { refreshIndicator } from "./indicator.js";
import { notifyEntryAdded, notifyToast } from "./notify.js";
import { OFFSCREEN_URL, closeOffscreenIfIdle } from "./offscreen.js";
import { finishScreenshotNote, onPromptWindowClosed, reconcilePendingScreenshot, saveScreenshotDraft } from "./pending-screenshot.js";
import { onRecorderStopped, reconcileRecordingState, stopFromOverlay } from "./recording.js";
import { onTabUpdated, refreshServerInfo } from "./server-info.js";
import { decide, finishTranscript, relayTranscript, saveDraft } from "./voice-overlay.js";

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

    case "menu:run":
      // The toolbar menu (menu.html): same path as the shortcuts. Only from
      // an extension page that is not a tab (the action popup): a content
      // script (i.e. a web page) must not be able to trigger captures.
      // Answered before the work is done, so the menu can close right away.
      if (!isTrustedExtensionSender(sender, chrome.runtime.id)) return { ok: false, error: "Menu requests must come from the toolbar menu." };
      if (!isMenuRunRequest(message)) return { ok: false, error: "Malformed menu request." };
      void runFromMenu(message);
      return { ok: true };

    case "server-info:refresh":
      // The menu (when it opens) or the panel: check the server for the page in front again.
      if (!isTrustedExtensionSender(sender, chrome.runtime.id)) return undefined;
      return refreshServerInfo().then(() => ({ ok: true }));

    case "screenshot-note:finish":
      // The note prompt after a screenshot (a popup window, i.e. a tab, so
      // isTrustedExtensionSender would refuse it): write the screenshot's
      // entry with the user's note. Answered once it is written, so the
      // prompt can show an error and keep the text if it fails.
      if (!isOwnPageSender(sender, chrome.runtime.id)) return { ok: false, error: "Screenshot notes must come from holt's note prompt." };
      if (!isScreenshotNoteFinishMessage(message)) return { ok: false, error: "Malformed screenshot note." };
      return finishScreenshotNote(message.id, message.note);

    case "screenshot-note:draft":
      // The same prompt, as the user types: kept with the pending screenshot
      // so the paths that write it without the prompt's answer keep the words.
      if (!isOwnPageSender(sender, chrome.runtime.id)) return { ok: false, error: "Screenshot notes must come from holt's note prompt." };
      if (!isScreenshotNoteDraftMessage(message)) return { ok: false, error: "Malformed screenshot note." };
      return saveScreenshotDraft(message.id, message.draft).then(() => ({ ok: true }));

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
    case "recorder:transcript":
      // Forward to the box on the page.
      if (!fromOffscreen(sender) || !isRecorderTranscriptMessage(message)) return undefined;
      void relayTranscript(message);
      return { ok: true };
    case "recorder:finished":
      // Save the transcript, or let the user review it first.
      if (!fromOffscreen(sender) || !isRecorderFinishedMessage(message)) return undefined;
      void finishTranscript(message);
      return { ok: true };

    // ---- from the transcript box, i.e. from inside a web page ---------------
    // Each is checked against the tab the recording's box was put in.
    case "voice-overlay:stop":
      if (!isVoiceOverlayStopMessage(message)) return undefined;
      return stopFromOverlay(sender, message.id);
    case "voice-overlay:draft":
      if (!isVoiceOverlayDraftMessage(message)) return undefined;
      return saveDraft(message, sender).then(() => ({ ok: true }));
    case "voice-overlay:decision":
      if (!isVoiceOverlayDecisionMessage(message)) return undefined;
      return decide(message, sender);

    default:
      // entry-added / toast are for the panel; offscreen:* for the offscreen
      // document; helper:* and the other voice-overlay:* for content scripts.
      return undefined;
  }
});

/** The recorder reports are only believed from our offscreen document. */
function fromOffscreen(sender: chrome.runtime.MessageSender): boolean {
  return isSenderPage(sender, chrome.runtime.id, OFFSCREEN_URL);
}

// The toolbar indicator follows the recording state and the server for the
// page in front, whichever context changed them (worker, panel, or a
// previous worker instance). storage.onChanged also wakes the worker, so it
// can't be missed.
onRecordingStateChanged(() => void refreshIndicator());
onStateChanged("serverInfo", () => void refreshIndicator());

// Is there a holt server for the page in front? Re-checked when another page
// comes to the front or finishes loading, and when the settings change; no
// timers (see server-info.ts for exactly when, and what it costs).
chrome.tabs.onActivated.addListener(() => void refreshServerInfo());
// Unfiltered on purpose: Chrome's tabs.onUpdated takes no filter argument
// (`{ properties: ["status"] }` is Firefox-only: Chrome 155 throws at
// registration, which stops this whole file, as smoke showed). So every
// tab change wakes the worker; onTabUpdated returns at once unless it is a
// finished page load in an active tab.
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => void onTabUpdated(changeInfo, tab));
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) void refreshServerInfo();
});
onSettingsChanged(() => void refreshServerInfo());

// Clicking the toolbar icon opens the menu (manifest action.default_popup,
// menu.html). Opening an action's popup counts as invoking the action, so
// it grants `activeTab` for the tab like the shortcuts do: the menu's
// screenshots and tab recording rely on that.
//
// Chrome also has sidePanel.setPanelBehavior({ openPanelOnActionClick: true }),
// which would route the click straight to the side panel instead. That flag
// is persisted by Chrome, so we explicitly turn it off on every start in
// case an earlier build turned it on.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch((error: unknown) => {
  console.warn("[holt] setPanelBehavior failed", error);
});

// The screenshot note prompt was closed without Save/Skip: write the
// screenshot with whatever was typed (pending-screenshot.ts ignores other
// windows). A window event, so it also wakes a stopped worker.
chrome.windows.onRemoved.addListener((windowId) => void onPromptWindowClosed(windowId));

// The browser was quit with a note prompt open: storage.session is gone,
// but the pending screenshot's backup in storage.local is not. The worker
// start below already does this (reconcilePendingScreenshot also covers an
// extension reload, which clears storage.session without a browser
// restart); registering onStartup makes sure a browser start wakes us for it.
chrome.runtime.onStartup.addListener(() => void reconcilePendingScreenshot());

// On every worker start: forget recordings nothing backs any more, and make
// the icon match the state (the action's badge/icon survive worker restarts,
// but not an extension reload). Likewise, write a screenshot whose note
// prompt went away unanswered (or whose session storage did, see onStartup
// above), and check the server for the page in front
// (the stored answer may predate a browser restart or extension reload).
void reconcileRecordingState().then(refreshIndicator);
void reconcilePendingScreenshot();
void refreshServerInfo();

/**
 * Test seam: lets scripts/e2e.mjs run a keyboard command, since a real
 * shortcut can't be pressed through the DevTools protocol. Only code running
 * inside this worker (DevTools / CDP) can reach it: web pages, content
 * scripts and other extensions can't see the worker's global scope.
 */
(globalThis as { holtTest?: unknown }).holtTest = { handleCommand };

// ---------------------------------------------------------------------------

/**
 * The toolbar menu's item: the command on the active tab of the menu's
 * window (handleCommand retargets it if that is one of our own pages).
 */
async function runFromMenu({ command, windowId }: MenuRunRequest): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  handleCommand(command, tab);
}
