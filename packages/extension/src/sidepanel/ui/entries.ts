/**
 * The list of entries added in the current session, newest first.
 *
 * Source of truth is the `recentEntries` list in chrome.storage.session
 * (shared/state.ts), which both the worker (screenshots) and the panel
 * (notes, recordings) append to. So the list survives closing and reopening
 * the panel, and updates live via storage.onChanged.
 *
 * Screenshots get an "add note" field. There is no endpoint to edit an
 * entry, so the note is posted as a separate `note` entry that refers to the
 * screenshot's number.
 */

import type { Entry } from "@holt/protocol";
import { errorMessage } from "../../shared/messages.js";
import { getState as getStoredState, onStateChanged, type RecentEntry } from "../../shared/state.js";
import { getState, subscribe } from "../store.js";
import { postEntry } from "../upload.js";
import { formatDuration, formatTime, h, replace } from "./dom.js";
import { toast } from "./toast.js";

const LABELS: Record<Entry["kind"], string> = {
  screenshot: "Screenshot",
  recording: "Recording",
  "voice-note": "Voice note",
  note: "Note",
};

export function mountEntries(root: HTMLElement): void {
  const list = h("ol", { class: "entries", reversed: true });
  const empty = h("p", { class: "muted" }, "Nothing captured in this session yet.");
  replace(root, h("h2", {}, "This session"), empty, list);

  let items: RecentEntry[] = [];
  let shownSessionId: string | undefined;
  /** Keep typed-but-unsent notes when the list re-renders. */
  const drafts = new Map<string, string>();

  const render = (): void => {
    const sessionId = getState().session?.id;
    const visible = sessionId ? items.filter((i) => i.sessionId === sessionId) : items;
    empty.hidden = visible.length > 0;
    replace(list, ...visible.map((i) => renderEntry(i.entry, drafts)));
  };

  void getStoredState("recentEntries").then((stored) => {
    items = stored ?? [];
    render();
  });
  onStateChanged("recentEntries", (value) => {
    items = value ?? [];
    render();
  });
  subscribe((state) => {
    if (state.session?.id !== shownSessionId) {
      shownSessionId = state.session?.id;
      render();
    }
  });
}

function renderEntry(entry: Entry, drafts: Map<string, string>): HTMLElement {
  const title = h("div", { class: "entry-title" }, h("strong", {}, `#${entry.seq} ${LABELS[entry.kind]}`), " ", h("span", { class: "muted" }, formatTime(entry.capturedAt)));
  const page = entry.page.url
    ? h("div", { class: "entry-page", title: entry.page.url }, entry.page.title)
    : h("div", { class: "entry-page muted" }, entry.page.title);

  let detail: Node | null = null;
  switch (entry.kind) {
    case "screenshot":
      detail = h("div", { class: "muted" }, `${entry.mode} · ${entry.width}×${entry.height} · ${entry.file}`);
      break;
    case "recording":
      detail = h("div", { class: "muted" }, `${formatDuration(entry.durationMs)} · ${entry.file}`);
      break;
    case "voice-note":
      detail = h("div", {}, entry.transcript ? `“${entry.transcript}”` : h("span", { class: "muted" }, `${formatDuration(entry.durationMs)} audio`));
      break;
    case "note":
      detail = h("div", { class: "entry-text" }, entry.text);
      break;
  }

  return h("li", { class: `entry entry-${entry.kind}` }, title, page, detail, entry.kind === "screenshot" ? noteField(entry, drafts) : null);
}

function noteField(entry: Entry, drafts: Map<string, string>): HTMLElement {
  const input = h("input", { type: "text", placeholder: "Add a note to this screenshot…", value: drafts.get(entry.id) ?? "" });
  input.addEventListener("input", () => drafts.set(entry.id, input.value));
  const send = async (): Promise<void> => {
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    try {
      await postEntry({ kind: "note", capturedAt: new Date().toISOString(), page: entry.page, text: `About #${entry.seq}: ${text}` });
      drafts.delete(entry.id);
      input.value = "";
    } catch (error) {
      toast("error", `Note not saved: ${errorMessage(error)}`);
    } finally {
      input.disabled = false;
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void send();
    }
  });
  return h("div", { class: "entry-note" }, input);
}
