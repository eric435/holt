/**
 * Window/screen recording with getDisplayMedia + MediaRecorder: the panel's
 * secondary "Record a window or screen…" option. (The primary "Record tab"
 * uses chrome.tabCapture in the offscreen document, see offscreen/tab.ts,
 * because that one survives the panel closing and needs no picker.)
 *
 * Why this one stays in the side panel: getDisplayMedia shows Chrome's
 * picker, and only does so with "transient user activation", i.e. within a
 * few seconds of a real click/keypress in the calling document. An
 * offscreen document never gets user activation (it is never shown), and a
 * keyboard shortcut is handled by the worker, which has no document at all.
 * (Chrome documents a DISPLAY_MEDIA offscreen reason, but the picker would
 * still need activation in that document, which nothing can give it.)
 *
 * Lifetime: the recording lives in this page. Closing the side panel destroys
 * the page and the recording with it (nothing is uploaded); the panel says
 * so next to the button. The user can also stop via Chrome's own "Stop
 * sharing" bar; we treat that as a normal stop.
 *
 * Output: WebM (VP9 + Opus if available, else VP8, else browser default).
 * Note that MediaRecorder WebM files carry no duration header, so some
 * players show an unknown length / no seek bar until fully loaded.
 */

import { VIDEO_TYPES, pickMimeType, record, type RecordedMedia } from "../../shared/media-recorder.js";

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
