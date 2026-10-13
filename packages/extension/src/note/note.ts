/**
 * The quick-note popup (note.html, opened by the Alt+T shortcut).
 *
 *  1. Reset the action's popup to "" right away, so the next click on the
 *     toolbar icon opens the side panel again (the worker set it to
 *     note.html just to be able to call openPopup(), see
 *     background/note-popup.ts).
 *  2. Read the page the note is about from storage.session (`noteContext`,
 *     written by the worker at shortcut time).
 *  3. Focused textarea: Enter saves, Shift+Enter = newline, Esc closes.
 *  4. Save straight to the server (this is an extension page with the same
 *     settings and host permissions as the panel), then hand the entry to
 *     the worker (`entry-created`), which adds it to the panel's recent list
 *     and toasts in the panel or flashes the badge. Show "Saved #N" briefly
 *     and close. Errors stay inline so the text isn't lost.
 */

import { getApi } from "../shared/api.js";
import { errorMessage, sendMessage } from "../shared/messages.js";
import { noteKeyAction } from "../shared/note-keys.js";
import { pageContextFromTab } from "../shared/page-context.js";
import { getState, onStateChanged, type NoteContext } from "../shared/state.js";

/** A context older than this is from an earlier shortcut press, not this one. */
const CONTEXT_MAX_AGE_MS = 60_000;
const CLOSE_AFTER_SAVE_MS = 900;

const inWindow = new URLSearchParams(location.search).has("window");
// Step 1, before anything can fail. Harmless in window mode.
void chrome.action.setPopup({ popup: "" }).catch(() => undefined);

const form = document.getElementById("form") as HTMLFormElement;
const textarea = document.getElementById("text") as HTMLTextAreaElement;
const pageLabel = document.getElementById("page") as HTMLElement;
const status = document.getElementById("status") as HTMLElement;
const save = document.getElementById("save") as HTMLButtonElement;
if (inWindow) document.body.classList.add("in-window");

textarea.focus();
const contextReady = loadContext().then((context) => {
  pageLabel.textContent = `Note on: ${context.page.title}`;
  pageLabel.title = context.page.url;
  return context;
});

textarea.addEventListener("keydown", (e) => {
  const action = noteKeyAction(e);
  if (action === "save") {
    e.preventDefault();
    void submit();
  } else if (action === "cancel") {
    e.preventDefault();
    close();
  }
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  void submit();
});

let saving = false;
async function submit(): Promise<void> {
  const text = textarea.value.trim();
  if (!text || saving) return;
  saving = true;
  save.disabled = true;
  showStatus("Saving…");
  try {
    const { page } = await contextReady;
    const api = await getApi();
    const { entry, session } = await api.postEntry({ kind: "note", capturedAt: new Date().toISOString(), page, text });
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
 * The worker writes `noteContext` before it opens us, but storage writes
 * and page loads race in principle, so wait briefly for a fresh one.
 */
async function loadContext(): Promise<NoteContext> {
  const fresh = (c: NoteContext | undefined): c is NoteContext => Boolean(c && Date.now() - c.at < CONTEXT_MAX_AGE_MS);
  const stored = await getState("noteContext");
  if (fresh(stored)) return stored;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ page: pageContextFromTab(undefined), windowId: -1, at: Date.now() }), 1_000);
    onStateChanged("noteContext", (value) => {
      if (fresh(value)) {
        clearTimeout(timer);
        resolve(value);
      }
    });
  });
}
