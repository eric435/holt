/**
 * Server + session status, for the page in front of this window.
 *
 * The server is the one a capture on this window's active tab would go to
 * (shared/server.ts): that tab's own origin if holt answers there (Vite
 * plugin), else the URL from the settings. The first line names the
 * project it writes into (from /status) prominently, then
 * "holt <version> · <host:port> · <how it was picked>" muted, where the
 * last part is "from this tab", "fixed URL" or "fallback (no holt on this
 * page)". The session buttons act on that same server.
 *
 * Re-resolved and re-checked: every few seconds while the panel is visible
 * (stopped when it is hidden, e.g. when the user switches to another side
 * panel; when the panel is closed the page is destroyed and the timer with
 * it), when another tab of this window comes to the front or finishes
 * loading, and when the settings change.
 *
 * The toolbar's view of the same question (`serverInfo`: badge, tooltip,
 * menu header) belongs to the worker (background/server-info.ts), which
 * only checks on events. When this panel's poll sees the server come or go,
 * it asks the worker to check again, so the badge follows without waiting
 * for the next tab switch.
 */

import { createApi, type Api } from "../../shared/api.js";
import { errorMessage, sendMessage } from "../../shared/messages.js";
import { serverLabel, sourceLabel } from "../../shared/server-label.js";
import { HoltNotAnsweringError, type ResolvedServer } from "../../shared/server-resolve.js";
import { apiForServer, resolveServerForTab } from "../../shared/server.js";
import { getState, subscribe, update, type PanelState } from "../store.js";
import { h, replace } from "./dom.js";
import { toast } from "./toast.js";

const POLL_MS = 3_000;

export function mountStatus(root: HTMLElement): void {
  const serverLine = h("div", { class: "server-line" });
  const sessionBox = h("div", { class: "session" });
  const titleInput = h("input", { type: "text", placeholder: "Session title (optional)", "aria-label": "Session title" });
  const startBtn = h("button", { onclick: () => void startSession() }, "Start new session");
  const stopBtn = h("button", { class: "secondary", onclick: () => void stopSession() }, "End session");
  const controls = h("div", { class: "row" }, titleInput, startBtn, stopBtn);
  replace(root, h("h2", {}, "Server"), serverLine, sessionBox, controls);

  subscribe((state) => render(state));

  function render({ server, session, settings, resolved }: PanelState): void {
    const serverUrl = resolved?.serverUrl ?? settings.serverUrl;
    if (server.kind === "checking") {
      replace(serverLine, dot("grey"), `Connecting to ${serverUrl}…`);
    } else if (server.kind === "down") {
      replace(
        serverLine,
        dot("red"),
        h("span", { class: "error-text" }, server.message),
        resolved && h("span", { class: "muted" }, `(${sourceLabel(resolved.source)})`),
      );
    } else {
      const s = server.status;
      const label = serverLabel(s, serverUrl, resolved?.source);
      replace(
        serverLine,
        dot("green"),
        label.project && h("strong", { class: "project" }, label.project),
        h("span", { class: "muted" }, label.detail),
        s.config?.requiresToken && !settings.token ? h("div", { class: "warn" }, "Server requires a token: set it in Settings.") : null,
      );
    }

    const up = server.kind === "ok";
    startBtn.disabled = !up;
    stopBtn.disabled = !up || !session || Boolean(session.endedAt);
    titleInput.disabled = !up;

    if (!up) {
      replace(sessionBox);
    } else if (!session || session.endedAt) {
      replace(sessionBox, h("p", { class: "muted" }, "No active session. Your first capture starts one automatically."));
    } else {
      replace(
        sessionBox,
        h("dl", {},
          h("dt", {}, "Notes"), h("dd", {}, h("code", {}, session.markdownFile)),
          h("dt", {}, "Folder"), h("dd", { title: session.dir }, h("code", {}, session.dir)),
          h("dt", {}, "Entries"), h("dd", {}, String(session.entryCount)),
        ),
      );
    }
  }

  async function startSession(): Promise<void> {
    try {
      const { session } = await (await currentApi()).startSession(titleInput.value);
      titleInput.value = "";
      update({ session });
      toast("success", session ? `Started ${session.markdownFile}` : "Session started.");
    } catch (error) {
      toast("error", errorMessage(error));
    }
  }

  async function stopSession(): Promise<void> {
    try {
      const { session } = await (await currentApi()).stopSession();
      update({ session });
      toast("info", "Session ended.");
    } catch (error) {
      toast("error", errorMessage(error));
    }
  }

  startPolling();
}

/** The server the status line shows (resolve it now if there is none yet). */
async function currentApi(): Promise<Api> {
  const { resolved } = getState();
  if (resolved) return apiForServer(resolved.serverUrl);
  const { serverUrl } = await resolveForWindow();
  return apiForServer(serverUrl);
}

function dot(color: "green" | "red" | "grey"): HTMLElement {
  return h("span", { class: `dot dot-${color}`, "aria-hidden": "true" });
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | undefined;
/** Only the latest check may update the UI (a poll and a tab event can overlap). */
let checks = 0;

/** The server for a capture on this window's active tab. */
async function resolveForWindow(): Promise<ResolvedServer> {
  const { windowId, settings } = getState();
  const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
  return resolveServerForTab(tab, settings);
}

/** Resolve the server and fetch /status once now. Exported so settings changes can trigger it. */
export async function refreshStatus(): Promise<void> {
  const check = ++checks;
  const before = getState().server.kind;
  let next: Partial<PanelState>;
  try {
    const resolved = await resolveForWindow();
    const where = { serverUrl: resolved.serverUrl, source: resolved.source };
    try {
      const status = resolved.status ?? (await createApi({ serverUrl: resolved.serverUrl, token: getState().settings.token }).status());
      next = { resolved: where, server: { kind: "ok", status }, session: status.session };
    } catch (error) {
      // Expected while the server isn't running: show it in the UI, don't log
      // it as an error to the console.
      next = { resolved: where, server: { kind: "down", message: errorMessage(error) } };
    }
  } catch (error) {
    // The page's own holt server stopped answering (shared/server-resolve.ts): name it, don't fall back.
    next = error instanceof HoltNotAnsweringError
      ? { resolved: { serverUrl: error.serverUrl, source: "tab" }, server: { kind: "down", message: error.message } }
      : { server: { kind: "down", message: errorMessage(error) } };
  }
  if (check !== checks) return; // a newer check started meanwhile
  const { server, resolved } = getState();
  const same =
    next.server?.kind === "down" && server.kind === "down" && server.message === next.server.message &&
    resolved?.serverUrl === next.resolved?.serverUrl && resolved?.source === next.resolved?.source;
  if (!same) update(next);
  // The server came or went: the toolbar badge (the worker's) should know too.
  const after = getState().server.kind;
  if (before !== "checking" && before !== after) void sendMessage({ type: "server-info:refresh" }).catch(() => undefined);
}

function startPolling(): void {
  const tick = async (): Promise<void> => {
    await refreshStatus();
    if (document.visibilityState === "visible") timer = setTimeout(() => void tick(), POLL_MS);
  };
  document.addEventListener("visibilitychange", () => {
    clearTimeout(timer);
    if (document.visibilityState === "visible") void tick();
  });
  void tick();

  // Another page in front of this window: its server may be another one.
  chrome.tabs.onActivated.addListener(({ windowId }) => {
    if (windowId === getState().windowId) void refreshStatus();
  });
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.active && tab.windowId === getState().windowId) void refreshStatus();
  });
}
