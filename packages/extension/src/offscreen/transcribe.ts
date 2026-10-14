/**
 * Live transcription in the offscreen recorders: voice notes (voice.ts) and
 * tab recordings (narration, see `startNarration` below).
 *
 * The Web Speech plumbing (opening the microphone, restarting recognition,
 * the `final`/`interim` updates) lives in shared/speech.ts, because the
 * screenshot note prompt dictates with it too; its header has the details
 * of what works where. What is specific to the recorders is here: the
 * narration's own microphone (error messages that say the recording goes
 * on without a transcript are in shared/speech-errors.ts). Whatever happens with the transcript, the
 * recording it belongs to continues, so the user never loses what they
 * recorded.
 */

import { describeMicrophoneError, describeSpeechError } from "../shared/speech-errors.js";
import { openMicrophone, startSpeechRecognition, type Transcriber, type TranscriptUpdate } from "../shared/speech.js";

/** How long stop() waits for a microphone that is still opening before giving up on the transcript. */
const MICROPHONE_OPEN_GRACE_MS = 2_000;

/**
 * Transcribe what the user says during a tab recording. The microphone is
 * opened for the recogniser only: the recording itself keeps just the tab's
 * own audio. Returns at once and never fails: the recording must neither
 * wait for the microphone nor depend on it. Without one there is simply no
 * transcript, and `onTranscript` says why.
 */
export function startNarration(microphoneId: string, onTranscript: (update: TranscriptUpdate) => void): Transcriber {
  let abandoned = false;
  const started: Promise<Transcriber> = openMicrophone(microphoneId).then(
    ({ stream }) => {
      const transcriber = startTranscription(onTranscript, stream.getAudioTracks()[0]);
      const running: Transcriber = {
        async stop() {
          const result = await transcriber.stop();
          for (const track of stream.getTracks()) track.stop();
          return result;
        },
      };
      // The recording ended before the microphone opened: don't leave it on.
      if (abandoned) void running.stop();
      return running;
    },
    (error: unknown) => {
      const why = describeMicrophoneError(error, "narration");
      onTranscript({ final: "", interim: "", error: why });
      return { stop: async () => ({ text: "", error: why }) };
    },
  );
  return {
    async stop() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), MICROPHONE_OPEN_GRACE_MS)));
      const running = await Promise.race([started, late]).finally(() => clearTimeout(timer));
      if (running) return running.stop();
      abandoned = true;
      return { text: "", error: "The microphone did not open in time, so there is no transcript." };
    },
  };
}

/** Transcribe `track` (or, if the browser won't take it, the default microphone) until stop(). */
export function startTranscription(onTranscript: (update: TranscriptUpdate) => void, track: MediaStreamTrack | undefined): Transcriber {
  return startSpeechRecognition(onTranscript, track, (code) => describeSpeechError(code, "narration"));
}
