/**
 * Screen recording with getDisplayMedia + MediaRecorder.
 *
 * Lives in the side panel, not the worker: MediaRecorder and getDisplayMedia
 * need a document, and a service worker has none.
 *
 * User gesture: getDisplayMedia only works with "transient user activation",
 * i.e. within a few seconds of a real click/keypress in this document. A
 * keyboard shortcut is handled by the worker and does not count as activation
 * in the panel, so the toggle-recording shortcut can stop a recording but
 * starting one needs a click on the panel's button.
 *
 * Lifetime: the recording lives in this page. Closing the side panel destroys
 * the page and the recording with it (nothing is uploaded). The user can also
 * stop via Chrome's own "Stop sharing" bar; we treat that as a normal stop.
 *
 * Output: WebM (VP9 + Opus if available, else VP8, else browser default).
 * Note that MediaRecorder WebM files carry no duration header, so some
 * players show an unknown length / no seek bar until fully loaded.
 */

import { pickMimeType, record, type RecordedMedia } from "./media.js";

const VIDEO_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

export interface ScreenRecording {
  /** Stop and get the result. Safe to call more than once. */
  stop(): Promise<RecordedMedia>;
}

/**
 * Prompts the user to pick a tab/window/screen and starts recording.
 * Rejects with NotAllowedError if the user cancels the picker or there was
 * no user activation.
 * `onEnded` fires if sharing is stopped from outside (Chrome's sharing bar).
 */
export async function startScreenRecording(onEnded: () => void): Promise<ScreenRecording> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30 } },
    // Lets the user tick "Also share tab audio" in Chrome's picker.
    audio: true,
  });

  const session = record(stream, pickMimeType(VIDEO_TYPES));
  let result: Promise<RecordedMedia> | null = null;
  const stop = (): Promise<RecordedMedia> => (result ??= session.stop());

  stream.getVideoTracks()[0]?.addEventListener("ended", () => {
    if (!result) onEnded();
  });

  return { stop };
}

/** Is there transient user activation right now (a recent click)? */
export function hasUserActivation(): boolean {
  // navigator.userActivation is Chrome 72+; treat "unknown" as yes and let
  // getDisplayMedia decide.
  return navigator.userActivation?.isActive ?? true;
}
