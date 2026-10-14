/**
 * The editable transcript box on the page during a voice note or tab
 * recording (content/voice-overlay.ts), seen from the worker:
 *
 *   registerTranscriptBox()   remember which tab the recording's box is in
 *                             (before the recording starts, so no early
 *                             transcript is missed)
 *   showTranscriptBox()       inject it once the recording runs
 *   relayTranscript()         forward each `recorder:transcript` from the
 *                             offscreen document (which has no chrome.tabs)
 *   finishTranscript()        the recording stopped: save its transcript as
 *                             is, or let the user review it first
 *   saveDraft(), decide()     the box's edits, and its Save/Discard
 *   closeTranscriptBox()      the recording is gone with nothing to save
 *   withVoiceOverlayHidden()  keep the box out of screenshots of that tab
 *
 * The review handshake, after the user (or the tab closing) stops a recording:
 *
 *   offscreen --recorder:finished { transcript }--> worker
 *   worker --voice-overlay:finish--> box: not touched by the user? it closes,
 *        and the worker commits the transcript as recognised.
 *        Clicked into or edited? it stays open, and later sends
 *   box --voice-overlay:decision { save, text }--> worker
 *   worker --offscreen:commit { save, transcript }--> offscreen (uploads, or drops it)
 *
 * The box is a convenience; the recording is saved whether or not it can be
 * shown. Injection fails on chrome:// pages, the Web Store and tabs we have
 * no access to (no activeTab grant, not localhost), and then the transcript
 * is saved as recognised.
 *
 * Reloads and navigations take the box with them (content scripts die with
 * the document). Instead of watching every tab's navigations, which would
 * wake the worker on every page load in the browser, relayTranscript puts
 * the box back when a send finds nobody listening, i.e. as soon as the user
 * speaks again; the user's edits come back with it, because the box reports
 * them (`voice-overlay:draft`) and we keep them in storage.session. SPA
 * route changes keep the document, so the box stays.
 *
 * Messages from the box come from inside a web page, so each is only
 * honoured from the top frame of the tab that box was put in.
 *
 * State lives in storage.session (`transcriptBoxes`), since the worker may
 * restart during a recording or a review.
 */

import { getRecordingState, getState, setState, type TranscriptBoxState } from "../shared/state.js";
import {
  errorMessage,
  isNoReceiverError,
  isTopFrameOfTab,
  sendToTab,
  type RecorderFinishedMessage,
  type RecorderTranscriptMessage,
  type SenderLike,
  type VoiceOverlayDecision,
  type VoiceOverlayDraft,
  type VoiceOverlayUpdate,
} from "../shared/messages.js";
import { mergeTranscript } from "../shared/transcript-text.js";
import { VOICE_OVERLAY_FILE, injectFile } from "./capture/inject.js";
import { notifyToast } from "./notify.js";
import { sendIfOpen } from "./offscreen.js";

/** Don't retry injecting into a tab more often than this (a page that refuses would be retried on every word). */
const REINJECT_INTERVAL_MS = 3_000;
/**
 * Last injection attempt per tab. Module state is fine here: it only
 * throttles retries, and a fresh worker starting from "never" is harmless.
 */
const lastInjection = new Map<number, number>();

// ---------------------------------------------------------------------------
// The boxes in storage.session. Only this module writes them; writes are
// serialised so two read-modify-writes in this worker can't lose one.
// ---------------------------------------------------------------------------

type Boxes = Record<string, TranscriptBoxState>;
let writes: Promise<unknown> = Promise.resolve();

async function getBoxes(): Promise<Boxes> {
  return (await getState("transcriptBoxes")) ?? {};
}

function editBoxes(edit: (boxes: Boxes) => void): Promise<void> {
  const run = writes.then(async () => {
    const boxes = await getBoxes();
    edit(boxes);
    await setState("transcriptBoxes", boxes);
  });
  writes = run.catch(() => undefined);
  return run;
}

function forgetBox(id: string): Promise<void> {
  return editBoxes((boxes) => void delete boxes[id]);
}

/** Box `id`, if `sender` is the top frame of the tab it is in. */
async function boxFor(id: string, sender: SenderLike): Promise<TranscriptBoxState | null> {
  const box = (await getBoxes())[id];
  return box && isTopFrameOfTab(sender, box.tabId) ? box : null;
}

// ---------------------------------------------------------------------------
// During the recording
// ---------------------------------------------------------------------------

export function registerTranscriptBox(id: string, box: TranscriptBoxState): Promise<void> {
  return editBoxes((boxes) => void (boxes[id] = box));
}

/** Show the (empty: "Listening…") box of recording `id`. Never throws. */
export async function showTranscriptBox(id: string): Promise<void> {
  const box = (await getBoxes())[id];
  if (!box) return;
  try {
    await inject(box.tabId, updateFor(id, box, "", ""));
  } catch (error) {
    console.info("[holt] no transcript box on this page:", errorMessage(error));
    return;
  }
  // Finished while the box was being injected: don't leave it behind.
  if (!(await getBoxes())[id]) await sendToTab(box.tabId, { type: "voice-overlay:close", id }).catch(() => undefined);
}

/** Forward the offscreen document's transcript to the box. Never throws. */
export async function relayTranscript(message: RecorderTranscriptMessage): Promise<void> {
  const box = (await getBoxes())[message.id];
  if (!box) return;
  const update = updateFor(message.id, box, message.final, message.interim);
  if (message.error) update.error = message.error;
  try {
    await sendToTab(box.tabId, update);
  } catch (error) {
    if (!isNoReceiverError(error)) return;
    const last = lastInjection.get(box.tabId) ?? 0;
    if (Date.now() - last < REINJECT_INTERVAL_MS) return;
    // The page reloaded or navigated and took the box with it: put it back.
    await inject(box.tabId, update).catch(() => undefined);
  }
}

/** The box's edits (debounced), kept so the box can be re-created with them after a navigation. */
export async function saveDraft(message: VoiceOverlayDraft, sender: SenderLike): Promise<void> {
  if (!(await boxFor(message.id, sender))) return;
  await editBoxes((boxes) => {
    const box = boxes[message.id];
    if (box) box.draft = message.draft;
  });
}

// ---------------------------------------------------------------------------
// After the recording
// ---------------------------------------------------------------------------

/** Called for `recorder:finished`: commit the transcript now, or once the user has reviewed it. */
export async function finishTranscript(message: RecorderFinishedMessage): Promise<void> {
  const { id, transcript } = message;
  const box = (await getBoxes())[id];
  if (!box) {
    await commit(id, true, transcript); // started without a tab, or on a page without a box
    return;
  }
  let review = false;
  try {
    review = await askForReview(id, box, transcript);
  } catch (error) {
    console.info("[holt] could not reach the transcript box:", errorMessage(error));
  }
  if (review) return; // the box will send voice-overlay:decision
  await forgetBox(id);
  // A box we couldn't reach may still have left edits behind.
  await commit(id, true, box.draft ? mergeTranscript(box.draft, transcript) : transcript);
}

/** Ask the box whether the user wants to review; true if it stays open for that. */
async function askForReview(id: string, box: TranscriptBoxState, transcript: string): Promise<boolean> {
  const finish = { type: "voice-overlay:finish", id, transcript } as const;
  try {
    return (await sendToTab(box.tabId, finish))?.review === true;
  } catch (error) {
    // The page navigated since the user edited the transcript: put the box
    // back (with their edits) so they can still review it.
    if (!isNoReceiverError(error) || !box.draft) throw error;
    await inject(box.tabId, updateFor(id, box, transcript, ""));
    return (await sendToTab(box.tabId, finish))?.review === true;
  }
}

/** The box's Save / Discard (or the page going away mid-review, which saves). */
export async function decide(message: VoiceOverlayDecision, sender: SenderLike): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await boxFor(message.id, sender))) return { ok: false, error: "This transcript is not waiting to be saved." };
  // Only for a recording that has stopped: one still running has nothing to commit yet.
  const { screen, voice } = await getRecordingState();
  if (screen?.id === message.id || voice?.id === message.id) return { ok: false, error: "Stop the recording first." };
  await forgetBox(message.id);
  if (await commit(message.id, message.save, message.text)) return { ok: true };
  return { ok: false, error: "The recording was no longer waiting for this transcript; it may already have been saved as recognised." };
}

/** The recording `id` is gone with nothing to save (failed to start, or the recorder died): remove its box. */
export async function closeTranscriptBox(id: string): Promise<void> {
  const box = (await getBoxes())[id];
  if (!box) return;
  await forgetBox(id);
  lastInjection.delete(box.tabId);
  await sendToTab(box.tabId, { type: "voice-overlay:close", id }).catch(() => undefined);
}

/** Tell the offscreen document what to do with finished recording `id`. False if it wasn't waiting. */
async function commit(id: string, save: boolean, transcript: string): Promise<boolean> {
  try {
    const response = await sendIfOpen({ type: "offscreen:commit", id, save, transcript });
    if (response?.found) return true;
  } catch (error) {
    console.warn("[holt] commit failed", error);
  }
  if (save) await notifyToast("error", "A recording's transcript could not be saved: the background recorder no longer had the recording.");
  return false;
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

/**
 * Run `capture` (a screenshot of `tabId`) with the boxes hidden, if any are
 * showing there. The page answers the hide request only after it has
 * repainted without them.
 */
export async function withVoiceOverlayHidden<T>(tabId: number | undefined, capture: () => Promise<T>): Promise<T> {
  const boxes = tabId === undefined ? {} : await getBoxes();
  if (tabId === undefined || !Object.values(boxes).some((box) => box.tabId === tabId)) return capture();
  const hidden = await sendToTab(tabId, { type: "voice-overlay:visibility", hidden: true }).then(
    () => true,
    () => false, // no box on the page: nothing to hide
  );
  try {
    return await capture();
  } finally {
    if (hidden) await sendToTab(tabId, { type: "voice-overlay:visibility", hidden: false }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------

function updateFor(id: string, box: TranscriptBoxState, final: string, interim: string): VoiceOverlayUpdate {
  const update: VoiceOverlayUpdate = { type: "voice-overlay:update", id, recorder: box.recorder, startedAt: box.startedAt, final, interim };
  if (box.draft) update.draft = box.draft;
  return update;
}

async function inject(tabId: number, update: VoiceOverlayUpdate): Promise<void> {
  lastInjection.set(tabId, Date.now());
  await injectFile(tabId, VOICE_OVERLAY_FILE);
  await sendToTab(tabId, update);
}
