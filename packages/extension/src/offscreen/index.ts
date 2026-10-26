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
 * Both recorders transcribe the microphone live (transcribe.ts): a voice
 * note what it records, a tab recording the user's narration; unless
 * transcription is off in the settings (`settings.transcribe`), in which
 * case no speech recogniser is started and the transcript is empty. The user can
 * edit the transcript in a box on the page while recording and review it
 * afterwards, so a stopped recording is not uploaded right away:
 *
 *   stop -> recorder:stopped (indicator off) -> recorder:finished { transcript }
 *        -> (the worker lets the user review it) -> offscreen:commit { save, transcript }
 *        -> upload with the reviewed transcript, or drop it
 *
 * Until the commit arrives the recording waits here (`awaiting`), at most
 * REVIEW_TIMEOUT_MS; then it is saved with the raw transcript, so a lost
 * review (the tab was closed, the worker never answered) can't lose it.
 *
 * Messages handled (all from the worker):
 *   offscreen:start-tab / offscreen:start-voice   -> OffscreenStartResponse
 *   offscreen:stop                                -> { ok, wasRunning } (finishing continues afterwards)
 *   offscreen:commit                              -> { ok, found } (upload continues afterwards)
 *   offscreen:status                              -> OffscreenStatusResponse
 * Messages sent (to the worker):
 *   recorder:stopped, recorder:finished, recorder:toast, recorder:idle,
 *   entry-created, recorder:transcript (live transcript, which the worker
 *   forwards to the box on the page)
 */

import type { EntryInput, EntryKind, PageContext } from "@holt/protocol";
import { createApi } from "../shared/api.js";
import {
  errorMessage,
  isOffscreenCommitRequest,
  isOffscreenStartTabRequest,
  isOffscreenStartVoiceRequest,
  isOffscreenStopRequest,
  isTrustedExtensionSender,
  onMessage,
  type Message,
  type OffscreenStartResponse,
  type OffscreenStartTabRequest,
  type OffscreenStartVoiceRequest,
  type OffscreenCommitResponse,
  type OffscreenStatusResponse,
  type RecorderFinishedMessage,
  type RecorderKind,
  type RecorderSettings,
  type RecorderTranscriptMessage,
  type ToastAction,
  type ToastLevel,
} from "../shared/messages.js";
import type { RecordedMedia } from "../shared/media-recorder.js";
import { noteText, recordingEntry, voiceNoteEntry } from "../shared/entry-bodies.js";
import { keepsVoiceAudio } from "../shared/settings.js";
import { startTabRecording } from "./tab.js";
import type { TranscriptResult, TranscriptUpdate } from "../shared/speech.js";
import { noTranscription, startNarration } from "./transcribe.js";
import { startVoiceNote, type VoiceResult } from "./voice.js";

/** How long a stopped recording waits for the user's review before it is saved as is. */
const REVIEW_TIMEOUT_MS = 60 * 60_000;

type Stopped = { kind: "tab"; media: RecordedMedia; transcript: TranscriptResult } | { kind: "voice"; result: VoiceResult };

interface Active {
  id: string;
  page: PageContext;
  settings: RecorderSettings;
  /** Stop recording; resolves with what to upload. */
  stop(): Promise<Stopped>;
}

interface Awaiting {
  current: Active;
  stopped: Stopped;
  /** The recogniser's transcript, saved if the review never comes. */
  transcript: string;
  timer: ReturnType<typeof setTimeout>;
}

const active: Partial<Record<RecorderKind, Active>> = {};
/** Stopped recordings waiting for `offscreen:commit`, by id. */
const awaiting = new Map<string, Awaiting>();
/** Recordings stopped but not saved yet (awaiting review or uploading): the document must stay open for them. */
let finishing = 0;

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
    case "offscreen:commit": {
      if (!isOffscreenCommitRequest(message)) return { ok: true, found: false } satisfies OffscreenCommitResponse;
      const found = commit(message.id, message.save, message.transcript);
      return { ok: true, found } satisfies OffscreenCommitResponse;
    }
    case "offscreen:status":
      return status();
    default:
      return undefined; // everything else is for the worker or the panel
  }
});

function status(): OffscreenStatusResponse {
  return { ok: true, tab: active.tab?.id ?? null, voice: active.voice?.id ?? null, finishing };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function startTab(request: OffscreenStartTabRequest): Promise<OffscreenStartResponse> {
  // The worker only starts a recorder whose slot is empty, so this one is
  // running behind its back: say which, so it can stop (and save) it.
  if (active.tab) return { ok: false, error: "A tab recording is already running.", runningId: active.tab.id };
  try {
    const recording = await startTabRecording(request.streamId, () => void finish("tab"));
    console.info("[holt] tab capture running at", recording.settings.width, "x", recording.settings.height);
    // Once the capture runs; it doesn't wait for (or depend on) the microphone.
    // With transcription off the microphone isn't opened at all: it is only there for the transcript.
    const narration = request.settings.transcribe ? startNarration(request.settings.microphoneId, transcriptSender("tab", request.id)) : noTranscription();
    active.tab = {
      id: request.id,
      page: request.page,
      settings: request.settings,
      stop: async () => {
        const [media, transcript] = await Promise.all([recording.stop(), narration.stop()]);
        return { kind: "tab", media, transcript };
      },
    };
    return { ok: true };
  } catch (error) {
    return startFailure(error);
  }
}

async function startVoice(request: OffscreenStartVoiceRequest): Promise<OffscreenStartResponse> {
  if (active.voice) return { ok: false, error: "A voice note is already running.", runningId: active.voice.id };
  try {
    const started = await startVoiceNote(request.settings.microphoneId, transcriptSender("voice", request.id), request.settings.transcribe);
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

/** Forward live transcript updates to the worker, which shows them in the box on the page. Best effort. */
function transcriptSender(recorder: RecorderKind, id: string): (update: TranscriptUpdate) => void {
  return ({ final, interim, error }) => {
    const message: RecorderTranscriptMessage = { type: "recorder:transcript", recorder, id, final, interim };
    if (error) message.error = error;
    chrome.runtime.sendMessage(message).catch(() => undefined);
  };
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
 * Stop `kind` (on request, or because its stream ended), then hand its
 * transcript to the worker for review and wait for `offscreen:commit`.
 * Tells the worker "stopped" right away, so the indicator goes off before
 * the transcript's last words (and the review) are in.
 */
async function finish(kind: RecorderKind): Promise<void> {
  const current = active[kind];
  if (!current) return;
  delete active[kind];
  finishing++;
  send({ type: "recorder:stopped", recorder: kind, id: current.id });
  let stopped: Stopped;
  try {
    stopped = await current.stop();
  } catch (error) {
    toast("error", `${label(kind)} not saved: ${errorMessage(error)}`);
    done();
    return;
  }
  const { text, error } = stopped.kind === "tab" ? stopped.transcript : { text: stopped.result.transcript, error: stopped.result.transcriptError };
  const timer = setTimeout(() => {
    console.warn("[holt] no review for", current.id, "in time; saving the transcript as recognised");
    commit(current.id, true, text);
  }, REVIEW_TIMEOUT_MS);
  awaiting.set(current.id, { current, stopped, transcript: text, timer });
  const message: RecorderFinishedMessage = { type: "recorder:finished", recorder: kind, id: current.id, transcript: text };
  if (error) message.error = error;
  send(message);
}

/**
 * The user's verdict on a finished recording: upload it with `transcript`,
 * or drop it. Returns false if `id` isn't waiting (any more). The upload
 * continues after we have answered.
 */
function commit(id: string, save: boolean, transcript: string): boolean {
  const waiting = awaiting.get(id);
  if (!waiting) return false;
  awaiting.delete(id);
  clearTimeout(waiting.timer);
  const { current, stopped } = waiting;
  void (async () => {
    try {
      if (!save) toast("info", `${label(stopped.kind)} discarded.`);
      else if (stopped.kind === "tab") await saveTab(current, stopped.media, transcript);
      else await saveVoice(current, stopped.result, transcript);
    } catch (error) {
      toast("error", `${label(stopped.kind)} not saved: ${errorMessage(error)}`);
    } finally {
      done();
    }
  })();
  return true;
}

function done(): void {
  finishing--;
  maybeIdle();
}

function label(kind: RecorderKind): string {
  return kind === "tab" ? "Recording" : "Voice note";
}

async function saveTab(current: Active, media: RecordedMedia, transcript: string): Promise<void> {
  const capturedAt = new Date(Date.now() - media.durationMs).toISOString();
  toast("info", `Uploading recording (${(media.blob.size / 1e6).toFixed(1)} MB)…`);
  // The reviewed narration is the user's words about the recording.
  const base = { capturedAt, page: current.page, durationMs: media.durationMs };
  await upload(current.settings, media.blob, "recording", (file) => recordingEntry(base, file, transcript));
}

async function saveVoice(current: Active, result: VoiceResult, reviewed: string): Promise<void> {
  if (result.transcriptError) toast("info", result.transcriptError);
  // Audio is kept if the user asked for it (off by default), always while
  // transcription is off, and whenever there are no usable words, or the
  // voice note would be empty (shared/settings.ts, unit-tested).
  const keepAudio = keepsVoiceAudio(current.settings, noteText(reviewed));
  const capturedAt = new Date(Date.now() - result.durationMs).toISOString();
  const base = { capturedAt, page: current.page, durationMs: result.durationMs };
  if (keepAudio) {
    await upload(current.settings, result.blob, "voice-note", (file) => voiceNoteEntry(base, file, reviewed));
  } else {
    await upload(current.settings, null, "voice-note", () => voiceNoteEntry(base, undefined, reviewed));
  }
}

/** Upload `blob` (if any), post the entry, and hand it to the worker for notification. */
async function upload(settings: RecorderSettings, blob: Blob | null, kind: EntryKind, build: (file: string) => EntryInput): Promise<void> {
  // The worker sends the server URL and token with each start request: an
  // offscreen document has no chrome.storage to read the settings from.
  // The server's protocol was checked when the recording started
  // (background/recording.ts).
  const api = createApi(settings);
  const file = blob ? (await api.uploadMedia(blob, kind)).file : "";
  const { entry, session } = await api.postEntry(build(file));
  send({ type: "entry-created", entry, session });
}

// ---------------------------------------------------------------------------
// Reporting to the worker
// ---------------------------------------------------------------------------

function maybeIdle(): void {
  if (!active.tab && !active.voice && finishing === 0) send({ type: "recorder:idle" });
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
