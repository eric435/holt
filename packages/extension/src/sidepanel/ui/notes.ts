/**
 * Typed notes: a textarea. Enter saves, Shift+Enter starts a new line (the
 * same keys as the Alt+T note popup; see shared/note-keys.ts).
 */

import type { Entry } from "@nitpick/protocol";
import { errorMessage } from "../../shared/messages.js";
import { noteKeyAction } from "../../shared/note-keys.js";
import { getActivePage } from "../page.js";
import { postEntry } from "../upload.js";
import { h, replace } from "./dom.js";
import { toast } from "./toast.js";

export interface NotesApi {
  focus(): void;
}

export function mountNotes(root: HTMLElement, onEntry: (entry: Entry) => void): NotesApi {
  const textarea = h("textarea", { rows: 3, placeholder: "What's wrong on this page? (Shift+Enter for a new line)", "aria-label": "Note" });
  const submit = h("button", { onclick: () => void send() }, "Add note (Enter)");

  textarea.addEventListener("keydown", (e) => {
    if (noteKeyAction(e) === "save") {
      e.preventDefault();
      void send();
    }
  });

  async function send(): Promise<void> {
    const text = textarea.value.trim();
    if (!text) return;
    submit.disabled = true;
    try {
      const page = await getActivePage();
      const entry = await postEntry({ kind: "note", capturedAt: new Date().toISOString(), page, text });
      textarea.value = "";
      onEntry(entry);
    } catch (error) {
      toast("error", `Note not saved: ${errorMessage(error)}`);
    } finally {
      submit.disabled = false;
    }
  }

  replace(root, h("h2", {}, "Note"), textarea, h("div", { class: "row end" }, submit));

  return { focus: () => textarea.focus() };
}
