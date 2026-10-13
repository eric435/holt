/**
 * Lifecycle of the offscreen document (src/offscreen/), owned by the worker.
 *
 * Chrome allows ONE offscreen document per extension. Creating a second one
 * fails ("Only a single offscreen document may be created"), so:
 *  - before creating, ask Chrome whether it exists
 *    (chrome.runtime.getContexts, Chrome 116+); the worker may have been
 *    restarted since it created it, so a module variable can't know;
 *  - two callers in the same worker instance could both see "no document"
 *    and both create; `creating` (a shared promise) makes the second wait
 *    for the first instead;
 *  - create/close/start are serialised through one queue, so "close because
 *    idle" can never interleave with "start a new recording" and close the
 *    document under it.
 *
 * Created lazily when a recording starts; closed when the document reports
 * `recorder:idle` (nothing recording, nothing uploading) and a fresh status
 * check agrees. An open offscreen document costs a renderer process, so we
 * don't keep it around.
 *
 * Reason: USER_MEDIA covers getUserMedia, including redeeming a
 * chrome.tabCapture stream id (as in Chrome's own tab-capture sample). We
 * don't use DISPLAY_MEDIA: getDisplayMedia needs a click in the calling
 * document, which an invisible document never gets, so window/screen
 * recording stays in the side panel. (Note: AUDIO_PLAYBACK would make
 * Chrome close the document after 30 s of silence; we don't use it, and
 * playing captured tab audio back works under USER_MEDIA.)
 */

import { isNoReceiverError, sendMessage, type Message, type ResponseFor } from "../shared/messages.js";

export const OFFSCREEN_PATH = "offscreen.html";
export const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN_PATH);

/** How long a start request may take (getUserMedia normally answers in well under a second). */
const START_TIMEOUT_MS = 15_000;

let creating: Promise<void> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

export async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
    documentUrls: [OFFSCREEN_URL],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["USER_MEDIA" as chrome.offscreen.Reason],
      justification: "Records the current tab (chrome.tabCapture) and voice notes (microphone) so recordings continue while the side panel is closed.",
    })
    .catch((error: unknown) => {
      // Lost a race with another worker instance: fine, it exists now.
      if (/single offscreen/i.test(String((error as Error)?.message ?? error))) return;
      throw error;
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

/**
 * Make sure the document exists, then send it `message` and return its
 * answer. Serialised with closing (see the header).
 */
export function sendToRecorder<M extends Message>(message: M): Promise<ResponseFor<M>> {
  return serialized(async () => {
    await ensureOffscreenDocument();
    return withTimeout(sendMessage(message), START_TIMEOUT_MS, "The background recorder did not respond.");
  });
}

/**
 * Send to the document only if it exists (stop/status). Returns null if
 * there is no document, i.e. nothing is recording there.
 */
export function sendIfOpen<M extends Message>(message: M): Promise<ResponseFor<M> | null> {
  return serialized(async () => {
    if (!(await hasOffscreenDocument())) return null;
    try {
      return await withTimeout(sendMessage(message), START_TIMEOUT_MS, "The background recorder did not respond.");
    } catch (error) {
      if (isNoReceiverError(error)) return null; // document still loading or just closed
      throw error;
    }
  });
}

/** Close the document if it exists and confirms it has nothing to do. */
export function closeOffscreenIfIdle(): Promise<void> {
  return serialized(async () => {
    if (!(await hasOffscreenDocument())) return;
    const status = await sendMessage({ type: "offscreen:status" }).catch(() => null);
    if (status && (status.tab || status.voice || status.uploading > 0)) return;
    await chrome.offscreen.closeDocument().catch((error: unknown) => console.warn("[holt] closing the offscreen document failed", error));
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
