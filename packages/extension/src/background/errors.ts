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
      "Chrome only lets holt capture a tab after you invoke holt on it. " +
      "Press a holt shortcut (e.g. Alt+S) or click the holt toolbar icon on this tab, " +
      "then try again. The permission lasts until the tab navigates to another page."
    );
  }
  // chrome://, the Web Store, other extensions' pages, the PDF viewer...
  if (/chrome:\/\/|chrome-extension:\/\/|extensions gallery|cannot be scripted|Cannot access a/i.test(text)) {
    return "Chrome does not allow extensions to capture this kind of page (chrome:// pages, the Web Store, other extensions).";
  }
  if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|rate limit|quota/i.test(text)) {
    return "Chrome's screenshot rate limit was hit. Wait a second and try again.";
  }
  if (/No tab with id|tab was closed/i.test(text)) {
    return "The tab was closed before the capture finished.";
  }
  return text;
}

/**
 * Same idea for chrome.tabCapture.getMediaStreamId / tab-capture
 * getUserMedia errors. Chrome's wording (Chrome 155):
 *  - "Extension has not been invoked for the current page (see activeTab
 *    permission). Chrome pages cannot be captured."  no activeTab grant, or
 *    a chrome:// page;
 *  - "Cannot capture a tab with an active stream."    already being captured.
 */
export function friendlyRecordingError(error: unknown): string {
  const text = errorMessage(error);
  if (/has not been invoked|activeTab/i.test(text)) {
    return (
      "Chrome only lets holt record a tab after you invoke holt on it. " +
      "Press the record shortcut on the tab itself, or click the holt toolbar icon on it, then try again. " +
      "(chrome:// pages and the Web Store can't be recorded at all.)"
    );
  }
  if (/active stream/i.test(text)) {
    return "This tab is already being captured (by holt or another extension). Stop that capture first.";
  }
  return friendlyCaptureError(text);
}
