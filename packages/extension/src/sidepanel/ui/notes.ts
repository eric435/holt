/**
 * Typed notes: a textarea, submitted with the button or Cmd/Ctrl+Enter.
 */

import type { Entry } from "@nitpick/protocol";
import { errorMessage } from "../../shared/messages.js";
import { getActivePage } from "../page.js";
import { postEntry } from "../upload.js";
import { h, replace } from "./dom.js";
import { toast } from "./toast.js";

export interface NotesApi {
  focus(): void;
}

export function mountNotes(root: HTMLElement, onEntry: (entry: Entry) => void): NotesApi {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const textarea = h("textarea", { rows: 3, placeholder: "What's wrong on this page?", "aria-label": "Note" });
  const submit = h("button", { onclick: () => void send() }, `Add note (${isMac ? "⌘" : "Ctrl"}+Enter)`);

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
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
