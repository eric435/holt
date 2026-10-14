/**
 * Tab recording from a chrome.tabCapture stream id.
 *
 * How the pieces fit (Chrome 116+):
 *   1. The worker calls chrome.tabCapture.getMediaStreamId({ targetTabId }).
 *      That needs the activeTab grant for the tab (a holt shortcut or a
 *      toolbar click on it); see background/recording.ts.
 *   2. The id is a short-lived, single-use token. The worker sends it here.
 *   3. We redeem it with getUserMedia and the legacy `mandatory`
 *      constraints `chromeMediaSource: "tab"` (that is how Chrome spells
 *      this; there is no standard constraint for it), then record with
 *      MediaRecorder.
 *
 * Compared to getDisplayMedia (window/screen sharing, which holt doesn't
 * offer: it needs a click in a visible document and shows a picker):
 * no picker, no user activation needed (so a shortcut can start it), it
 * records only the tab's content, and it follows the tab across
 * navigations. It ends when the tab is closed: the video track fires
 * "ended", and we stop and upload what we have.
 *
 * Tab audio: while a tab is captured, Chrome stops playing its audio to the
 * speakers (the capture "takes" it). We play the captured audio back
 * through an AudioContext so the user still hears the page.
 *
 * Resolution: no size constraints on purpose. Without them the capture
 * follows the tab's size (an 800x600 tab records at 800x600). We tried
 * `maxWidth: 3840, maxHeight: 2160`: Chrome 155 then produced a fixed
 * 3840x2160 frame and scaled the 4:3 tab into it, i.e. bigger files and a
 * distorted/letterboxed picture. (Measured with track.getSettings().)
 */

import { VIDEO_TYPES, pickMimeType, record, type RecordedMedia } from "../shared/media-recorder.js";

export interface TabRecording {
  stop(): Promise<RecordedMedia>;
  /** Width/height the capture actually runs at, for diagnostics. */
  readonly settings: MediaTrackSettings;
}

export async function startTabRecording(streamId: string, onEnded: () => void): Promise<TabRecording> {
  const source = { chromeMediaSource: "tab", chromeMediaSourceId: streamId };
  // `mandatory` is not in TypeScript's MediaTrackConstraints (it predates the
  // standard), hence the cast.
  const constraints = {
    audio: { mandatory: source },
    video: { mandatory: source },
  } as unknown as MediaStreamConstraints;
  const stream = await navigator.mediaDevices.getUserMedia(constraints);

  // Give the user their tab audio back (see above).
  let playback: AudioContext | null = null;
  if (stream.getAudioTracks().length > 0) {
    playback = new AudioContext();
    playback.createMediaStreamSource(stream).connect(playback.destination);
    // Offscreen documents are never "activated" by the user; resume() is a
    // no-op if autoplay already allowed the context to run.
    void playback.resume().catch(() => undefined);
  }

  const session = record(stream, pickMimeType(VIDEO_TYPES));
  let result: Promise<RecordedMedia> | null = null;
  const stop = (): Promise<RecordedMedia> =>
    (result ??= session.stop().finally(() => void playback?.close().catch(() => undefined)));

  const video = stream.getVideoTracks()[0];
  video?.addEventListener("ended", () => {
    // The tab was closed (or capture was stopped by Chrome).
    if (!result) onEnded();
  });

  return { stop, settings: video?.getSettings() ?? {} };
}
