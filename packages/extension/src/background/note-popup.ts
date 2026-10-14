/**
 * The quick-note shortcut: a small page (note.html) with a focused textarea,
 * shown as the toolbar action's popup.
 *
 * chrome.action.openPopup() is available to all extensions since Chrome 127
 * (before that, only to policy-installed ones), which is why the manifest's
 * minimum_chrome_version is 127. It can only open the popup that is
 * *currently set* for the action, and ours is normally the menu (menu.html,
 * what a click on the icon shows). So the note page is set just in time:
 *
 *   setPopup("note.html") -> openPopup() -> note.html loads and immediately
 *   setPopup("menu.html") again, so the next click shows the menu as usual.
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
 * The server for that page (shared/server.ts) may need a probe, which can't
 * happen before openPopup (see Gestures), so `noteContext` is written twice:
 * at once with the page, and again with `serverUrl` once it is resolved.
 * The popup waits for the second write only when the user saves.
 *
 * Gestures: openPopup is called without awaiting anything first, in the
 * same synchronous run as setPopup (extension API calls are processed in
 * the order they are made, so the popup is set by the time openPopup
 * runs). Whether openPopup needs a gesture at all is not documented; this
 * way it doesn't matter.
 *
 * The popup *window* is also how the screenshot note prompt is shown
 * (pending-screenshot.ts): a screenshot finishes long after the gesture,
 * so it goes straight to `openPopupWindow`.
 */

import { notePageUrl } from "../shared/note-prompt.js";
import { MENU_PAGE, NOTE_PAGE } from "../shared/pages.js";
import { pageContextFromTab } from "../shared/page-context.js";
import { resolveServerForTab } from "../shared/server.js";
import { getState, setState, type NoteContext } from "../shared/state.js";

const NOTE_WINDOW_SIZE = { width: 420, height: 230 };

/** Must be called synchronously from the command handler. */
export function openNotePopup(tab: chrome.tabs.Tab | undefined): void {
  const windowId = tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
  const context: NoteContext = { page: pageContextFromTab(tab), windowId, at: Date.now() };
  const stored = setState("noteContext", context);
  const set = chrome.action.setPopup({ popup: NOTE_PAGE });
  const opened = chrome.action.openPopup(tab ? { windowId } : {});

  // The popup is on its way; now the (possibly slower) server lookup.
  void stored
    .then(() => resolveServerForTab(tab))
    .then(async ({ serverUrl }) => {
      // Unless a newer shortcut press has replaced the context meanwhile.
      if ((await getState("noteContext"))?.at === context.at) await setState("noteContext", { ...context, serverUrl });
    })
    .catch((error: unknown) => console.warn("[holt] could not resolve the server for the quick note", error));

  // Promise.all attaches a handler to all three right now, so an early
  // rejection of `opened` is never reported as unhandled.
  Promise.all([stored, set, opened]).catch(async (error: unknown) => {
    console.info("[holt] openPopup failed, opening a note window instead:", String((error as Error)?.message ?? error));
    await chrome.action.setPopup({ popup: MENU_PAGE }).catch(() => undefined);
    await openPopupWindow(notePageUrl({ mode: "note", inWindow: true }), tab?.windowId, NOTE_WINDOW_SIZE).catch((e: unknown) =>
      console.warn("[holt] could not open the note window", e),
    );
  });
}

/**
 * An extension page (`path`, relative to the extension root) in a small,
 * focused popup window near the top right of browser window `nearWindowId`,
 * where the action popup would be.
 */
export async function openPopupWindow(
  path: string,
  nearWindowId: number | undefined,
  size: { width: number; height: number },
): Promise<chrome.windows.Window> {
  const position: { left?: number; top?: number } = {};
  if (nearWindowId !== undefined) {
    try {
      const win = await chrome.windows.get(nearWindowId);
      if (win.left !== undefined && win.width !== undefined) position.left = Math.max(0, win.left + win.width - size.width - 24);
      if (win.top !== undefined) position.top = win.top + 80;
    } catch {
      /* let Chrome place it */
    }
  }
  const options: chrome.windows.CreateData = { url: chrome.runtime.getURL(path), type: "popup", ...size, focused: true };
  try {
    return await chrome.windows.create({ ...options, ...position });
  } catch (error) {
    // Chrome refuses bounds that are not at least half on a screen ("Invalid
    // value for bounds"), e.g. when the browser window extends past the
    // screen edge (or in headless Chrome, whose screen is smaller than its
    // window). Let Chrome place it instead.
    if (!("left" in position) && !("top" in position)) throw error;
    return chrome.windows.create(options);
  }
}
