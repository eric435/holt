/**
 * Starting and stopping the recorders that live in the offscreen document,
 * and keeping `recordingScreen` / `recordingVoice` in storage.session in
 * step with them. Triggered by the shortcuts (commands.ts) and by the side
 * panel's buttons (a `recorder:toggle` message), which therefore behave
 * identically.
 *
 * Who owns what:
 *   worker (this file)  decides start vs stop, gets the tab-capture stream
 *                       id, writes the recording state, shows toasts;
 *   offscreen document  owns the MediaStreams and MediaRecorders, uploads
 *                       the result, reports back by message;
 *   storage.session     the record of what is running, read by the panel,
 *                       the indicator and any later worker instance.
 *
 * The state is written BEFORE the start request goes out, with a fresh id:
 * a tab that is closed the instant recording starts makes the offscreen
 * document report "stopped" before we'd otherwise have written "started",
 * and we'd be left showing REC forever. With the state written first,
 * "stopped" always finds it, and `clearIfCurrent` only clears the slot if
 * the id still matches (a late event from an older recording can't clear a
 * newer one).
 *
 * The worker can be stopped by Chrome mid-recording; nothing here relies on
 * module variables. The offscreen document's messages wake a new instance.
 */

import type { PageContext } from "@nitpick/protocol";
import { errorMessage, type RecorderKind, type RecorderSettings, type RecorderToggleResponse } from "../shared/messages.js";
import { pageContextFromTab } from "../shared/page-context.js";
import { loadSettings } from "../shared/settings.js";
import { clearState, getRecordingState, getState, setState } from "../shared/state.js";
import { friendlyRecordingError } from "./errors.js";
import { notifyToast } from "./notify.js";
import { closeOffscreenIfIdle, hasOffscreenDocument, sendIfOpen, sendToRecorder } from "./offscreen.js";

const PERMISSIONS_PAGE = "permissions.html";
/** Ignore state younger than this when reconciling (a start may be in flight). */
const RECONCILE_GRACE_MS = 15_000;

// ---------------------------------------------------------------------------
// Tab recording
// ---------------------------------------------------------------------------

/**
 * Start or stop recording `tab`.
 *
 * About user gestures: chrome.tabCapture.getMediaStreamId is NOT bound to
 * the synchronous part of the gesture the way sidePanel.open() is. What it
 * checks is the activeTab grant for the target tab, which the shortcut (or
 * a toolbar click) creates and which lasts until the tab navigates. So it
 * may be called after awaits. Verified with Chrome 155 (e2e): the panel's
 * "Record tab" button reaches this function through a runtime message,
 * i.e. with no gesture in the worker at all, and capture starts. Chrome's
 * own offscreen tab-capture sample also calls it after two awaits.
 */
export async function toggleTabRecording(tab: chrome.tabs.Tab | undefined): Promise<RecorderToggleResponse> {
  const { screen } = await getRecordingState();
  if (screen?.source === "display") {
    return fail("A window/screen recording is running in the side panel. Stop it there first.");
  }
  if (screen) return stop("tab", screen.id);

  if (tab?.id === undefined) return fail("No active tab to record.");
  const tabId = tab.id;
  let streamId: string;
  try {
    streamId = await getMediaStreamId(tabId);
  } catch (error) {
    return fail(friendlyRecordingError(error));
  }

  const id = crypto.randomUUID();
  const page = pageContextFromTab(tab);
  await setState("recordingScreen", { id, source: "tab", startedAt: Date.now(), page, tabId });
  try {
    const response = await sendToRecorder({ type: "offscreen:start-tab", id, streamId, page, settings: await recorderSettings() });
    if (!response.ok) throw new Error(response.error);
    return { ok: true, running: true };
  } catch (error) {
    await clearIfCurrent("screen", id);
    void closeOffscreenIfIdle();
    return fail(`Could not start the tab recording: ${friendlyRecordingError(error)}`);
  }
}

/** chrome.tabCapture.getMediaStreamId has no Promise form in our typings; wrap the callback. */
function getMediaStreamId(targetTabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
      const error = chrome.runtime.lastError;
      if (error || !streamId) reject(new Error(error?.message ?? "Chrome returned no stream id."));
      else resolve(streamId);
    });
  });
}

// ---------------------------------------------------------------------------
// Voice note
// ---------------------------------------------------------------------------

export async function toggleVoice(page: PageContext): Promise<RecorderToggleResponse> {
  const { voice } = await getRecordingState();
  if (voice) return stop("voice", voice.id);

  const settings = await recorderSettings();
  const id = crypto.randomUUID();
  await setState("recordingVoice", { id, startedAt: Date.now(), page, microphoneLabel: settings.microphoneLabel });
  let response;
  try {
    response = await sendToRecorder({ type: "offscreen:start-voice", id, page, settings });
  } catch (error) {
    response = { ok: false as const, error: errorMessage(error) };
  }

  if (!response.ok) {
    await clearIfCurrent("voice", id);
    void closeOffscreenIfIdle();
    return voiceStartFailed(response.error, response.errorName);
  }

  // Record which mic is really in use (the default's label, or the chosen one's).
  const current = await getState("recordingVoice");
  if (current?.id === id && (response.microphoneLabel !== undefined || response.microphoneFallback)) {
    const next = { ...current, microphoneLabel: response.microphoneLabel ?? current.microphoneLabel };
    // Also in the toolbar tooltip, which is all the user sees with the panel closed.
    if (response.microphoneFallback) next.microphoneFallback = true;
    await setState("recordingVoice", next);
  }
  if (response.microphoneFallback) {
    const used = response.microphoneLabel ? ` (${response.microphoneLabel})` : "";
    await notifyToast("info", `Selected microphone not found; used the default${used}.`);
  }
  return { ok: true, running: true };
}

async function voiceStartFailed(error: string, errorName: string | undefined): Promise<RecorderToggleResponse> {
  if (errorName === "NotAllowedError" || errorName === "SecurityError") {
    // The offscreen document can't show a permission prompt (it is never
    // visible). permissions.html, in a normal tab, can.
    const message = "Microphone access is blocked for nitpick. Allow it once on nitpick's permission page, then try again.";
    const shown = await notifyToast("error", message, "open-permissions");
    // Panel closed: nobody can click the toast's button, so open the page
    // directly. The user just asked for a voice note, so this is expected.
    if (!shown) await openPermissionsPage();
    return { ok: false, error: message };
  }
  if (errorName === "NotFoundError") return fail("No microphone found.");
  return fail(`Could not start the voice note: ${error}`);
}

export async function openPermissionsPage(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL(PERMISSIONS_PAGE) });
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

async function stop(recorder: RecorderKind, id: string): Promise<RecorderToggleResponse> {
  // Clear right away so the indicator goes off without waiting for the
  // round trip; "recorder:stopped" will find nothing left to do.
  await clearIfCurrent(slotOf(recorder), id);
  let wasRunning = false;
  try {
    wasRunning = (await sendIfOpen({ type: "offscreen:stop", recorder }))?.wasRunning ?? false;
  } catch (error) {
    console.warn("[nitpick] stop request failed", error);
  }
  if (!wasRunning) {
    await notifyToast("error", `The ${recorder === "tab" ? "tab recording" : "voice note"} had already stopped (the background recorder was gone); nothing was saved.`);
    void closeOffscreenIfIdle();
  }
  return { ok: true, running: false };
}

/** Called for `recorder:stopped` from the offscreen document. */
export async function onRecorderStopped(recorder: RecorderKind, id: string): Promise<void> {
  await clearIfCurrent(slotOf(recorder), id);
}

function slotOf(recorder: RecorderKind): "screen" | "voice" {
  return recorder === "tab" ? "screen" : "voice";
}

/** Clear a slot if it still holds recording `id`. Tab recordings live in the "screen" slot. */
async function clearIfCurrent(slot: "screen" | "voice", id: string): Promise<void> {
  const key = slot === "screen" ? "recordingScreen" : "recordingVoice";
  const current = await getState(key);
  if (current?.id === id) await clearState(key);
}

async function recorderSettings(): Promise<RecorderSettings> {
  const { serverUrl, token, keepAudio, microphoneId, microphoneLabel } = await loadSettings();
  return { serverUrl, token, keepAudio, microphoneId, microphoneLabel };
}

async function fail(message: string): Promise<RecorderToggleResponse> {
  await notifyToast("error", message);
  return { ok: false, error: message };
}

/**
 * On worker start: drop recording state nothing backs any more (the
 * offscreen document crashed or was closed, or the side panel that ran a
 * window/screen recording went away without clearing its slot). Entries
 * younger than RECONCILE_GRACE_MS are left alone: the event that woke this
 * worker may be the start request that just wrote them.
 */
export async function reconcileRecordingState(): Promise<void> {
  try {
    const { screen, voice } = await getRecordingState();
    const old = (startedAt: number): boolean => Date.now() - startedAt > RECONCILE_GRACE_MS;
    const checkTab = screen?.source === "tab" && old(screen.startedAt);
    const checkVoice = voice !== undefined && old(voice.startedAt);
    if (checkTab || checkVoice) {
      const status = (await hasOffscreenDocument()) ? await sendIfOpen({ type: "offscreen:status" }) : null;
      if (checkTab && screen && status?.tab !== screen.id) await clearIfCurrent("screen", screen.id);
      if (checkVoice && voice && status?.voice !== voice.id) await clearIfCurrent("voice", voice.id);
    }
    if (screen?.source === "display" && old(screen.startedAt)) {
      const panels = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL" as chrome.runtime.ContextType] });
      if (panels.length === 0) await clearIfCurrent("screen", screen.id);
    }
  } catch (error) {
    console.warn("[nitpick] could not reconcile the recording state", error);
  }
}
