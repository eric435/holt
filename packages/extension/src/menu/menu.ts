/**
 * The toolbar menu (menu.html, the action's popup): what a click on holt's
 * icon shows.
 *
 *   nothing recording:  Screenshot area · Screenshot viewport ·
 *                       Screenshot full page · Voice note · Quick note ·
 *                       Start recording · Settings
 *   something recording: only its Stop item (with the elapsed time)
 *
 * The capture items do exactly what the matching shortcut does: the menu
 * sends `menu:run` and the worker runs the command (background/commands.ts)
 * on the active tab. Opening this popup is an action invocation, so it
 * grants `activeTab` for that tab just like a shortcut. The worker answers
 * before doing the work, and the menu closes: it must be gone before an
 * area selection, and results and errors are reported by the worker (badge,
 * or the settings panel if open), not here.
 *
 * Quick note is the exception: the shortcut's note page shows up as this
 * very popup (background/note-popup.ts), so the menu becomes it, with
 * `location.href = "note.html"`, rather than asking the worker to open a
 * popup while this one is still up. It hands the note page the same
 * `noteContext` the worker would (the page, and its server, resolved while
 * the menu was open), and note.ts treats it exactly like the shortcut's.
 *
 * Settings opens the side panel (the "settings panel"). sidePanel.open()
 * must run during the click, synchronously, so the window id is looked up
 * when the menu opens, not when the item is clicked.
 *
 * The items show the current shortcuts (chrome.commands.getAll(), which the
 * user may have changed), and follow the recording state in storage.session
 * while the menu is open.
 *
 * The header names the project of the server for the page in front
 * (`serverInfo`, owned by the worker: background/server-info.ts). The menu
 * asks the worker to check again when it opens, and follows the answer.
 * When no server answers, the header says so ("Not connected: …", with the
 * API client's hint) and offers "Open settings". A holt server that speaks
 * another protocol version (shared/protocol-compat.ts) gets "Update
 * needed: …" with what to update instead.
 *
 * The capture items stay enabled even then. `serverInfo` is a snapshot, and
 * a capture resolves its server afresh (the dev server may have just
 * started, or the probe cache just expired); if it really fails, the
 * capture says why itself (badge "!" and tooltip, or a toast in the panel).
 * Disabling them on a stale "no" would block a capture that would work.
 */

import { errorMessage, sendMessage, type MenuCommand } from "../shared/messages.js";
import { pageContextFromTab } from "../shared/page-context.js";
import { NOTE_PAGE } from "../shared/pages.js";
import { getShortcuts, type CommandName, type ShortcutMap } from "../shared/shortcuts.js";
import { displayHost } from "../shared/server-label.js";
import { resolveServerForTab } from "../shared/server.js";
import {
  getRecordingState,
  getState,
  onRecordingStateChanged,
  onStateChanged,
  setState,
  type NoteContext,
  type RecordingState,
  type ServerInfo,
} from "../shared/state.js";

type IconName = "area" | "viewport" | "page" | "mic" | "note" | "record" | "settings" | "stop";

interface Item {
  label: string;
  icon: IconName;
  /** The shortcut that does the same (shown on the right). */
  shortcut: CommandName;
  run(): void;
  /** Started at (epoch ms): show the elapsed time instead of the shortcut. */
  since?: number;
}

const items = document.getElementById("items") as HTMLElement;
const status = document.getElementById("status") as HTMLElement;
const project = document.getElementById("project") as HTMLElement;
const problem = document.getElementById("problem") as HTMLElement;
const problemTitle = document.getElementById("problem-title") as HTMLElement;
const problemText = document.getElementById("problem-text") as HTMLElement;
const problemSettings = document.getElementById("problem-settings") as HTMLButtonElement;

/** The hint under "Not connected" is cut to about three lines of the 260 px menu. */
const MAX_PROBLEM_CHARS = 170;

let windowId: number | undefined;
let shortcuts: ShortcutMap = {};
let busy = false;
/** The page in front and its server, for Quick note (looked up when the menu opens, like the window id). */
let noteTarget: Promise<Omit<NoteContext, "at">> | undefined;

void main();

async function main(): Promise<void> {
  const [win, recording, keys, serverInfo] = await Promise.all([
    chrome.windows.getCurrent(),
    getRecordingState(),
    getShortcuts(),
    getState("serverInfo"),
  ]);
  windowId = win.id;
  shortcuts = keys;
  if (windowId !== undefined) noteTarget = quickNoteTarget(windowId);
  renderServer(serverInfo);
  onStateChanged("serverInfo", renderServer);
  problemSettings.addEventListener("click", openSettings);
  // The stored answer may be from before the last tab switch or server start.
  void sendMessage({ type: "server-info:refresh" }).catch(() => undefined);
  render(recording);
  onRecordingStateChanged((next) => {
    if (!busy) render(next);
  });
  setInterval(tickTimers, 500);
}

function itemsFor({ screen, voice }: RecordingState): Item[] {
  // While recording, stopping is the only thing on offer.
  const stops: Item[] = [];
  if (voice) stops.push({ label: "Stop voice note", icon: "stop", shortcut: "toggle-voice", since: voice.startedAt, run: () => run("toggle-voice") });
  if (screen) stops.push({ label: "Stop recording", icon: "stop", shortcut: "toggle-recording", since: screen.startedAt, run: () => run("toggle-recording") });
  if (stops.length > 0) return stops;
  return [
    { label: "Screenshot area", icon: "area", shortcut: "screenshot-area", run: () => run("screenshot-area") },
    { label: "Screenshot viewport", icon: "viewport", shortcut: "screenshot-viewport", run: () => run("screenshot-viewport") },
    { label: "Screenshot full page", icon: "page", shortcut: "screenshot-full", run: () => run("screenshot-full") },
    { label: "Voice note", icon: "mic", shortcut: "toggle-voice", run: () => run("toggle-voice") },
    { label: "Quick note", icon: "note", shortcut: "quick-note", run: () => void quickNote() },
    { label: "Start recording", icon: "record", shortcut: "toggle-recording", run: () => run("toggle-recording") },
    { label: "Settings", icon: "settings", shortcut: "open-panel", run: openSettings },
  ];
}

function render(recording: RecordingState): void {
  const list = itemsFor(recording);
  items.replaceChildren(
    ...list.flatMap((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `menu-item${item.icon === "stop" ? " stop" : ""}`;
      button.setAttribute("role", "menuitem");
      const side = document.createElement("span");
      side.className = "menu-side";
      if (item.since !== undefined) {
        side.dataset.since = String(item.since);
        side.classList.add("menu-timer");
      } else if (shortcuts[item.shortcut]) {
        const kbd = document.createElement("kbd");
        kbd.textContent = shortcuts[item.shortcut] ?? "";
        side.append(kbd);
      }
      const label = document.createElement("span");
      label.className = "menu-label";
      label.textContent = item.label;
      button.append(icon(item.icon), label, side);
      button.addEventListener("click", () => item.run());
      // Settings goes below a divider: it's not a capture.
      const divider = index > 0 && item.icon === "settings" ? [Object.assign(document.createElement("hr"), { className: "menu-divider" })] : [];
      return [...divider, button];
    }),
  );
  tickTimers();
  focusable()[0]?.focus();
}

/** Header: the project, or why there is no server for this page. */
function renderServer(info: ServerInfo | undefined): void {
  project.textContent = info?.ok ? (info.project ?? displayHost(info.serverUrl)) : "";
  problem.hidden = !info || info.ok;
  if (!info || info.ok) return;
  // A holt server of another protocol version answered: its message says what to update.
  problemTitle.textContent = info.incompatible ? "Update needed" : "Not connected";
  // In front: whether the page itself was checked; the message names the server that was tried.
  const text = info.source === "fallback" && !info.incompatible ? `No holt on this page, and none at the fallback URL. ${info.message}` : info.message;
  problemText.textContent = clip(text, MAX_PROBLEM_CHARS);
  problemText.title = text;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Ask the worker to run `command` on the active tab, then get out of the way. */
function run(command: MenuCommand): void {
  if (busy || windowId === undefined) return;
  busy = true;
  for (const button of focusable()) button.disabled = true;
  sendMessage({ type: "menu:run", command, windowId }).then(
    (response) => {
      if (response.ok) return window.close();
      showError(response.error);
    },
    (error: unknown) => showError(errorMessage(error)),
  );
}

/**
 * The page the menu was opened on, and the server a capture there goes to
 * (shared/server.ts). Opening the menu granted activeTab, so the tab's URL
 * and title are readable. A server that can't be resolved now is left out;
 * the note page then resolves it itself when the user saves.
 */
async function quickNoteTarget(inWindow: number): Promise<Omit<NoteContext, "at">> {
  const [tab] = await chrome.tabs.query({ active: true, windowId: inWindow }).catch(() => []);
  const context: Omit<NoteContext, "at"> = { page: pageContextFromTab(tab), windowId: inWindow };
  try {
    return { ...context, serverUrl: (await resolveServerForTab(tab)).serverUrl };
  } catch {
    return context;
  }
}

/** Become the quick-note popup (see the header). */
async function quickNote(): Promise<void> {
  if (busy || !noteTarget) return;
  busy = true;
  for (const button of focusable()) button.disabled = true;
  try {
    await setState("noteContext", { ...(await noteTarget), at: Date.now() });
    location.href = NOTE_PAGE;
  } catch (error) {
    showError(`Could not open the note: ${errorMessage(error)}`);
  }
}

function openSettings(): void {
  if (windowId === undefined) return;
  // Synchronously, during the click: Chrome only allows it in response to a user gesture.
  chrome.sidePanel.open({ windowId }).then(
    () => window.close(),
    (error: unknown) => showError(`Could not open the settings panel: ${errorMessage(error)}`),
  );
}

function showError(message: string): void {
  busy = false;
  for (const button of focusable()) button.disabled = false;
  status.hidden = false;
  status.textContent = message;
}

function tickTimers(): void {
  for (const el of items.querySelectorAll<HTMLElement>("[data-since]")) {
    el.textContent = formatElapsed(Date.now() - Number(el.dataset.since));
  }
}

function focusable(): HTMLButtonElement[] {
  return [...items.querySelectorAll<HTMLButtonElement>("button.menu-item")];
}

// Up/Down (and Home/End) move between items, like a native menu; Enter/Space click.
items.addEventListener("keydown", (e) => {
  const buttons = focusable();
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const target =
    e.key === "ArrowDown" ? buttons[(at + 1) % buttons.length]
    : e.key === "ArrowUp" ? buttons[(at - 1 + buttons.length) % buttons.length]
    : e.key === "Home" ? buttons[0]
    : e.key === "End" ? buttons[buttons.length - 1]
    : undefined;
  if (!target) return;
  e.preventDefault();
  target.focus();
});

/** "0:07", "12:34": same format as the side panel's timers. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// 16px line icons (drawn with currentColor, so they follow light/dark)
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

const ICONS: Record<IconName, ReadonlyArray<[string, Record<string, string>]>> = {
  area: [["rect", { x: "2.5", y: "2.5", width: "11", height: "11", rx: "1", "stroke-dasharray": "2.2 1.8" }]],
  viewport: [
    ["rect", { x: "1.5", y: "3", width: "13", height: "10", rx: "1.5" }],
    ["path", { d: "M1.5 5.5h13" }],
  ],
  page: [
    ["path", { d: "M4 1.5h5.5L12.5 4.5v10H4z" }],
    ["path", { d: "M9.5 1.5v3h3M6 8h4.5M6 10.5h4.5" }],
  ],
  mic: [
    ["rect", { x: "6", y: "1.5", width: "4", height: "8", rx: "2" }],
    ["path", { d: "M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" }],
  ],
  note: [
    ["path", { d: "M10.5 2.5l3 3L6 13H3v-3z" }],
    ["path", { d: "M9 4l3 3" }],
  ],
  record: [
    ["circle", { cx: "8", cy: "8", r: "6" }],
    ["circle", { cx: "8", cy: "8", r: "3", style: "fill: var(--danger); stroke: none" }],
  ],
  settings: [
    ["path", { d: "M2 4.5h12M2 11.5h12" }],
    ["circle", { cx: "5.5", cy: "4.5", r: "1.75", style: "fill: var(--card)" }],
    ["circle", { cx: "10.5", cy: "11.5", r: "1.75", style: "fill: var(--card)" }],
  ],
  stop: [["rect", { x: "4", y: "4", width: "8", height: "8", rx: "1.5", fill: "currentColor", stroke: "none" }]],
};

function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 16 16", width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "1.4", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "menu-icon" })) {
    svg.setAttribute(key, value);
  }
  for (const [tag, attrs] of ICONS[name]) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
    svg.append(shape);
  }
  return svg;
}
