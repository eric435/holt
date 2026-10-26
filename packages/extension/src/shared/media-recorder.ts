/**
 * Shared MediaRecorder plumbing for both recorders in the offscreen document:
 * the tab recorder and the voice recorder. Needs a document (MediaRecorder
 * does not exist in a service worker), so only pages import this.
 */

// The candidate lists live in a module without MediaRecorder (media-types.ts).
export { AUDIO_TYPES, VIDEO_TYPES } from "./media-types.js";

/** First MIME type in `candidates` this browser can record, or "" (browser default). */
export function pickMimeType(candidates: readonly string[]): string {
  if (typeof MediaRecorder === "undefined") return "";
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

export interface RecordedMedia {
  blob: Blob;
  durationMs: number;
}

/**
 * Wraps a MediaRecorder: start immediately, `stop()` resolves with the
 * recorded Blob once the final `dataavailable` has fired.
 *
 * `start(1000)` asks for a chunk every second, so a long recording is not
 * held in one giant internal buffer and an unexpected end still leaves data.
 */
export function record(stream: MediaStream, mimeType: string): { stop(): Promise<RecordedMedia>; recorder: MediaRecorder } {
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks: Blob[] = [];
  const startedAt = performance.now();

  recorder.addEventListener("dataavailable", (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  });

  const stopped = new Promise<RecordedMedia>((resolve, reject) => {
    recorder.addEventListener("stop", () => {
      const type = recorder.mimeType || mimeType || chunks[0]?.type || "";
      resolve({ blob: new Blob(chunks, { type }), durationMs: Math.round(performance.now() - startedAt) });
    });
    recorder.addEventListener("error", (e) => reject((e as ErrorEvent).error ?? new Error("Recording failed.")));
  });

  recorder.start(1000);

  return {
    recorder,
    stop() {
      if (recorder.state !== "inactive") recorder.stop();
      stream.getTracks().forEach((track) => track.stop());
      return stopped;
    },
  };
}
