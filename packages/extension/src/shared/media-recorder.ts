/**
 * Shared MediaRecorder plumbing for both recorders in the offscreen document:
 * the tab recorder and the voice recorder. Needs a document (MediaRecorder
 * does not exist in a service worker), so only pages import this.
 */

/** Video containers/codecs to try, best first (tab recordings). */
export const VIDEO_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

/** Audio types to try for voice notes. All are in the server's ACCEPTED_MEDIA_TYPES. */
export const AUDIO_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"] as const;

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
