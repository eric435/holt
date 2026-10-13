/**
 * Server + session status.
 *
 * Polls GET /status every few seconds while the panel is visible, and stops
 * when it is hidden (document.visibilityState), e.g. when the user switches
 * to another side panel. When the panel is closed the page is destroyed and
 * the timer with it.
 */

import { getApi } from "../../shared/api.js";
import { errorMessage } from "../../shared/messages.js";
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

  function render({ server, session, settings }: PanelState): void {
    if (server.kind === "checking") {
      replace(serverLine, dot("grey"), `Connecting to ${settings.serverUrl}…`);
    } else if (server.kind === "down") {
      replace(serverLine, dot("red"), h("span", { class: "error-text" }, server.message));
    } else {
      const s = server.status;
      replace(
        serverLine,
        dot("green"),
        `nitpick ${s.version} at ${settings.serverUrl}`,
        s.config.requiresToken && !settings.token ? h("div", { class: "warn" }, "Server requires a token: set it in Settings.") : null,
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
      const { session } = await (await getApi()).startSession(titleInput.value);
      titleInput.value = "";
      update({ session });
      toast("success", session ? `Started ${session.markdownFile}` : "Session started.");
    } catch (error) {
      toast("error", errorMessage(error));
    }
  }

  async function stopSession(): Promise<void> {
    try {
      const { session } = await (await getApi()).stopSession();
      update({ session });
      toast("info", "Session ended.");
    } catch (error) {
      toast("error", errorMessage(error));
    }
  }

  startPolling();
}

function dot(color: "green" | "red" | "grey"): HTMLElement {
  return h("span", { class: `dot dot-${color}`, "aria-hidden": "true" });
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | undefined;

/** Fetch /status once now. Exported so settings changes can trigger it. */
export async function refreshStatus(): Promise<void> {
  try {
    const status = await (await getApi()).status();
    update({ server: { kind: "ok", status }, session: status.session });
  } catch (error) {
    // Expected while the server isn't running: show it in the UI, don't log
    // it as an error to the console.
    if (getState().server.kind !== "down" || (getState().server as { message: string }).message !== errorMessage(error)) {
      update({ server: { kind: "down", message: errorMessage(error) } });
    }
  }
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
}
