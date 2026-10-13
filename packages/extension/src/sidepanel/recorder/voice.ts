/**
 * Voice notes: microphone audio (getUserMedia + MediaRecorder) plus a live
 * transcript from the Web Speech API, both from the same button press.
 *
 * Transcription (webkitSpeechRecognition) is best-effort:
 *  - It may be missing entirely (non-Chrome, some Chromium builds).
 *  - In Chrome it streams audio to Google's speech service, so it fails with
 *    `network` offline, and may fail with `not-allowed` /
 *    `service-not-allowed` in some extension contexts or policies.
 *  - With `continuous = true` Chrome still ends recognition after a pause or
 *    about a minute; we restart it while the recording is running.
 * Whatever happens with the transcript, the audio recording continues and is
 * returned, so the user never loses what they said.
 *
 * Microphone permission is per origin, and our origin is
 * chrome-extension://<id>. Chrome may not show the permission prompt inside
 * a side panel; in that case getUserMedia rejects with NotAllowedError and
 * the panel offers to open permissions.html in a normal tab, where the prompt
 * does show. Once granted there, it applies to the side panel too.
 */

import { pickMimeType, record } from "./media.js";

const AUDIO_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"] as const;

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

export async function startVoiceNote(onTranscript: (update: TranscriptUpdate) => void): Promise<VoiceRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const session = record(stream, pickMimeType(AUDIO_TYPES));
  const transcriber = startTranscription(onTranscript);

  let result: Promise<VoiceResult> | null = null;
  return {
    stop() {
      result ??= (async () => {
        const [media, transcript] = await Promise.all([session.stop(), transcriber.stop()]);
        const out: VoiceResult = { blob: media.blob, durationMs: media.durationMs, transcript: transcript.text };
        if (transcript.error) out.transcriptError = transcript.error;
        return out;
      })();
      return result;
    },
  };
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
  start(): void;
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

function startTranscription(onTranscript: (update: TranscriptUpdate) => void): Transcriber {
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

  recognition.onend = () => {
    committed = join(committed, runFinal);
    runFinal = "";
    if (!stopping) {
      // Chrome ended a "continuous" session on its own (silence/time limit): resume.
      try {
        recognition.start();
        return;
      } catch {
        /* fall through and treat as ended */
      }
    }
    ended?.();
  };

  try {
    recognition.start();
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
      return "Speech recognition is not allowed here (microphone permission or browser policy). Audio was still recorded.";
    case "network":
      return "Speech recognition needs a network connection (Chrome uses an online service). Audio was still recorded.";
    case "audio-capture":
      return "Speech recognition could not access the microphone.";
    default:
      return `Speech recognition error: ${code}.`;
  }
}
