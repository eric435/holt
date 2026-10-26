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
 * Transcription is best-effort (see transcribe.ts): whatever happens with
 * the transcript, the audio recording continues and is returned, so the
 * user never loses what they said. It can also be off altogether
 * (Settings.transcribe); then the recording is all there is, and
 * offscreen/index.ts always uploads it.
 */

import { AUDIO_TYPES, pickMimeType, record } from "../shared/media-recorder.js";
import { openMicrophone, type TranscriptUpdate } from "../shared/speech.js";
import { noTranscription, startTranscription } from "./transcribe.js";

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

export interface StartedVoiceNote {
  recording: VoiceRecording;
  /** Label of the microphone in use ("" if the browser doesn't say). */
  microphoneLabel: string;
  /** The selected microphone was not found, so the default one is used. */
  microphoneFallback: boolean;
}

/** `transcribe` false (Settings.transcribe): record the audio only, never start a speech recogniser. */
export async function startVoiceNote(
  microphoneId: string,
  onTranscript: (update: TranscriptUpdate) => void,
  transcribe: boolean,
): Promise<StartedVoiceNote> {
  const { stream, fallback: microphoneFallback } = await openMicrophone(microphoneId);

  const track = stream.getAudioTracks()[0];
  const session = record(stream, pickMimeType(AUDIO_TYPES));
  // A clone, so the recogniser stopping/ending its track can never end the recording's.
  const speechTrack = transcribe ? track?.clone() : undefined;
  const transcriber = transcribe ? startTranscription(onTranscript, speechTrack) : noTranscription();

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
