/**
 * Starting and stopping the recorders that live in the offscreen document,
 * and keeping `recordingScreen` / `recordingVoice` in storage.session in
 * step with them. Triggered by the shortcuts (commands.ts) and by the
 * toolbar menu's items (a `menu:run` message, which runs the same command),
 * which therefore behave identically; the transcript box's Stop button
 * (`stopFromOverlay`) can only stop.
 *
 * Who owns what:
 *   worker (this file)  decides start vs stop, gets the tab-capture stream
 *                       id, writes the recording state, shows toasts;
 *   offscreen document  owns the MediaStreams and MediaRecorders, uploads
 *                       the result, reports back by message;
 *   storage.session     the record of what is running, read by the menu,
 *                       the indicator and any later worker instance.
 *
 * One decision at a time: every toggle, stop and state change here runs
 * through one queue (`exclusive`). Otherwise two quick presses would both
 * read "nothing running", both start, the second's state would overwrite
 * the first's, and the first recording would run on with nothing pointing
 * at it (Stop would find nothing to stop). The queue is module state, which
 * is enough: only one worker instance runs at a time, and a toggle keeps it
 * busy (alive) until it is done. What a worker restart can still leave
 * behind, `reconcileRecordingState` cleans up at the next start: state
 * nothing backs is cleared, and a recording the offscreen document runs
 * without state pointing at it is stopped (which saves it).
 *
 * The state is written BEFORE the start request goes out, with a fresh id:
 * a tab that is closed the instant recording starts makes the offscreen
 * document report "stopped" before we'd otherwise have written "started",
 * and we'd be left showing REC forever. With the state written first,
 * "stopped" always finds it, and `clearIfCurrent` only clears the slot if
 * the id still matches (a late event from an older recording can't clear a
 * newer one).
 *
 * Both recorders transcribe the microphone into an editable box on the page
 * (voice-overlay.ts), so only one of them runs at a time: two speech
 * recognisers on one microphone would fight over it. With transcription
 * turned off (Settings.transcribe) the box is still shown, for typed notes,
 * and says that nothing is transcribed; the one-at-a-time rule is kept
 * anyway, so what can run together doesn't depend on a setting.
 */

import { errorMessage, isTopFrameOfTab, type OffscreenStartResponse, type RecorderKind, type RecorderSettings, type RecorderToggleResponse, type SenderLike } from "../shared/messages.js";
import { pageContextFromTab } from "../shared/page-context.js";
import { PERMISSIONS_PAGE } from "../shared/pages.js";
import { compatibleServerForTab } from "../shared/server.js";
import { loadSettings } from "../shared/settings.js";
import { describeMicrophoneError, microphoneProblem } from "../shared/speech-errors.js";
import { clearState, getRecordingState, getState, setState, type TranscriptBoxState } from "../shared/state.js";
import { friendlyRecordingError } from "./errors.js";
import { notifyToast } from "./notify.js";
import { closeOffscreenIfIdle, sendIfOpen, sendToRecorder } from "./offscreen.js";
import { closeTranscriptBox, registerTranscriptBox, showTranscriptBox } from "./voice-overlay.js";

/** Ignore state younger than this when reconciling (a start may be in flight). */
const RECONCILE_GRACE_MS = 15_000;

/** Every decision about the recorders runs one after another (see the header). */
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

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
 * may be called after awaits (and after waiting in the queue). Verified
 * with Chrome 155 (e2e): the toolbar menu's "Start recording" reaches this
 * function through a runtime message (`menu:run`), i.e. with no gesture in
 * the worker at all, and capture starts. Chrome's own offscreen tab-capture
 * sample also calls it after two awaits.
 */
export function toggleTabRecording(tab: chrome.tabs.Tab | undefined): Promise<RecorderToggleResponse> {
  return exclusive(() => toggleTab(tab));
}

async function toggleTab(tab: chrome.tabs.Tab | undefined): Promise<RecorderToggleResponse> {
  const { screen, voice } = await getRecordingState();
  if (screen) return stop("tab", screen.id);
  if (voice) return fail("A voice note is running. Stop it before you start a recording (recordings transcribe your voice too).");

  if (tab?.id === undefined) return fail("No active tab to record.");
  const tabId = tab.id;
  let streamId: string;
  try {
    streamId = await getMediaStreamId(tabId);
  } catch (error) {
    // "Cannot capture a tab with an active stream" may be our own recorder,
    // still capturing with no state pointing at it (the slot is empty here).
    const orphan = (await sendIfOpen({ type: "offscreen:status" }).catch(() => null))?.tab;
    if (orphan) return orphanStopped("tab", orphan);
    return fail(friendlyRecordingError(error));
  }

  let settings: RecorderSettings;
  try {
    // Before the box is registered: it needs to know whether there will be a transcript.
    settings = await recorderSettings(tab);
  } catch (error) {
    return fail(`Could not start the tab recording: ${errorMessage(error)}`);
  }
  const id = crypto.randomUUID();
  const page = pageContextFromTab(tab);
  const startedAt = Date.now();
  await setState("recordingScreen", { id, startedAt, page, tabId });
  await registerTranscriptBox(id, boxFor("tab", tabId, startedAt, settings));
  let response: OffscreenStartResponse;
  try {
    response = await sendToRecorder({ type: "offscreen:start-tab", id, streamId, page, settings });
  } catch (error) {
    response = { ok: false, error: errorMessage(error) };
  }
  if (!response.ok) {
    await startFailed("tab", id);
    if (response.runningId) return orphanStopped("tab", response.runningId);
    return fail(`Could not start the tab recording: ${friendlyRecordingError(response.error)}`);
  }
  await showTranscriptBox(id);
  return { ok: true, running: true };
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

/**
 * Start or stop a voice note about `tab`. While it runs, `tab` shows the live
 * transcript in a box on the page (voice-overlay.ts), when we can inject there.
 */
export function toggleVoice(tab: chrome.tabs.Tab | undefined): Promise<RecorderToggleResponse> {
  return exclusive(() => toggleVoiceNote(tab));
}

async function toggleVoiceNote(tab: chrome.tabs.Tab | undefined): Promise<RecorderToggleResponse> {
  const { screen, voice } = await getRecordingState();
  if (voice) return stop("voice", voice.id);
  if (screen) return fail("A tab recording is running and already transcribes what you say. Stop it before you start a voice note.");

  let settings: RecorderSettings;
  try {
    settings = await recorderSettings(tab);
  } catch (error) {
    // E.g. the page's own holt server stopped answering (shared/server-resolve.ts).
    return fail(`Could not start the voice note: ${errorMessage(error)}`);
  }
  const id = crypto.randomUUID();
  const startedAt = Date.now();
  const tabId = tab?.id;
  const page = pageContextFromTab(tab);
  await setState("recordingVoice", { id, startedAt, page, microphoneLabel: settings.microphoneLabel, ...(tabId !== undefined && { tabId }) });
  if (tabId !== undefined) await registerTranscriptBox(id, boxFor("voice", tabId, startedAt, settings));
  let response: OffscreenStartResponse;
  try {
    response = await sendToRecorder({ type: "offscreen:start-voice", id, page, settings });
  } catch (error) {
    response = { ok: false, error: errorMessage(error) };
  }

  if (!response.ok) {
    await startFailed("voice", id);
    if (response.runningId) return orphanStopped("voice", response.runningId);
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
  await showTranscriptBox(id);
  return { ok: true, running: true };
}

/**
 * The Stop button in a transcript box on the page. That message comes from
 * inside a web page, so it is only honoured from the top frame of the tab
 * the recording's box was put in, and it can only stop a recording, never
 * start one.
 */
export function stopFromOverlay(sender: SenderLike, id: string): Promise<RecorderToggleResponse> {
  return exclusive(async () => {
    const { screen, voice } = await getRecordingState();
    if (voice?.id === id && voice.tabId !== undefined && isTopFrameOfTab(sender, voice.tabId)) return stop("voice", id);
    if (screen?.id === id && isTopFrameOfTab(sender, screen.tabId)) return stop("tab", id);
    return { ok: false, error: "Nothing to stop here." };
  });
}

async function voiceStartFailed(error: string, errorName: string | undefined): Promise<RecorderToggleResponse> {
  // The offscreen document reports the DOMException's name and message (the
  // exception itself doesn't survive messaging); shared/speech-errors.ts words it.
  const message = describeMicrophoneError({ name: errorName, message: error }, "voice-note");
  if (microphoneProblem(errorName) === "blocked") {
    // The offscreen document can't show a permission prompt (it is never
    // visible). permissions.html, in a normal tab, can.
    const shown = await notifyToast("error", message, "open-permissions");
    // Panel closed: nobody can click the toast's button, so open the page
    // directly. The user just asked for a voice note, so this is expected.
    if (!shown) await openPermissionsPage();
    return { ok: false, error: message };
  }
  return fail(message);
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
    console.warn("[holt] stop request failed", error);
  }
  if (!wasRunning) {
    await closeTranscriptBox(id);
    await notifyToast("error", `The ${recorder === "tab" ? "tab recording" : "voice note"} had already stopped (the background recorder was gone); nothing was saved.`);
    void closeOffscreenIfIdle();
  }
  return { ok: true, running: false };
}

/** Called for `recorder:stopped` from the offscreen document. */
export function onRecorderStopped(recorder: RecorderKind, id: string): Promise<void> {
  return exclusive(() => clearIfCurrent(slotOf(recorder), id));
}

/**
 * A start request for recording `id` failed: forget it, and if the
 * recorder started it after all (the request timed out, but the document
 * got there in the end), stop it rather than leave it running unseen.
 */
async function startFailed(recorder: RecorderKind, id: string): Promise<void> {
  await clearIfCurrent(slotOf(recorder), id);
  await closeTranscriptBox(id);
  try {
    const status = await sendIfOpen({ type: "offscreen:status" });
    if (status?.[recorder] === id) await sendIfOpen({ type: "offscreen:stop", recorder });
  } catch (error) {
    console.warn("[holt] could not check the recorder after a failed start", error);
  }
  void closeOffscreenIfIdle();
}

/**
 * The recorder answered a start with "already running `runningId`": a
 * recording nothing in our state points at (the worker lost track of it).
 * Stop it, which saves it like any other (offscreen/index.ts), and tell
 * the user; the next press starts a new one.
 */
async function orphanStopped(recorder: RecorderKind, runningId: string): Promise<RecorderToggleResponse> {
  console.warn("[holt] the recorder was still running", runningId, "without state; stopping it");
  await stopOrphan(recorder);
  const what = recorder === "tab" ? "tab recording" : "voice note";
  return fail(`An earlier ${what} was still running in the background; it has been stopped and saved. Press again to start a new one.`);
}

async function stopOrphan(recorder: RecorderKind): Promise<void> {
  try {
    await sendIfOpen({ type: "offscreen:stop", recorder });
  } catch (error) {
    console.warn("[holt] could not stop an orphaned recording", error);
  }
}

function slotOf(recorder: RecorderKind): "screen" | "voice" {
  return recorder === "tab" ? "screen" : "voice";
}

/**
 * Clear a slot if it still holds recording `id`. Tab recordings live in the
 * "screen" slot. The transcript box stays: it closes once the transcript is
 * saved (voice-overlay.ts), which may be after a review.
 */
async function clearIfCurrent(slot: "screen" | "voice", id: string): Promise<void> {
  const key = slot === "screen" ? "recordingScreen" : "recordingVoice";
  if ((await getState(key))?.id === id) await clearState(key);
}

/**
 * What the offscreen recorder needs, including the server, resolved for the
 * tab the recording starts on (shared/server.ts). The offscreen document gets
 * it once, with the start request, and uploads there whatever happens next:
 * the recording is pinned to that server for its lifetime, even if the tab
 * navigates to another origin (or another project's dev server) meanwhile,
 * or the settings change.
 */
/**
 * What the offscreen recorder needs, including the server the result will
 * go to. Throws (and the recording does not start) if that server speaks
 * another protocol version (shared/server.ts `assertCompatible`): better
 * than a recording the server refuses after the user has narrated it.
 */
async function recorderSettings(tab: chrome.tabs.Tab | undefined): Promise<RecorderSettings> {
  const settings = await loadSettings();
  const { serverUrl } = await compatibleServerForTab(tab, settings);
  const { token, transcribe, keepAudio, microphoneId, microphoneLabel } = settings;
  return { serverUrl, token, transcribe, keepAudio, microphoneId, microphoneLabel };
}

/** The transcript box of a recording about to start; it says so when transcription is off. */
function boxFor(recorder: RecorderKind, tabId: number, startedAt: number, settings: RecorderSettings): TranscriptBoxState {
  return settings.transcribe ? { recorder, tabId, startedAt } : { recorder, tabId, startedAt, untranscribed: true };
}

async function fail(message: string): Promise<RecorderToggleResponse> {
  await notifyToast("error", message);
  return { ok: false, error: message };
}

/**
 * On worker start, bring the state and the offscreen document back in step:
 *  - state nothing backs any more (the offscreen document crashed or was
 *    closed) is dropped. Entries younger than RECONCILE_GRACE_MS are left
 *    alone: the event that woke this worker may be the start request that
 *    just wrote them;
 *  - a recording the document runs that no state points at (a previous
 *    worker cleared its slot and died before the stop request went out) is
 *    stopped, which saves it. Its state is always written before its start
 *    request, so "running but not in state" can't be a start in flight.
 */
export function reconcileRecordingState(): Promise<void> {
  return exclusive(async () => {
    try {
      const { screen, voice } = await getRecordingState();
      const status = await sendIfOpen({ type: "offscreen:status" });
      const old = (startedAt: number): boolean => Date.now() - startedAt > RECONCILE_GRACE_MS;
      if (screen && old(screen.startedAt) && status?.tab !== screen.id) await clearStale("screen", screen.id);
      if (voice && old(voice.startedAt) && status?.voice !== voice.id) await clearStale("voice", voice.id);
      if (status?.tab && status.tab !== screen?.id) await stopOrphan("tab");
      if (status?.voice && status.voice !== voice?.id) await stopOrphan("voice");
    } catch (error) {
      console.warn("[holt] could not reconcile the recording state", error);
    }
  });
}

/** A recording nothing backs any more: forget it, and take its box off the page. */
async function clearStale(slot: "screen" | "voice", id: string): Promise<void> {
  await clearIfCurrent(slot, id);
  await closeTranscriptBox(id);
}
