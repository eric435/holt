/**
 * Build the protocol's PageContext ({ url, title }) from a chrome.tabs.Tab.
 *
 * Without the broad "tabs" permission, Chrome only fills in `tab.url` and
 * `tab.title` for tabs we have access to: tabs the user granted activeTab on
 * (hotkey / toolbar click) and tabs matching our host_permissions
 * (http://localhost/*, http://127.0.0.1/*, which conveniently covers most dev
 * servers). Otherwise both are undefined and we fall back to placeholders.
 */

import type { PageContext } from "@nitpick/protocol";

export const UNKNOWN_PAGE_TITLE = "Unknown page";

/** The subset of chrome.tabs.Tab we read (keeps tests free of Chrome types). */
export interface TabLike {
  url?: string | undefined;
  pendingUrl?: string | undefined;
  title?: string | undefined;
}

export function pageContextFromTab(tab: TabLike | undefined): PageContext {
  const url = sanitizeUrl(tab?.url || tab?.pendingUrl || "");
  const title = (tab?.title ?? "").trim() || url || UNKNOWN_PAGE_TITLE;
  return { url, title };
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
