/**
 * welcome.html (dist/welcome.js): the page the worker opens once, on first
 * install. The text is static HTML; this fills in the three live parts:
 *
 *  - the server line: does holt answer at the fixed/fallback URL from the
 *    settings (http://127.0.0.1:4848 by default)? Checked with the same API
 *    client as the panel (GET /__holt/status), now, every few seconds while
 *    the tab is visible (so starting the server turns it green by itself;
 *    one request to a loopback address, nothing while hidden), and when the
 *    settings change. What it says is welcome-model.ts. Without a page to
 *    look at there is no auto-detection here (the Vite plugin's server is
 *    found from the captured page's origin), which the "not found" text
 *    explains;
 *  - the shortcuts as Chrome has them (chrome.commands.getAll, never the
 *    manifest's suggestions; shared/shortcuts.ts says why), re-read when the
 *    tab becomes visible again, since the user may have just changed them;
 *  - the transcription switch with its disclosure (sidepanel/ui/transcription.ts),
 *    the same one as in the panel's Settings.
 */

import { ApiError, createApi } from "../shared/api.js";
import { getShortcuts, SHORTCUTS_PAGE } from "../shared/shortcuts.js";
import { loadSettings, onSettingsChanged } from "../shared/settings.js";
import { h, replace } from "../sidepanel/ui/dom.js";
import { transcribeToggle } from "../sidepanel/ui/transcription.js";
import { serverLine, shortcutRows, type ServerCheck } from "./welcome-model.js";

const POLL_MS = 3_000;

const serverLineEl = element("server-line");
const serverDetailEl = element("server-detail");
const shortcutsEl = element("shortcuts");

function element(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`welcome.html is missing #${id}`);
  return el;
}

// ---- server ------------------------------------------------------------------

/** Only the latest check may update the page (a poll and a settings change can overlap). */
let checks = 0;

function showServer(check: ServerCheck): void {
  const line = serverLine(check);
  replace(serverLineEl, h("span", { class: `dot dot-${line.tone}`, "aria-hidden": "true" }), line.text);
  serverLineEl.dataset.state = check.kind;
  serverDetailEl.textContent = line.detail ?? "";
}

async function checkServer(): Promise<void> {
  const check = ++checks;
  const { serverUrl, token } = await loadSettings();
  if (check === checks && serverLineEl.dataset.state === undefined) showServer({ kind: "checking", serverUrl });
  let result: ServerCheck;
  try {
    const status = await createApi({ serverUrl, token }).status();
    result = { kind: "ok", serverUrl, status };
  } catch (error) {
    // Not running is the expected answer on a fresh install: show it, don't log it.
    result = error instanceof ApiError && error.code === "forbidden" ? { kind: "needs-token", serverUrl } : { kind: "down", serverUrl };
  }
  if (check === checks) showServer(result);
}

let timer: ReturnType<typeof setTimeout> | undefined;
function poll(): void {
  clearTimeout(timer);
  void checkServer().finally(() => {
    // Two checks can be in flight (a settings change during a poll): keep one timer.
    clearTimeout(timer);
    if (document.visibilityState === "visible") timer = setTimeout(poll, POLL_MS);
  });
}

// ---- shortcuts -----------------------------------------------------------------

async function showShortcuts(): Promise<void> {
  const rows = shortcutRows(await getShortcuts());
  replace(
    shortcutsEl,
    ...rows.flatMap(({ label, key }) => [h("dt", {}, label), h("dd", {}, key ? h("kbd", {}, key) : h("span", { class: "muted" }, "not set"))]),
  );
}

// Extension pages may open chrome:// URLs as tabs, but links to them are blocked.
element("shortcuts-link").addEventListener("click", (e) => {
  e.preventDefault();
  void chrome.tabs.create({ url: SHORTCUTS_PAGE });
});

// ---- start ---------------------------------------------------------------------

document.addEventListener("visibilitychange", () => {
  clearTimeout(timer);
  if (document.visibilityState !== "visible") return;
  poll();
  void showShortcuts();
});
onSettingsChanged(() => poll());

void loadSettings().then(({ transcribe }) => element("transcription").append(transcribeToggle({ initial: transcribe })));
void showShortcuts();
poll();
