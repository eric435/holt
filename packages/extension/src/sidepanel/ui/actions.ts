/**
 * The big buttons: screenshots, screen recording, voice note.
 *
 * Screenshots are delegated to the service worker (it owns captureVisibleTab
 * and the activeTab grant). Recordings happen here, in the panel, because
 * they need a document; the panel uploads them itself.
 */

import type { Entry, PageContext, ScreenshotMode } from "@nitpick/protocol";
import { errorMessage, sendMessage } from "../../shared/messages.js";
import { getActivePage } from "../page.js";
import { hasUserActivation, startScreenRecording, type ScreenRecording } from "../recorder/screen.js";
import { startVoiceNote, type VoiceRecording } from "../recorder/voice.js";
import { getState } from "../store.js";
import { uploadAndPost, postEntry } from "../upload.js";
import { formatDuration, h, replace } from "./dom.js";
import { toast } from "./toast.js";

export interface ActionsApi {
  toggleRecording(): void;
  toggleVoice(): void;
}

export function mountActions(root: HTMLElement, onEntry: (entry: Entry) => void): ActionsApi {
  // ---- screenshots -------------------------------------------------------
  const shotButton = (mode: ScreenshotMode, label: string, hint: string): HTMLButtonElement =>
    h("button", { class: "big", title: hint, onclick: () => void screenshot(mode) }, label);

  const shots = h(
    "div",
    { class: "grid3" },
    shotButton("viewport", "Visible", "Screenshot the visible part of the page (Alt+Shift+S)"),
    shotButton("full-page", "Full page", "Scroll and stitch the whole page (Alt+Shift+F)"),
    shotButton("area", "Area", "Drag to select an area (Alt+Shift+A)"),
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

  // ---- screen recording --------------------------------------------------
  let screen: ScreenRecording | null = null;
  let screenStartedAt = 0;
  let startedPage: PageContext | null = null;
  const recordBtn = h("button", { class: "big toggle", onclick: () => void toggleRecording(true) }, "● Record screen");
  const recordTimer = h("span", { class: "timer" });

  async function toggleRecording(fromClick = false): Promise<void> {
    if (screen) return void stopRecording();
    if (!fromClick && !hasUserActivation()) {
      // A shortcut can't start a screen share: Chrome requires a click here.
      recordBtn.classList.add("attention");
      recordBtn.focus();
      setTimeout(() => recordBtn.classList.remove("attention"), 2_000);
      toast("info", "Chrome needs a click to start screen sharing: press “Record screen”.");
      return;
    }
    try {
      const pagePromise = getActivePage();
      screen = await startScreenRecording(() => void stopRecording());
      screenStartedAt = Date.now();
      startedPage = await pagePromise;
      recordBtn.textContent = "■ Stop recording";
      recordBtn.classList.add("active");
      tickTimer(recordTimer, () => (screen ? Date.now() - screenStartedAt : null));
      void chrome.action.setBadgeText({ text: "REC" });
    } catch (error) {
      screen = null;
      const name = (error as DOMException).name;
      if (name === "NotAllowedError") toast("info", "Screen recording cancelled.");
      else toast("error", `Could not start screen recording: ${errorMessage(error)}`);
    }
  }

  async function stopRecording(): Promise<void> {
    const current = screen;
    if (!current) return;
    screen = null;
    recordBtn.textContent = "● Record screen";
    recordBtn.classList.remove("active");
    void chrome.action.setBadgeText({ text: "" });
    recordBtn.disabled = true;
    try {
      const { blob, durationMs } = await current.stop();
      const page = startedPage ?? (await getActivePage());
      const capturedAt = new Date(Date.now() - durationMs).toISOString();
      toast("info", `Uploading recording (${(blob.size / 1e6).toFixed(1)} MB)…`);
      const entry = await uploadAndPost(blob, "recording", (file) => ({ kind: "recording", capturedAt, page, file, durationMs }));
      onEntry(entry);
    } catch (error) {
      toast("error", `Recording not saved: ${errorMessage(error)}`);
    } finally {
      recordBtn.disabled = false;
    }
  }

  // ---- voice note --------------------------------------------------------
  let voice: VoiceRecording | null = null;
  let voiceStartedAt = 0;
  const voiceBtn = h("button", { class: "big toggle", onclick: () => void toggleVoice() }, "🎙 Voice note");
  const voiceTimer = h("span", { class: "timer" });
  const transcriptBox = h("div", { class: "transcript", hidden: true, "aria-live": "polite" });

  async function toggleVoice(): Promise<void> {
    if (voice) return void stopVoice();
    try {
      voice = await startVoiceNote(({ final, interim }) => {
        replace(transcriptBox, final, interim && h("span", { class: "interim" }, ` ${interim}`));
      });
      voiceStartedAt = Date.now();
      voiceBtn.textContent = "■ Stop voice note";
      voiceBtn.classList.add("active");
      replace(transcriptBox, h("span", { class: "interim" }, "Listening…"));
      transcriptBox.hidden = false;
      tickTimer(voiceTimer, () => (voice ? Date.now() - voiceStartedAt : null));
    } catch (error) {
      voice = null;
      const name = (error as DOMException).name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        toast("error", "Microphone access was blocked. Chrome may not show the permission prompt inside the side panel.", {
          label: "Grant microphone access",
          run: () => void chrome.tabs.create({ url: chrome.runtime.getURL("permissions.html") }),
        });
      } else if (name === "NotFoundError") {
        toast("error", "No microphone found.");
      } else {
        toast("error", `Could not start the voice note: ${errorMessage(error)}`);
      }
    }
  }

  async function stopVoice(): Promise<void> {
    const current = voice;
    if (!current) return;
    voice = null;
    voiceBtn.textContent = "🎙 Voice note";
    voiceBtn.classList.remove("active");
    voiceBtn.disabled = true;
    try {
      const [result, page] = await Promise.all([current.stop(), getActivePage()]);
      transcriptBox.hidden = true;
      if (result.transcriptError) toast("info", result.transcriptError);
      const transcript = result.transcript.trim();
      const keepAudio = getState().settings.keepAudio || !transcript;
      const capturedAt = new Date(Date.now() - result.durationMs).toISOString();
      const base = { kind: "voice-note" as const, capturedAt, page, durationMs: result.durationMs };
      const entry = keepAudio
        ? await uploadAndPost(result.blob, "voice-note", (file) => (transcript ? { ...base, file, transcript } : { ...base, file }))
        : await postEntry({ ...base, transcript });
      onEntry(entry);
    } catch (error) {
      toast("error", `Voice note not saved: ${errorMessage(error)}`);
    } finally {
      voiceBtn.disabled = false;
    }
  }

  replace(
    root,
    h("h2", {}, "Capture"),
    shots,
    h("div", { class: "grid2" }, h("div", { class: "stack" }, recordBtn, recordTimer), h("div", { class: "stack" }, voiceBtn, voiceTimer)),
    transcriptBox,
  );

  // If the panel is closed mid-recording the recording is lost; at least
  // don't leave a stale "REC" badge behind.
  window.addEventListener("pagehide", () => {
    if (screen) void chrome.action.setBadgeText({ text: "" });
  });

  return {
    toggleRecording: () => void toggleRecording(false),
    toggleVoice: () => void toggleVoice(),
  };
}

function setBusy(container: HTMLElement, busy: boolean): void {
  container.querySelectorAll("button").forEach((b) => (b.disabled = busy));
  container.classList.toggle("busy", busy);
}

/** Update `el` every half second with elapsed time while `elapsed()` is non-null. */
function tickTimer(el: HTMLElement, elapsed: () => number | null): void {
  const tick = (): void => {
    const ms = elapsed();
    el.textContent = ms === null ? "" : formatDuration(ms);
    if (ms !== null) setTimeout(tick, 500);
  };
  tick();
}
