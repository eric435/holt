/**
 * Voice notes: microphone audio (getUserMedia + MediaRecorder) plus a live
 * transcript from the Web Speech API, started together.
 *
 * Runs in the offscreen document (it used to run in the side panel), so a
 * voice note keeps going when the panel is closed and can be started from a
 * shortcut. getUserMedia needs no user activation, only the microphone
 * permission.
 *
 * Microphone permission is per origin, and our origin is
 * chrome-extension://<id> everywhere: the panel, permissions.html and this
 * offscreen document share it. An offscreen document is never shown, so
 * Chrome cannot show a permission prompt for it: without a prior grant
 * getUserMedia rejects with NotAllowedError, and the worker then offers
 * permissions.html (a normal tab, where the prompt does show). Once granted
 * there it applies here too.
 *
 * Microphone choice: see mic.ts. The label of the device actually used is
 * reported back so the panel/tooltip can show it.
 *
 * Transcription (webkitSpeechRecognition) is best-effort:
 *  - It may be missing entirely (non-Chrome, some Chromium builds).
 *  - In Chrome it streams audio to Google's speech service, so it fails with
 *    `network` offline, and may fail with `not-allowed` /
 *    `service-not-allowed` in some contexts or under some policies.
 *  - In an offscreen document: not documented either way. Observed with
 *    Chrome 155: it starts (onstart fires) once the extension has microphone
 *    permission, and fails with `not-allowed` without it. Whether Google's
 *    service then returns text could not be tested headless (the fake
 *    microphone only beeps); the audio is kept regardless.
 *  - Which microphone: by default Chrome's recogniser opens the *system
 *    default* microphone itself, not ours. Newer Chrome accepts a
 *    MediaStreamTrack in `start(track)`, so we pass (a clone of) the track
 *    we record, and transcript and audio come from the same mic. Chrome 155
 *    has this overload (verified: `start("x")` throws "parameter 1 is not of
 *    type 'MediaStreamTrack'", and `start(track)` starts in the offscreen
 *    document). Chrome versions from before the overload ignore the extra
 *    argument (WebIDL drops surplus arguments) and transcribe from the
 *    system default mic while the audio file uses the selected one; if a
 *    browser rejects the track we fall back to plain `start()` the same way.
 *  - With `continuous = true` Chrome still ends recognition after a pause or
 *    about a minute; we restart it while the recording is running.
 * Whatever happens with the transcript, the audio recording continues and is
 * returned, so the user never loses what they said.
 */

import { AUDIO_TYPES, pickMimeType, record } from "../shared/media-recorder.js";
import { isMissingDeviceError, microphoneConstraints } from "./mic.js";

/** Errors after which restarting recognition is pointless. */
const FATAL_RECOGNITION_ERRORS = new Set(["not-allowed", "service-not-allowed", "network", "audio-capture", "language-not-supported"]);

export interface VoiceResult {
  blob: Blob;
  transcript: string;
  durationMs: number;
  /** Why there is no (or only a partial) transcript, if something failed. */
  transcriptError?: string;
}

export interface VoiceRecording {
  stop(): Promise<VoiceResult>;
}

export interface TranscriptUpdate {
  /** Finalised text so far. */
  final: string;
  /** Current best guess for the words being spoken right now. */
  interim: string;
}

export interface StartedVoiceNote {
  recording: VoiceRecording;
  /** Label of the microphone in use ("" if the browser doesn't say). */
  microphoneLabel: string;
  /** The selected microphone was not found, so the default one is used. */
  microphoneFallback: boolean;
}

export async function startVoiceNote(
  microphoneId: string,
  onTranscript: (update: TranscriptUpdate) => void,
): Promise<StartedVoiceNote> {
  let stream: MediaStream;
  let microphoneFallback = false;
  try {
    stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(microphoneId));
  } catch (error) {
    if (!microphoneId || !isMissingDeviceError((error as DOMException).name)) throw error;
    // The chosen mic is gone: use the default and let the caller say so.
    stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(""));
    microphoneFallback = true;
  }

  const track = stream.getAudioTracks()[0];
  const session = record(stream, pickMimeType(AUDIO_TYPES));
  // A clone, so the recogniser stopping/ending its track can never end the recording's.
  const speechTrack = track?.clone();
  const transcriber = startTranscription(onTranscript, speechTrack);

  let result: Promise<VoiceResult> | null = null;
  const recording: VoiceRecording = {
    stop() {
      result ??= (async () => {
        const [media, transcript] = await Promise.all([session.stop(), transcriber.stop()]);
        speechTrack?.stop();
        const out: VoiceResult = { blob: media.blob, durationMs: media.durationMs, transcript: transcript.text };
        if (transcript.error) out.transcriptError = transcript.error;
        return out;
      })();
      return result;
    },
  };
  return { recording, microphoneLabel: track?.label ?? "", microphoneFallback };
}

// ---------------------------------------------------------------------------
// Web Speech API (not in TypeScript's DOM lib, so minimal local typings)
// ---------------------------------------------------------------------------

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0: { transcript: string };
}
interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  /** `track` is newer Chrome only (older versions ignore it, see the header). */
  start(track?: MediaStreamTrack): void;
  stop(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function speechRecognitionCtor(): SpeechRecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

interface Transcriber {
  stop(): Promise<{ text: string; error?: string }>;
}

/** Wait at most this long after stop() for the last results to arrive. */
const FINAL_RESULT_GRACE_MS = 1_500;

function startTranscription(onTranscript: (update: TranscriptUpdate) => void, track: MediaStreamTrack | undefined): Transcriber {
  const Ctor = speechRecognitionCtor();
  if (!Ctor) {
    return { stop: async () => ({ text: "", error: "Speech recognition is not available in this browser." }) };
  }

  /** Finalised text from earlier recognition runs (each restart resets `results`). */
  let committed = "";
  /** Finalised text from the current run. */
  let runFinal = "";
  let error: string | undefined;
  let stopping = false;
  let ended: (() => void) | null = null;

  const recognition = new Ctor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";

  recognition.onresult = (e) => {
    let final = "";
    let interim = "";
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (!r) continue;
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    runFinal = final;
    onTranscript({ final: join(committed, runFinal), interim: interim.trim() });
  };

  recognition.onerror = (e) => {
    // "no-speech" and "aborted" are routine; the rest are worth reporting.
    if (e.error !== "no-speech" && e.error !== "aborted") error = describeSpeechError(e.error);
    if (FATAL_RECOGNITION_ERRORS.has(e.error)) stopping = true;
  };

  /** Start with our track if the browser takes it, else plain start() (default mic). */
  let useTrack = Boolean(track);
  const begin = (): void => {
    if (useTrack && track) {
      try {
        recognition.start(track);
        return;
      } catch {
        useTrack = false; // e.g. a Chrome that knows the overload but rejects this track
      }
    }
    recognition.start();
  };

  recognition.onend = () => {
    committed = join(committed, runFinal);
    runFinal = "";
    if (!stopping) {
      // Chrome ended a "continuous" session on its own (silence/time limit): resume.
      try {
        begin();
        return;
      } catch {
        /* fall through and treat as ended */
      }
    }
    ended?.();
  };

  try {
    begin();
  } catch (e) {
    stopping = true;
    error = `Speech recognition could not start: ${(e as Error).message}`;
  }

  return {
    stop() {
      const alreadyStopped = stopping;
      stopping = true;
      return new Promise((resolve) => {
        const finish = (): void => resolve(error ? { text: join(committed, runFinal), error } : { text: join(committed, runFinal) });
        if (alreadyStopped && error) return finish();
        ended = finish;
        setTimeout(finish, FINAL_RESULT_GRACE_MS);
        try {
          recognition.stop();
        } catch {
          finish();
        }
      });
    },
  };
}

function join(a: string, b: string): string {
  return [a.trim(), b.trim()].filter(Boolean).join(" ");
}

function describeSpeechError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Speech recognition is not allowed in nitpick's background recorder (microphone permission or browser policy). Audio was still recorded.";
    case "network":
      return "Speech recognition needs a network connection (Chrome uses an online service). Audio was still recorded.";
    case "audio-capture":
      return "Speech recognition could not access the microphone.";
    default:
      return `Speech recognition error: ${code}.`;
  }
}
