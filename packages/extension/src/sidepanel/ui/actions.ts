/**
 * The Capture card: screenshots, tab recording, voice note, and the
 * secondary window/screen recording.
 *
 * Who does the work:
 *  - Screenshots: the service worker (it owns captureVisibleTab and the
 *    activeTab grant). We send `capture` and the worker broadcasts the result.
 *  - "Record tab" and "Voice note": the offscreen document, via the worker
 *    (`recorder:toggle`), exactly like the Alt+D / Alt+A shortcuts. They
 *    keep running when this panel is closed. The buttons render from the
 *    recording state in storage.session (store.recording), so they are right
 *    no matter who started the recording or whether this panel was open then.
 *  - "Record a window or screen…": getDisplayMedia, here in the panel,
 *    because Chrome's picker needs a click in a visible document (see
 *    recorder/screen.ts). It is the one recording that stops if the panel
 *    is closed, and the button says so.
 */

import type { Entry, PageContext, ScreenshotMode } from "@holt/protocol";
import { errorMessage, sendMessage, type RecorderKind } from "../../shared/messages.js";
import { withShortcut, type CommandName } from "../../shared/shortcuts.js";
import { clearState, getState as getStoredState, setState } from "../../shared/state.js";
import { getActivePage } from "../page.js";
import { startScreenRecording, type ScreenRecording } from "../recorder/screen.js";
import { getState, subscribe, type PanelState } from "../store.js";
import { uploadAndPost } from "../upload.js";
import { formatDuration, h, replace } from "./dom.js";
import { mountShortcutHint } from "./shortcuts.js";
import { toast } from "./toast.js";

export interface ActionsApi {
  /** Live transcript from the offscreen voice recorder. */
  showTranscript(final: string, interim: string): void;
}

export function mountActions(root: HTMLElement, onEntry: (entry: Entry) => void): ActionsApi {
  // ---- screenshots -------------------------------------------------------
  const shotButtons: Array<[HTMLButtonElement, string, CommandName]> = [];
  const shotButton = (mode: ScreenshotMode, label: string, hint: string, command: CommandName): HTMLButtonElement => {
    const button = h("button", { class: "big", onclick: () => void screenshot(mode) }, label);
    shotButtons.push([button, hint, command]);
    return button;
  };
  const shots = h(
    "div",
    { class: "grid3" },
    shotButton("viewport", "Visible", "Screenshot the visible part of the page", "screenshot-viewport"),
    shotButton("full-page", "Full page", "Scroll and stitch the whole page", "screenshot-full"),
    shotButton("area", "Area", "Drag to select an area", "screenshot-area"),
  );

  async function screenshot(mode: ScreenshotMode): Promise<void> {
    setBusy(shots, true);
    try {
      const response = await sendMessage({ type: "capture", mode, windowId: getState().windowId });
      // Results (entry-added) and errors (toast) are broadcast by the worker,
      // which also covers shortcut-triggered captures; nothing to do here
      // except explain the area overlay.
      if (response.ok && response.pending) toast("info", "Drag on the page to select an area. Esc cancels.");
    } catch (error) {
      toast("error", errorMessage(error));
    } finally {
      setBusy(shots, false);
    }
  }

  // ---- tab recording + voice note (offscreen, via the worker) -------------
  const recordBtn = h("button", { class: "big toggle", onclick: () => void toggle("tab") }, "");
  const recordTimer = h("span", { class: "timer" });
  const voiceBtn = h("button", { class: "big toggle", onclick: () => void toggle("voice") }, "");
  const voiceTimer = h("span", { class: "timer" });
  const micHint = h("span", { class: "hint mic-hint" });
  const transcriptBox = h("div", { class: "transcript", hidden: true, "aria-live": "polite" });
  const pending = new Set<RecorderKind>();

  async function toggle(recorder: RecorderKind): Promise<void> {
    if (pending.has(recorder)) return;
    pending.add(recorder);
    render(getState());
    try {
      // Errors are toasted by the worker (so they also reach the badge when
      // the shortcut is used with the panel closed); nothing to add here.
      await sendMessage({ type: "recorder:toggle", recorder, windowId: getState().windowId });
    } catch (error) {
      toast("error", errorMessage(error));
    } finally {
      pending.delete(recorder);
      render(getState());
    }
  }

  // ---- window/screen recording (here in the panel) ----------------------
  let display: { recording: ScreenRecording; id: string; startedAt: number; page: PageContext } | null = null;
  const displayBtn = h("button", { class: "link display-btn", onclick: () => void toggleDisplay() }, "");
  const displayHint = h("span", { class: "hint" }, "Chrome's picker; needs a click, and stops if you close this panel.");

  async function toggleDisplay(): Promise<void> {
    if (display) return void stopDisplay();
    if (getState().recording.screen) return void toast("info", "A tab recording is running. Stop it first.");
    try {
      const pagePromise = getActivePage();
      const recording = await startScreenRecording(() => void stopDisplay());
      display = { recording, id: crypto.randomUUID(), startedAt: Date.now(), page: await pagePromise };
      // Mirror it like the offscreen recordings, so the toolbar shows REC.
      await setState("recordingScreen", { id: display.id, source: "display", startedAt: display.startedAt, page: display.page });
    } catch (error) {
      display = null;
      const name = (error as DOMException).name;
      if (name === "NotAllowedError") toast("info", "Screen recording cancelled.");
      else toast("error", `Could not start screen recording: ${errorMessage(error)}`);
    }
    render(getState());
  }

  async function stopDisplay(): Promise<void> {
    const current = display;
    if (!current) return;
    display = null;
    await clearOwnDisplayState(current.id);
    displayBtn.disabled = true;
    try {
      const { blob, durationMs } = await current.recording.stop();
      const capturedAt = new Date(Date.now() - durationMs).toISOString();
      toast("info", `Uploading recording (${(blob.size / 1e6).toFixed(1)} MB)…`);
      const entry = await uploadAndPost(blob, "recording", (file) => ({ kind: "recording", capturedAt, page: current.page, file, durationMs }));
      onEntry(entry);
    } catch (error) {
      toast("error", `Recording not saved: ${errorMessage(error)}`);
    } finally {
      displayBtn.disabled = false;
      render(getState());
    }
  }

  // ---- rendering ---------------------------------------------------------
  function render({ recording, shortcuts, settings }: PanelState): void {
    const { screen, voice } = recording;
    const tabRunning = screen?.source === "tab";

    recordBtn.textContent = tabRunning ? "■ Stop tab recording" : "● Record tab";
    recordBtn.classList.toggle("active", tabRunning);
    recordBtn.disabled = pending.has("tab") || screen?.source === "display";
    recordBtn.title = withShortcut(
      tabRunning ? "Stop and save the tab recording" : "Record this tab (no picker; keeps recording with the panel closed)",
      shortcuts,
      "toggle-recording",
    );

    voiceBtn.textContent = voice ? "■ Stop voice note" : "🎙 Voice note";
    voiceBtn.classList.toggle("active", Boolean(voice));
    voiceBtn.disabled = pending.has("voice");
    voiceBtn.title = withShortcut(voice ? "Stop and save the voice note" : "Record a voice note with a transcript", shortcuts, "toggle-voice");
    if (voice?.microphoneFallback) {
      micHint.textContent = "Mic: default (selected one not found)";
    } else {
      const mic = voice ? voice.microphoneLabel : settings.microphoneLabel;
      micHint.textContent = mic ? `Mic: ${mic}` : "Mic: system default";
    }

    if (!voice) {
      transcriptBox.hidden = true;
    } else if (transcriptBox.hidden) {
      transcriptBox.hidden = false;
      replace(transcriptBox, h("span", { class: "interim" }, "Listening…"));
    }

    displayBtn.textContent = display ? "■ Stop window/screen recording" : "Record a window or screen…";
    displayBtn.disabled = !display && Boolean(screen);

    for (const [button, hint, command] of shotButtons) button.title = withShortcut(hint, shortcuts, command);

    tickTimer(recordTimer, () => (getState().recording.screen ? Date.now() - getState().recording.screen!.startedAt : null));
    tickTimer(voiceTimer, () => (getState().recording.voice ? Date.now() - getState().recording.voice!.startedAt : null));
  }

  const hint = h("div", { class: "shortcut-hint-slot" });
  replace(
    root,
    h("h2", {}, "Capture"),
    shots,
    h(
      "div",
      { class: "grid2" },
      h("div", { class: "stack" }, recordBtn, recordTimer),
      h("div", { class: "stack" }, voiceBtn, voiceTimer, micHint),
    ),
    transcriptBox,
    h("div", { class: "row display-row" }, displayBtn, displayHint),
    hint,
  );
  mountShortcutHint(hint);

  let previous: PanelState | null = null;
  subscribe((state) => {
    if (previous && state.recording === previous.recording && state.shortcuts === previous.shortcuts && state.settings === previous.settings) return;
    previous = state;
    render(state);
  });

  // Closing the panel ends a window/screen recording (it lives in this
  // page); at least don't leave a stale REC behind.
  window.addEventListener("pagehide", () => {
    if (display) void clearOwnDisplayState(display.id);
  });

  return {
    showTranscript(final, interim) {
      if (!getState().recording.voice) return;
      transcriptBox.hidden = false;
      if (!final && !interim) replace(transcriptBox, h("span", { class: "interim" }, "Listening…"));
      else replace(transcriptBox, final, interim && h("span", { class: "interim" }, ` ${interim}`));
    },
  };
}

/** Clear the screen slot only if it is still our display recording. */
async function clearOwnDisplayState(id: string): Promise<void> {
  const current = await getStoredState("recordingScreen");
  if (current?.id === id) await clearState("recordingScreen");
}

function setBusy(container: HTMLElement, busy: boolean): void {
  container.querySelectorAll("button").forEach((b) => (b.disabled = busy));
  container.classList.toggle("busy", busy);
}

/** Per element: one timer loop at most, updating every half second while `elapsed()` is non-null. */
const ticking = new WeakSet<HTMLElement>();
function tickTimer(el: HTMLElement, elapsed: () => number | null): void {
  if (ticking.has(el)) return;
  const tick = (): void => {
    const ms = elapsed();
    el.textContent = ms === null ? "" : formatDuration(ms);
    if (ms !== null) setTimeout(tick, 500);
    else ticking.delete(el);
  };
  ticking.add(el);
  tick();
}
