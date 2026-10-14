/**
 * Transcript overlay (dist/content/voice-overlay.js): a small box in the
 * page's top-right corner, under the toolbar icon, with the live transcript
 * of a voice note or tab recording, which the user can edit while they
 * talk, and review before it is saved.
 *
 * Injected on demand by the worker (background/voice-overlay.ts) into the
 * tab the recording was started on. It reacts to the worker's messages
 * (chrome.tabs.sendMessage; web pages can't send those):
 *
 *   voice-overlay:update      show the recording's box (creating it if needed)
 *                             with the transcript so far
 *   voice-overlay:finish      the recording stopped: close the box if the
 *                             user never touched it (the transcript is saved
 *                             as is), else keep it open for review
 *   voice-overlay:visibility  hide the boxes for a screenshot (answered after
 *                             the page has repainted without them), or show
 *                             them again
 *   voice-overlay:close       the recording is gone: remove its box
 *
 * and sends: `voice-overlay:stop` (Stop), `voice-overlay:draft` (the user's
 * edits, debounced, so a navigation doesn't lose them) and
 * `voice-overlay:decision` (Save / Discard after review).
 *
 * Editing while the recogniser is still talking: the box keeps the user's
 * text, and appends only what was recognised since (shared/transcript-text.ts),
 * at the end, without moving the caret. What is being recognised right now
 * (interim results) is shown greyed out under the text, not in it.
 *
 * "Active" (keep the box open for review when the recording stops) means:
 * the user clicked into the text, or edited it. Otherwise the box closes and
 * the transcript is saved exactly as recognised.
 *
 * Unlike the area-select overlay it must not get in the way: the host
 * element covers only the boxes, so the rest of the page stays clickable.
 * Closed shadow root and custom tag name for the same reasons as there (no
 * CSS leaking either way); key events are stopped at the box, so page-level
 * keyboard shortcuts don't fire while the user types. The page can see that
 * the box exists, and it shows what the user says about that page; nothing
 * else is exposed.
 *
 * Note for tab recordings: the box is part of the page, so it is in the
 * video too. It can be dragged aside, or hidden (✕) while recording.
 *
 * Idempotent: the worker injects it at the start of every recording and
 * again after the page reloads. A second copy in the same page does
 * nothing. Built as an IIFE because executeScript({ files }) runs classic
 * scripts.
 */

import {
  onMessage,
  type Ack,
  type RecorderKind,
  type RecorderToggleResponse,
  type VoiceOverlayDecision,
  type VoiceOverlayDraft,
  type VoiceOverlayFinishResponse,
  type VoiceOverlayStop,
  type VoiceOverlayUpdate,
} from "../shared/messages.js";
import { noteKeyAction } from "../shared/note-keys.js";
import { applyFinal } from "../shared/transcript-text.js";

declare global {
  interface Window {
    __holtVoiceOverlay?: true;
  }
}

/** Show the boxes again by ourselves if the worker hid them and went quiet (it can be terminated). */
const HIDDEN_WATCHDOG_MS = 15_000;
/** Distance from the viewport edges. */
const MARGIN_PX = 12;
/** Report edits to the worker at most this often. */
const DRAFT_DEBOUNCE_MS = 400;

const LABELS: Record<RecorderKind, { title: string; review: string; discard: string }> = {
  voice: { title: "Voice note", review: "Review voice note", discard: "Discard this voice note?" },
  tab: { title: "Recording", review: "Review transcript", discard: "Discard this recording? The video is deleted too." },
};

const STYLE = `
  .stack { display: flex; flex-direction: column; gap: 8px; }
  .box {
    width: 340px; max-width: calc(100vw - ${2 * MARGIN_PX}px);
    font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #f1f5f9;
    background: rgba(15, 23, 42, 0.95); border: 1px solid rgba(148, 163, 184, 0.25);
    border-radius: 10px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.35);
    overflow: hidden;
  }
  .box[hidden] { display: none; }
  .box.review { border-color: rgba(116, 143, 252, 0.7); }
  .head {
    display: flex; align-items: center; gap: 8px; padding: 7px 8px 7px 12px;
    cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none;
    border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  }
  .head.dragging { cursor: grabbing; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #f03e3e; flex: none; animation: pulse 1.6s ease-in-out infinite; }
  .review .dot { background: #748ffc; animation: none; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
  .title { font-weight: 600; }
  .clock { font-variant-numeric: tabular-nums; color: #94a3b8; }
  .spacer { flex: 1; }
  button {
    font: inherit; font-size: 12px; color: inherit; cursor: pointer;
    background: transparent; border: 1px solid rgba(148, 163, 184, 0.35); border-radius: 6px; padding: 2px 8px;
  }
  button:hover { background: rgba(148, 163, 184, 0.15); }
  button:focus-visible, textarea:focus-visible { outline: 2px solid #4c6ef5; outline-offset: 1px; }
  button:disabled { opacity: 0.5; cursor: default; }
  button[hidden] { display: none; }
  button.primary { background: #4c6ef5; border-color: #4c6ef5; color: #fff; }
  button.primary:hover { background: #5c7cfa; }
  button.danger { border-color: rgba(250, 82, 82, 0.6); color: #ffa8a8; }
  .close { border-color: transparent; padding: 2px 6px; color: #94a3b8; }
  .body { padding: 8px 10px 10px; display: grid; gap: 6px; }
  textarea {
    font: inherit; color: inherit; width: 100%; box-sizing: border-box; margin: 0;
    min-height: 5.8em; max-height: 40vh; resize: vertical; padding: 6px 8px;
    background: rgba(148, 163, 184, 0.08); border: 1px solid rgba(148, 163, 184, 0.25); border-radius: 6px;
  }
  textarea::placeholder { color: #94a3b8; }
  .interim { color: #94a3b8; font-style: italic; min-height: 1.45em; overflow-wrap: anywhere; }
  .interim:empty::before { content: "\\00a0"; }
  .error { color: #fcc419; font-size: 12px; }
  .row { display: flex; align-items: center; gap: 6px; }
  .hint { color: #94a3b8; font-size: 12px; flex: 1; }
  [hidden] { display: none !important; }
`;

if (!window.__holtVoiceOverlay) {
  window.__holtVoiceOverlay = true;
  install();
}

function install(): void {
  const boxes = new Map<string, Box>();
  let layer: Layer | null = null;
  /** Where the user dragged the boxes to (kept for later recordings on this page). */
  let position: { left: number; top: number } | null = null;

  const remove = (id: string): void => {
    boxes.get(id)?.destroy();
    boxes.delete(id);
    if (boxes.size === 0) {
      layer?.destroy();
      layer = null;
    }
  };

  onMessage((message) => {
    switch (message.type) {
      case "voice-overlay:update": {
        let box = boxes.get(message.id);
        if (!box) {
          layer ??= createLayer(position, (moved) => (position = moved));
          box = createBox(message, layer, () => remove(message.id));
          boxes.set(message.id, box);
        }
        box.update(message);
        return { ok: true };
      }
      case "voice-overlay:finish": {
        const box = boxes.get(message.id);
        const review = box ? box.finish(message.transcript) : false;
        if (!review) remove(message.id);
        return { ok: true, review } satisfies VoiceOverlayFinishResponse;
      }
      case "voice-overlay:visibility":
        if (!layer) return { ok: true };
        return layer.setHidden(message.hidden).then((): Ack => ({ ok: true }));
      case "voice-overlay:close":
        remove(message.id);
        return { ok: true };
      default:
        return undefined;
    }
  });

  // Leaving the page (navigation, reload, closing the tab) takes the boxes
  // with it. Hand over what the user wrote: during a recording as a draft
  // (the box comes back on the next page with it), during a review as a
  // Save, since keeping the text is the safe choice.
  window.addEventListener("pagehide", () => {
    for (const box of boxes.values()) box.flush();
  });
}

// ---------------------------------------------------------------------------
// The layer: one fixed, draggable column holding the boxes
// ---------------------------------------------------------------------------

interface Layer {
  stack: HTMLElement;
  /** Start dragging the whole column (from a box's header). */
  dragFrom(head: HTMLElement): void;
  /** Hide the column when every box in it is hidden. */
  refresh(): void;
  setHidden(hidden: boolean): Promise<void>;
  destroy(): void;
}

function createLayer(position: { left: number; top: number } | null, onMoved: (position: { left: number; top: number }) => void): Layer {
  const host = document.createElement("holt-voice-overlay");
  host.style.cssText = `all: initial; position: fixed; top: ${MARGIN_PX}px; right: ${MARGIN_PX}px; z-index: 2147483647;`;
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = STYLE;
  const stack = el("div", "stack");
  shadow.append(style, stack);
  document.documentElement.append(host);
  if (position) moveTo(position.left, position.top);

  function moveTo(left: number, top: number): void {
    const rect = host.getBoundingClientRect();
    const x = clamp(left, 0, window.innerWidth - rect.width);
    const y = clamp(top, 0, window.innerHeight - rect.height);
    Object.assign(host.style, { left: `${x}px`, top: `${y}px`, right: "auto" });
  }

  let watchdog: ReturnType<typeof setTimeout> | undefined;

  return {
    stack,
    // Dragging by a header (not its buttons). Switches from right/top to left/top.
    dragFrom(head) {
      let drag: { dx: number; dy: number } | null = null;
      head.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || (e.target as Element).closest("button")) return;
        e.preventDefault();
        const rect = host.getBoundingClientRect();
        drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        head.setPointerCapture(e.pointerId);
        head.classList.add("dragging");
      });
      head.addEventListener("pointermove", (e) => {
        if (drag) moveTo(e.clientX - drag.dx, e.clientY - drag.dy);
      });
      const endDrag = (): void => {
        if (!drag) return;
        drag = null;
        head.classList.remove("dragging");
        const rect = host.getBoundingClientRect();
        onMoved({ left: rect.left, top: rect.top });
      };
      head.addEventListener("pointerup", endDrag);
      head.addEventListener("pointercancel", endDrag);
    },
    refresh() {
      host.style.display = [...stack.children].every((child) => (child as HTMLElement).hidden) ? "none" : "";
    },
    /** Resolves once the change is on screen, so a screenshot taken next doesn't include the boxes. */
    async setHidden(hidden) {
      clearTimeout(watchdog);
      host.style.visibility = hidden ? "hidden" : "";
      if (!hidden) return;
      watchdog = setTimeout(() => (host.style.visibility = ""), HIDDEN_WATCHDOG_MS);
      await nextFrame();
      await nextFrame(); // the second frame callback runs after the first has painted
    },
    destroy() {
      clearTimeout(watchdog);
      host.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// One recording's box
// ---------------------------------------------------------------------------

interface Box {
  update(message: VoiceOverlayUpdate): void;
  /** The recording stopped with this transcript. True if the box stays open for review. */
  finish(transcript: string): boolean;
  /** The page is going away: send the user's text to the worker. */
  flush(): void;
  destroy(): void;
}

/** recording -> (Stop) stopping -> (finish) review -> (Save/Discard) saving -> gone */
type BoxState = "recording" | "stopping" | "review" | "saving";

function createBox({ id, recorder, startedAt, draft }: VoiceOverlayUpdate, layer: Layer, onGone: () => void): Box {
  const labels = LABELS[recorder];
  let state: BoxState = "recording";
  /** The recogniser's text that `text.value` already contains. */
  let heard = "";
  /** The user clicked into the text. */
  let engaged = false;
  /** The user changed the text. */
  let dirty = false;
  let draftTimer: ReturnType<typeof setTimeout> | undefined;

  // ---- elements ----------------------------------------------------------
  const title = span("title", labels.title);
  const clock = el("span", "clock");
  const stop = button("■ Stop", "", `Stop and save the ${labels.title.toLowerCase()}`);
  const hide = button("✕", "close", "Hide this box (recording continues)");
  const head = el("div", "head");
  head.append(el("span", "dot"), title, clock, el("span", "spacer"), stop, hide);

  const text = document.createElement("textarea");
  text.rows = 4;
  text.spellcheck = true;
  text.placeholder = "Listening… Click here to edit as you talk.";
  text.setAttribute("aria-label", `${labels.title} transcript`);
  const interim = el("div", "interim");
  interim.setAttribute("aria-live", "polite");
  const error = el("div", "error");
  error.hidden = true;

  const save = button("Save", "primary", "Save with this transcript (Enter)");
  const discard = button("Discard…", "danger", `Throw the ${labels.title.toLowerCase()} away`);
  const reviewRow = el("div", "row");
  reviewRow.append(span("hint", "Enter saves · Shift+Enter new line"), discard, save);
  reviewRow.hidden = true;

  const confirmDiscard = button("Discard", "danger", "");
  const keep = button("Keep editing", "", "");
  const confirmRow = el("div", "row");
  confirmRow.append(span("hint", labels.discard), keep, confirmDiscard);
  confirmRow.hidden = true;

  const body = el("div", "body");
  body.append(text, interim, error, reviewRow, confirmRow);
  const box = el("div", "box");
  box.append(head, body);
  layer.stack.append(box);
  layer.dragFrom(head);

  // Typing here is for us, not for the page's keyboard shortcuts (events
  // from a shadow root reach the page's listeners, retargeted to the host).
  for (const type of ["keydown", "keyup", "keypress"]) box.addEventListener(type, (e) => e.stopPropagation());

  if (draft) {
    // Re-created after a navigation: the user's edits come back.
    text.value = draft.text;
    heard = draft.heard;
    dirty = true;
  }

  const tick = (): void => {
    clock.textContent = formatElapsed(Date.now() - startedAt);
  };
  tick();
  const timer = setInterval(tick, 1000);

  // ---- editing -----------------------------------------------------------
  text.addEventListener("focus", () => (engaged = true));
  text.addEventListener("input", () => {
    dirty = true;
    clearTimeout(draftTimer);
    if (state === "recording" || state === "stopping") draftTimer = setTimeout(sendDraft, DRAFT_DEBOUNCE_MS);
  });
  text.addEventListener("keydown", (e) => {
    if (state !== "review" || noteKeyAction(e) !== "save") return;
    e.preventDefault();
    void decide(true);
  });

  function sendDraft(): void {
    clearTimeout(draftTimer);
    const message: VoiceOverlayDraft = { type: "voice-overlay:draft", id, draft: { text: text.value, heard } };
    chrome.runtime.sendMessage(message).catch(() => undefined);
  }

  /** Bring in what the recogniser finalised since `heard`, keeping the user's edits (shared/transcript-text.ts). */
  function takeFinal(final: string): void {
    heard = applyFinal(text, heard, final, { edited: dirty, focused: isFocused() });
  }

  function isFocused(): boolean {
    return (text.getRootNode() as ShadowRoot).activeElement === text;
  }

  // ---- buttons -----------------------------------------------------------
  stop.addEventListener("click", () => {
    state = "stopping";
    stop.disabled = true;
    stop.textContent = "Stopping…";
    const message: VoiceOverlayStop = { type: "voice-overlay:stop", id };
    // On success the worker sends voice-overlay:finish. A rejection means the
    // extension was reloaded since injection, so this box is stale.
    chrome.runtime.sendMessage<VoiceOverlayStop, RecorderToggleResponse>(message).then(
      (response) => {
        if (response?.ok || state !== "stopping") return;
        state = "recording";
        stop.disabled = false;
        stop.textContent = "■ Stop";
      },
      () => onGone(),
    );
  });
  hide.addEventListener("click", () => {
    if (state === "review" || state === "saving") return onGone(); // only offered after a failed save
    box.hidden = true;
    layer.refresh();
  });
  save.addEventListener("click", () => void decide(true));
  discard.addEventListener("click", () => {
    reviewRow.hidden = true;
    confirmRow.hidden = false;
    keep.focus();
  });
  keep.addEventListener("click", () => {
    confirmRow.hidden = true;
    reviewRow.hidden = false;
    text.focus();
  });
  confirmDiscard.addEventListener("click", () => void decide(false));

  async function decide(keepIt: boolean): Promise<void> {
    if (state !== "review") return;
    state = "saving";
    for (const b of [save, discard, confirmDiscard, keep]) b.disabled = true;
    text.readOnly = true;
    const message: VoiceOverlayDecision = { type: "voice-overlay:decision", id, save: keepIt, text: keepIt ? text.value : "" };
    let response: { ok: boolean; error?: string } | undefined;
    try {
      response = await chrome.runtime.sendMessage<VoiceOverlayDecision, { ok: boolean; error?: string }>(message);
    } catch {
      response = { ok: false, error: "holt was reloaded, so this can't be saved any more. Copy the text if you need it." };
      hide.hidden = false; // let the user close the box
      hide.title = "Close";
    }
    if (response?.ok) return onGone();
    state = "review";
    for (const b of [save, discard, confirmDiscard, keep]) b.disabled = false;
    text.readOnly = false;
    showError(response?.error ?? "Not saved.");
  }

  function showError(message: string): void {
    error.hidden = false;
    error.textContent = message;
  }

  function enterReview(): void {
    state = "review";
    clearInterval(timer);
    box.classList.add("review");
    box.hidden = false;
    layer.refresh();
    title.textContent = labels.review;
    stop.hidden = true;
    hide.hidden = true;
    interim.hidden = true;
    reviewRow.hidden = false;
    text.placeholder = "Nothing was recognised. Type what you want to save, or discard.";
    if (!isFocused()) text.focus({ preventScroll: true });
  }

  return {
    update({ final, interim: guess, error: problem }) {
      if (state === "review" || state === "saving") return;
      takeFinal(final);
      interim.textContent = guess;
      // Once transcription has failed it stays failed for this recording; keep saying so.
      if (problem) showError(problem);
    },
    finish(transcript) {
      if (state === "review" || state === "saving") return true;
      takeFinal(transcript);
      interim.textContent = "";
      if (!engaged && !dirty) return false;
      enterReview();
      return true;
    },
    flush() {
      if (state === "review") {
        const message: VoiceOverlayDecision = { type: "voice-overlay:decision", id, save: true, text: text.value };
        chrome.runtime.sendMessage(message).catch(() => undefined);
      } else if (dirty && state !== "saving") {
        sendDraft();
      }
    },
    destroy() {
      clearInterval(timer);
      clearTimeout(draftTimer);
      box.remove();
      layer.refresh();
    },
  };
}

// ---------------------------------------------------------------------------

/** "0:07", "12:34": same format as the side panel's timers. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function span(className: string, content: string): HTMLElement {
  const node = el("span", className);
  node.textContent = content;
  return node;
}

function button(label: string, className: string, title: string): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  if (title) {
    node.title = title;
    if (label.length <= 2) node.setAttribute("aria-label", title);
  }
  return node;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
