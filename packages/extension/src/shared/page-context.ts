/**
 * Build the protocol's PageContext ({ url, title }) from a chrome.tabs.Tab.
 *
 * Without the broad "tabs" permission, Chrome only fills in `tab.url` and
 * `tab.title` for tabs we have access to: tabs the user granted activeTab on
 * (hotkey / toolbar click) and tabs matching our host_permissions
 * (http://localhost/*, http://127.0.0.1/*, which conveniently covers most dev
 * servers). Otherwise both are undefined and we fall back to placeholders.
 *
 * Both are clamped to the server's field limits (ENTRY_FIELD_LIMITS, which
 * it enforces with a 400): a page with a huge URL (a data: URL, a long
 * query string) or title must still be captured, so the extension cuts
 * them down rather than having the entry refused after the capture.
 */

import { ENTRY_FIELD_LIMITS, type PageContext } from "@holt/protocol";

export const UNKNOWN_PAGE_TITLE = "Unknown page";

/** The subset of chrome.tabs.Tab we read (keeps tests free of Chrome types). */
export interface TabLike {
  url?: string | undefined;
  pendingUrl?: string | undefined;
  title?: string | undefined;
}

export function pageContextFromTab(tab: TabLike | undefined): PageContext {
  const url = clampText(sanitizeUrl(tab?.url || tab?.pendingUrl || ""), ENTRY_FIELD_LIMITS["page.url"]);
  const title = clampText((tab?.title ?? "").trim() || url || UNKNOWN_PAGE_TITLE, ENTRY_FIELD_LIMITS["page.title"]);
  return { url, title };
}

/**
 * `text` cut to at most `max` UTF-16 code units (the server counts JS string
 * length), without leaving half of a surrogate pair at the end.
 */
export function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Remove embedded credentials (`https://user:pass@host/`) before the URL is
 * written into a markdown file that may get committed.
 */
export function sanitizeUrl(raw: string): string {
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    return url.href;
  } catch {
    return raw;
  }
}
