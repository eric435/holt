/**
 * Offscreen document entry point (dist/offscreen.js, loaded by offscreen.html).
 *
 * What an offscreen document is: a hidden extension page the service worker
 * creates with chrome.offscreen.createDocument() when it needs DOM APIs a
 * worker lacks. We need it for MediaRecorder, getUserMedia (microphone and
 * tab capture), AudioContext and the Web Speech API. Unlike the side panel
 * it is not tied to any window and nobody closes it by accident, so
 * recordings started from a shortcut keep running with the panel closed.
 *
 * Rules that shape this file:
 *  - One offscreen document per extension. The worker creates it lazily and
 *    closes it again when we report `recorder:idle` (background/offscreen.ts).
 *  - Of the extension APIs, only chrome.runtime exists here: no
 *    chrome.storage, no chrome.action, no chrome.tabs. So the worker sends
 *    everything we need (server URL, token, keepAudio, microphone, page
 *    context) with each start request, and we report every state change,
 *    result and error back to the worker by message. The worker owns the
 *    recording state (storage.session), the toolbar indicator and the toasts.
 *  - Blobs can't travel over runtime messaging, so we upload recordings to
 *    the server ourselves, then tell the worker about the entry
 *    (`entry-created`), which updates the recent list and notifies the panel
 *    or flashes the badge.
 *  - Our messages also wake the worker if Chrome has shut it down mid-recording.
 *
 * Messages handled (all from the worker):
 *   offscreen:start-tab / offscreen:start-voice   -> OffscreenStartResponse
 *   offscreen:stop                                -> { ok, wasRunning } (upload continues afterwards)
 *   offscreen:status                              -> OffscreenStatusResponse
 * Messages sent (to the worker; the panel also hears them):
 *   recorder:stopped, recorder:toast, recorder:idle, entry-created,
 *   recorder:transcript (for the panel's live transcript)
 */

import type { EntryInput, EntryKind, PageContext } from "@holt/protocol";
import { getApi } from "../shared/api.js";
import {
  errorMessage,
  isOffscreenStartTabRequest,
  isOffscreenStartVoiceRequest,
  isOffscreenStopRequest,
  isTrustedExtensionSender,
  onMessage,
  type Message,
  type OffscreenStartResponse,
  type OffscreenStartTabRequest,
  type OffscreenStartVoiceRequest,
  type OffscreenStatusResponse,
  type RecorderKind,
  type RecorderSettings,
  type ToastAction,
  type ToastLevel,
} from "../shared/messages.js";
import type { RecordedMedia } from "../shared/media-recorder.js";
import { startTabRecording } from "./tab.js";
import { startVoiceNote, type VoiceResult } from "./voice.js";

interface Active {
  id: string;
  page: PageContext;
  settings: RecorderSettings;
  /** Stop recording; resolves with what to upload. */
  stop(): Promise<{ kind: "tab"; media: RecordedMedia } | { kind: "voice"; result: VoiceResult }>;
}

const active: Partial<Record<RecorderKind, Active>> = {};
/** Recordings stopped but not uploaded yet: the document must stay open for them. */
let uploading = 0;

onMessage((message: Message, sender) => {
  // Content scripts' runtime messages reach extension pages too; only our
  // worker (and pages, which never send these) may drive the recorders.
  if (!isTrustedExtensionSender(sender, chrome.runtime.id)) return undefined;
  switch (message.type) {
    case "offscreen:start-tab":
      if (!isOffscreenStartTabRequest(message)) return { ok: false, error: "Malformed start request." };
      return startTab(message);
    case "offscreen:start-voice":
      if (!isOffscreenStartVoiceRequest(message)) return { ok: false, error: "Malformed start request." };
      return startVoice(message);
    case "offscreen:stop": {
      if (!isOffscreenStopRequest(message)) return { ok: true, wasRunning: false };
      const wasRunning = Boolean(active[message.recorder]);
      void finish(message.recorder);
      return { ok: true, wasRunning };
    }
    case "offscreen:status":
      return status();
    default:
      return undefined; // everything else is for the worker or the panel
  }
});

function status(): OffscreenStatusResponse {
  return { ok: true, tab: active.tab?.id ?? null, voice: active.voice?.id ?? null, uploading };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function startTab(request: OffscreenStartTabRequest): Promise<OffscreenStartResponse> {
  if (active.tab) return { ok: false, error: "A tab recording is already running." };
  try {
    const recording = await startTabRecording(request.streamId, () => void finish("tab"));
    console.info("[holt] tab capture running at", recording.settings.width, "x", recording.settings.height);
    active.tab = {
      id: request.id,
      page: request.page,
      settings: request.settings,
      stop: async () => ({ kind: "tab", media: await recording.stop() }),
    };
    return { ok: true };
  } catch (error) {
    return startFailure(error);
  }
}

async function startVoice(request: OffscreenStartVoiceRequest): Promise<OffscreenStartResponse> {
  if (active.voice) return { ok: false, error: "A voice note is already running." };
  try {
    const started = await startVoiceNote(request.settings.microphoneId, ({ final, interim }) => {
      // Best effort: only the panel listens, and it may be closed.
      chrome.runtime.sendMessage({ type: "recorder:transcript", final, interim }).catch(() => undefined);
    });
    active.voice = {
      id: request.id,
      page: request.page,
      settings: request.settings,
      stop: async () => ({ kind: "voice", result: await started.recording.stop() }),
    };
    const response: OffscreenStartResponse = { ok: true, microphoneLabel: started.microphoneLabel };
    if (started.microphoneFallback) response.microphoneFallback = true;
    return response;
  } catch (error) {
    return startFailure(error);
  }
}

function startFailure(error: unknown): OffscreenStartResponse {
  const name = error instanceof DOMException || error instanceof Error ? error.name : undefined;
  const response: OffscreenStartResponse = { ok: false, error: errorMessage(error) };
  if (name) response.errorName = name;
  // If this was the only reason to exist, let the worker close us.
  maybeIdle();
  return response;
}

// ---------------------------------------------------------------------------
// Stop + upload
// ---------------------------------------------------------------------------

/**
 * Stop `kind` (on request, or because its stream ended) and upload it.
 * Tells the worker "stopped" right away, so the indicator goes off before
 * the (possibly slow) upload.
 */
async function finish(kind: RecorderKind): Promise<void> {
  const current = active[kind];
  if (!current) return;
  delete active[kind];
  uploading++;
  send({ type: "recorder:stopped", recorder: kind, id: current.id });
  try {
    const stopped = await current.stop();
    if (stopped.kind === "tab") await saveTab(current, stopped.media);
    else await saveVoice(current, stopped.result);
  } catch (error) {
    toast("error", `${kind === "tab" ? "Recording" : "Voice note"} not saved: ${errorMessage(error)}`);
  } finally {
    uploading--;
    maybeIdle();
  }
}

async function saveTab(current: Active, media: RecordedMedia): Promise<void> {
  const capturedAt = new Date(Date.now() - media.durationMs).toISOString();
  toast("info", `Uploading recording (${(media.blob.size / 1e6).toFixed(1)} MB)…`);
  await upload(current.settings, media.blob, "recording", (file) => ({
    kind: "recording",
    capturedAt,
    page: current.page,
    file,
    durationMs: media.durationMs,
  }));
}

async function saveVoice(current: Active, result: VoiceResult): Promise<void> {
  if (result.transcriptError) toast("info", result.transcriptError);
  const transcript = result.transcript.trim();
  // Audio is always kept when there is no transcript, or the note would be empty.
  const keepAudio = current.settings.keepAudio || !transcript;
  const capturedAt = new Date(Date.now() - result.durationMs).toISOString();
  const base = { kind: "voice-note" as const, capturedAt, page: current.page, durationMs: result.durationMs };
  if (keepAudio) {
    await upload(current.settings, result.blob, "voice-note", (file) => (transcript ? { ...base, file, transcript } : { ...base, file }));
  } else {
    await upload(current.settings, null, "voice-note", () => ({ ...base, transcript }));
  }
}

/** Upload `blob` (if any), post the entry, and hand it to the worker for notification. */
async function upload(settings: RecorderSettings, blob: Blob | null, kind: EntryKind, build: (file: string) => EntryInput): Promise<void> {
  const api = await getApi(settings);
  const file = blob ? (await api.uploadMedia(blob, kind)).file : "";
  const { entry, session } = await api.postEntry(build(file));
  send({ type: "entry-created", entry, session });
}

// ---------------------------------------------------------------------------
// Reporting to the worker
// ---------------------------------------------------------------------------

function maybeIdle(): void {
  if (!active.tab && !active.voice && uploading === 0) send({ type: "recorder:idle" });
}

function toast(level: ToastLevel, message: string, action?: ToastAction): void {
  send(action ? { type: "recorder:toast", level, message, action } : { type: "recorder:toast", level, message });
}

/**
 * Fire-and-forget to the worker. Wakes it if Chrome stopped it. A failure
 * here (extension being reloaded) has nobody left to report to.
 */
function send(message: Message): void {
  chrome.runtime.sendMessage(message).catch((error: unknown) => console.warn("[holt] could not reach the worker", error));
}
