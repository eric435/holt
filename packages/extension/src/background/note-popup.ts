/**
 * The quick-note shortcut: a small page (note.html) with a focused textarea,
 * shown as the toolbar action's popup.
 *
 * chrome.action.openPopup() is available to all extensions since Chrome 127
 * (before that, only to policy-installed ones), which is why the manifest's
 * minimum_chrome_version is 127. It can only open the popup that is
 * *currently set* for the action, and ours normally has none: a click on the
 * icon must reach action.onClicked to open the side panel (see index.ts).
 * So the popup is set just in time:
 *
 *   setPopup("note.html") -> openPopup() -> note.html loads and immediately
 *   setPopup("") again, so the next click opens the side panel as usual.
 *
 * If openPopup fails (Chrome refuses when the window isn't focused or is
 * not a normal browser window, e.g. headless or a DevTools window is
 * focused), we reset the popup ourselves and fall back to the same page in
 * a small popup *window* (chrome.windows.create({ type: "popup" })).
 *
 * The page to attach the note to is captured here, at command time, from
 * the command's tab (url/title are readable because the shortcut granted
 * activeTab), and handed over in storage.session. The popup can't work it
 * out itself: in fallback mode its "current window" is its own window.
 *
 * Gestures: openPopup is called without awaiting anything first, in the
 * same synchronous run as setPopup (extension API calls are processed in
 * the order they are made, so the popup is set by the time openPopup
 * runs). Whether openPopup needs a gesture at all is not documented; this
 * way it doesn't matter.
 */

import { pageContextFromTab } from "../shared/page-context.js";
import { setState } from "../shared/state.js";

export const NOTE_PAGE = "note.html";
const WINDOW_WIDTH = 420;
const WINDOW_HEIGHT = 230;

/** Must be called synchronously from the command handler. */
export function openNotePopup(tab: chrome.tabs.Tab | undefined): void {
  const windowId = tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
  const stored = setState("noteContext", { page: pageContextFromTab(tab), windowId, at: Date.now() });
  const set = chrome.action.setPopup({ popup: NOTE_PAGE });
  const opened = chrome.action.openPopup(tab ? { windowId } : {});

  // Promise.all attaches a handler to all three right now, so an early
  // rejection of `opened` is never reported as unhandled.
  Promise.all([stored, set, opened]).catch(async (error: unknown) => {
    console.info("[nitpick] openPopup failed, opening a note window instead:", String((error as Error)?.message ?? error));
    await chrome.action.setPopup({ popup: "" }).catch(() => undefined);
    await openNoteWindow(tab?.windowId).catch((e: unknown) => console.warn("[nitpick] could not open the note window", e));
  });
}

/** The fallback: note.html in a small popup window near the top right of the browser window. */
async function openNoteWindow(nearWindowId: number | undefined): Promise<void> {
  const position: { left?: number; top?: number } = {};
  if (nearWindowId !== undefined) {
    try {
      const win = await chrome.windows.get(nearWindowId);
      if (win.left !== undefined && win.width !== undefined) position.left = Math.max(0, win.left + win.width - WINDOW_WIDTH - 24);
      if (win.top !== undefined) position.top = win.top + 80;
    } catch {
      /* let Chrome place it */
    }
  }
  await chrome.windows.create({
    url: chrome.runtime.getURL(`${NOTE_PAGE}?window=1`),
    type: "popup",
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    focused: true,
    ...position,
  });
}
