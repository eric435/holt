/**
 * The worker owns "is there a holt server for the page I'm looking at?"
 * (`serverInfo` in storage.session), which drives the toolbar badge and
 * tooltip (indicator.ts) and the toolbar menu's header.
 *
 * What it checks: the active tab of the last focused normal browser window
 * (popup windows such as the note prompt don't count, or the badge would
 * flip whenever one opens), resolved the way a capture on that tab would be
 * (shared/server.ts: the tab's own origin if holt answers there, else the
 * fixed/fallback URL), then GET /status on that server with our token.
 * `ok: true` = that answered as holt and speaks our protocol version;
 * anything else is `ok: false` with the API client's message (unreachable,
 * wrong token, not holt, ...) or, for a holt server of another protocol
 * version, `incompatible: true` and the message saying which side to update
 * (shared/protocol-compat.ts).
 *
 * When: only on events, never on a timer (an MV3 worker should sleep):
 *   - worker start (the info may be from before a browser restart or an
 *     extension reload, or missing);
 *   - tabs.onActivated, windows.onFocusChanged: another page is in front;
 *   - tabs.onUpdated with status "complete" for an active tab, if the page
 *     is on loopback or the previous answer was about one (going from one
 *     website to another changes nothing we show, so it costs nothing);
 *   - settings changes (mode, URL, token);
 *   - a `server-info:refresh` request from the menu (when it opens) or the
 *     side panel (when its own 3 s poll sees the server come or go).
 * Overlapping requests are coalesced: at most one check runs, and one more
 * runs after it if anything asked meanwhile.
 *
 * Cost: one storage read, a probe of the page's origin only for loopback
 * pages and at most every few seconds per origin (server-resolve.ts
 * caches), and one GET /status to a loopback address.
 */

import { createApi } from "../shared/api.js";
import { errorMessage } from "../shared/messages.js";
import { protocolCompatibility } from "../shared/protocol-compat.js";
import { projectName } from "../shared/server-label.js";
import { HoltNotAnsweringError, isLocalPage, type ResolvedServer } from "../shared/server-resolve.js";
import { resolveServerForTab } from "../shared/server.js";
import { loadSettings } from "../shared/settings.js";
import { getState, setState, type ServerInfo } from "../shared/state.js";

let running: Promise<void> | null = null;
let again = false;

/** Re-check the server for the page in front and update `serverInfo` if anything changed. Never throws. */
export function refreshServerInfo(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      try {
        await refreshOnce();
      } catch (error) {
        console.warn("[holt] could not check the server for the current page", error);
      }
    } while (again);
  })().finally(() => {
    running = null;
  });
  return running;
}

/** tabs.onUpdated: only page loads in an active tab that can change the answer (see the header). */
export async function onTabUpdated(changeInfo: { status?: string | undefined }, tab: chrome.tabs.Tab): Promise<void> {
  if (changeInfo.status !== "complete" || !tab.active) return;
  if (isLocalPage(tab.url) || (await getState("serverInfo"))?.localPage !== false) await refreshServerInfo();
}

async function refreshOnce(): Promise<void> {
  const tab = await activeTab();
  const settings = await loadSettings();
  const localPage = isLocalPage(tab?.url);
  let resolved: ResolvedServer;
  try {
    resolved = await resolveServerForTab(tab, settings);
  } catch (error) {
    // The page's own holt server (it answered before) doesn't now: that is the answer to show.
    if (!(error instanceof HoltNotAnsweringError)) throw error;
    await store({ serverUrl: error.serverUrl, source: "tab", localPage, ok: false, message: error.message });
    return;
  }
  const base = { serverUrl: resolved.serverUrl, source: resolved.source, localPage };
  let info: ServerInfo;
  try {
    // The probe's status was fetched without the token; it only comes back
    // when the server doesn't require one, so it is as good as our own.
    const status = resolved.status ?? (await createApi({ serverUrl: resolved.serverUrl, token: settings.token }).status());
    const compatibility = protocolCompatibility(status, resolved.serverUrl);
    info = compatibility.ok
      ? { ...base, ok: true, project: projectName(status), version: typeof status.version === "string" ? status.version : "" }
      : { ...base, ok: false, incompatible: true, message: compatibility.message };
  } catch (error) {
    info = { ...base, ok: false, message: errorMessage(error) };
  }
  await store(info);
}

async function store(info: ServerInfo): Promise<void> {
  const previous = await getState("serverInfo");
  // Unchanged: don't write, so storage.onChanged listeners (the indicator) stay quiet.
  if (JSON.stringify(previous) !== JSON.stringify(info)) await setState("serverInfo", info);
}

/** The active tab of the last focused normal window, if any. */
async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (win.id === undefined) return undefined;
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    return tab;
  } catch {
    return undefined; // no normal window (all closed, or only popups)
  }
}
