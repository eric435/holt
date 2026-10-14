/**
 * The list of entries added in the current session, newest first.
 *
 * Source of truth is the `recentEntries` list in chrome.storage.session
 * (shared/state.ts), which the worker appends to for every entry written
 * (its own screenshots, and what the offscreen recorders and the note popup
 * report). So the list survives closing and reopening the panel, and
 * updates live via storage.onChanged.
 *
 * One item per capture: the page, the media file (if any) and the user's
 * words (if any), laid out by ../entry-view.ts. Notes are added when the
 * capture is made (the screenshot note prompt, the transcript review), so
 * there is nothing to edit here.
 */

import type { Entry } from "@holt/protocol";
import { getState as getStoredState, onStateChanged, type RecentEntry } from "../../shared/state.js";
import { entryView } from "../entry-view.js";
import { getState, subscribe } from "../store.js";
import { formatTime, h, replace } from "./dom.js";

export function mountEntries(root: HTMLElement): void {
  const list = h("ol", { class: "entries", reversed: true });
  const empty = h("p", { class: "muted" }, "Nothing captured in this session yet.");
  replace(root, h("h2", {}, "This session"), empty, list);

  let items: RecentEntry[] = [];
  let shownSessionId: string | undefined;

  const render = (): void => {
    const sessionId = getState().session?.id;
    const visible = sessionId ? items.filter((i) => i.sessionId === sessionId) : items;
    empty.hidden = visible.length > 0;
    replace(list, ...visible.map((i) => renderEntry(i.entry)));
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

function renderEntry(entry: Entry): HTMLElement {
  const view = entryView(entry);
  return h(
    "li",
    { class: `entry entry-${entry.kind}` },
    h("div", { class: "entry-title" }, h("strong", {}, view.title), " ", h("span", { class: "muted" }, formatTime(entry.capturedAt))),
    h("div", { class: view.pageUrl ? "entry-page" : "entry-page muted", title: view.pageUrl }, view.page),
    view.media ? h("div", { class: "muted entry-media" }, view.media) : null,
    view.note ? h("div", { class: "entry-text" }, view.note) : null,
  );
}
