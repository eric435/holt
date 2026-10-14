/**
 * Live transcription of a microphone with the Web Speech API: the part
 * shared by the offscreen recorders (voice notes and tab-recording
 * narration, see offscreen/transcribe.ts and offscreen/voice.ts) and the
 * screenshot note prompt's dictation button (note/note.ts). Both are
 * extension pages on our own origin, so the same microphone permission and
 * device ids apply in both.
 *
 * Best-effort, always:
 *  - webkitSpeechRecognition may be missing entirely (non-Chrome, some
 *    Chromium builds).
 *  - In Chrome it streams audio to Google's speech service, so it fails with
 *    `network` offline, and may fail with `not-allowed` /
 *    `service-not-allowed` in some contexts or under some policies.
 *  - In an offscreen document: not documented either way. Observed with
 *    Chrome 155: it starts (onstart fires) once the extension has microphone
 *    permission, and fails with `not-allowed` without it. Whether Google's
 *    service then returns text could not be tested headless (the fake
 *    microphone only beeps).
 *  - Which microphone: by default Chrome's recogniser opens the *system
 *    default* microphone itself, not ours. Newer Chrome accepts a
 *    MediaStreamTrack in `start(track)`, so we pass the track of the
 *    microphone the user selected. Chrome 155 has this overload (verified:
 *    `start("x")` throws "parameter 1 is not of type 'MediaStreamTrack'",
 *    and `start(track)` starts in the offscreen document). Chrome versions
 *    from before the overload ignore the extra argument (WebIDL drops
 *    surplus arguments) and transcribe from the system default mic; if a
 *    browser rejects the track we fall back to plain `start()` the same way.
 *  - With `continuous = true` Chrome still ends recognition after a pause or
 *    about a minute; we restart it until stop() is called.
 *
 * `final` in every update is everything recognised so far and only ever
 * grows (earlier runs are committed; a run's final results are not revised),
 * which is what lets an editable field append new speech to the user's
 * edits (shared/transcript-text.ts).
 *
 * How errors are worded depends on the context (a recorder keeps recording
 * without a transcript; the note prompt just stops dictating), so the caller
 * passes `describeError` for the recogniser's error codes.
 */

import { isMissingDeviceError, microphoneConstraints } from "./mic.js";

/** Errors after which restarting recognition is pointless. */
const FATAL_RECOGNITION_ERRORS = new Set(["not-allowed", "service-not-allowed", "network", "audio-capture", "language-not-supported"]);

/** Wait at most this long after stop() for the last results to arrive. */
const FINAL_RESULT_GRACE_MS = 1_500;

export interface TranscriptUpdate {
  /** Finalised text so far. */
  final: string;
  /** Current best guess for the words being spoken right now. */
  interim: string;
  /** Why transcription stopped working, as soon as it happens (a recording goes on). */
  error?: string;
}

export interface TranscriptResult {
  text: string;
  /** Why there is no (or only a partial) transcript, if something failed. */
  error?: string;
}

export interface Transcriber {
  stop(): Promise<TranscriptResult>;
}

export interface OpenedMicrophone {
  stream: MediaStream;
  /** The selected microphone was not found, so the default one is used. */
  fallback: boolean;
}

/** The selected microphone, or the default one if it is gone. */
export async function openMicrophone(microphoneId: string): Promise<OpenedMicrophone> {
  try {
    return { stream: await navigator.mediaDevices.getUserMedia(microphoneConstraints(microphoneId)), fallback: false };
  } catch (error) {
    if (!microphoneId || !isMissingDeviceError((error as DOMException).name)) throw error;
    // The chosen mic is gone: use the default and let the caller say so.
    return { stream: await navigator.mediaDevices.getUserMedia(microphoneConstraints("")), fallback: true };
  }
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

/**
 * Transcribe `track` (or, if the browser won't take it, the default
 * microphone) until stop(). `describeError` turns a recogniser error code
 * ("network", "not-allowed", ...) into a message for the user.
 */
export function startSpeechRecognition(
  onTranscript: (update: TranscriptUpdate) => void,
  track: MediaStreamTrack | undefined,
  describeError: (code: string) => string,
): Transcriber {
  const Ctor = speechRecognitionCtor();
  if (!Ctor) {
    const error = "Speech recognition is not available in this browser.";
    onTranscript({ final: "", interim: "", error });
    return { stop: async () => ({ text: "", error }) };
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
    if (e.error === "no-speech" || e.error === "aborted") return;
    error = describeError(e.error);
    if (FATAL_RECOGNITION_ERRORS.has(e.error)) stopping = true;
    // Say so now, not only when the recording is saved: the live view is how the user knows it works.
    onTranscript({ final: join(committed, runFinal), interim: "", error });
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
    onTranscript({ final: "", interim: "", error });
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
