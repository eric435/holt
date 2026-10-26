/**
 * The note page (note.html), in one of two modes (shared/note-prompt.ts):
 *
 * Quick note (Alt+T), the action popup or its fallback window:
 *  1. Reset the action's popup to the menu right away, so the next click on
 *     the toolbar icon shows the menu again (the worker set it to note.html
 *     just to be able to call openPopup(), see background/note-popup.ts).
 *  2. Read the page the note is about from storage.session (`noteContext`,
 *     written by the worker at shortcut time).
 *  3. Focused textarea: Enter saves, Shift+Enter = newline, Esc closes.
 *  4. Save straight to the server for that page (the worker resolves it,
 *     see `serverFor`; this is an extension page with the same settings
 *     and host permissions as the panel), after checking that it speaks
 *     our protocol version (shared/server.ts `assertCompatible`; checked
 *     once when the page opens too, so the user hears about a server to
 *     update before typing the note), then hand the entry to
 *     the worker (`entry-created`), which adds it to the panel's recent list
 *     and toasts in the panel or flashes the badge. Show "Saved #N" briefly
 *     and close. Errors stay inline so the text isn't lost.
 *
 * Screenshot note prompt (`?mode=screenshot&id=…`), a popup window the
 * worker opens after every screenshot (background/pending-screenshot.ts):
 *  1. Read the pending screenshot `id` from storage.session for its page.
 *  2. Enter / Save: hand the note to the worker (`screenshot-note:finish`),
 *     which writes the screenshot's one entry with it; Skip: the same with
 *     no note. Esc skips an empty note and saves a typed one (an Esc must
 *     not throw away what the user wrote). The worker posts, not this page,
 *     so every way out ends in the same place and the entry is never
 *     written twice.
 *     What is typed is also mirrored to the worker as it is typed
 *     (`screenshot-note:draft`, debounced, and once more when the page goes
 *     away), so the ways out that don't pass through here (closing the
 *     window, the next screenshot, a browser restart) still save the words.
 *     If the screenshot's session has ended meanwhile (the server refuses
 *     its entry), the worker saves the words as a separate note and says
 *     so; Skip always closes.
 *  3. 🎙 Dictate (only while transcription is on in the settings, see
 *     Settings.transcribe): speech into the textarea, the same way as the transcript
 *     box on the page (content/voice-overlay.ts): newly recognised words
 *     are appended after the user's text without moving their caret, and
 *     what is being recognised right now is shown greyed out underneath.
 *     The microphone is the one picked in the settings. This page is
 *     visible, so Chrome can ask for microphone access here; if access is
 *     blocked we open holt's permissions page, as voice notes do.
 *     Save stops dictation first and waits for its last words.
 */

import type { PageContext } from "@holt/protocol";
import { ApiError } from "../shared/api.js";
import { quickNoteEntry } from "../shared/entry-bodies.js";
import { compatibleApiForServer, resolveServerForUrl } from "../shared/server.js";
import { errorMessage, sendMessage, type ScreenshotNoteDraftMessage } from "../shared/messages.js";
import { noteKeyAction } from "../shared/note-keys.js";
import { parseNotePageParams } from "../shared/note-prompt.js";
import { MENU_PAGE, PERMISSIONS_PAGE } from "../shared/pages.js";
import { pageContextFromTab } from "../shared/page-context.js";
import { loadSettings } from "../shared/settings.js";
import { describeMicrophoneError, describeSpeechError, microphoneProblem } from "../shared/speech-errors.js";
import { openMicrophone, startSpeechRecognition, type Transcriber, type TranscriptUpdate } from "../shared/speech.js";
import { getRecordingState, getState, onStateChanged, type NoteContext, type PendingScreenshot } from "../shared/state.js";
import { applyFinal } from "../shared/transcript-text.js";

/** A context older than this is from an earlier shortcut press, not this one. */
const CONTEXT_MAX_AGE_MS = 60_000;
const CLOSE_AFTER_SAVE_MS = 900;
/** How long to wait for the worker's storage write if the page loaded first. */
const CONTEXT_WAIT_MS = 1_000;
/** How long Save waits for the worker to add the server to the context (it may be probing the page's origin). */
const SERVER_WAIT_MS = 3_000;
/** How long the screenshot prompt waits after the last keystroke before it mirrors the text to the worker. */
const DRAFT_DEBOUNCE_MS = 400;

const prompt = parseNotePageParams(location.search);
// Quick note, step 1, before anything can fail. Harmless in window mode;
// the screenshot prompt never borrowed the action's popup.
if (prompt.mode === "note") void chrome.action.setPopup({ popup: MENU_PAGE }).catch(() => undefined);

const form = document.getElementById("form") as HTMLFormElement;
const textarea = document.getElementById("text") as HTMLTextAreaElement;
const pageLabel = document.getElementById("page") as HTMLElement;
const status = document.getElementById("status") as HTMLElement;
const interim = document.getElementById("interim") as HTMLElement;
const save = document.getElementById("save") as HTMLButtonElement;
const skip = document.getElementById("skip") as HTMLButtonElement;
const mic = document.getElementById("mic") as HTMLButtonElement;

/** What the mode does on Save (Enter) and on cancel (Esc; the screenshot prompt saves typed text instead). */
interface Mode {
  submit(): Promise<void>;
  cancel(): void;
}

const mode: Mode = prompt.mode === "screenshot" ? screenshotMode(prompt.id) : quickNoteMode(prompt.inWindow);

textarea.focus();
textarea.addEventListener("keydown", (e) => {
  const action = noteKeyAction(e);
  if (action === "save") {
    e.preventDefault();
    void mode.submit();
  } else if (action === "cancel") {
    e.preventDefault();
    mode.cancel();
  }
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  void mode.submit();
});

// ---------------------------------------------------------------------------
// Quick note (Alt+T)
// ---------------------------------------------------------------------------

function quickNoteMode(inWindow: boolean): Mode {
  if (inWindow) document.body.classList.add("in-window");
  const contextReady = loadNoteContext().then((context) => {
    showPage(context.page);
    return context;
  });

  let saving = false;
  // A server that speaks another protocol version (shared/protocol-compat.ts)
  // would refuse the note: say so now, before the user types it, not only
  // on Save. Anything else (not running yet, ...) is left to Save as before.
  void contextReady
    .then(async (context) => compatibleApiForServer(await serverFor(context)))
    .catch((error: unknown) => {
      if (error instanceof ApiError && error.code === "incompatible" && !saving) showStatus(error.message, "error");
    });
  return {
    async submit() {
      const note = textarea.value.trim();
      if (!note || saving) return;
      saving = true;
      save.disabled = true;
      showStatus("Saving…");
      try {
        const context = await contextReady;
        const api = await compatibleApiForServer(await serverFor(context));
        const { entry, session } = await api.postEntry(quickNoteEntry(context.page, note, new Date().toISOString()));
        // The worker lists it and notifies; if that fails the note is still saved.
        await sendMessage({ type: "entry-created", entry, session }).catch(() => undefined);
        textarea.disabled = true;
        showStatus(`Saved #${entry.seq}`, "ok");
        setTimeout(close, CLOSE_AFTER_SAVE_MS);
      } catch (error) {
        saving = false;
        save.disabled = false;
        showStatus(`Not saved: ${errorMessage(error)}`, "error");
        textarea.focus();
      }
    },
    cancel: close,
  };
}

/**
 * The server for the note's page: the one the worker resolved for that tab
 * when the shortcut was pressed (background/note-popup.ts writes it into the
 * context a moment after the rest). If it doesn't arrive in time (or there
 * is no context), resolve it here the same way, from the page's URL.
 */
async function serverFor(context: NoteContext): Promise<string> {
  if (context.serverUrl) return context.serverUrl;
  if (context.windowId !== -1) {
    const same = (c: unknown): c is NoteContext => (c as NoteContext | undefined)?.at === context.at && Boolean((c as NoteContext).serverUrl);
    const resolved = await waitForState("noteContext", same, SERVER_WAIT_MS);
    if (resolved?.serverUrl) return resolved.serverUrl;
  }
  return (await resolveServerForUrl(context.page.url)).serverUrl;
}

/**
 * The worker writes `noteContext` before it opens us, but storage writes
 * and page loads race in principle, so wait briefly for a fresh one.
 */
async function loadNoteContext(): Promise<NoteContext> {
  const fresh = (c: unknown): c is NoteContext => Boolean(c && Date.now() - (c as NoteContext).at < CONTEXT_MAX_AGE_MS);
  return (await waitForState("noteContext", fresh)) ?? { page: pageContextFromTab(undefined), windowId: -1, at: Date.now() };
}

// ---------------------------------------------------------------------------
// Screenshot note prompt
// ---------------------------------------------------------------------------

const SCREENSHOT_KEYS_HINT = "Enter saves · Esc skips if empty, else saves";

function screenshotMode(id: string): Mode {
  document.body.classList.add("in-window");
  textarea.placeholder = "What's wrong in this screenshot? (optional)";
  showStatus(SCREENSHOT_KEYS_HINT);
  skip.hidden = false;
  const dictation = setUpDictation();

  const mine = (p: unknown): p is PendingScreenshot => (p as PendingScreenshot | undefined)?.id === id;
  void waitForState("pendingScreenshot", mine).then((pending) => {
    if (pending) {
      showPage(pending.page);
      return;
    }
    // Answered already (another prompt replaced this one, or the worker timed it out).
    pageLabel.textContent = "This screenshot was already saved";
    save.disabled = true;
  });

  // Mirror the text to the worker as it is typed (see the header).
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  let sentDraft = "";
  const sendDraft = (): void => {
    clearTimeout(draftTimer);
    if (textarea.value === sentDraft) return;
    sentDraft = textarea.value;
    const message: ScreenshotNoteDraftMessage = { type: "screenshot-note:draft", id, draft: sentDraft };
    sendMessage(message).catch(() => undefined);
  };
  textarea.addEventListener("input", () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(sendDraft, DRAFT_DEBOUNCE_MS);
  });
  // The window's ✕ (or the next screenshot closing it): the last keystrokes too.
  window.addEventListener("pagehide", () => {
    if (!finishing) sendDraft();
  });

  let finishing = false;
  /** Hand the user's words (or none) to the worker, which writes the entry. */
  async function finish(note: string): Promise<void> {
    if (finishing) return;
    finishing = true;
    clearTimeout(draftTimer);
    save.disabled = skip.disabled = true;
    showStatus(note ? "Saving…" : "Skipping…");
    try {
      const response = await sendMessage({ type: "screenshot-note:finish", id, note });
      if (!response?.ok) throw new Error(response?.error ?? "holt did not answer.");
      if (response.sessionGone && response.entry) {
        // The words are saved, but not under the screenshot: say so before closing.
        textarea.disabled = true;
        showStatus(`The screenshot's session had ended; your note was saved as note #${response.entry.seq}.`, "ok");
        setTimeout(close, CLOSE_AFTER_SAVE_MS * 3);
        return;
      }
      if (!response.entry && note) {
        // Saved without this note before we got here: keep the text on screen so it can be copied.
        showStatus("This screenshot was already saved without a note. Copy your text if you need it.", "error");
        skip.disabled = false;
        skip.textContent = "Close";
        skip.onclick = close;
        return;
      }
      textarea.disabled = true;
      if (response.entry) showStatus(note ? `Saved #${response.entry.seq} with your note` : `Saved #${response.entry.seq}`, "ok");
      setTimeout(close, note ? CLOSE_AFTER_SAVE_MS : 0);
    } catch (error) {
      finishing = false;
      save.disabled = skip.disabled = false;
      showStatus(`Not saved: ${errorMessage(error)}`, "error");
      textarea.focus();
    }
  }

  const submit = async (): Promise<void> => {
    if (finishing) return;
    await dictation.stop(); // its last words belong in the note
    void finish(textarea.value.trim());
  };
  skip.addEventListener("click", () => {
    dictation.cancel();
    void finish("");
  });
  return {
    submit,
    cancel() {
      // Esc with words in the box saves them: a reflex Esc must not lose a typed note.
      if (textarea.value.trim()) return void submit();
      dictation.cancel();
      void finish("");
    },
  };
}

// ---- dictation ------------------------------------------------------------

interface Dictation {
  /** Stop listening and add the last recognised words. */
  stop(): Promise<void>;
  /** Stop listening, dropping whatever was still being recognised. */
  cancel(): void;
}

function setUpDictation(): Dictation {
  const available = "webkitSpeechRecognition" in window || "SpeechRecognition" in window;
  if (!available) return { stop: async () => undefined, cancel: () => undefined };
  // The button stays hidden (as in note.html) unless transcription is on in
  // the settings: dictating is speech recognition, which sends the audio to
  // Google's speech service, and the user may have turned that off.
  void loadSettings().then(({ transcribe }) => {
    mic.hidden = !transcribe;
    interim.hidden = !transcribe;
  });

  /** The microphone and recogniser while dictating; `transcriber` is null for the instant it is being created. */
  let running: { stream: MediaStream; transcriber: Transcriber | null } | null = null;
  let starting = false;
  /** The recogniser's text that the textarea already contains (resets with every start). */
  let heard = "";

  // Both recorders transcribe the microphone; a second recogniser on it at
  // the same time would fight them, so dictation waits for them to finish.
  const reflectRecorders = (): void =>
    void getRecordingState().then(({ screen, voice }) => {
      const busy = Boolean(voice || screen);
      if (busy && running) return;
      mic.disabled = busy;
      mic.title = busy ? "The microphone is in use by a recording. Stop it to dictate here." : "Dictate into the note (click again to stop)";
    });
  reflectRecorders();
  onStateChanged("recordingVoice", reflectRecorders);
  onStateChanged("recordingScreen", reflectRecorders);

  const setPressed = (pressed: boolean): void => {
    mic.setAttribute("aria-pressed", String(pressed));
    mic.textContent = pressed ? "■ Stop" : "🎙 Dictate";
  };

  /**
   * Bring in what the recogniser finalised since `heard`, as the box on the
   * page does (shared/transcript-text.ts). The text is the user's note, so
   * it is never replaced wholesale. Mirrored to the worker like typing.
   */
  const takeFinal = (final: string): void => {
    const before = textarea.value;
    heard = applyFinal(textarea, heard, final, { edited: true, focused: document.activeElement === textarea });
    if (textarea.value !== before) textarea.dispatchEvent(new Event("input"));
  };

  const onUpdate = (update: TranscriptUpdate): void => {
    if (!running) return;
    takeFinal(update.final);
    interim.textContent = update.interim;
    if (update.error) {
      showStatus(update.error, "error");
      void stop(); // the recogniser has given up; release the microphone
    }
  };

  async function start(): Promise<void> {
    if (running || starting) return;
    starting = true;
    mic.disabled = true;
    try {
      const { microphoneId, transcribe } = await loadSettings();
      if (!transcribe) {
        // Turned off since this window opened.
        mic.hidden = true;
        return;
      }
      const { stream, fallback } = await openMicrophone(microphoneId);
      heard = "";
      const session: { stream: MediaStream; transcriber: Transcriber | null } = { stream, transcriber: null };
      running = session;
      setPressed(true);
      // May report an error synchronously (no recogniser), which stops the session right away.
      session.transcriber = startSpeechRecognition(onUpdate, stream.getAudioTracks()[0], (code) => describeSpeechError(code, "dictation"));
      if (running !== session) return;
      showStatus(fallback ? "Selected microphone not found; dictating with the default one." : `Listening… ${SCREENSHOT_KEYS_HINT}`);
      textarea.focus();
    } catch (error) {
      microphoneFailed(error);
    } finally {
      starting = false;
      mic.disabled = false;
    }
  }

  async function stop(): Promise<void> {
    const current = running;
    if (!current) return;
    running = null;
    mic.disabled = true;
    try {
      const result = await current.transcriber?.stop();
      if (result) takeFinal(result.text);
    } finally {
      for (const track of current.stream.getTracks()) track.stop();
      interim.textContent = "";
      setPressed(false);
      mic.disabled = false;
    }
  }

  mic.addEventListener("click", () => void (running ? stop() : start()));
  // Leaving without Save/Skip (the window's ✕): don't leave the microphone on.
  window.addEventListener("pagehide", () => {
    for (const track of running?.stream.getTracks() ?? []) track.stop();
  });

  return {
    stop,
    cancel() {
      const current = running;
      running = null;
      if (!current) return;
      void current.transcriber?.stop();
      for (const track of current.stream.getTracks()) track.stop();
    },
  };
}

function microphoneFailed(error: unknown): void {
  showStatus(describeMicrophoneError(error, "dictation"), "error");
  // This page can't show the prompt reliably once it was blocked; holt's permissions page can.
  if (microphoneProblem(error) === "blocked") void chrome.tabs.create({ url: chrome.runtime.getURL(PERMISSIONS_PAGE) }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function showPage(page: PageContext): void {
  pageLabel.textContent = `Note on: ${page.title || page.url}`;
  pageLabel.title = page.url;
}

function showStatus(text: string, kind?: "ok" | "error"): void {
  status.textContent = text;
  status.className = kind === "error" ? "hint error-text" : kind === "ok" ? "hint ok-text" : "hint";
}

function close(): void {
  // Closes the action popup, or the popup window (an extension page may
  // close its own window).
  window.close();
}

/**
 * The value of storage.session `key` once `accept` likes it: right away, or
 * when the worker's write lands (it writes before it opens this page, but
 * storage writes and page loads race in principle), else null.
 */
async function waitForState<T>(
  key: "noteContext" | "pendingScreenshot",
  accept: (value: unknown) => value is T,
  timeoutMs = CONTEXT_WAIT_MS,
): Promise<T | null> {
  const stored = await getState(key);
  if (accept(stored)) return stored;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    onStateChanged(key, (value) => {
      if (!accept(value)) return;
      clearTimeout(timer);
      resolve(value);
    });
  });
}
