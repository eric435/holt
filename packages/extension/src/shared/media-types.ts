/**
 * The media types the recorders ask MediaRecorder for, best first
 * (shared/media-recorder.ts picks the first one the browser supports).
 * Every base type must be in the server's ACCEPTED_MEDIA_TYPES, or the
 * upload is refused with a 415 after the recording.
 *
 * On their own, without MediaRecorder, so that the protocol contract test
 * (packages/server/src/http/extension-contract.test.ts) can upload one of
 * each to the real server in Node.
 */

/** Video containers/codecs to try, best first (tab recordings). */
export const VIDEO_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

/** Audio types to try for voice notes. */
export const AUDIO_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"] as const;
