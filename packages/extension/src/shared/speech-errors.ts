/**
 * What to tell the user when the microphone or speech recognition fails,
 * for each place holt listens (pure, unit-tested):
 *
 *   "dictation"   the screenshot note prompt's 🎙 button (note/note.ts): a
 *                 visible page; the user can type instead;
 *   "narration"   the live transcript of a tab recording
 *                 (offscreen/transcribe.ts): the recording goes on without it;
 *   "voice-note"  starting a voice note (background/recording.ts), where no
 *                 microphone means no voice note at all.
 *
 * One table, so the same failure reads the same everywhere and a new
 * DOMException name or recogniser error code is handled in one place.
 */

export type SpeechUse = "dictation" | "narration" | "voice-note";

/**
 * What getUserMedia's error comes down to: access blocked (the fix is
 * holt's permissions page), no such device, or anything else.
 */
export type MicrophoneProblem = "blocked" | "missing" | "other";

/** Classify a getUserMedia failure (a DOMException, or just its `name`). */
export function microphoneProblem(error: unknown): MicrophoneProblem {
  const name = typeof error === "string" ? error : nameOf(error);
  if (name === "NotAllowedError" || name === "SecurityError") return "blocked";
  if (name === "NotFoundError") return "missing";
  return "other";
}

/**
 * The message for a microphone that could not be opened. `error` is what
 * getUserMedia threw, or `{ name, message }` as the offscreen document
 * reports it (a DOMException doesn't survive runtime messaging).
 */
export function describeMicrophoneError(error: unknown, use: SpeechUse): string {
  const problem = microphoneProblem(error);
  if (problem === "blocked") {
    if (use === "dictation") return "Microphone access is blocked for holt. Allow it on the page that just opened, then dictate again.";
    if (use === "narration") return "Microphone access is blocked for holt, so there is no transcript (allow it once from a voice note). The recording continues.";
    return "Microphone access is blocked for holt. Allow it once on holt's permission page, then try again.";
  }
  if (problem === "missing") {
    if (use === "dictation") return "No microphone found. Type your note instead.";
    if (use === "narration") return "No microphone found, so there is no transcript. The recording continues.";
    return "No microphone found.";
  }
  const detail = messageOf(error);
  if (use === "dictation") return `Could not start dictation: ${detail}`;
  if (use === "narration") return `No transcript: the microphone could not be opened (${detail}). The recording continues.`;
  return `Could not start the voice note: ${detail}`;
}

/**
 * The message for a Web Speech error code (SpeechRecognitionErrorEvent.error)
 * that ended recognition. The recorders keep recording without a transcript;
 * dictation leaves the user's text as it is.
 */
export function describeSpeechError(code: string, use: SpeechUse): string {
  const recorder = use !== "dictation";
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return recorder
        ? "Speech recognition is not allowed in holt's background recorder (microphone permission or browser policy). Still recording, without a transcript."
        : "Speech recognition is not allowed here (microphone permission or browser policy). Type your note instead.";
    case "network":
      return recorder
        ? "Speech recognition needs a network connection (Chrome uses an online service). Still recording, without a transcript."
        : "Dictation needs a network connection (Chrome uses an online speech service).";
    case "audio-capture":
      return "Speech recognition could not access the microphone.";
    default:
      return `Speech recognition error: ${code}.`;
  }
}

function nameOf(error: unknown): string | undefined {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" ? name : undefined;
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message ? message : String(error);
}
