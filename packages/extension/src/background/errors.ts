/**
 * Translate Chrome's terse capture/injection errors into something the user
 * can act on. Pure, so it is unit-tested.
 */

import { errorMessage } from "../shared/messages.js";

export function friendlyCaptureError(error: unknown): string {
  const text = errorMessage(error);

  // captureVisibleTab / executeScript without an activeTab grant for this tab.
  if (/activeTab|<all_urls>|Cannot access contents|must request permission/i.test(text)) {
    return (
      "Chrome only lets nitpick capture a tab after you invoke nitpick on it. " +
      "Press a nitpick shortcut (e.g. Alt+Shift+S) or click the nitpick toolbar icon on this tab, " +
      "then try again. The permission lasts until the tab navigates to another page."
    );
  }
  // chrome://, the Web Store, other extensions' pages, the PDF viewer...
  if (/chrome:\/\/|chrome-extension:\/\/|extensions gallery|cannot be scripted|Cannot access a/i.test(text)) {
    return "Chrome does not allow extensions to capture this kind of page (chrome:// pages, the Web Store, other extensions).";
  }
  if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|rate/i.test(text)) {
    return "Chrome's screenshot rate limit was hit. Wait a second and try again.";
  }
  if (/No tab with id|tab was closed/i.test(text)) {
    return "The tab was closed before the capture finished.";
  }
  return text;
}
